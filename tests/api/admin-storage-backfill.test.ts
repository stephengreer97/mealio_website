import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeDb, DEFAULT_PAGE_ROWS } from '../helpers/supabase-mock';
import { jsonRequest } from '../helpers/request';

// vi.mock is hoisted above imports, so the factory must import the helper
// dynamically rather than close over the static import.
vi.mock('@/lib/supabase', async () =>
  (await import('../helpers/supabase-mock')).mockSupabaseModule());
vi.mock('@/lib/logger', () => ({ log: vi.fn() }));

const resolvePhotoUrl = vi.fn();
vi.mock('@/lib/photos', () => ({
  resolvePhotoUrl: (...args: unknown[]) => resolvePhotoUrl(...args),
}));

import { POST as BACKFILL_PHOTOS } from '@/app/api/admin/storage/backfill-photos/route';
import { POST as BACKFILL_HASHES } from '@/app/api/admin/storage/backfill-hashes/route';
import { clearRevocationCache, createAccessToken } from '@/lib/tokens';

function asAdmin(isAdmin = true) {
  clearRevocationCache();
  fakeDb.queue('user_profiles', { data: { tokens_invalidated_at: null } });
  fakeDb.queue('user_profiles', { data: { is_admin: isAdmin } });
}

/**
 * MEAL-129. Both backfills selected without a bound, processed at most
 * `db-max-rows` rows, and then reported success — so an operator got a green
 * result and an incomplete job, with nothing in the response distinguishing
 * "finished" from "hit the page ceiling".
 *
 * The property under test is not "it processes everything". A backfill that
 * downloads and re-uploads an image per row genuinely cannot finish an arbitrary
 * backlog inside a 300s `maxDuration`, and a run that exceeds it returns no JSON at
 * all. The property is that a partial run is never presentable as a complete one:
 * the bound is explicit, and `complete` says whether another run is needed.
 */
describe('/api/admin/storage/backfill-photos', () => {
  let token: string;
  const OVER = DEFAULT_PAGE_ROWS + 200;
  const PIXABAY = 'https://cdn.pixabay.com/photo/2020/01/01/x.jpg';

  beforeEach(async () => {
    fakeDb.reset();
    resolvePhotoUrl.mockReset();
    resolvePhotoUrl.mockResolvedValue('https://storage.test/permanent.jpg');
    token = await createAccessToken('admin-1', 'admin@mealio.co');
  });

  it('403 for a non-admin, and nothing is fetched', async () => {
    asAdmin(false);
    const res = await BACKFILL_PHOTOS(jsonRequest('/api/admin/storage/backfill-photos', { token }));
    expect(res.status).toBe(403);
    expect(resolvePhotoUrl).not.toHaveBeenCalled();
  });

  it('finishes a small job and says so', async () => {
    asAdmin();
    fakeDb.seed('meals', Array.from({ length: 3 }, (_, i) => ({
      id: `m-${i}`, user_id: 'u1', photo_url: PIXABAY,
    })));
    fakeDb.seed('preset_meals', []);

    const body = await (await BACKFILL_PHOTOS(jsonRequest('/api/admin/storage/backfill-photos', { token }))).json();

    expect(body).toMatchObject({ total: 3, processed: 3, remaining: 0, complete: true, scanComplete: true });
  });

  it(`sees all ${OVER} candidates, not the first ${DEFAULT_PAGE_ROWS}`, async () => {
    asAdmin();
    fakeDb.seed('meals', Array.from({ length: OVER }, (_, i) => ({
      id: `m-${String(i).padStart(6, '0')}`, user_id: 'u1', photo_url: PIXABAY,
    })));
    fakeDb.seed('preset_meals', []);

    const body = await (await BACKFILL_PHOTOS(jsonRequest('/api/admin/storage/backfill-photos', { token }))).json();

    // The count the operator reads. Under the bug this was 1000 and the response
    // claimed the job was done.
    expect(body.total).toBe(OVER);
    // The batch is bounded, and that is fine — what matters is that it is stated.
    expect(body.processed).toBe(body.batchLimit);
    expect(body.remaining).toBe(OVER - body.batchLimit);
    // The whole point: a bounded run does not claim to be a finished one.
    expect(body.complete).toBe(false);
    expect(body.scanComplete).toBe(true);
  });

  /**
   * The second-order failure, and the nastier of the two.
   *
   * The SQL filter is "has a photo" while the work filter is "that photo is a
   * Pixabay URL". With an unbounded select the 1000-row window was the front of the
   * table, so a table whose first 1000 rows are all permanent URLs yielded zero
   * candidates — and the route reported success — while every real candidate sat
   * past the ceiling, run after run, forever.
   */
  it('finds candidates that sit past the first page of non-candidates', async () => {
    asAdmin();
    fakeDb.seed('meals', Array.from({ length: OVER }, (_, i) => ({
      id: `m-${String(i).padStart(6, '0')}`,
      user_id: 'u1',
      // Only the last 200 are Pixabay URLs; the first 1000 are already permanent.
      photo_url: i < DEFAULT_PAGE_ROWS ? 'https://storage.test/permanent.jpg' : PIXABAY,
    })));
    fakeDb.seed('preset_meals', []);

    const body = await (await BACKFILL_PHOTOS(jsonRequest('/api/admin/storage/backfill-photos', { token }))).json();

    expect(body.total).toBe(200);
    expect(body.processed).toBe(200);
    expect(body.complete).toBe(true);
  });

  it('reaches preset_meals even when meals fills the batch', async () => {
    asAdmin();
    fakeDb.seed('meals', Array.from({ length: 600 }, (_, i) => ({
      id: `m-${String(i).padStart(6, '0')}`, user_id: 'u1', photo_url: PIXABAY,
    })));
    fakeDb.seed('preset_meals', Array.from({ length: 50 }, (_, i) => ({
      id: `p-${String(i).padStart(6, '0')}`, creator_id: 'c1', photo_url: PIXABAY,
    })));

    const body = await (await BACKFILL_PHOTOS(jsonRequest('/api/admin/storage/backfill-photos', { token }))).json();

    // 650 candidates across both tables, all of them counted.
    expect(body.total).toBe(650);
    expect(body.complete).toBe(false);
    expect(body.remaining).toBe(650 - body.batchLimit);
  });

  it('does not report success when the scan itself was truncated', async () => {
    asAdmin();
    fakeDb.seed('meals', [{ id: 'm-1', user_id: 'u1', photo_url: PIXABAY }]);
    fakeDb.seed('preset_meals', []);
    // The first page of the meals scan fails outright. `total` is then a floor, and
    // a floor may not be reported as a count.
    fakeDb.queue('meals', { data: null, error: { message: 'boom' } });

    const body = await (await BACKFILL_PHOTOS(jsonRequest('/api/admin/storage/backfill-photos', { token }))).json();

    expect(body.scanComplete).toBe(false);
    expect(body.complete).toBe(false);
  });
});

