import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeDb } from '../helpers/supabase-mock';
import { jsonRequest } from '../helpers/request';

vi.mock('@/lib/supabase', async () =>
  (await import('../helpers/supabase-mock')).mockSupabaseModule());
vi.mock('@/lib/logger', () => ({ log: vi.fn() }));

import { PATCH } from '@/app/api/creator/me/route';
import { clearRevocationCache, createAccessToken } from '@/lib/tokens';

/**
 * A creator editing their own platform links (MEAL-94).
 *
 * Two properties this file exists for, and neither is "the PATCH worked":
 *
 * 1. **Adding a link never starts polling.** `primary_source` and
 *    `import_opt_in` are an operator's decision (MEAL-81), so no request a
 *    creator can make may write either.
 * 2. **Clearing a link never leaves a creator opted into polling a source they
 *    just removed.** Refused, with the reason.
 *
 * Asserted on the row afterwards rather than on the call, because what a write
 * *sent* is not the property worth defending — the state it left is.
 */

/** Queues the `user_profiles` read `verifyAccessToken` makes (memoised for 30s). */
function asUser() {
  clearRevocationCache();
  fakeDb.queue('user_profiles', { data: { tokens_invalidated_at: null } });
}

/** A creator with a website and nothing else, not polled. */
function creatorRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'c1',
    user_id: 'u1',
    handle: 'chefsarah',
    website_url: 'https://chefsarah.test/',
    youtube_url: null,
    instagram_url: null,
    tiktok_url: null,
    primary_source: 'none',
    import_opt_in: false,
    feed_url: null,
    ...overrides,
  };
}

function patch(token: string, body: Record<string, unknown>) {
  return PATCH(jsonRequest('/api/creator/me', { method: 'PATCH', token, body }));
}

