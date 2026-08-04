import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeDb } from '../helpers/supabase-mock';
import { jsonRequest } from '../helpers/request';

vi.mock('@/lib/supabase', async () =>
  (await import('../helpers/supabase-mock')).mockSupabaseModule());
vi.mock('@/lib/logger', () => ({ log: vi.fn() }));

/**
 * The viability check is the one thing in this flow that reaches the network and
 * a model. Stubbed at the module boundary so the *route's* decisions — what it
 * writes, what it refuses, and what sentence it hands back — are what is under
 * test, rather than a blog somebody has to keep online.
 */
const runViabilityCheck = vi.fn();
vi.mock('@/lib/import/viability', () => ({
  runViabilityCheck: (...args: unknown[]) => runViabilityCheck(...args),
}));

import { PATCH } from '@/app/api/creator/me/route';
import { PATCH as ADMIN_PATCH } from '@/app/api/admin/creators/route';
import { POST as SAVE_WEBSITE } from '@/app/api/creator/website/route';
import { POST as START_SYNC } from '@/app/api/creator/sync/route';
import { clearRevocationCache, createAccessToken } from '@/lib/tokens';
import { CREATOR_SELECTION_MAX } from '@/lib/creator-sources';

/**
 * The creator choosing what Mealio syncs from (MEAL-101).
 *
 * `primary_source` and `import_opt_in` were an operator decision (MEAL-81) and
 * this route refused to write either — *"nothing here writes `primary_source`"*.
 * Both are the creator's now on this path, and these are the four properties
 * that has to keep:
 *
 *  1. **It takes effect.** A creator picks a source they have connected and
 *     polling starts, with nobody in the loop. That is the whole ticket.
 *  2. **They cannot name a source they have not connected.** A link says where
 *     somebody publishes; it says nothing about what we can read. YouTube needs
 *     a grant, a website needs a feed found on that same host.
 *  3. **They cannot name a source no creator can use.** The dropdown disables
 *     Instagram and TikTok. A request is not a dropdown.
 *  4. **The admin control still works.** It stopped being the only way in; it
 *     did not go away, and a creator writing these columns must not have quietly
 *     broken the route an operator uses to fix a row.
 */

/** Queues the `user_profiles` read `verifyAccessToken` makes (memoised for 30s). */
function asUser() {
  clearRevocationCache();
  fakeDb.queue('user_profiles', { data: { tokens_invalidated_at: null } });
}

function creatorRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'c1',
    user_id: 'u1',
    display_name: 'Chef Sarah',
    handle: 'chefsarah',
    website_url: null,
    youtube_url: null,
    instagram_url: null,
    tiktok_url: null,
    primary_source: 'none',
    import_opt_in: false,
    feed_url: null,
    import_paused_reason: null,
    import_paused_at: null,
    ...overrides,
  };
}

/** A creator whose website has been read and found importable. */
const READY_WEBSITE = {
  website_url: 'https://chefsarah.test/',
  feed_url: 'https://chefsarah.test/feed',
};

let token: string;

function patch(body: Record<string, unknown>) {
  return PATCH(jsonRequest('/api/creator/me', { method: 'PATCH', token, body }));
}

beforeEach(async () => {
  fakeDb.reset();
  runViabilityCheck.mockReset();
  token = await createAccessToken('u1', 'sarah@chefsarah.test');
});

// ── The creator's own choice ─────────────────────────────────────────────────

