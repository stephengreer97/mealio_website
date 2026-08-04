import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeDb } from '../helpers/supabase-mock';
import { jsonRequest } from '../helpers/request';

vi.mock('@/lib/supabase', async () =>
  (await import('../helpers/supabase-mock')).mockSupabaseModule());
vi.mock('@/lib/logger', () => ({ log: vi.fn() }));

type MovedAlert = Parameters<typeof import('@/lib/email')['sendCreatorSourceMovedEmail']>[0];
const sendCreatorSourceMovedEmail = vi.fn<(opts: MovedAlert) => Promise<void>>(async () => {});
vi.mock('@/lib/email', async () => {
  const actual = await vi.importActual<typeof import('@/lib/email')>('@/lib/email');
  return {
    // The recipient resolution is real — a signal addressed to nobody is not a
    // signal, and that is a property of this feature rather than of Resend.
    adminNotifyEmails: actual.adminNotifyEmails,
    sendCreatorSourceMovedEmail: (opts: MovedAlert) => sendCreatorSourceMovedEmail(opts),
  };
});

import { PATCH } from '@/app/api/creator/me/route';
import { PATCH as ADMIN_PATCH } from '@/app/api/admin/creators/route';
import { clearRevocationCache, createAccessToken } from '@/lib/tokens';

