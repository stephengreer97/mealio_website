import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeDb } from '../helpers/supabase-mock';
import { jsonRequest } from '../helpers/request';

vi.mock('@/lib/supabase', async () =>
  (await import('../helpers/supabase-mock')).mockSupabaseModule());
vi.mock('@/lib/logger', () => ({ log: vi.fn() }));
vi.mock('next/cache', () => ({ revalidateTag: vi.fn() }));

const buildCatalog = vi.fn();
const advanceRun = vi.fn();
vi.mock('@/lib/admin-sync', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/admin-sync')>()),
  buildCatalog: (...args: unknown[]) => buildCatalog(...args),
  advanceRun: (...args: unknown[]) => advanceRun(...args),
}));

import { POST as CATALOG } from '@/app/api/admin/sync/catalog/route';
import { GET, PATCH, POST } from '@/app/api/admin/sync/route';
import { POST as WORKER } from '@/app/api/admin/sync/worker/route';
import { clearRevocationCache, createAccessToken } from '@/lib/tokens';

/**
 * The HTTP surface of admin sync (MEAL-90). Every endpoint here makes our server
 * fetch URLs and publish under a creator's name, so the admin guard is tested on
 * each one — and tested to stop the work happening, not merely to return 403.
 */

const CREATOR = {
  id: 'c1',
  user_id: 'u1',
  display_name: 'Chef Sarah',
  website_url: 'https://chefsarah.test/',
  youtube_url: null,
  instagram_url: null,
  tiktok_url: null,
  feed_url: 'https://chefsarah.test/feed',
};

function asAdmin(isAdmin = true) {
  clearRevocationCache();
  fakeDb.queue('user_profiles', { data: { tokens_invalidated_at: null } });
  fakeDb.queue('user_profiles', { data: { is_admin: isAdmin } });
}

/** The row an insert hands back. */
function insertedRun(items: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    id: 'r1', creator_id: 'c1', source: 'website', mode: 'catalog', status: 'queued',
    items, created_at: '2026-08-02T10:00:00.000Z', ...overrides,
  };
}

let token: string;

beforeEach(async () => {
  fakeDb.reset();
  buildCatalog.mockReset();
  advanceRun.mockReset();
  token = await createAccessToken('admin-1', 'admin@mealio.co');
});

describe('/api/admin/sync/catalog', () => {
  it('403 for a non-admin, and no feed is read', async () => {
    asAdmin(false);
    const res = await CATALOG(jsonRequest('/api/admin/sync/catalog', { token, body: { creatorId: 'c1', source: 'website' } }));
    expect(res.status).toBe(403);
    expect(buildCatalog).not.toHaveBeenCalled();
  });

  it('400 for a source outside the four', async () => {
    asAdmin();
    const res = await CATALOG(jsonRequest('/api/admin/sync/catalog', { token, body: { creatorId: 'c1', source: 'substack' } }));
    expect(res.status).toBe(400);
    expect(buildCatalog).not.toHaveBeenCalled();
  });

  it('404 for a creator that does not exist', async () => {
    asAdmin();
    const res = await CATALOG(jsonRequest('/api/admin/sync/catalog', { token, body: { creatorId: 'nope', source: 'website' } }));
    expect(res.status).toBe(404);
  });

  it('enumerates from the creator’s stored links, never from the request body', async () => {
    asAdmin();
    fakeDb.queue('creators', { data: CREATOR });
    buildCatalog.mockResolvedValue({ ok: true, source: 'website', feed: null, entries: [], truncated: false });

    const res = await CATALOG(jsonRequest('/api/admin/sync/catalog', {
      token,
      body: { creatorId: 'c1', source: 'website', websiteUrl: 'https://attacker.test/' },
    }));

    expect(res.status).toBe(200);
    expect(buildCatalog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: 'c1' }),
      'website',
      { pageToken: null },
    );
  });

  it('carries a page cursor through, so the second window of a back catalogue is reachable', async () => {
    asAdmin();
    fakeDb.queue('creators', { data: CREATOR });
    buildCatalog.mockResolvedValue({ ok: true, source: 'youtube', feed: null, entries: [], truncated: false });

    const res = await CATALOG(jsonRequest('/api/admin/sync/catalog', {
      token,
      body: { creatorId: 'c1', source: 'youtube', pageToken: 'CDIQAA' },
    }));

    expect(res.status).toBe(200);
    expect(buildCatalog).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'youtube', { pageToken: 'CDIQAA' });
  });

  it('refuses a page cursor that is not one YouTube issued, before anything is listed', async () => {
    asAdmin();
    fakeDb.queue('creators', { data: CREATOR });

    const res = await CATALOG(jsonRequest('/api/admin/sync/catalog', {
      token,
      body: { creatorId: 'c1', source: 'youtube', pageToken: 'https://evil.test/ ?x' },
    }));

    // The cursor cannot point the listing at another channel — the playlist is
    // resolved from the grant — but an unbounded string from a request body
    // still does not get interpolated into an outbound URL.
    expect(res.status).toBe(400);
    expect(buildCatalog).not.toHaveBeenCalled();
  });

  it('422 when the source cannot be listed, carrying the explanation', async () => {
    asAdmin();
    fakeDb.queue('creators', { data: CREATOR });
    buildCatalog.mockResolvedValue({ ok: false, reason: 'not-connected', detail: 'YouTube needs MEAL-74.' });

    const res = await CATALOG(jsonRequest('/api/admin/sync/catalog', { token, body: { creatorId: 'c1', source: 'youtube' } }));
    expect(res.status).toBe(422);
    expect((await res.json()).catalog.detail).toMatch(/MEAL-74/);
  });
});