describe('PATCH /api/creator/me — the creator chooses their source', () => {
  it('sets a website they have had checked, and starts polling with it', async () => {
    asUser();
    fakeDb.seed('creators', [creatorRow(READY_WEBSITE)]);

    const res = await patch({ primarySource: 'website' });

    expect(res.status).toBe(200);
    const row = fakeDb.row('creators', 'c1');
    // Both switches, together. The poller's query requires both
    // (`import_opt_in = true AND primary_source <> 'none'`), so writing one
    // without the other is a creator who chose a source and is never read.
    expect(row?.primary_source).toBe('website');
    expect(row?.import_opt_in).toBe(true);
  });

  it('sets YouTube once the channel is actually connected', async () => {
    asUser();
    fakeDb.seed('creators', [creatorRow()]);
    fakeDb.seed('creator_platform_accounts', [{ id: 'pa1', creator_id: 'c1', platform: 'youtube' }]);

    // No `youtube_url` on the row at all. The grant is what makes a channel
    // readable — `channelIdForCreator` takes the id off it and never off a link
    // — so insisting on a link would refuse exactly the creator who connected
    // properly.
    const res = await patch({ primarySource: 'youtube' });

    expect(res.status).toBe(200);
    expect(fakeDb.row('creators', 'c1')?.primary_source).toBe('youtube');
    expect(fakeDb.row('creators', 'c1')?.import_opt_in).toBe(true);
  });

  it('reports where the row stands, so the screen does not have to guess', async () => {
    asUser();
    fakeDb.seed('creators', [creatorRow(READY_WEBSITE)]);

    const body = await (await patch({ primarySource: 'website' })).json();

    // The section renders "Mealio is watching your Website" off these two. A
    // screen that re-derived them from the request it just sent would show the
    // wrong thing the moment the server disagreed — which is what the refusals
    // below exist to do.
    expect(body.source).toEqual({ primarySource: 'website', importOptIn: true });
  });

  it('lets a creator stop being read at all', async () => {
    asUser();
    fakeDb.seed('creators', [creatorRow({ ...READY_WEBSITE, primary_source: 'website', import_opt_in: true })]);

    // Consent that can only be given is not consent. `none` is always available,
    // whatever state the row is in.
    const res = await patch({ primarySource: 'none' });

    expect(res.status).toBe(200);
    expect(fakeDb.row('creators', 'c1')?.primary_source).toBe('none');
    expect(fakeDb.row('creators', 'c1')?.import_opt_in).toBe(false);
  });

  it('clears the pause it has just answered', async () => {
    asUser();
    fakeDb.seed('creators', [
      creatorRow({
        ...READY_WEBSITE,
        primary_source: 'website',
        import_opt_in: false,
        import_paused_reason: 'The creator changed the Website link we poll.',
        import_paused_at: '2026-08-01T00:00:00.000Z',
      }),
    ]);

    await patch({ primarySource: 'website' });

    // Left behind, the Sources tab reports a paused import beside a creator
    // that is being polled, and the next operator has to work out which of the
    // two to believe.
    const row = fakeDb.row('creators', 'c1');
    expect(row?.import_opt_in).toBe(true);
    expect(row?.import_paused_reason).toBeNull();
    expect(row?.import_paused_at).toBeNull();
  });
});

describe('a source the creator has not connected', () => {
  it('refuses YouTube with no grant, and writes nothing', async () => {
    asUser();
    fakeDb.seed('creators', [creatorRow({ youtube_url: 'https://youtube.com/@chefsarah' })]);
    fakeDb.seed('creator_platform_accounts', []);

    // A link is a creator telling us where they publish. It is not a channel we
    // can read: without a grant `playlistItems.list` and `videos.list` both
    // refuse us, so this row would be polled forever and find nothing.
    const res = await patch({ primarySource: 'youtube' });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/connect your youtube account first/i);
    const row = fakeDb.row('creators', 'c1');
    expect(row?.primary_source).toBe('none');
    expect(row?.import_opt_in).toBe(false);
  });

  it('refuses a website whose feed has never been found', async () => {
    asUser();
    fakeDb.seed('creators', [creatorRow({ website_url: 'https://chefsarah.test/', feed_url: null })]);

    // The link alone is not enough: `feed_url` is what the poller actually
    // reads, and it only exists once the viability check has read real posts
    // through it.
    const res = await patch({ primarySource: 'website' });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/save your website below first/i);
    expect(fakeDb.row('creators', 'c1')?.import_opt_in).toBe(false);
  });

  it('refuses a website whose feed is on a host they have since left', async () => {
    asUser();
    fakeDb.seed('creators', [
      creatorRow({ website_url: 'https://sarahcooks.test/', feed_url: 'https://chefsarah.test/feed' }),
    ]);

    // Both columns are populated, so "both present" would call this ready and
    // start polling a feed on a host that is no longer theirs — importing
    // somebody else's posts under this creator's name.
    const res = await patch({ primarySource: 'website' });

    expect(res.status).toBe(400);
    expect(fakeDb.row('creators', 'c1')?.import_opt_in).toBe(false);
  });
});