describe('/api/admin/storage/backfill-hashes', () => {
  let token: string;
  const OVER = DEFAULT_PAGE_ROWS + 200;
  const BASE_URL = 'https://etaracmlewdvzpcjrgru.supabase.co/storage/v1/object/public/meal-photos/';

  beforeEach(async () => {
    fakeDb.reset();
    token = await createAccessToken('admin-1', 'admin@mealio.co');
    // Every object downloads clean, so the counts under test are the route's
    // bookkeeping rather than fetch outcomes.
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => new TextEncoder().encode('image-bytes').buffer,
    })));
  });

  it('401 for a non-admin', async () => {
    asAdmin(false);
    const res = await BACKFILL_HASHES(jsonRequest('/api/admin/storage/backfill-hashes', { token }));
    expect(res.status).toBe(401);
  });

  it('finishes a small job and says so', async () => {
    asAdmin();
    fakeDb.seed('rpc:list_storage_objects', [
      { name: 'a.jpg', size: 10 }, { name: 'b.jpg', size: 20 },
    ]);
    fakeDb.seed('photo_hashes', []);

    const body = await (await BACKFILL_HASHES(jsonRequest('/api/admin/storage/backfill-hashes', { token }))).json();

    expect(body).toMatchObject({ total: 2, processed: 2, remaining: 0, complete: true, scanComplete: true });
  });

  it(`counts all ${OVER} objects in the bucket, not the first ${DEFAULT_PAGE_ROWS}`, async () => {
    asAdmin();
    // A set-returning RPC is subject to `db-max-rows` exactly as a table is, so the
    // object list capped at 1000 too — and `total` capped with it.
    fakeDb.seed('rpc:list_storage_objects', Array.from({ length: OVER }, (_, i) => ({
      name: `obj-${String(i).padStart(6, '0')}.jpg`, size: 100,
    })));
    fakeDb.seed('photo_hashes', []);

    const body = await (await BACKFILL_HASHES(jsonRequest('/api/admin/storage/backfill-hashes', { token }))).json();

    expect(body.total).toBe(OVER);
    expect(body.processed).toBe(body.batchLimit);
    expect(body.remaining).toBe(OVER - body.batchLimit);
    expect(body.complete).toBe(false);
    expect(body.scanComplete).toBe(true);
  });

  /**
   * The skip-list bug, which cost work as well as completeness: a truncated
   * `photo_hashes` read meant objects already hashed were downloaded, hashed and
   * counted as `processed` again. The number the operator read was inflated by the
   * same short read that made the job incomplete.
   */
  it('skips every already-hashed object, including ones past the page ceiling', async () => {
    asAdmin();
    const objects = Array.from({ length: OVER }, (_, i) => ({
      name: `obj-${String(i).padStart(6, '0')}.jpg`, size: 100,
    }));
    fakeDb.seed('rpc:list_storage_objects', objects);
    // All but the last 5 are already hashed. Under the bug only 1000 of these were
    // read, so ~200 already-hashed objects were re-downloaded and counted as work.
    fakeDb.seed('photo_hashes', objects.slice(0, OVER - 5).map((obj, i) => ({
      hash: `h-${String(i).padStart(6, '0')}`,
      url: `${BASE_URL}${obj.name}`,
    })));

    const body = await (await BACKFILL_HASHES(jsonRequest('/api/admin/storage/backfill-hashes', { token }))).json();

    expect(body.total).toBe(OVER);
    // Exactly the 5 genuinely unhashed objects, and no re-work.
    expect(body.processed).toBe(5);
    expect(body.remaining).toBe(0);
    expect(body.complete).toBe(true);
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(5);
  });

  it('does not report success when the known-url scan was truncated', async () => {
    asAdmin();
    fakeDb.seed('rpc:list_storage_objects', [{ name: 'a.jpg', size: 10 }]);
    fakeDb.seed('photo_hashes', []);
    fakeDb.queue('photo_hashes', { data: null, error: { message: 'boom' } });

    const body = await (await BACKFILL_HASHES(jsonRequest('/api/admin/storage/backfill-hashes', { token }))).json();

    expect(body.scanComplete).toBe(false);
    expect(body.complete).toBe(false);
  });
});
