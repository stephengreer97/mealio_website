import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { fakeDb } from '../helpers/supabase-mock';
import { publicLookup, stubFetch } from '../helpers/import-stubs';
import { importedGuacamole } from '../helpers/import-ui-fixtures';
import type { ImportResult, ImportSuccess } from '@/lib/import/types';

vi.mock('@/lib/logger', () => ({ log: vi.fn() }));

// A run must not be able to reach either of these any more: nothing it produces
// is live, so there is nothing to announce and no cache to invalidate. The mocks
// exist so the tests can assert they were never called.
const sendCreatorSyncPublishedEmail = vi.fn();
vi.mock('@/lib/email', () => ({
  sendCreatorSyncPublishedEmail: (...args: unknown[]) => sendCreatorSyncPublishedEmail(...args),
}));

const publishCreatorMeal = vi.fn();
vi.mock('@/lib/creator-meals', () => ({
  publishCreatorMeal: (...args: unknown[]) => publishCreatorMeal(...args),
}));

import {
  advanceRun,
  buildCatalog,
  processSyncItem,
  retrySyncItem,
  summariseRun,
  type SyncDeps,
  type SyncItem,
  type SyncRun,
} from '@/lib/admin-sync';

/**
 * The engine behind both sync modes.
 *
 * Four properties carry the two tickets and are tested as such: drawing the
 * checklist costs one feed read and nothing else, the gate still decides what
 * gets extracted, one bad item does not take the batch with it, and — MEAL-91 —
 * **a run never publishes**. The last one is tested by asserting the publisher
 * and the notifier were not reached, not merely that the item says `drafted`.
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
  user_profiles: { email: 'sarah@chefsarah.test' },
};

const supabase = fakeDb as unknown as SupabaseClient;

function item(overrides: Partial<SyncItem> = {}): SyncItem {
  return {
    itemId: 'guid-1',
    url: 'https://chefsarah.test/guacamole',
    title: 'Guacamole',
    publishedAt: '2026-07-29T09:00:00.000Z',
    status: 'pending',
    detail: null,
    draftId: null,
    mealName: null,
    needALook: null,
    costUsd: 0,
    ...overrides,
  };
}

function run(items: SyncItem[], overrides: Partial<SyncRun> = {}): SyncRun {
  return {
    id: 'r1',
    creatorId: 'c1',
    source: 'website',
    mode: 'catalog',
    status: 'queued',
    items,
    createdAt: null,
    finishedAt: null,
    ...overrides,
  };
}

/** The row shape `creator_sync_runs` hands back. */
function runRow(items: SyncItem[], overrides: Record<string, unknown> = {}) {
  return {
    id: 'r1',
    creator_id: 'c1',
    source: 'website',
    mode: 'catalog',
    status: 'queued',
    items,
    started_at: null,
    created_at: '2026-08-02T10:00:00.000Z',
    ...overrides,
  };
}

/** Queues the run read and a successful lease claim. */
function queueRun(row: Record<string, unknown>) {
  fakeDb.queue('creator_sync_runs', { data: row });
  fakeDb.queue('creator_sync_runs', { data: [row] });
  fakeDb.queue('creators', { data: CREATOR });
}

const rejection = (stage: ImportResult extends never ? never : 'fetch' | 'gate' | 'extract', detail: string): ImportResult => ({
  status: 'rejected',
  url: 'https://chefsarah.test/guacamole',
  stage,
  reason: stage === 'gate' ? 'gate-no' : 'timeout',
  detail,
  meta: { cached: false },
});

function deps(overrides: Partial<SyncDeps> = {}): SyncDeps {
  return {
    supabase,
    queue: vi.fn(async () => 'draft-1') as unknown as SyncDeps['queue'],
    now: () => 1_800_000_000_000,
    ...overrides,
  };
}

beforeEach(() => {
  fakeDb.reset();
  sendCreatorSyncPublishedEmail.mockReset();
  publishCreatorMeal.mockReset();
});

// ── Catalog ──────────────────────────────────────────────────────────────────