describe('a source no creator can use yet', () => {
  it('refuses Instagram with the reason the dropdown shows', async () => {
    asUser();
    fakeDb.seed('creators', [creatorRow({ instagram_url: 'https://instagram.com/chefsarah' })]);
    // Even with a grant. The dropdown disables Instagram because Meta has not
    // approved the app, not because nobody connected it — a request is not a
    // dropdown, so the server says the same thing.
    fakeDb.seed('creator_platform_accounts', [{ id: 'pa1', creator_id: 'c1', platform: 'instagram' }]);

    const res = await patch({ primarySource: 'instagram' });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/meta/i);
    expect(fakeDb.row('creators', 'c1')?.primary_source).toBe('none');
  });

  it('accepts TikTok now that its credentials exist', async () => {
    asUser();
    fakeDb.seed('creators', [creatorRow()]);
    fakeDb.seed('creator_platform_accounts', [{ id: 'pa1', creator_id: 'c1', platform: 'tiktok' }]);

    // TikTok was refused alongside Instagram until `TIKTOK_CLIENT_KEY` was set.
    // The integration was finished the whole time — the connect and callback
    // routes, the refresh sweep, the source documents — so nothing about this
    // path is new; what changed is that the app has credentials.
    const res = await patch({ primarySource: 'tiktok' });

    expect(res.status).toBe(200);
    expect(fakeDb.row('creators', 'c1')?.primary_source).toBe('tiktok');
    expect(fakeDb.row('creators', 'c1')?.import_opt_in).toBe(true);
  });

  it('still refuses TikTok with no grant, link or not', async () => {
    asUser();
    fakeDb.seed('creators', [creatorRow({ tiktok_url: 'https://tiktok.com/@chefsarah' })]);
    fakeDb.seed('creator_platform_accounts', []);

    // TikTok's Display API shows us nothing without a grant, so a link is a
    // creator telling us where they are and not something we can read.
    const res = await patch({ primarySource: 'tiktok' });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/connect your tiktok account first/i);
    expect(fakeDb.row('creators', 'c1')?.import_opt_in).toBe(false);
  });

  it('refuses a value the column would not accept either', async () => {
    asUser();
    fakeDb.seed('creators', [creatorRow(READY_WEBSITE)]);

    // Validated against `PRIMARY_SOURCES`, which is the CHECK constraint's own
    // value set — so this cannot drift into accepting something the database
    // then rejects at 3am.
    const res = await patch({ primarySource: 'facebook' });

    expect(res.status).toBe(400);
    expect(fakeDb.row('creators', 'c1')?.primary_source).toBe('none');
  });

  it('does not save the links in the same request either', async () => {
    asUser();
    fakeDb.seed('creators', [creatorRow()]);

    const res = await patch({ links: { instagram: 'instagram.com/chefsarah' }, primarySource: 'instagram' });

    // One request, one outcome. A half-applied write that saved the link and
    // refused the source would leave the creator reading a refusal beside a
    // field that had changed.
    expect(res.status).toBe(400);
    expect(fakeDb.row('creators', 'c1')?.instagram_url).toBeNull();
  });
});

// ── The admin control did not go away ────────────────────────────────────────