describe('POST /api/admin/sync', () => {
  it('403 for a non-admin, and no run is created', async () => {
    asAdmin(false);
    const res = await POST(jsonRequest('/api/admin/sync', { token, body: { creatorId: 'c1', mode: 'link', url: 'https://x.test/a' } }));
    expect(res.status).toBe(403);
    expect(fakeDb.calls.some((c) => c.method === 'insert')).toBe(false);
  });

  it('creates a one-item run from a pasted link, with the source derived from it', async () => {
    asAdmin();
    fakeDb.queue('creators', { data: CREATOR });
    fakeDb.queue('creator_sync_runs', { data: insertedRun([]) });

    const res = await POST(jsonRequest('/api/admin/sync', {
      token,
      body: { creatorId: 'c1', mode: 'link', url: 'chefsarah.test/guacamole' },
    }));

    expect(res.status).toBe(201);
    const insert = fakeDb.calls.find((c) => c.table === 'creator_sync_runs' && c.method === 'insert');
    expect(insert?.args[0]).toMatchObject({ mode: 'link', source: 'website', requested_by: 'admin-1' });
    expect(insert?.args[0].items).toHaveLength(1);
    expect(insert?.args[0].items[0]).toMatchObject({ url: 'https://chefsarah.test/guacamole', status: 'pending' });
  });

  it('keys a pasted YouTube link on the video id, not on the URL', async () => {
    asAdmin();
    fakeDb.queue('creators', { data: CREATOR });
    fakeDb.queue('creator_sync_runs', { data: insertedRun([]) });

    const res = await POST(jsonRequest('/api/admin/sync', {
      token,
      body: { creatorId: 'c1', mode: 'link', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
    }));

    expect(res.status).toBe(201);
    const insert = fakeDb.calls.find((c) => c.table === 'creator_sync_runs' && c.method === 'insert');
    // The id the uploads feed uses. Keyed on the URL the worker looks the video
    // up by a string the channel map has never heard of and fails the item with
    // "no longer in the channel's recent uploads" — a sentence about the video
    // rather than about the key, which is the worst kind of wrong message.
    expect(insert?.args[0].items[0]).toMatchObject({ itemId: 'dQw4w9WgXcQ' });
    expect(insert?.args[0]).toMatchObject({ source: 'youtube' });
  });

  it('never writes a preset meal — a run only enqueues (MEAL-91)', async () => {
    asAdmin();
    fakeDb.queue('creators', { data: CREATOR });
    fakeDb.queue('creator_sync_runs', { data: insertedRun([]) });

    await POST(jsonRequest('/api/admin/sync', { token, body: { creatorId: 'c1', mode: 'link', url: 'https://chefsarah.test/a' } }));

    expect(fakeDb.calls.some((c) => c.table === 'preset_meals')).toBe(false);
    expect(fakeDb.calls.some((c) => c.table === 'creator_import_drafts')).toBe(false);
  });

  it('carries no per-run notification flag, because a run announces nothing', async () => {
    asAdmin();
    fakeDb.queue('creators', { data: CREATOR });
    fakeDb.queue('creator_sync_runs', { data: insertedRun([]) });

    await POST(jsonRequest('/api/admin/sync', {
      token,
      body: { creatorId: 'c1', mode: 'link', url: 'https://chefsarah.test/a', notifyCreator: true },
    }));

    // Ignored rather than honoured: the email is a decision made at Approve now,
    // and a flag stored here would be a promise this route cannot keep.
    expect(fakeDb.calls.find((c) => c.method === 'insert')?.args[0]).not.toHaveProperty('notify_creator');
  });

  it('refuses a selection containing a URL that is not on the creator’s own site', async () => {
    // These rows came from the creator's feed. A cross-host entry means either a
    // hijacked feed or a hand-edited request, and publishing a stranger's recipe
    // under this creator's name is exactly what must not happen.
    asAdmin();
    fakeDb.queue('creators', { data: CREATOR });

    const res = await POST(jsonRequest('/api/admin/sync', {
      token,
      body: {
        creatorId: 'c1',
        mode: 'catalog',
        source: 'website',
        items: [
          { itemId: 'a', url: 'https://chefsarah.test/a' },
          { itemId: 'b', url: 'https://someoneelse.test/b' },
        ],
      },
    }));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/not on this creator's own/i);
    expect(fakeDb.calls.some((c) => c.method === 'insert')).toBe(false);
  });

  it('checks the host for a non-website source too, not only for websites', async () => {
    // The guard used to read `source === 'website' && !isSameSite(...)`, so a
    // hand-written request naming any other source carried arbitrary URLs
    // through untouched. `buildCatalog` cannot produce that shape today, which
    // is exactly why the exemption would still have been there when it could.
    asAdmin();
    fakeDb.queue('creators', { data: { ...CREATOR, youtube_url: 'https://www.youtube.com/@chefsarah' } });

    const res = await POST(jsonRequest('/api/admin/sync', {
      token,
      body: {
        creatorId: 'c1',
        mode: 'catalog',
        source: 'youtube',
        items: [{ itemId: 'v1', url: 'https://attacker.test/not-their-video' }],
      },
    }));

    expect(res.status).toBe(400);
    expect(fakeDb.calls.some((c) => c.method === 'insert')).toBe(false);
  });

  it('starts a YouTube run for a connected creator with no youtube_url on their row', async () => {
    // The channel comes from the OAuth grant (MEAL-74), so requiring the link as
    // well would refuse exactly the creators who did the connecting properly.
    asAdmin();
    fakeDb.queue('creators', { data: CREATOR });
    fakeDb.queue('creator_sync_runs', { data: insertedRun([], { source: 'youtube' }) });

    const res = await POST(jsonRequest('/api/admin/sync', {
      token,
      body: {
        creatorId: 'c1',
        mode: 'catalog',
        source: 'youtube',
        items: [{ itemId: 'vid0000000A', url: 'https://www.youtube.com/watch?v=vid0000000A' }],
      },
    }));

    expect(res.status).toBe(201);
  });

  it('refuses a YouTube item whose URL is not the watch page for its video id', async () => {
    // `creator_source_items` is what MEAL-79 reads to decide which video a
    // published meal came from, so a row describing one video with another's
    // link is a link written to the wrong channel later.
    asAdmin();
    fakeDb.queue('creators', { data: CREATOR });

    const res = await POST(jsonRequest('/api/admin/sync', {
      token,
      body: {
        creatorId: 'c1',
        mode: 'catalog',
        source: 'youtube',
        items: [{ itemId: 'vid0000000A', url: 'https://www.youtube.com/watch?v=somebodyelse' }],
      },
    }));

    expect(res.status).toBe(400);
    expect(fakeDb.calls.some((c) => c.method === 'insert')).toBe(false);
  });

  it('starts an Instagram run for a connected creator with no instagram_url', async () => {
    // The account comes from the OAuth grant (MEAL-82), so requiring the link as
    // well would refuse exactly the creators who did the connecting properly.
    asAdmin();
    fakeDb.queue('creators', { data: CREATOR });
    fakeDb.queue('creator_sync_runs', { data: insertedRun([], { source: 'instagram' }) });

    const res = await POST(jsonRequest('/api/admin/sync', {
      token,
      body: {
        creatorId: 'c1',
        mode: 'catalog',
        source: 'instagram',
        items: [{ itemId: 'm1', url: 'https://www.instagram.com/reel/CabcDEFghij/' }],
      },
    }));

    expect(res.status).toBe(201);
  });

  it('refuses a TikTok item whose URL is not on tiktok.com', async () => {
    // A permalink carries a shortcode rather than the media id, so the id cannot
    // be cross-checked against the URL the way YouTube's can. The host can be,
    // and a row claiming a TikTok post lives elsewhere is not one to record
    // under this creator's name.
    asAdmin();
    fakeDb.queue('creators', { data: CREATOR });

    const res = await POST(jsonRequest('/api/admin/sync', {
      token,
      body: {
        creatorId: 'c1',
        mode: 'catalog',
        source: 'tiktok',
        items: [{ itemId: 'v1', url: 'https://not-tiktok.test/@someone/video/v1' }],
      },
    }));

    expect(res.status).toBe(400);
    expect(fakeDb.calls.some((c) => c.method === 'insert')).toBe(false);
  });

  it('gives one link one item_id however it was spelled', async () => {
    // Three spellings of one post were three item_ids, so an operator pasting
    // the same link on two different days got two drafts and two published
    // meals under the creator's name.
    asAdmin();
    fakeDb.queue('creators', { data: CREATOR });
    fakeDb.queue('creator_sync_runs', { data: insertedRun([]) });

    await POST(jsonRequest('/api/admin/sync', {
      token,
      body: { creatorId: 'c1', mode: 'link', url: 'http://www.chefsarah.test/guacamole/' },
    }));

    const insert = fakeDb.calls.find((c) => c.table === 'creator_sync_runs' && c.method === 'insert');
    expect(insert?.args[0].items[0]).toMatchObject({
      itemId: 'https://chefsarah.test/guacamole',
      // Still fetched as it was written: folding the scheme or the `www.` into
      // what we request would mean asking for a host nobody gave us.
      url: 'http://www.chefsarah.test/guacamole',
    });
  });

  it('accepts a subdomain of the creator’s site', async () => {
    asAdmin();
    fakeDb.queue('creators', { data: CREATOR });
    fakeDb.queue('creator_sync_runs', { data: insertedRun([]) });

    const res = await POST(jsonRequest('/api/admin/sync', {
      token,
      body: { creatorId: 'c1', mode: 'catalog', source: 'website', items: [{ itemId: 'a', url: 'https://blog.chefsarah.test/a' }] },
    }));
    expect(res.status).toBe(201);
  });

  it('rejects an empty selection', async () => {
    asAdmin();
    fakeDb.queue('creators', { data: CREATOR });
    const res = await POST(jsonRequest('/api/admin/sync', { token, body: { creatorId: 'c1', mode: 'catalog', source: 'website', items: [] } }));
    expect(res.status).toBe(400);
  });

  it('rejects a mode it does not have', async () => {
    asAdmin();
    const res = await POST(jsonRequest('/api/admin/sync', { token, body: { creatorId: 'c1', mode: 'everything' } }));
    expect(res.status).toBe(400);
  });
});

describe('GET /api/admin/sync', () => {
  it('403 for a non-admin', async () => {
    asAdmin(false);
    const res = await GET(jsonRequest('/api/admin/sync?runId=r1', { method: 'GET', token }));
    expect(res.status).toBe(403);
  });

  it('returns a run with the totals that make the arithmetic legible', async () => {
    asAdmin();
    fakeDb.queue('creator_sync_runs', {
      data: insertedRun([
        { itemId: 'a', url: 'u', title: null, publishedAt: null, status: 'drafted', detail: null, draftId: 'd1', mealName: 'A', needALook: 2, costUsd: 0.07 },
        { itemId: 'b', url: 'u', title: null, publishedAt: null, status: 'rejected', detail: 'not a recipe', draftId: null, mealName: null, needALook: null, costUsd: 0 },
      ]),
    });

    const res = await GET(jsonRequest('/api/admin/sync?runId=r1', { method: 'GET', token }));
    expect(res.status).toBe(200);
    expect((await res.json()).totals).toMatchObject({ selected: 2, drafted: 1, rejected: 1, needALook: 2 });
  });

  it('404 for a run that does not exist', async () => {
    asAdmin();
    const res = await GET(jsonRequest('/api/admin/sync?runId=nope', { method: 'GET', token }));
    expect(res.status).toBe(404);
  });
});

describe('GET /api/admin/sync — the job queue', () => {
  /** A run as the table stores one. Seeded, not queued: the ordering and the
   *  window are the behaviour under test, so the fake has to evaluate them. */
  const storedRun = (id: string, creatorId: string, createdAt: string, over: Record<string, unknown> = {}) => ({
    id, creator_id: creatorId, source: 'website', mode: 'catalog', status: 'done',
    created_at: createdAt, finished_at: null, items: [], ...over,
  });

  const item = (status: string) => ({
    itemId: `i-${status}`, url: 'https://chefsarah.test/x', title: null, publishedAt: null,
    status, detail: null, draftId: null, mealName: null, needALook: null, costUsd: 0,
  });

  it('403 for a non-admin, and no runs are read', async () => {
    asAdmin(false);
    const res = await GET(jsonRequest('/api/admin/sync', { method: 'GET', token }));
    expect(res.status).toBe(403);
    // Tested by what did not happen, not by the status code: every other admin
    // guard on this file is, and a queue that reads first and refuses after is
    // a guard in name only.
    expect(fakeDb.calls.some((c) => c.table === 'creator_sync_runs')).toBe(false);
  });

  it('lists recent runs across every creator, newest first, with the creator named', async () => {
    asAdmin();
    fakeDb.seed('creators', [
      { id: 'c1', display_name: 'Chef Sarah' },
      { id: 'c2', display_name: 'Chef Ben' },
    ]);
    fakeDb.seed('creator_sync_runs', [
      storedRun('old', 'c1', '2026-07-30T09:00:00.000Z'),
      storedRun('new', 'c2', '2026-08-02T09:00:00.000Z', {
        status: 'running', source: 'youtube', items: [item('drafted'), item('pending')],
      }),
      storedRun('mid', 'c1', '2026-08-01T09:00:00.000Z'),
    ]);

    const res = await GET(jsonRequest('/api/admin/sync', { method: 'GET', token }));
    expect(res.status).toBe(200);
    const { runs } = await res.json();

    // A queue is only a queue in order.
    expect(runs.map((r: any) => r.id)).toEqual(['new', 'mid', 'old']);
    // Whose run it is. A row carries `creator_id` and nothing else, and a uuid
    // is not something an operator scanning a queue can act on.
    expect(runs[0]).toMatchObject({ creatorId: 'c2', creatorName: 'Chef Ben', status: 'running', source: 'youtube' });
    expect(runs[1].creatorName).toBe('Chef Sarah');
    // Counts, computed by the same function the run card uses.
    expect(runs[0].totals).toMatchObject({ selected: 2, drafted: 1, pending: 1, failed: 0, rejected: 0 });
    // And not the items themselves: a 500-item run is 500 rows' worth of
    // payload for a list nobody reads the items in.
    expect(runs[0].items).toBeUndefined();
  });

  it('returns a window, not the table', async () => {
    asAdmin();
    fakeDb.seed('creators', [{ id: 'c1', display_name: 'Chef Sarah' }]);
    fakeDb.seed('creator_sync_runs', Array.from({ length: 30 }, (_, i) =>
      storedRun(`r${i}`, 'c1', `2026-08-${String(i + 1).padStart(2, '0')}T09:00:00.000Z`)));

    const { runs } = await (await GET(jsonRequest('/api/admin/sync', { method: 'GET', token }))).json();

    expect(runs).toHaveLength(25);
    // Bounded from the newest end — a window that dropped the newest five would
    // be the one page of a job queue that is worth nothing.
    expect(runs[0].id).toBe('r29');
    expect(runs.at(-1).id).toBe('r5');
  });

  it('still lists a run whose creator row has gone', async () => {
    asAdmin();
    fakeDb.seed('creators', [{ id: 'c1', display_name: 'Chef Sarah' }]);
    fakeDb.seed('creator_sync_runs', [storedRun('orphan', 'deleted-creator', '2026-08-02T09:00:00.000Z')]);

    const { runs } = await (await GET(jsonRequest('/api/admin/sync', { method: 'GET', token }))).json();

    // The name is looked up beside the runs rather than joined through them, so
    // a missing creator costs the row its name and not its place in the queue.
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ id: 'orphan', creatorName: null });
  });

  it('asks for names once, for the creators on the page', async () => {
    asAdmin();
    fakeDb.seed('creators', [{ id: 'c1', display_name: 'Chef Sarah' }]);
    fakeDb.seed('creator_sync_runs', [
      storedRun('a', 'c1', '2026-08-02T09:00:00.000Z'),
      storedRun('b', 'c1', '2026-08-01T09:00:00.000Z'),
      storedRun('c', 'c1', '2026-07-31T09:00:00.000Z'),
    ]);

    await GET(jsonRequest('/api/admin/sync', { method: 'GET', token }));

    // One `.in()` for the whole page, not a lookup per run: 25 runs of one
    // creator must not be 25 round trips for the same name.
    const lookups = fakeDb.calls.filter((c) => c.table === 'creators' && c.method === 'in');
    expect(lookups).toHaveLength(1);
    expect(lookups[0].args[1]).toEqual(['c1']);
  });
});