describe('buildCatalog — drawing the list is free', () => {
  function feedWith(count: number): string {
    const items = Array.from({ length: count }, (_, i) =>
      `<item><title>Recipe ${i}</title><link>https://chefsarah.test/post-${i}</link>` +
      `<guid>guid-${i}</guid><pubDate>Tue, 29 Jul 2026 09:00:00 +0000</pubDate></item>`,
    ).join('');
    return `<rss><channel>${items}</channel></rss>`;
  }

  it('lists a 200-post blog without fetching a single post', async () => {
    const { impl, calls } = stubFetch({
      'https://chefsarah.test/robots.txt': { body: 'User-agent: *\nAllow: /' },
      'https://chefsarah.test/feed': { body: feedWith(200), headers: { 'content-type': 'application/rss+xml' } },
    });

    const result = await buildCatalog(
      { supabase, fetchOptions: { fetchImpl: impl, lookup: publicLookup } },
      CREATOR,
      'website',
    );

    expect(result.ok && result.entries).toHaveLength(200);
    // robots.txt and the feed. Nothing else — no post is opened to draw a row,
    // which is what makes this screen safe to open on an archive.
    expect(calls).toEqual(['https://chefsarah.test/robots.txt', 'https://chefsarah.test/feed']);
    expect(calls.some((url) => url.includes('/post-'))).toBe(false);
  });

  it('marks what is already imported, from the record and not from a fetch', async () => {
    const { impl } = stubFetch({
      'https://chefsarah.test/robots.txt': { body: '' },
      'https://chefsarah.test/feed': { body: feedWith(3) },
    });
    fakeDb.queue('creator_source_items', {
      data: [
        { item_id: 'guid-1', status: 'imported', detail: null, updated_at: '2026-07-01T00:00:00.000Z' },
        { item_id: 'guid-2', status: 'rejected', detail: 'Not a recipe: a roundup post', updated_at: null },
      ],
    });

    const result = await buildCatalog(
      { supabase, fetchOptions: { fetchImpl: impl, lookup: publicLookup } },
      CREATOR,
      'website',
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries[0].record).toBeNull();
    expect(result.entries[1].record).toMatchObject({ status: 'imported' });
    expect(result.entries[2].record).toMatchObject({ status: 'rejected' });
  });

  it('says a platform is not connected rather than showing an empty list', async () => {
    // An empty list would read as "this creator publishes nothing", which is the
    // one thing it must not mean.
    const result = await buildCatalog({ supabase }, CREATOR, 'youtube');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toMatch(/MEAL-74/);
  });
});

// ── One item ─────────────────────────────────────────────────────────────────