describe('the operator can still set a source', () => {
  it('writes the same two columns through the same invariants', async () => {
    fakeDb.seed('creators', [creatorRow(READY_WEBSITE)]);
    fakeDb.seed('user_profiles', [{ id: 'admin-1', email: 'admin@mealio.co', is_admin: true }]);
    clearRevocationCache();
    fakeDb.queue('user_profiles', { data: { tokens_invalidated_at: null } });
    fakeDb.queue('user_profiles', { data: { is_admin: true } });
    const adminToken = await createAccessToken('admin-1', 'admin@mealio.co');

    const res = await ADMIN_PATCH(
      jsonRequest('/api/admin/creators', {
        method: 'PATCH',
        token: adminToken,
        body: { id: 'c1', primarySource: 'website', importOptIn: true },
      }),
    );

    // MEAL-101 took away the admin route's monopoly, not the admin route. An
    // operator repairing a row a creator cannot reach — an Instagram source, a
    // feed the creator's own screen refuses — is still how that gets fixed.
    expect(res.status).toBe(200);
    expect(fakeDb.row('creators', 'c1')?.primary_source).toBe('website');
    expect(fakeDb.row('creators', 'c1')?.import_opt_in).toBe(true);
  });

  it('can still set a source the creator’s own screen refuses', async () => {
    fakeDb.seed('creators', [creatorRow({ instagram_url: 'https://instagram.com/chefsarah' })]);
    fakeDb.seed('user_profiles', [{ id: 'admin-1', email: 'admin@mealio.co', is_admin: true }]);
    clearRevocationCache();
    fakeDb.queue('user_profiles', { data: { tokens_invalidated_at: null } });
    fakeDb.queue('user_profiles', { data: { is_admin: true } });
    const adminToken = await createAccessToken('admin-1', 'admin@mealio.co');

    const res = await ADMIN_PATCH(
      jsonRequest('/api/admin/creators', {
        method: 'PATCH',
        token: adminToken,
        body: { id: 'c1', primarySource: 'instagram' },
      }),
    );

    // The two rules are not the same rule and must not be merged. "No creator
    // can pick this yet" is about what a creator is offered; an operator
    // pointing a row at Instagram ahead of Meta's approval is a decision they
    // are allowed to make and the poller will simply find nothing until it is.
    expect(res.status).toBe(200);
    expect(fakeDb.row('creators', 'c1')?.primary_source).toBe('instagram');
  });
});

// ── Website Save runs the real check ─────────────────────────────────────────

function report(overrides: Record<string, unknown> = {}) {
  return {
    source: 'website',
    outcome: 'viable',
    summary: 'operator prose',
    checked: 10,
    passed: 8,
    items: [],
    feed: { url: 'https://chefsarah.test/feed', kind: 'rss', via: 'link', entries: [] },
    unsupported: null,
    reason: null,
    costUsd: 0.02,
    ...overrides,
  };
}

function saveWebsite(url: unknown) {
  return SAVE_WEBSITE(jsonRequest('/api/creator/website', { token, body: { url } }));
}