/**
 * A creator editing their own platform links (MEAL-94).
 *
 * Three properties this file exists for, and none of them is "the PATCH worked":
 *
 * 1. **Adding a link never starts polling.** `primary_source` and
 *    `import_opt_in` are an operator's decision (MEAL-81), so no request a
 *    creator can make may write either the other way.
 * 2. **Touching the link Mealio is polling stops the polling.** The edit is
 *    allowed — a creator who renames a channel or moves a blog has no other way
 *    to tell us — but `import_opt_in` goes off in the same write, so the
 *    substitution it would otherwise permit reaches nothing until an operator
 *    has looked. Removing that link takes the same path: it substitutes
 *    nothing, so refusing the lower-risk edit while allowing the higher-risk
 *    one was the rule pointing the wrong way.
 * 3. **The pause is never silent, and never only in an inbox.** The creator is
 *    told in the same response, an operator is emailed which creator, which
 *    link, from where to where, and the row itself keeps why and when. Without
 *    the first two, a creator's edit reverses an operator's decision with
 *    nobody told; without the third, the only record is an email somebody can
 *    delete.
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
    sendCreatorSourceMovedEmail.mockClear();
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
    it('leaves primary_source and import_opt_in alone', async () => {
      asUser();
      fakeDb.seed('creators', [creatorRow()]);

      await patch(token, { links: { youtube: 'youtube.com/@chefsarah', instagram: 'instagram.com/chefsarah' } });

      // Since MEAL-101 the creator *may* choose their source — in the box that
      // is about syncing, by name, in its own field. Saying "I have a channel"
      // is still not saying "read it", and a link edit must never be read as an
      // answer to a question nobody asked here.
      const row = fakeDb.row('creators', 'c1');
      expect(row?.primary_source).toBe('none');
      expect(row?.import_opt_in).toBe(false);
    });

    it('ignores the raw column names, and the opt-in on its own', async () => {
      asUser();
      fakeDb.seed('creators', [creatorRow()]);

      await patch(token, {
        links: { youtube: 'youtube.com/@chefsarah' },
        // Neither of these is a field this route has. `import_opt_in` is not
        // separately settable by a creator at all: consent to be read arrives
        // with the source choice or not at all, so an opt-in with no source
        // named is a request to poll nothing, which is not a state that exists.
        importOptIn: true,
        primary_source: 'youtube',
        import_opt_in: true,
      });

      const row = fakeDb.row('creators', 'c1');
      expect(row?.primary_source).toBe('none');
      expect(row?.import_opt_in).toBe(false);
      expect(row?.youtube_url).toBe('https://youtube.com/@chefsarah');
    });
  });

  describe('the link that is being polled', () => {
    it('lets it be removed, and stops polling in the same write', async () => {
      asUser();
      fakeDb.seed('creators', [
        creatorRow({ primary_source: 'website', import_opt_in: true, feed_url: 'https://chefsarah.test/feed' }),
      ]);

      // Refusing this while allowing a *move* had the rule pointing the wrong
      // way: a clear substitutes nothing, so it carries strictly less risk than
      // the replacement that was allowed, and it was the lower-risk edit that
      // was refused. One rule, one path — the edit lands and polling stops.
      const res = await patch(token, { links: { website: '' } });

      expect(res.status).toBe(200);
      const row = fakeDb.row('creators', 'c1');
      expect(row?.website_url).toBeNull();
      // The state that must never exist: opted in, with nothing to poll.
      expect(row?.import_opt_in).toBe(false);
      // Still the operator's choice of which source. They are the one who lifts
      // the pause, and the row has to say what they were polling.
      expect(row?.primary_source).toBe('website');
    });

    it('leaves a grant-backed source polling when an unrelated link is edited', async () => {
      asUser();
      // The state MEAL-101 made ordinary: YouTube is the source, and it is
      // connected by a grant rather than by `youtube_url`. Nothing here is
      // broken, so nothing about editing an unrelated link should stop it.
      fakeDb.seed('creators', [
        creatorRow({ primary_source: 'youtube', import_opt_in: true, youtube_url: null }),
      ]);
      fakeDb.seed('creator_platform_accounts', [{ creator_id: 'c1', platform: 'youtube' }]);

      const res = await patch(token, { links: { instagram: 'https://instagram.com/chefsarah' } });

      expect(res.status).toBe(200);
      const row = fakeDb.row('creators', 'c1');
      expect(row?.instagram_url).toBe('https://instagram.com/chefsarah');
      // The regression: read without the grants, the invariant sees a YouTube
      // source with no YouTube link, calls the row unpollable, and switches off
      // an import the creator never touched — then writes a pause reason
      // blaming them for it.
      expect(row?.import_opt_in).toBe(true);
      expect(row?.import_paused_reason ?? null).toBeNull();
    });

    it('tells the creator, and the operator, that a removal stopped the import', async () => {
      asUser();
      fakeDb.seed('user_profiles', [{ id: 'admin-1', email: 'admin@mealio.co', is_admin: true }]);
      fakeDb.seed('creators', [
        creatorRow({
          display_name: 'Chef Sarah',
          primary_source: 'website',
          import_opt_in: true,
          feed_url: 'https://chefsarah.test/feed',
        }),
      ]);

      const body = await (await patch(token, { links: { website: '' } })).json();

      // The same three things a move gets. A removal that only worked would be
      // a creator's edit reversing an operator's decision with nobody told,
      // which is what made refusing look like the safer answer in the first
      // place.
      expect(body.importPaused).toBe(true);
      expect(body.notices.join(' ')).toMatch(/removed/i);
      expect(sendCreatorSourceMovedEmail).toHaveBeenCalledTimes(1);
      // Blank, so the alert can say "removed" rather than leave an operator
      // reading an empty cell and guessing.
      expect(sendCreatorSourceMovedEmail.mock.calls[0][0]).toMatchObject({
        sourceLabel: 'Website',
        previousUrl: 'https://chefsarah.test/',
        newUrl: '',
      });
    });

    describe('the pause is recorded on the row, not only in an inbox', () => {
      it('writes why and when a moved link paused the import', async () => {
        asUser();
        fakeDb.seed('creators', [
          creatorRow({
            youtube_url: 'https://youtube.com/@chefsarah',
            primary_source: 'youtube',
            import_opt_in: true,
          }),
        ]);

        await patch(token, { links: { youtube: 'youtube.com/@sarahcooks' } });

        // The email is push-only: delete it and the pause exists nowhere but a
        // log line, and "why is this creator not being polled?" asked three
        // months later has no answer. This is the answer.
        const row = fakeDb.row('creators', 'c1');
        expect(row?.import_paused_reason).toMatch(/changed the YouTube link we poll/i);
        expect(row?.import_paused_reason).toContain('https://youtube.com/@chefsarah');
        expect(row?.import_paused_reason).toContain('https://youtube.com/@sarahcooks');
        expect(Date.parse(String(row?.import_paused_at))).toBeGreaterThan(0);
      });

      it('says a removed link was removed, rather than moved to nowhere', async () => {
        asUser();
        fakeDb.seed('creators', [
          creatorRow({ primary_source: 'website', import_opt_in: true, feed_url: 'https://chefsarah.test/feed' }),
        ]);

        await patch(token, { links: { website: '' } });

        // An operator deciding what to do next needs to know which of the two
        // happened: one is waiting for a link to be checked, the other for a
        // link to exist at all.
        expect(fakeDb.row('creators', 'c1')?.import_paused_reason).toMatch(/removed the Website link we poll/i);
      });

      it('writes nothing about a pause when no pause happened', async () => {
        asUser();
        fakeDb.seed('creators', [
          creatorRow({ primary_source: 'website', import_opt_in: true, feed_url: 'https://chefsarah.test/feed' }),
        ]);

        await patch(token, { links: { tiktok: 'tiktok.com/@chefsarah' } });

        // An ordinary edit must not stamp a reason onto a creator who is still
        // being polled — the Sources tab would then report a paused import
        // beside a running one.
        const row = fakeDb.row('creators', 'c1');
        expect(row?.import_paused_reason ?? null).toBeNull();
        expect(row?.import_paused_at ?? null).toBeNull();
        expect(row?.import_opt_in).toBe(true);
      });
    });

    it('lets it be repointed, and stops polling in the same write', async () => {
      asUser();
      fakeDb.seed('creators', [
        creatorRow({
          youtube_url: 'https://youtube.com/@chefsarah',
          primary_source: 'youtube',
          import_opt_in: true,
        }),
      ]);

      // The hostile version of the edit. With no OAuth grant
      // `channelIdForCreator` reads the channel off this column, so replacing it
      // substitutes a stranger's uploads under this creator's name — and no host
      // guard can see it, because both links really are on youtube.com and the
      // videos really are from the channel the row now names.
      //
      // Refusing it also blocked the creator who genuinely renamed their
      // channel, so the edit lands and the polling stops instead: nothing is
      // read from the new link until an operator turns import back on.
      const res = await patch(token, { links: { youtube: 'youtube.com/@somebodyelse' } });

      expect(res.status).toBe(200);
      const row = fakeDb.row('creators', 'c1');
      expect(row?.youtube_url).toBe('https://youtube.com/@somebodyelse');
      expect(row?.import_opt_in).toBe(false);
      // The operator's choice of *which* source is still theirs. The creator has
      // told us where they publish now, not what we should poll.
      expect(row?.primary_source).toBe('youtube');
    });

    it('tells the creator their import is paused, in the same response', async () => {
      asUser();
      fakeDb.seed('creators', [
        creatorRow({
          youtube_url: 'https://youtube.com/@chefsarah',
          primary_source: 'youtube',
          import_opt_in: true,
        }),
      ]);

      const body = await (await patch(token, { links: { youtube: 'youtube.com/@sarahcooks' } })).json();

      // Saved *and* paused. Letting them find out by noticing nothing arrives is
      // the failure this sentence exists to prevent.
      expect(body.notices.join(' ')).toMatch(/paused that import/i);
      expect(body.notices.join(' ')).toMatch(/saved/i);
      // And as a fact the card can act on, rather than prose it has to match.
      expect(body.importPaused).toBe(true);
    });

    it('raises an operator alert naming the creator, the link and the pause', async () => {
      asUser();
      fakeDb.seed('user_profiles', [{ id: 'admin-1', email: 'admin@mealio.co', is_admin: true }]);
      fakeDb.seed('creators', [
        creatorRow({
          display_name: 'Chef Sarah',
          youtube_url: 'https://youtube.com/@chefsarah',
          primary_source: 'youtube',
          import_opt_in: true,
        }),
      ]);

      await patch(token, { links: { youtube: 'youtube.com/@somebodyelse' } });

      // The half that makes clearing the opt-in acceptable at all. An operator's
      // decision has just been reversed by somebody else's request; they are
      // told which creator, which link, where it went, and that polling is off —
      // without reading a log, and without waiting for a creator to complain
      // that their imports stopped.
      expect(sendCreatorSourceMovedEmail).toHaveBeenCalledTimes(1);
      expect(sendCreatorSourceMovedEmail.mock.calls[0][0]).toMatchObject({
        adminEmails: ['admin@mealio.co'],
        creatorName: 'Chef Sarah',
        handle: 'chefsarah',
        sourceLabel: 'YouTube',
        previousUrl: 'https://youtube.com/@chefsarah',
        newUrl: 'https://youtube.com/@somebodyelse',
      });
    });

    it('raises nothing when no polled link moved', async () => {
      asUser();
      fakeDb.seed('user_profiles', [{ id: 'admin-1', email: 'admin@mealio.co', is_admin: true }]);
      fakeDb.seed('creators', [
        creatorRow({ primary_source: 'website', import_opt_in: true, feed_url: 'https://chefsarah.test/feed' }),
      ]);

      // An operator alert for every link a creator touches is an operator alert
      // nobody reads.
      await patch(token, { links: { tiktok: 'tiktok.com/@chefsarah' } });

      expect(sendCreatorSourceMovedEmail).not.toHaveBeenCalled();
    });

    it('still saves the link when the alert cannot be sent', async () => {
      asUser();
      fakeDb.seed('user_profiles', [{ id: 'admin-1', email: 'admin@mealio.co', is_admin: true }]);
      fakeDb.seed('creators', [
        creatorRow({
          youtube_url: 'https://youtube.com/@chefsarah',
          primary_source: 'youtube',
          import_opt_in: true,
        }),
      ]);
      sendCreatorSourceMovedEmail.mockRejectedValueOnce(new Error('Resend is down'));

      const res = await patch(token, { links: { youtube: 'youtube.com/@sarahcooks' } });

      // The write has already landed by the time the alert is attempted, and the
      // safe half of it — polling off — landed with it. Failing the request here
      // would tell a creator their save did not happen when it did.
      expect(res.status).toBe(200);
      expect(fakeDb.row('creators', 'c1')?.youtube_url).toBe('https://youtube.com/@sarahcooks');
      expect(fakeDb.row('creators', 'c1')?.import_opt_in).toBe(false);
    });

    it('lets a creator move their blog, and leaves the operator’s feed pairing to be re-confirmed', async () => {
      asUser();
      fakeDb.seed('creators', [
        creatorRow({ primary_source: 'website', import_opt_in: true, feed_url: 'https://chefsarah.test/feed' }),
      ]);

      // The case refusing cost most: a creator whose blog has moved, who had no
      // way at all to say so. `feed_url` is left exactly as the operator
      // confirmed it — it is the record of what they looked at, and the stale
      // pairing is precisely what stops import going back on by accident.
      const res = await patch(token, { links: { website: 'sarahcooks.test' } });

      expect(res.status).toBe(200);
      const row = fakeDb.row('creators', 'c1');
      expect(row?.website_url).toBe('https://sarahcooks.test/');
      expect(row?.feed_url).toBe('https://chefsarah.test/feed');
      expect(row?.import_opt_in).toBe(false);
    });

    it('leaves the operator with an invariant they still have to satisfy', async () => {
      asUser();
      fakeDb.seed('user_profiles', [{ id: 'admin-1', email: 'admin@mealio.co', is_admin: true }]);
      fakeDb.seed('creators', [
        creatorRow({ primary_source: 'website', import_opt_in: true, feed_url: 'https://chefsarah.test/feed' }),
      ]);

      await patch(token, { links: { website: 'sarahcooks.test' } });

      // Turning it back on is the operator's, and it is not a rubber stamp: the
      // feed they confirmed is on the old host, so `checkPollingInvariants`
      // refuses until they look at the new site. Pausing has to leave the row in
      // a state the admin route judges, not one it waves through.
      clearRevocationCache();
      fakeDb.queue('user_profiles', { data: { tokens_invalidated_at: null } });
      fakeDb.queue('user_profiles', { data: { is_admin: true } });
      const adminToken = await createAccessToken('admin-1', 'admin@mealio.co');
      const res = await ADMIN_PATCH(
        jsonRequest('/api/admin/creators', { method: 'PATCH', token: adminToken, body: { id: 'c1', importOptIn: true } }),
      );

      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/not on the creator's own site/i);
      expect(fakeDb.row('creators', 'c1')?.import_opt_in).toBe(false);
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

      // Otherwise a creator on such a row would pause their own import every
      // time they saved anything: every save would read as repointing the source
      // at itself.
      expect(res.status).toBe(200);
      expect(fakeDb.row('creators', 'c1')?.tiktok_url).toBe('https://tiktok.com/@chefsarah');
      expect(fakeDb.row('creators', 'c1')?.import_opt_in).toBe(true);
      expect(sendCreatorSourceMovedEmail).not.toHaveBeenCalled();
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
