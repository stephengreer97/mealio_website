import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { fakeDb } from '../helpers/supabase-mock';
import { publicLookup, stubFetch } from '../helpers/import-stubs';
import { importedGuacamole } from '../helpers/import-ui-fixtures';
import type { ImportResult, ImportSuccess } from '@/lib/import/types';

vi.mock('@/lib/logger', () => ({ log: vi.fn() }));

const sendCreatorSyncPublishedEmail = vi.fn();
vi.mock('@/lib/email', () => ({
  sendCreatorSyncPublishedEmail: (...args: unknown[]) => sendCreatorSyncPublishedEmail(...args),
}));

const sendMarketingEmail = vi.fn();
vi.mock('@/lib/marketing-email', () => ({
  sendMarketingEmail: (...args: unknown[]) => sendMarketingEmail(...args),
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
 * Three properties carry the ticket and are tested as such: drawing the
 * checklist costs one feed read and nothing else, the gate still decides what
 * publishes, and one bad item does not take the batch with it.
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
    mealId: null,
    mealName: null,
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
    notifyCreator: true,
    items,
    notifiedAt: null,
    notifyError: null,
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
    notify_creator: true,
    items,
    notified_at: null,
    notify_error: null,
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
    publisher: vi.fn(async () => ({ id: 'meal-1', name: 'Guacamole' })) as unknown as SyncDeps['publisher'],
    now: () => 1_800_000_000_000,
    ...overrides,
  };
}

beforeEach(() => {
  fakeDb.reset();
  sendCreatorSyncPublishedEmail.mockReset();
  sendMarketingEmail.mockReset();
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

  it('publishes a recipe and records it as imported', async () => {
    const publisher = vi.fn(async () => ({ id: 'meal-1', name: 'Best Guacamole' }));
    const result = await processSyncItem(
      deps({ importer: async () => success, publisher: publisher as unknown as SyncDeps['publisher'] }),
      run([item()]),
      CREATOR,
      item(),
    );

    expect(result).toMatchObject({ status: 'imported', mealId: 'meal-1', mealName: 'Best Guacamole' });
    expect(result.costUsd).toBeGreaterThan(0);
    const record = fakeDb.calls.find((c) => c.table === 'creator_source_items' && c.method === 'upsert');
    expect(record?.args[0]).toMatchObject({ creator_id: 'c1', source: 'website', item_id: 'guid-1', status: 'imported' });
  });

  it('drops a selected post the gate says is not a recipe — and says so', async () => {
    const publisher = vi.fn();
    const result = await processSyncItem(
      deps({
        importer: async () => rejection('gate', 'Not a recipe: this is a kitchen-tour post.'),
        publisher: publisher as unknown as SyncDeps['publisher'],
      }),
      run([item()]),
      CREATOR,
      item(),
    );

    expect(result.status).toBe('rejected');
    expect(result.detail).toMatch(/not a recipe/i);
    expect(publisher).not.toHaveBeenCalled();
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

  it('skips an item already imported rather than publishing it twice', async () => {
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

  it('keeps the cost when extraction succeeded but publishing did not', async () => {
    const result = await processSyncItem(
      deps({
        importer: async () => success,
        publisher: (async () => { throw new Error('duplicate key'); }) as unknown as SyncDeps['publisher'],
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

  it('publishes what passes, explains what did not, and finishes', async () => {
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
    expect(summariseRun(result!)).toMatchObject({ selected: 3, imported: 1, rejected: 1, failed: 1, pending: 0 });
  });

  it('sends exactly one email listing every published title, linked by meal id', async () => {
    const items = [
      item({ itemId: 'a', url: 'https://chefsarah.test/a' }),
      item({ itemId: 'b', url: 'https://chefsarah.test/b' }),
    ];
    queueRun(runRow(items));

    let published = 0;
    await advanceRun(
      deps({
        importer: async () => success,
        publisher: (async () => {
          published += 1;
          return { id: `meal-${published}`, name: `Recipe ${published}` };
        }) as unknown as SyncDeps['publisher'],
      }),
      'r1',
    );

    expect(sendCreatorSyncPublishedEmail).toHaveBeenCalledTimes(1);
    const [to, name, meals] = sendCreatorSyncPublishedEmail.mock.calls[0];
    expect(to).toBe('sarah@chefsarah.test');
    expect(name).toBe('Chef Sarah');
    expect(meals).toEqual([
      { id: 'meal-1', name: 'Recipe 1' },
      { id: 'meal-2', name: 'Recipe 2' },
    ]);
    // Transactional, not marketing: marketing_opt_out must never suppress this.
    expect(sendMarketingEmail).not.toHaveBeenCalled();
  });

  it('sends nothing when nothing published', async () => {
    queueRun(runRow([item()]));
    await advanceRun(deps({ importer: async () => rejection('gate', 'Not a recipe.') }), 'r1');
    expect(sendCreatorSyncPublishedEmail).not.toHaveBeenCalled();
  });

  it('sends nothing when the operator turned notification off', async () => {
    queueRun(runRow([item()], { notify_creator: false }));
    await advanceRun(deps({ importer: async () => success }), 'r1');
    expect(sendCreatorSyncPublishedEmail).not.toHaveBeenCalled();
  });

  it('keeps the run retryable when the email fails, rather than swallowing it', async () => {
    queueRun(runRow([item()]));
    sendCreatorSyncPublishedEmail.mockRejectedValueOnce(new Error('Resend is down'));

    const result = await advanceRun(deps({ importer: async () => success }), 'r1');

    expect(result?.status).toBe('done');
    const update = fakeDb.calls
      .filter((c) => c.table === 'creator_sync_runs' && c.method === 'update')
      .at(-1);
    expect(update?.args[0].notify_error).toMatch(/NOT told/);
    // The claim is rolled back, so the next attempt still has something to send.
    expect(update?.args[0].items[0].notified).toBeFalsy();
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
    expect(totals.imported).toBeLessThan(6);
    expect(sendCreatorSyncPublishedEmail).not.toHaveBeenCalled();
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

  it('refuses to retry something already published', async () => {
    fakeDb.queue('creator_sync_runs', { data: runRow([item({ status: 'imported', mealId: 'm1' })]) });
    const result = await retrySyncItem(deps(), 'r1', 'guid-1');
    expect(result.ok).toBe(false);
  });
});