describe('POST /api/creator/website — Save runs the viability check', () => {
  it('stores the site, the feed it read and the source, in one press', async () => {
    asUser();
    fakeDb.seed('creators', [creatorRow()]);
    runViabilityCheck.mockResolvedValue(report());

    const res = await saveWebsite('chefsarah.test');
    const body = await res.json();

    expect(body.ok).toBe(true);
    // The check is what confirms the feed. An operator used to do that by
    // squinting at a URL; having read ten posts through it is a stronger
    // confirmation than a human eye on a hostname.
    const row = fakeDb.row('creators', 'c1');
    expect(row?.website_url).toBe('https://chefsarah.test/');
    expect(row?.feed_url).toBe('https://chefsarah.test/feed');
    expect(row?.primary_source).toBe('website');
    expect(row?.import_opt_in).toBe(true);
  });

  it('runs the full check rather than a reachability ping', async () => {
    asUser();
    fakeDb.seed('creators', [creatorRow()]);
    runViabilityCheck.mockResolvedValue(report());

    await saveWebsite('chefsarah.test');

    // The same function the admin already uses, on the normalised link, with
    // discovery run fresh — any `feed_url` on the row was found for whatever
    // site was there before.
    expect(runViabilityCheck).toHaveBeenCalledWith('website', 'https://chefsarah.test/', { feedUrl: null });
  });

  it('says what happens next, including that the back catalogue is not automatic', async () => {
    asUser();
    fakeDb.seed('creators', [creatorRow()]);
    runViabilityCheck.mockResolvedValue(report());

    const body = await (await saveWebsite('chefsarah.test')).json();

    // The promise, at the moment it becomes true.
    expect(body.detail).toMatch(/new posts sync automatically/i);
    expect(body.detail).toMatch(/drafts for you to review/i);
    // And the baseline, which is why the checklist below it exists. Without
    // this a creator watches nothing arrive and concludes it did not work.
    expect(body.detail).toMatch(/nothing you have already published is imported automatically/i);
  });

  it('takes a blog that only sometimes posts recipes', async () => {
    asUser();
    fakeDb.seed('creators', [creatorRow()]);
    runViabilityCheck.mockResolvedValue(report({ outcome: 'partial', passed: 3, checked: 10 }));

    const body = await (await saveWebsite('chefsarah.test')).json();

    // `partial` works, it just syncs less often. Refusing it would be Mealio
    // deciding a creator publishes the wrong things.
    expect(body.ok).toBe(true);
    expect(fakeDb.row('creators', 'c1')?.import_opt_in).toBe(true);
    expect(body.detail).toMatch(/the rest we will leave alone/i);
  });

  describe('a site that cannot be imported from says why, in the creator’s terms', () => {
    it.each([
      ['no-feed', 'unavailable', /could not find a feed/i],
      ['blocked-by-robots', 'unavailable', /robots\.txt/i],
      ['blocked-by-site', 'unavailable', /refused to let Mealio read it/i],
      ['unreachable', 'unavailable', /could not reach/i],
      ['no-entries', 'unavailable', /could not read any posts out of it/i],
      ['classifier-unavailable', 'unavailable', /try again in a few minutes/i],
    ])('reports %s as something they can act on', async (reason, outcome, expected) => {
      asUser();
      fakeDb.seed('creators', [creatorRow()]);
      runViabilityCheck.mockResolvedValue(
        report({ outcome, reason, feed: null, checked: 0, passed: 0, summary: 'Website could not be checked: 404.' }),
      );

      const body = await (await saveWebsite('chefsarah.test')).json();

      expect(body.ok).toBe(false);
      expect(body.error).toMatch(expected);
      // Never a status code, and never the operator's paragraph — that one
      // names screens a creator cannot open and codes they cannot act on.
      expect(body.error).not.toMatch(/\b40\d\b|\b50\d\b/);
      expect(body.error).not.toBe('Website could not be checked: 404.');
    });

    it('says plainly when the posts are simply not recipes', async () => {
      asUser();
      fakeDb.seed('creators', [creatorRow()]);
      runViabilityCheck.mockResolvedValue(report({ outcome: 'not-viable', passed: 0, checked: 10 }));

      const body = await (await saveWebsite('chefsarah.test')).json();

      expect(body.ok).toBe(false);
      expect(body.error).toMatch(/none of them looked like a recipe/i);
    });

    it('writes nothing at all when the check fails', async () => {
      asUser();
      fakeDb.seed('creators', [creatorRow()]);
      runViabilityCheck.mockResolvedValue(report({ outcome: 'not-viable', passed: 0, checked: 10, feed: null }));

      await saveWebsite('chefsarah.test');

      // A failed check must not leave a half-set row behind: a `website_url`
      // with no feed is exactly the state the dropdown then refuses, and the
      // creator would be looking at a saved-looking box that does nothing.
      const row = fakeDb.row('creators', 'c1');
      expect(row?.website_url).toBeNull();
      expect(row?.feed_url).toBeNull();
      expect(row?.primary_source).toBe('none');
    });

    it('catches a social link in the website box before spending anything', async () => {
      asUser();
      fakeDb.seed('creators', [creatorRow()]);

      const res = await saveWebsite('https://instagram.com/chefsarah');

      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/put it in the Instagram box|is a link to Instagram/i);
      expect(runViabilityCheck).not.toHaveBeenCalled();
    });
  });
});

// ── The cap on a back-catalogue run ──────────────────────────────────────────