describe('processSyncItem — the gate is not bypassed by selecting something', () => {
  let success: ImportSuccess;
  beforeEach(async () => { success = await importedGuacamole(); });

  it('queues a recipe for review instead of publishing it', async () => {
    const queue = vi.fn(async () => 'draft-9');
    const result = await processSyncItem(
      deps({ importer: async () => success, queue: queue as unknown as SyncDeps['queue'] }),
      run([item()]),
      CREATOR,
      item(),
    );

    expect(result).toMatchObject({ status: 'drafted', draftId: 'draft-9', mealName: 'Best Guacamole' });
    expect(result.costUsd).toBeGreaterThan(0);
    // The point of the ticket: nothing reached Discover, and nobody was told a
    // recipe went live. Asserting the status alone would pass on a version that
    // published as well as queued.
    expect(publishCreatorMeal).not.toHaveBeenCalled();
    expect(sendCreatorSyncPublishedEmail).not.toHaveBeenCalled();
  });

  it('stores the field-level confidence rather than discarding it', async () => {
    // `processSyncItem` computed `result.confidence` and never passed it on, so
    // the MEAL-72 assessment protected nothing on this path. That is the bug.
    const queue = vi.fn(async (_supabase: unknown, input: unknown) => { void input; return 'draft-9'; });
    await processSyncItem(
      deps({ importer: async () => success, queue: queue as unknown as SyncDeps['queue'] }),
      run([item()]),
      CREATOR,
      item(),
    );

    const queued = queue.mock.calls[0][1] as { confidence: unknown; reviewBy: string; draft: { name: string } };
    expect(queued.confidence).toEqual(success.confidence);
    expect(queued.reviewBy).toBe('admin');
    expect(queued.draft.name).toBe('Best Guacamole');
  });

  it('counts the flagged fields so the run says how much reading is waiting', async () => {
    const result = await processSyncItem(
      deps({ importer: async () => success }),
      run([item()]),
      CREATOR,
      item(),
    );
    // The guacamole fixture lands fields on every level on purpose, including a
    // deliberate hallucination, so this is a real count and not a constant.
    expect(result.needALook).toBeGreaterThan(0);
  });

  it('records the item as imported the moment the draft exists, so a decline sticks', async () => {
    // `creator_source_items` is what the next sync and the poller read. Writing
    // it only on publish would mean a declined recipe comes back next cycle.
    await processSyncItem(
      deps({ importer: async () => success, queue: (async () => 'draft-9') as unknown as SyncDeps['queue'] }),
      run([item()]),
      CREATOR,
      item(),
    );
    const record = fakeDb.calls.find((c) => c.table === 'creator_source_items' && c.method === 'upsert');
    expect(record?.args[0]).toMatchObject({
      creator_id: 'c1', source: 'website', item_id: 'guid-1', status: 'imported', draft_id: 'draft-9',
    });
  });

  it('drops a selected post the gate says is not a recipe — and says so', async () => {
    const queue = vi.fn();
    const result = await processSyncItem(
      deps({
        importer: async () => rejection('gate', 'Not a recipe: this is a kitchen-tour post.'),
        queue: queue as unknown as SyncDeps['queue'],
      }),
      run([item()]),
      CREATOR,
      item(),
    );

    expect(result.status).toBe('rejected');
    expect(result.detail).toMatch(/not a recipe/i);
    expect(queue).not.toHaveBeenCalled();
  });

  it('calls a fetch failure failed, not rejected, so it stays retryable', async () => {
    // The gate is an answer about the post; a timeout is an answer about our
    // afternoon. Only the first is permanent.
    const result = await processSyncItem(
      deps({ importer: async () => rejection('fetch', 'The site took too long to answer.') }),
      run([item()]),
      CREATOR,
      item(),
    );
    expect(result.status).toBe('failed');
  });

  it('skips an item already imported rather than queuing it twice', async () => {
    fakeDb.queue('creator_source_items', { data: { status: 'imported' } });
    const importer = vi.fn();
    const result = await processSyncItem(
      deps({ importer: importer as unknown as SyncDeps['importer'] }),
      run([item()]),
      CREATOR,
      item(),
    );

    expect(result.status).toBe('skipped');
    expect(importer).not.toHaveBeenCalled();
  });

  it('survives an importer that throws', async () => {
    const result = await processSyncItem(
      deps({ importer: async () => { throw new Error('boom'); } }),
      run([item()]),
      CREATOR,
      item(),
    );
    expect(result.status).toBe('failed');
    expect(result.detail).toMatch(/boom/);
  });

  it('keeps the cost when extraction succeeded but queuing did not', async () => {
    const result = await processSyncItem(
      deps({
        importer: async () => success,
        queue: (async () => { throw new Error('duplicate key'); }) as unknown as SyncDeps['queue'],
      }),
      run([item()]),
      CREATOR,
      item(),
    );
    expect(result.status).toBe('failed');
    expect(result.costUsd).toBeGreaterThan(0);
  });
});

// ── A run ────────────────────────────────────────────────────────────────────