describe('PATCH /api/creator/me — platform links', () => {
  let token: string;

  beforeEach(async () => {
    fakeDb.reset();
    token = await createAccessToken('u1', 'sarah@chefsarah.test');
  });

  it('401 without a token', async () => {
    const res = await PATCH(jsonRequest('/api/creator/me', { method: 'PATCH', body: { links: { youtube: 'x' } } }));
    expect(res.status).toBe(401);
  });

  it('403 for someone who is not an approved creator', async () => {
    asUser();
    fakeDb.seed('creators', []);
    const res = await patch(token, { links: { youtube: 'youtube.com/@chefsarah' } });
    expect(res.status).toBe(403);
  });

  it('adds a link a creator did not have when they applied', async () => {
    asUser();
    fakeDb.seed('creators', [creatorRow()]);

    // The whole point of the ticket: joined without YouTube, started a channel
    // six months later.
    const res = await patch(token, { links: { youtube: 'youtube.com/@chefsarah' } });

    expect(res.status).toBe(200);
    expect(fakeDb.row('creators', 'c1')?.youtube_url).toBe('https://youtube.com/@chefsarah');
  });

  it('normalises through the application form’s own validator', async () => {
    asUser();
    fakeDb.seed('creators', [creatorRow({ website_url: null })]);

    // A bare host with no scheme is what people type, and `normalizePlatformUrl`
    // accepts it. One validator, so the two forms cannot drift.
    await patch(token, { links: { website: '  chefsarah.test  ' } });

    expect(fakeDb.row('creators', 'c1')?.website_url).toBe('https://chefsarah.test/');
  });

  it('refuses a link on the wrong platform, and writes nothing', async () => {
    asUser();
    fakeDb.seed('creators', [creatorRow()]);

    const res = await patch(token, { links: { instagram: 'https://youtube.com/@chefsarah' } });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/not on Instagram/i);
    expect(fakeDb.row('creators', 'c1')?.instagram_url).toBeNull();
  });

  it('leaves the links it was not asked about alone', async () => {
    asUser();
    fakeDb.seed('creators', [creatorRow({ tiktok_url: 'https://tiktok.com/@chefsarah' })]);

    // A partial edit is not a clear-out: a request naming one link must not take
    // the other three with it.
    await patch(token, { links: { youtube: 'youtube.com/@chefsarah' } });

    const row = fakeDb.row('creators', 'c1');
    expect(row?.tiktok_url).toBe('https://tiktok.com/@chefsarah');
    expect(row?.website_url).toBe('https://chefsarah.test/');
  });

  it('rejects a key that is not one of the four sources', async () => {
    asUser();
    fakeDb.seed('creators', [creatorRow()]);

    const res = await patch(token, { links: { facebook: 'facebook.com/chefsarah' } });

    expect(res.status).toBe(400);
    expect(Object.keys(fakeDb.row('creators', 'c1') ?? {})).not.toContain('facebook');
  });

  describe('adding a link never turns polling on', () => {
    it('leaves primary_source and import_opt_in exactly as the operator set them', async () => {
      asUser();
      fakeDb.seed('creators', [creatorRow()]);

      await patch(token, { links: { youtube: 'youtube.com/@chefsarah', instagram: 'instagram.com/chefsarah' } });

      const row = fakeDb.row('creators', 'c1');
      expect(row?.primary_source).toBe('none');
      expect(row?.import_opt_in).toBe(false);
    });

    it('ignores polling fields smuggled into the same request', async () => {
      asUser();
      fakeDb.seed('creators', [creatorRow()]);

      await patch(token, {
        links: { youtube: 'youtube.com/@chefsarah' },
        primarySource: 'youtube',
        importOptIn: true,
        primary_source: 'youtube',
        import_opt_in: true,
      });

      // A creator saying "I have a channel" is not a creator opting into having
      // it polled. Only the admin route writes these.
      const row = fakeDb.row('creators', 'c1');
      expect(row?.primary_source).toBe('none');
      expect(row?.import_opt_in).toBe(false);
      expect(row?.youtube_url).toBe('https://youtube.com/@chefsarah');
    });
  });

  describe('clearing a link that is being polled', () => {
    it('refuses, with the reason, and leaves the row untouched', async () => {
      asUser();
      fakeDb.seed('creators', [
        creatorRow({ primary_source: 'website', import_opt_in: true, feed_url: 'https://chefsarah.test/feed' }),
      ]);

      const res = await patch(token, { links: { website: '' } });

      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/importing your recipes from your Website/i);
      // The state that must never exist: opted in, with nothing to poll.
      const row = fakeDb.row('creators', 'c1');
      expect(row?.website_url).toBe('https://chefsarah.test/');
      expect(row?.import_opt_in).toBe(true);
      expect(row?.primary_source).toBe('website');
    });

    it('refuses repointing it at somebody else’s channel', async () => {
      asUser();
      fakeDb.seed('creators', [
        creatorRow({
          youtube_url: 'https://youtube.com/@chefsarah',
          primary_source: 'youtube',
          import_opt_in: true,
        }),
      ]);

      // The one that matters. With no OAuth grant `channelIdForCreator` reads
      // the channel off this column, so replacing it substitutes a stranger's
      // uploads feed under this creator's name — and the host guards cannot see
      // it, because both links really are on youtube.com and the videos really
      // are from the channel the row now names. Moving a polled link is the
      // operator's, and a creator asks for it in the error below.
      const res = await patch(token, { links: { youtube: 'youtube.com/@somebodyelse' } });

      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/can't be changed or removed here/i);
      const row = fakeDb.row('creators', 'c1');
      expect(row?.youtube_url).toBe('https://youtube.com/@chefsarah');
      expect(row?.import_opt_in).toBe(true);
    });

    it('refuses moving it even when the new link is the creator’s own', async () => {
      asUser();
      fakeDb.seed('creators', [
        creatorRow({ primary_source: 'website', import_opt_in: true, feed_url: 'https://chefsarah.test/feed' }),
      ]);

      // A genuine blog move is refused too, and deliberately: `feed_url` is a
      // pairing an operator confirmed against the old host, and a creator who
      // could move the site out from under it would leave the poller reading a
      // feed nobody has looked at. The message tells them how to ask.
      const res = await patch(token, { links: { website: 'sarahcooks.test' } });

      expect(res.status).toBe(400);
      const row = fakeDb.row('creators', 'c1');
      expect(row?.website_url).toBe('https://chefsarah.test/');
      expect(row?.feed_url).toBe('https://chefsarah.test/feed');
    });

    it('lets the polled link be re-sent in a spelling that means the same place', async () => {
      asUser();
      // A row written before the links had a validator. The card reads it back,
      // sends it, and the normalised form differs from the stored string — the
      // same site, spelled the way we store links now.
      fakeDb.seed('creators', [
        creatorRow({ website_url: 'chefsarah.test', primary_source: 'website', import_opt_in: true, feed_url: 'https://chefsarah.test/feed' }),
      ]);

      const res = await patch(token, { links: { website: 'chefsarah.test', tiktok: 'tiktok.com/@chefsarah' } });

      // Otherwise a creator on such a row could never save any link at all: every
      // save would read as repointing the source at itself.
      expect(res.status).toBe(200);
      expect(fakeDb.row('creators', 'c1')?.tiktok_url).toBe('https://tiktok.com/@chefsarah');
    });

    it('allows changing a link nothing is polling', async () => {
      asUser();
      fakeDb.seed('creators', [
        creatorRow({
          youtube_url: 'https://youtube.com/@chefsarah',
          primary_source: 'website',
          import_opt_in: true,
          feed_url: 'https://chefsarah.test/feed',
        }),
      ]);

      // The refusal is about the polled link, not about editing. A renamed
      // YouTube channel on a creator whose website is the source is an ordinary
      // edit and must stay one.
      const res = await patch(token, { links: { youtube: 'youtube.com/@sarahcooks' } });

      expect(res.status).toBe(200);
      expect(fakeDb.row('creators', 'c1')?.youtube_url).toBe('https://youtube.com/@sarahcooks');
    });

    it('allows clearing a link nothing is polling', async () => {
      asUser();
      fakeDb.seed('creators', [
        creatorRow({ tiktok_url: 'https://tiktok.com/@chefsarah', primary_source: 'website', import_opt_in: true, feed_url: 'https://chefsarah.test/feed' }),
      ]);

      const res = await patch(token, { links: { tiktok: '' } });

      expect(res.status).toBe(200);
      expect(fakeDb.row('creators', 'c1')?.tiktok_url).toBeNull();
      expect(fakeDb.row('creators', 'c1')?.import_opt_in).toBe(true);
    });

    it('allows clearing the chosen source while import is off', async () => {
      asUser();
      fakeDb.seed('creators', [
        creatorRow({ youtube_url: 'https://youtube.com/@chefsarah', primary_source: 'youtube', import_opt_in: false }),
      ]);

      // Nothing is being polled, so nothing is broken by removing it. The
      // operator's choice of source stays on the row for them to revisit; the
      // admin route already refuses to switch import on against an empty link.
      const res = await patch(token, { links: { youtube: '' } });

      expect(res.status).toBe(200);
      expect(fakeDb.row('creators', 'c1')?.youtube_url).toBeNull();
      expect(fakeDb.row('creators', 'c1')?.import_opt_in).toBe(false);
    });
  });

  describe('a value that is not a link at all', () => {
    it.each([
      ['null', null],
      ['a number', 42],
      ['an object', {}],
      ['an array', []],
      ['a boolean', true],
    ])('refuses %s rather than reading it as "clear this link"', async (_label, value) => {
      asUser();
      fakeDb.seed('creators', [creatorRow({ youtube_url: 'https://youtube.com/@chefsarah' })]);

      // Silently folding a non-string to blank made a client bug destructive: a
      // form that sends `null` for a field nobody touched would delete the link
      // and be told 200.
      const res = await patch(token, { links: { youtube: value } });

      expect(res.status).toBe(400);
      expect(fakeDb.row('creators', 'c1')?.youtube_url).toBe('https://youtube.com/@chefsarah');
    });

    it('still clears on an empty string, which is the way to say it', async () => {
      asUser();
      fakeDb.seed('creators', [creatorRow({ youtube_url: 'https://youtube.com/@chefsarah' })]);

      expect((await patch(token, { links: { youtube: '' } })).status).toBe(200);
      expect(fakeDb.row('creators', 'c1')?.youtube_url).toBeNull();
    });
  });

  describe('a row an operator left in a state no screen can produce', () => {
    it('stops the polling rather than the creator’s edit', async () => {
      asUser();
      // Opted into polling a website whose feed was never confirmed. Nothing a
      // creator can send produces this; `checkPollingInvariants` is the backstop
      // that catches it, and it is reached only from rows like this one.
      fakeDb.seed('creators', [
        creatorRow({ primary_source: 'website', import_opt_in: true, feed_url: null }),
      ]);

      const res = await patch(token, { links: { tiktok: 'tiktok.com/@chefsarah' } });
      const body = await res.json();

      // The edit goes through — a creator adding an unrelated TikTok link did
      // not break this row and must not be held hostage by it, least of all by
      // an error telling them to confirm a feed URL on a screen they cannot open.
      expect(res.status).toBe(200);
      expect(fakeDb.row('creators', 'c1')?.tiktok_url).toBe('https://tiktok.com/@chefsarah');
      // And the incoherent polling is off, which is the only safe reading of a
      // row that says "poll this website" with nothing to poll.
      expect(fakeDb.row('creators', 'c1')?.import_opt_in).toBe(false);
      expect(body.notices.join(' ')).toMatch(/paused importing/i);
      expect(body.notices.join(' ')).not.toMatch(/feed URL/i);
    });

    it('never writes the switch the other way', async () => {
      asUser();
      fakeDb.seed('creators', [
        creatorRow({ youtube_url: 'https://youtube.com/@chefsarah', primary_source: 'youtube', import_opt_in: false }),
      ]);

      // The backstop may only ever turn import off. A coherent row that could be
      // polled is still not one anybody asked to poll.
      await patch(token, { links: { instagram: 'instagram.com/chefsarah' } });

      expect(fakeDb.row('creators', 'c1')?.import_opt_in).toBe(false);
    });
  });

  describe('a link whose platform is connected', () => {
    it('says what happens to the grant instead of silently orphaning it', async () => {
      asUser();
      fakeDb.seed('creators', [creatorRow({ youtube_url: 'https://youtube.com/@chefsarah' })]);
      fakeDb.seed('creator_platform_accounts', [{ id: 'pa1', creator_id: 'c1', platform: 'youtube' }]);

      const res = await patch(token, { links: { youtube: '' } });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.notices.join(' ')).toMatch(/still connected/i);
      // And it is still connected — removing a link is not a revocation, which
      // is precisely why it has to be said.
      expect(fakeDb.rows('creator_platform_accounts')).toHaveLength(1);
      expect(fakeDb.row('creators', 'c1')?.youtube_url).toBeNull();
    });

    it('says nothing when there is no grant to orphan', async () => {
      asUser();
      fakeDb.seed('creators', [creatorRow({ youtube_url: 'https://youtube.com/@chefsarah' })]);
      fakeDb.seed('creator_platform_accounts', []);

      const body = await (await patch(token, { links: { youtube: '' } })).json();

      expect(body.notices).toEqual([]);
    });
  });

  it('still saves the profile fields it always did', async () => {
    asUser();
    fakeDb.seed('creators', [creatorRow({ bio: null })]);

    await patch(token, { bio: 'I cook.', links: { youtube: 'youtube.com/@chefsarah' } });

    const row = fakeDb.row('creators', 'c1');
    expect(row?.bio).toBe('I cook.');
    expect(row?.youtube_url).toBe('https://youtube.com/@chefsarah');
  });
});