describe('POST /api/creator/sync — the 100 cap', () => {
  function entries(count: number) {
    return Array.from({ length: count }, (_, i) => ({
      itemId: `chefsarah.test/post-${i}`,
      url: `https://chefsarah.test/post-${i}`,
      title: `Post ${i}`,
      publishedAt: '2026-01-01T00:00:00.000Z',
    }));
  }

  function startSync(items: unknown) {
    return START_SYNC(jsonRequest('/api/creator/sync', { token, body: { source: 'website', items } }));
  }

  it('takes exactly the cap', async () => {
    asUser();
    fakeDb.seed('creators', [creatorRow(READY_WEBSITE)]);
    fakeDb.seed('creator_sync_runs', []);

    const res = await startSync(entries(CREATOR_SELECTION_MAX));

    expect(res.status).toBe(201);
    expect(fakeDb.rows('creator_sync_runs')[0].items).toHaveLength(CREATOR_SELECTION_MAX);
  });

  it('refuses one more than the cap, and starts nothing', async () => {
    asUser();
    fakeDb.seed('creators', [creatorRow(READY_WEBSITE)]);
    fakeDb.seed('creator_sync_runs', []);

    const res = await startSync(entries(CREATOR_SELECTION_MAX + 1));

    // Enforced here rather than only counted on screen. The number beside the
    // checkboxes is a courtesy; this is the limit, and every ticked item is a
    // real extraction spending real money.
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(new RegExp(`at most ${CREATOR_SELECTION_MAX}`, 'i'));
    expect(fakeDb.rows('creator_sync_runs')).toHaveLength(0);
  });

  it('refuses a post that is not on the creator’s own site', async () => {
    asUser();
    fakeDb.seed('creators', [creatorRow(READY_WEBSITE)]);
    fakeDb.seed('creator_sync_runs', []);

    const res = await startSync([
      { itemId: 'a', url: 'https://chefsarah.test/one' },
      { itemId: 'b', url: 'https://somebodyelse.test/two' },
    ]);

    // The client got these rows from their own feed, so a cross-host entry is a
    // hand-edited request — and the whole selection is refused rather than the
    // one row dropped, because a partial answer to "import these" is worse than
    // a refusal.
    expect(res.status).toBe(400);
    expect(fakeDb.rows('creator_sync_runs')).toHaveLength(0);
  });

  it('lands the run against the caller’s own creator row', async () => {
    asUser();
    fakeDb.seed('creators', [creatorRow(READY_WEBSITE), { ...creatorRow(), id: 'c2', user_id: 'u2' }]);
    fakeDb.seed('creator_sync_runs', []);

    await startSync(entries(2));

    // There is no `creatorId` in the body to get wrong: it is resolved from the
    // token, so a creator cannot spend money against somebody else's catalogue.
    expect(fakeDb.rows('creator_sync_runs')[0].creator_id).toBe('c1');
    expect(fakeDb.rows('creator_sync_runs')[0].requested_by).toBe('u1');
  });

  it('refuses a source no creator can use yet', async () => {
    asUser();
    fakeDb.seed('creators', [creatorRow({ instagram_url: 'https://instagram.com/chefsarah' })]);
    fakeDb.seed('creator_sync_runs', []);

    const res = await START_SYNC(
      jsonRequest('/api/creator/sync', {
        token,
        body: { source: 'instagram', items: [{ itemId: 'x', url: 'https://instagram.com/p/x' }] },
      }),
    );

    expect(res.status).toBe(400);
    expect(fakeDb.rows('creator_sync_runs')).toHaveLength(0);
  });

  it('imports a TikTok back catalogue on the grant alone', async () => {
    asUser();
    // No `tiktok_url` on the row: the account comes from the OAuth grant, and
    // `buildSelectionItems` exempts the connected platforms from the link
    // requirement for exactly that reason.
    fakeDb.seed('creators', [creatorRow()]);
    fakeDb.seed('creator_sync_runs', []);

    const res = await START_SYNC(
      jsonRequest('/api/creator/sync', {
        token,
        body: {
          source: 'tiktok',
          items: [{ itemId: 'v1', url: 'https://www.tiktok.com/@chefsarah/video/1' }],
        },
      }),
    );

    expect(res.status).toBe(201);
    expect(fakeDb.rows('creator_sync_runs')[0].source).toBe('tiktok');
  });

  it('refuses a TikTok row whose URL is on somebody else’s host', async () => {
    asUser();
    fakeDb.seed('creators', [creatorRow()]);
    fakeDb.seed('creator_sync_runs', []);

    // A permalink carries a shortcode rather than the media id, so the id and
    // the URL cannot be checked against each other — what can be insisted on is
    // that the row claiming to be a TikTok video is on TikTok.
    const res = await START_SYNC(
      jsonRequest('/api/creator/sync', {
        token,
        body: { source: 'tiktok', items: [{ itemId: 'v1', url: 'https://notatiktok.test/video/1' }] },
      }),
    );

    expect(res.status).toBe(400);
    expect(fakeDb.rows('creator_sync_runs')).toHaveLength(0);
  });
});