describe('advanceRun', () => {
  let success: ImportSuccess;
  beforeEach(async () => { success = await importedGuacamole(); });

  it('queues what passes, explains what did not, and finishes', async () => {
    const items = [
      item({ itemId: 'a', url: 'https://chefsarah.test/a' }),
      item({ itemId: 'b', url: 'https://chefsarah.test/b' }),
      item({ itemId: 'c', url: 'https://chefsarah.test/c' }),
    ];
    queueRun(runRow(items));

    const importer = vi.fn(async (url: string) =>
      url.endsWith('/a') ? success
        : url.endsWith('/b') ? rejection('gate', 'Not a recipe: a travel diary.')
        : rejection('fetch', 'The site refused us.'),
    );

    const result = await advanceRun(deps({ importer: importer as unknown as SyncDeps['importer'] }), 'r1');

    expect(result?.status).toBe('done');
    // "I selected 3 and got 1" has to add up on screen.
    expect(summariseRun(result!)).toMatchObject({ selected: 3, drafted: 1, rejected: 1, failed: 1, pending: 0 });
  });

  it('publishes nothing and tells nobody, however many items succeed', async () => {
    // MEAL-90 published here and emailed the creator from the run. Both are gone:
    // a finished run has put nothing on Discover, so an email announcing live
    // recipes would be false. The announcement moved to Approve.
    const items = [
      item({ itemId: 'a', url: 'https://chefsarah.test/a' }),
      item({ itemId: 'b', url: 'https://chefsarah.test/b' }),
    ];
    queueRun(runRow(items));

    const result = await advanceRun(deps({ importer: async () => success }), 'r1');

    expect(summariseRun(result!)).toMatchObject({ selected: 2, drafted: 2 });
    expect(publishCreatorMeal).not.toHaveBeenCalled();
    expect(sendCreatorSyncPublishedEmail).not.toHaveBeenCalled();
    // And no preset_meals row was written by any other route either.
    expect(fakeDb.calls.some((c) => c.table === 'preset_meals')).toBe(false);
  });

  it('reports how many fields the queue will ask a human to check', async () => {
    queueRun(runRow([item()]));
    const result = await advanceRun(deps({ importer: async () => success }), 'r1');
    expect(summariseRun(result!).needALook).toBeGreaterThan(0);
  });

  it('refuses to work on a run another worker holds the lease on', async () => {
    fakeDb.queue('creator_sync_runs', { data: runRow([item()], { status: 'running' }) });
    fakeDb.queue('creator_sync_runs', { data: [] }); // the claim matched no row
    const importer = vi.fn();

    await advanceRun(deps({ importer: importer as unknown as SyncDeps['importer'] }), 'r1');

    expect(importer).not.toHaveBeenCalled();
  });

  it('stops at its time budget and leaves the rest queued', async () => {
    const items = Array.from({ length: 6 }, (_, i) => item({ itemId: `i${i}`, url: `https://chefsarah.test/${i}` }));
    queueRun(runRow(items));

    // A clock that jumps 30s per read: the budget is spent after the first wave.
    let clock = 1_800_000_000_000;
    const result = await advanceRun(
      deps({ importer: async () => success, now: () => (clock += 30_000) }),
      'r1',
    );

    expect(result?.status).toBe('queued');
    const totals = summariseRun(result!);
    expect(totals.pending).toBeGreaterThan(0);
    expect(totals.drafted).toBeLessThan(6);
  });

  it('returns null for a run that does not exist', async () => {
    expect(await advanceRun(deps(), 'nope')).toBeNull();
  });
});

describe('retrySyncItem', () => {
  it('puts a failed item back in the queue', async () => {
    fakeDb.queue('creator_sync_runs', { data: runRow([item({ status: 'failed', detail: 'timeout' })], { status: 'done' }) });
    const result = await retrySyncItem(deps(), 'r1', 'guid-1');
    expect(result.ok && result.run.items[0].status).toBe('pending');
    expect(result.ok && result.run.status).toBe('queued');
  });

  it('refuses to retry a gate rejection — that answer will not change', async () => {
    fakeDb.queue('creator_sync_runs', { data: runRow([item({ status: 'rejected' })]) });
    const result = await retrySyncItem(deps(), 'r1', 'guid-1');
    expect(result.ok).toBe(false);
  });

  it('refuses to retry something already drafted', async () => {
    fakeDb.queue('creator_sync_runs', { data: runRow([item({ status: 'drafted', draftId: 'd1' })]) });
    const result = await retrySyncItem(deps(), 'r1', 'guid-1');
    expect(result.ok).toBe(false);
  });
});
