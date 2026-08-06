import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeDb, DEFAULT_PAGE_ROWS } from '../helpers/supabase-mock';
import { jsonRequest } from '../helpers/request';

// The bucket and the deletes live outside the query builder, so the shared fake
// is wrapped rather than replaced: `from` still goes to FakeSupabase (that is
// what models the 1000-row ceiling), while `rpc` answers with a bucket listing
// and `storage.from().remove()` records what would be destroyed.
//
// vi.hoisted because the mock factory below is hoisted above these declarations.
const bucket = vi.hoisted(() => ({
  objects: [] as Array<{ name: string; size: number }>,
  removed: [] as string[],
}));

vi.mock('@/lib/supabase', async () => {
  const { fakeDb: db } = await import('../helpers/supabase-mock');
  return {
    createServerSupabaseClient: () => ({
      from: (table: string) => db.from(table),
      rpc: async () => ({ data: bucket.objects, error: null }),
      storage: {
        from: () => ({
          remove: async (paths: string[]) => {
            bucket.removed.push(...paths);
            return { data: null, error: null };
          },
        }),
      },
    }),
    createAnonSupabaseClient: () => ({ auth: { signInWithPassword: vi.fn() } }),
  };
});

const log = vi.fn();
vi.mock('@/lib/logger', () => ({ log: (...args: unknown[]) => log(...args) }));

import { POST } from '@/app/api/admin/storage/cleanup-orphans/route';
import { clearRevocationCache, createAccessToken } from '@/lib/tokens';

const BASE_URL = 'https://etaracmlewdvzpcjrgru.supabase.co/storage/v1/object/public/meal-photos/';

/** `n` meal rows whose photos are all live, ids ordered so paging is stable. */
function mealsWithPhotos(n: number, prefix = 'live') {
  return Array.from({ length: n }, (_, i) => {
    const path = `user-1/${prefix}-${String(i).padStart(5, '0')}.jpg`;
    return {
      id: `meal-${String(i).padStart(5, '0')}`,
      photo_url: `${BASE_URL}${path}`,
      _path: path,
    };
  });
}

function objectsFor(rows: Array<{ _path: string }>, size = 1000) {
  return rows.map((r) => ({ name: r._path, size }));
}