describe('PATCH /api/admin/sync — retry one item', () => {
  it('403 for a non-admin, and nothing is requeued', async () => {
    asAdmin(false);
    const res = await PATCH(jsonRequest('/api/admin/sync', { method: 'PATCH', token, body: { runId: 'r1', itemId: 'a' } }));
    expect(res.status).toBe(403);
    expect(fakeDb.calls.some((c) => c.method === 'update')).toBe(false);
  });

  it('requeues a failed item on its own', async () => {
    asAdmin();
    // Stored rather than queued: the retry takes the run's lease and writes
    // conditionally, so it needs a row that a predicate can match or refuse.
    fakeDb.seed('creator_sync_runs', [
      insertedRun([
        { itemId: 'a', url: 'u', title: null, publishedAt: null, status: 'drafted', detail: null, draftId: 'd1', mealName: 'A', needALook: 0, costUsd: 0 },
        { itemId: 'b', url: 'u', title: null, publishedAt: null, status: 'failed', detail: 'timeout', draftId: null, mealName: null, needALook: null, costUsd: 0 },
      ], { status: 'done', lease_until: null }),
    ]);

    const res = await PATCH(jsonRequest('/api/admin/sync', { method: 'PATCH', token, body: { runId: 'r1', itemId: 'b' } }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.run.items[0].status).toBe('drafted');
    expect(body.run.items[1].status).toBe('pending');
  });

  it('400 when the item is not retryable', async () => {
    asAdmin();
    fakeDb.queue('creator_sync_runs', {
      data: insertedRun([{ itemId: 'a', url: 'u', title: null, publishedAt: null, status: 'rejected', detail: null, draftId: null, mealName: null, needALook: null, costUsd: 0 }]),
    });
    const res = await PATCH(jsonRequest('/api/admin/sync', { method: 'PATCH', token, body: { runId: 'r1', itemId: 'a' } }));
    expect(res.status).toBe(400);
  });
});

describe('/api/admin/sync/worker', () => {
  it('403 for a non-admin, and no run is advanced', async () => {
    asAdmin(false);
    const res = await WORKER(jsonRequest('/api/admin/sync/worker', { token, body: { runId: 'r1' } }));
    expect(res.status).toBe(403);
    expect(advanceRun).not.toHaveBeenCalled();
  });

  it('400 without a runId', async () => {
    asAdmin();
    const res = await WORKER(jsonRequest('/api/admin/sync/worker', { token, body: {} }));
    expect(res.status).toBe(400);
  });

  it('404 for a run that does not exist', async () => {
    asAdmin();
    advanceRun.mockResolvedValue(null);
    const res = await WORKER(jsonRequest('/api/admin/sync/worker', { token, body: { runId: 'nope' } }));
    expect(res.status).toBe(404);
  });

  it('reports progress, including what the gate dropped', async () => {
    asAdmin();
    advanceRun.mockResolvedValue({
      id: 'r1', creatorId: 'c1', source: 'website', mode: 'catalog', status: 'running',
      createdAt: null, finishedAt: null,
      items: [
        { itemId: 'a', url: 'u', title: null, publishedAt: null, status: 'drafted', detail: null, draftId: 'd1', mealName: 'A', needALook: 1, costUsd: 0.07 },
        { itemId: 'b', url: 'u', title: null, publishedAt: null, status: 'rejected', detail: 'Not a recipe.', draftId: null, mealName: null, needALook: null, costUsd: 0 },
        { itemId: 'c', url: 'u', title: null, publishedAt: null, status: 'pending', detail: null, draftId: null, mealName: null, needALook: null, costUsd: 0 },
      ],
    });

    const res = await WORKER(jsonRequest('/api/admin/sync/worker', { token, body: { runId: 'r1' } }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.totals).toMatchObject({ selected: 3, drafted: 1, rejected: 1, pending: 1 });
    expect(body.run.items[1].detail).toBe('Not a recipe.');
  });
});
