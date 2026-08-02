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
    expect(buildCatalog).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: 'c1' }), 'website');
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
    expect((await res.json()).error).toMatch(/not on this creator's own site/i);
    expect(fakeDb.calls.some((c) => c.method === 'insert')).toBe(false);
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

describe('PATCH /api/admin/sync — retry one item', () => {
  it('403 for a non-admin, and nothing is requeued', async () => {
    asAdmin(false);
    const res = await PATCH(jsonRequest('/api/admin/sync', { method: 'PATCH', token, body: { runId: 'r1', itemId: 'a' } }));
    expect(res.status).toBe(403);
    expect(fakeDb.calls.some((c) => c.method === 'update')).toBe(false);
  });

  it('requeues a failed item on its own', async () => {
    asAdmin();
    fakeDb.queue('creator_sync_runs', {
      data: insertedRun([
        { itemId: 'a', url: 'u', title: null, publishedAt: null, status: 'drafted', detail: null, draftId: 'd1', mealName: 'A', needALook: 0, costUsd: 0 },
        { itemId: 'b', url: 'u', title: null, publishedAt: null, status: 'failed', detail: 'timeout', draftId: null, mealName: null, needALook: null, costUsd: 0 },
      ], { status: 'done' }),
    });

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