describe('/api/admin/storage/cleanup-orphans — the keep-set must be complete before anything is deleted', () => {
  let token: string;

  beforeEach(async () => {
    fakeDb.reset();
    log.mockClear();
    bucket.objects = [];
    bucket.removed = [];
    token = await createAccessToken('admin-1', 'admin@mealio.co');
    clearRevocationCache();
    // Seeded rather than queued: requireAuth's revocation read is memoised, so
    // the number of user_profiles reads per request is not fixed and a FIFO queue
    // would hand the wrong row to the second request in a test.
    fakeDb.seed('user_profiles', [
      { id: 'admin-1', email: 'admin@mealio.co', is_admin: true, tokens_invalidated_at: null },
    ]);
    fakeDb.seed('preset_meals', []);
    fakeDb.seed('creators', []);
    fakeDb.seed('creator_applications', []);
  });

  const run = (query = '') =>
    POST(jsonRequest(`/api/admin/storage/cleanup-orphans${query}`, { method: 'POST', token }));

  // ── MEAL-126 regression ───────────────────────────────────────────────────
  it('does not delete photos referenced past the 1000-row select ceiling', async () => {
    // 1500 live meals, every one of them with a photo in the bucket. Before the
    // fix the keep-set was one unbounded select — 1000 rows — so the 500 photos
    // belonging to rows 1001-1500 were reported as orphans and destroyed.
    const live = mealsWithPhotos(1500);
    fakeDb.seed('meals', live);

    const trueOrphans = [
      { name: 'user-9/abandoned-1.jpg', size: 500 },
      { name: 'user-9/abandoned-2.jpg', size: 500 },
      { name: 'user-9/abandoned-3.jpg', size: 500 },
      { name: 'user-9/abandoned-4.jpg', size: 500 },
    ];
    bucket.objects = [...objectsFor(live), ...trueOrphans];

    const res = await run();
    const body = await res.json();

    expect(res.status).toBe(200);
    // The property that matters: nothing a live meal points at was touched.
    const livePaths = new Set(live.map((m) => m._path));
    expect(bucket.removed.filter((p) => livePaths.has(p))).toEqual([]);
    expect(bucket.removed.sort()).toEqual(trueOrphans.map((o) => o.name).sort());
    expect(body.deleted).toBe(4);
    // 1500 rows read, not 1000 — the paging reached the end of the table.
    expect(body.referenceRowsRead).toBe(1500);
    expect(body.keepSetSize).toBe(1500);
  });

  it('pages a table whose size is an exact multiple of the page, without double-counting', async () => {
    // The awkward boundary: the last full page is followed by an empty one, and a
    // row must not be counted in both. 1000 rows, 1000 distinct paths, 0 orphans.
    const live = mealsWithPhotos(DEFAULT_PAGE_ROWS, 'exact');
    fakeDb.seed('meals', live);
    bucket.objects = objectsFor(live);

    const res = await run();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.referenceRowsRead).toBe(DEFAULT_PAGE_ROWS);
    expect(body.keepSetSize).toBe(DEFAULT_PAGE_ROWS);
    expect(body.orphanCount).toBe(0);
    expect(bucket.removed).toEqual([]);
    const meals = body.tables.find((t: { table: string }) => t.table === 'meals');
    // Two reads: the full page, then the empty one that proves it was the last.
    expect(meals).toMatchObject({ expected: DEFAULT_PAGE_ROWS, read: DEFAULT_PAGE_ROWS, pages: 2, complete: true });
  });

  // ── Gate 1: completeness reconciliation ───────────────────────────────────
  it('refuses to delete when the rows read fall short of the exact count', async () => {
    // The 1000-of-1500 case, expressed the way the route can detect it: the
    // count says 1500 and the pages produced 1000. Whatever the cause — a
    // truncated read, or rows deleted under the walk shifting a row out of the
    // window — the keep-set is missing 500 live photos.
    const live = mealsWithPhotos(DEFAULT_PAGE_ROWS, 'partial');
    fakeDb.seed('meals', live);
    // A queued result wins over the seeded table, so this answers the head-count
    // query only; the page reads still come from the 1000 seeded rows.
    fakeDb.queue('meals', { data: null, count: 1500 });
    bucket.objects = [...objectsFor(live), { name: 'user-9/orphan.jpg', size: 10 }];

    const res = await run();
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.blocked).toBe(true);
    expect(body.reason).toContain('meals');
    expect(body.reason).toContain('1000 of 1500');
    // The whole point: it deleted nothing, including the genuine orphan.
    expect(bucket.removed).toEqual([]);
  });

  it('refuses the DRY RUN too, instead of printing a plausible orphan list', async () => {
    // The dry run was the only safety mechanism and it was computed from the same
    // truncated keep-set, so it reported live photos as orphans and looked right.
    // An untrustworthy number must not be rendered as a number.
    const live = mealsWithPhotos(DEFAULT_PAGE_ROWS, 'partial');
    fakeDb.seed('meals', live);
    fakeDb.queue('meals', { data: null, count: 1500 });
    bucket.objects = objectsFor(live);

    const res = await run('?dryRun=true');
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.blocked).toBe(true);
    expect(body.orphanCount).toBeUndefined();
    expect(body.paths).toBeUndefined();
  });

  it('refuses when a page read errors instead of treating it as zero rows', async () => {
    // `mealsRes.data ?? []` swallowed the error and contributed nothing to the
    // keep-set, which for a failed read of `meals` means deleting every meal
    // photo in the bucket.
    fakeDb.seed('meals', mealsWithPhotos(3, 'err'));
    fakeDb.queue('meals', { data: null, count: 3 });
    fakeDb.queue('meals', { data: null, error: { message: 'connection reset' } });
    bucket.objects = objectsFor(mealsWithPhotos(3, 'err'));

    const res = await run();
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.blocked).toBe(true);
    expect(body.reason).toContain('page 0 failed');
    expect(body.reason).toContain('connection reset');
    expect(bucket.removed).toEqual([]);
  });

  it('refuses when the count itself errors', async () => {
    fakeDb.seed('meals', mealsWithPhotos(3, 'cnt'));
    fakeDb.queue('meals', { data: null, error: { message: 'statement timeout' } });
    bucket.objects = objectsFor(mealsWithPhotos(3, 'cnt'));

    const res = await run();
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.reason).toContain('count failed');
    expect(bucket.removed).toEqual([]);
  });

  it('checks all four reference tables, not just meals', async () => {
    fakeDb.seed('meals', []);
    fakeDb.queue('creator_applications', { data: null, count: 700 });
    bucket.objects = [{ name: 'user-1/x.jpg', size: 1 }];

    const res = await run();
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.reason).toContain('creator_applications');
    expect(bucket.removed).toEqual([]);
  });

  // ── Gate 2: orphan-share ceiling ──────────────────────────────────────────
  it('refuses to delete most of the bucket even when the read reconciled', async () => {
    // Reconciliation cannot see a keep-set that is complete but useless — the
    // shape a BASE_URL change produces, where every photo_url is read and none
    // of them converts to a path.
    fakeDb.seed('meals', [
      { id: 'm-1', photo_url: 'https://elsewhere.example/storage/v1/object/public/meal-photos/user-1/a.jpg' },
    ]);
    bucket.objects = Array.from({ length: 120 }, (_, i) => ({ name: `user-1/p-${i}.jpg`, size: 100 }));

    const res = await run();
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.blocked).toBe(true);
    expect(body.reason).toContain('exceeds');
    expect(body.orphanCount).toBe(120);
    expect(bucket.removed).toEqual([]);
  });

  it('lets an operator override the share ceiling explicitly, but not the completeness gate', async () => {
    fakeDb.seed('meals', []);
    bucket.objects = Array.from({ length: 120 }, (_, i) => ({ name: `user-1/p-${i}.jpg`, size: 100 }));

    const forced = await run('?force=true');
    expect(forced.status).toBe(200);
    expect((await forced.json()).deleted).toBe(120);
    expect(bucket.removed).toHaveLength(120);

    // Same override, incomplete read: still refuses.
    bucket.removed = [];
    fakeDb.queue('meals', { data: null, count: 5 });
    const stillBlocked = await run('?force=true');
    expect(stillBlocked.status).toBe(409);
    expect(bucket.removed).toEqual([]);
  });

  it('warns on the dry run when the share ceiling would block the delete', async () => {
    fakeDb.seed('meals', []);
    bucket.objects = Array.from({ length: 120 }, (_, i) => ({ name: `user-1/p-${i}.jpg`, size: 100 }));

    const res = await run('?dryRun=true');
    const body = await res.json();

    // The dry run still shows the list — that list is how a human diagnoses it —
    // but it says up front that the delete will refuse.
    expect(res.status).toBe(200);
    expect(body.wouldBlock).toBe(true);
    expect(body.blockReason).toContain('force=true');
    expect(body.orphanCount).toBe(120);
    expect(bucket.removed).toEqual([]);
  });

  it('does not apply the share ceiling to a nearly empty bucket', async () => {
    fakeDb.seed('meals', []);
    bucket.objects = [{ name: 'user-1/only.jpg', size: 10 }];

    const res = await run();
    expect(res.status).toBe(200);
    expect(bucket.removed).toEqual(['user-1/only.jpg']);
  });

  it('flags a bucket listing that may itself have been truncated', async () => {
    const live = mealsWithPhotos(DEFAULT_PAGE_ROWS, 'trunc');
    fakeDb.seed('meals', live);
    bucket.objects = objectsFor(live);

    const body = await (await run('?dryRun=true')).json();
    expect(body.objectListMaybeTruncated).toBe(true);
    expect(body.objectsListed).toBe(DEFAULT_PAGE_ROWS);
  });

  it('still requires an admin', async () => {
    const res = await POST(jsonRequest('/api/admin/storage/cleanup-orphans', { method: 'POST' }));
    expect(res.status).toBe(401);
    expect(bucket.removed).toEqual([]);
  });
});
