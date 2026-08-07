import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeDb, DEFAULT_PAGE_ROWS } from '../helpers/supabase-mock';
import { fakeStorage as bucket, mockSupabaseWithStorage } from '../helpers/storage-mock';
import { jsonRequest } from '../helpers/request';

// The bucket and the deletes live outside the query builder, so the shared fake
// is wrapped rather than replaced: `from` still goes to FakeSupabase (that is
// what models the 1000-row ceiling), while `rpc` answers with a bucket listing
// and `storage.from()` models the object side — what was asked for, what actually
// went away, whether it is still there, and the URL an upload gets back.
//
// That object side now lives in `tests/helpers/storage-mock.ts`, shared with the
// upload paths (MEAL-132's read half), because the two must agree about the
// bucket to prove anything: this route deletes the object and the uploaders
// decide whether the dedupe row that names it is still true.
vi.mock('@/lib/supabase', () => mockSupabaseWithStorage());

const log = vi.fn();
vi.mock('@/lib/logger', () => ({ log: (...args: unknown[]) => log(...args) }));

import { POST } from '@/app/api/admin/storage/cleanup-orphans/route';
// The other half of the MEAL-132 loop: the sweep poisons the dedupe cache and it
// is the UPLOAD that hands the dead URL out. Driving the real route rather than
// asserting on rows is the only way to show the poisoning is gone, because the
// row and the URL agreeing is exactly what the bug looked like.
import { POST as uploadImage } from '@/app/api/images/upload/route';
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
    bucket.reset();
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
    fakeDb.seed('creator_import_drafts', []);
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

  // ── MEAL-131 regression ───────────────────────────────────────────────────
  //
  // A different failure from MEAL-126, and not a paging one: `creator_import_drafts`
  // was not a source at all. Paging every table perfectly cannot save a table
  // nobody reads, and neither gate notices — every table the route knows about
  // reconciles against its own count, and one creator's drafts are nowhere near
  // half the bucket. An allowlist that is missing an entry is silently complete.
  describe('import drafts hold their photo inside the `draft` jsonb', () => {
    /** A draft row shaped like the ones `creator_import_drafts` actually carries. */
    function draftRow(photoUrl: string | null, over: Record<string, unknown> = {}) {
      return {
        id: 'draft-00001',
        creator_id: 'c-1',
        source_url: 'https://cookieandkate.example/guacamole',
        status: 'pending_review',
        draft: {
          name: 'Guacamole',
          ingredients: [{ ingredientName: 'avocado', qty: 3, productQty: 3, unit: 'qty' }],
          recipe: 'Mash it.',
          source: 'https://cookieandkate.example/guacamole',
          story: null,
          photoUrl,
          difficulty: 1,
          tags: ['Mexican'],
          serves: '4',
        },
        ...over,
      };
    }

    it('does not delete the photo of a draft that has not been published yet', async () => {
      // The whole bug. The import stored the creator's page image via
      // storeImageBuffer and put the URL on `draft.photoUrl`; until the draft is
      // published no `photo_url` column anywhere points at it, so every sweep
      // deleted it and the review queue rendered a broken image.
      const draftPath = 'creator-7/1754440000000.jpg';
      fakeDb.seed('meals', []);
      fakeDb.seed('creator_import_drafts', [draftRow(`${BASE_URL}${draftPath}`)]);

      const trueOrphan = { name: 'user-9/abandoned.jpg', size: 10 };
      bucket.objects = [{ name: draftPath, size: 4242 }, trueOrphan];

      const res = await run();
      const body = await res.json();

      expect(res.status).toBe(200);
      // Against the unfixed route this is the assertion that fails: the draft's
      // photo is in `removed` and object-storage deletion does not come back.
      expect(bucket.removed).not.toContain(draftPath);
      expect(bucket.removed).toEqual([trueOrphan.name]);
      expect(body.keepSetSize).toBe(1);
    });

    it('keeps the photo of a cancelled draft too, which is never deleted from the table', async () => {
      // `creator_import_drafts` marks a decision, it does not delete the row —
      // the poller must not re-propose the same post, and MEAL-77's consent
      // story shows what was proposed and what the creator did about it. That
      // history is still rendered, so its photo is still referenced. Hence no
      // status filter on the read.
      const cancelled = 'creator-7/cancelled.jpg';
      const approved = 'creator-7/approved.jpg';
      fakeDb.seed('meals', []);
      fakeDb.seed('creator_import_drafts', [
        draftRow(`${BASE_URL}${cancelled}`, { id: 'draft-00001', status: 'cancelled' }),
        draftRow(`${BASE_URL}${approved}`, { id: 'draft-00002', status: 'approved', published_meal_id: 'meal-1' }),
      ]);
      bucket.objects = [{ name: cancelled, size: 1 }, { name: approved, size: 1 }];

      const res = await run();
      expect(res.status).toBe(200);
      expect(bucket.removed).toEqual([]);
      expect((await res.json()).keepSetSize).toBe(2);
    });

    it('protects a storage URL anywhere in the draft, not just the `photoUrl` key', async () => {
      // The point of scanning the jsonb rather than selecting `draft->>photoUrl`:
      // the next key someone adds to the draft shape is protected the day it is
      // added, instead of becoming MEAL-131 a second time.
      const nested = 'creator-7/step-3.jpg';
      fakeDb.seed('meals', []);
      fakeDb.seed('creator_import_drafts', [
        draftRow(null, { draft: { name: 'Tacos', steps: [{ text: 'Fry', image: `${BASE_URL}${nested}` }] } }),
      ]);
      bucket.objects = [{ name: nested, size: 1 }];

      const res = await run();
      expect(res.status).toBe(200);
      expect(bucket.removed).toEqual([]);
    });

    it('reconciles the drafts read against its count, and refuses when it falls short', async () => {
      // The new source is behind the same completeness gate as the other four: a
      // truncated read of it is fatal, not a quietly smaller keep-set.
      fakeDb.seed('meals', []);
      fakeDb.seed('creator_import_drafts', [draftRow(`${BASE_URL}creator-7/a.jpg`)]);
      fakeDb.queue('creator_import_drafts', { data: null, count: 900 });
      bucket.objects = [{ name: 'creator-7/a.jpg', size: 1 }, { name: 'user-9/orphan.jpg', size: 1 }];

      const res = await run();
      const body = await res.json();

      expect(res.status).toBe(409);
      expect(body.blocked).toBe(true);
      expect(body.reason).toContain('creator_import_drafts');
      expect(body.reason).toContain('of 900');
      // Nothing deleted, including the genuine orphan.
      expect(bucket.removed).toEqual([]);
      expect(body.tables.map((t: { table: string }) => t.table)).toContain('creator_import_drafts');
    });

    it('pages the drafts table past the 1000-row ceiling like every other source', async () => {
      // MEAL-126's lesson applied to the new source rather than rediscovered by
      // it: 1500 drafts is 1500 protected photos, not the first 1000.
      const drafts = Array.from({ length: 1500 }, (_, i) => {
        const path = `creator-7/draft-${String(i).padStart(5, '0')}.jpg`;
        return { row: draftRow(`${BASE_URL}${path}`, { id: `draft-${String(i).padStart(5, '0')}` }), path };
      });
      fakeDb.seed('meals', []);
      fakeDb.seed('creator_import_drafts', drafts.map((d) => d.row));
      bucket.objects = drafts.map((d) => ({ name: d.path, size: 1 }));

      const res = await run();
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(bucket.removed).toEqual([]);
      expect(body.keepSetSize).toBe(1500);
      expect(body.tables.find((t: { table: string }) => t.table === 'creator_import_drafts'))
        .toMatchObject({ expected: 1500, read: 1500, complete: true });
    });
  });

  // ── MEAL-132 regression ───────────────────────────────────────────────────
  //
  // Deleting the object is only half of a deletion. `photo_hashes` maps sha256 →
  // stored URL and is read before every upload, so a row left pointing at a
  // deleted object is a permanent lie: the next upload of those bytes is handed
  // the dead URL, and re-uploading cannot fix it because dedupe keeps answering
  // the same way. One sweep poisons that image for every future upload of it.
  //
  // Note what is NOT tested here: `photo_hashes` is never read as a reference
  // source. Every object ever uploaded has a row, so protecting objects with it
  // would make the keep-set equal the bucket and turn the whole cleanup into a
  // no-op — a cache to invalidate, not a reference to honour.
  describe('the dedupe cache must not outlive the objects it points at', () => {
    const dataUrl = (label: string) =>
      `data:image/png;base64,${Buffer.from(label).toString('base64')}`;

    const upload = (imageData: string) =>
      uploadImage(jsonRequest('/api/images/upload', { method: 'POST', body: { imageData }, token }));

    it('does not hand a later upload of the same bytes the URL it just deleted', async () => {
      fakeDb.seed('meals', []);
      fakeDb.seed('photo_hashes', []);
      const imageData = dataUrl('one image, uploaded twice');

      // A held clock, because the upload path is `${userId}/${Date.now()}.png`:
      // two uploads inside one millisecond would reuse a path and the assertion
      // below could not tell a fresh object from the dead one it replaced.
      const clock = vi.spyOn(Date, 'now');
      const t0 = new Date().getTime();
      clock.mockReturnValue(t0);

      const first = await upload(imageData);
      expect(first.status).toBe(201);
      const deadUrl = (await first.json()).url as string;
      const deadPath = deadUrl.slice(BASE_URL.length);
      expect(bucket.objects.map((o) => o.name)).toEqual([deadPath]);
      expect(fakeDb.rows('photo_hashes')).toHaveLength(1);

      // Nothing ever referenced it — the meal was abandoned before saving — so the
      // sweep is right to take the object. The bug is in what it leaves behind.
      //
      // The clock moves past MEAL-133's grace window first, and that is not
      // bookkeeping: an object uploaded a moment ago is one the user may still be
      // part-way through attaching, and the sweep now leaves it alone. "Abandoned"
      // is a claim about elapsed time, so the test has to let time elapse.
      const anHourLater = t0 + 2 * 60 * 60 * 1000;
      clock.mockReturnValue(anHourLater);
      const sweep = await run();
      const body = await sweep.json();
      expect(sweep.status).toBe(200);
      expect(bucket.removed).toEqual([deadPath]);

      clock.mockReturnValue(anHourLater + 9_999);
      const second = await upload(imageData);
      const secondUrl = (await second.json()).url as string;

      // The assertion that fails against the unfixed route: dedupe matched the
      // stale row and returned the deleted URL, for this upload and every later
      // one of the same bytes.
      expect(secondUrl).not.toBe(deadUrl);
      // And a real object stands behind it — 201 is the store-it path, 200 is the
      // dedupe path, so this also pins WHY the URL is different.
      expect(second.status).toBe(201);
      expect(bucket.objects.map((o) => o.name)).toEqual([secondUrl.slice(BASE_URL.length)]);
      clock.mockRestore();

      // The mechanism, asserted after the behaviour on purpose: against the
      // unfixed route the failure above is a user-visible broken image, and a
      // missing report field would otherwise fail first and hide it.
      expect(fakeDb.rows('photo_hashes').map((r) => r.url)).toEqual([secondUrl]);
      expect(body.hashRowsDeleted).toBe(1);
      expect(body.hashInvalidationComplete).toBe(true);
    });

    it('leaves the hash row of an object storage did not confirm removing', async () => {
      // `remove()` answers 200 with the rows it DID delete; a path it declined is
      // simply absent from that list. Dropping a hash row because the call did not
      // error would lose dedupe for an image that is still sitting there — the
      // milder of the two mistakes, but still a mistake, and avoidable.
      const survives = 'user-9/survives.jpg';
      const gone = 'user-9/really-deleted.jpg';
      fakeDb.seed('meals', []);
      fakeDb.seed('photo_hashes', [
        { hash: 'aaa', url: `${BASE_URL}${survives}` },
        { hash: 'bbb', url: `${BASE_URL}${gone}` },
      ]);
      bucket.objects = [{ name: survives, size: 1 }, { name: gone, size: 1 }];
      bucket.undeletable = new Set([survives]);

      const body = await (await run()).json();

      expect(fakeDb.rows('photo_hashes').map((r) => r.hash)).toEqual(['aaa']);
      expect(body.removalsConfirmed).toBe(1);
      expect(body.removalsUnconfirmed).toBe(1);
      expect(body.hashRowsDeleted).toBe(1);
      expect(body.warnings.join(' ')).toContain('did not confirm');
    });

    it('invalidates nothing when the removal itself failed', async () => {
      fakeDb.seed('meals', []);
      fakeDb.seed('photo_hashes', [{ hash: 'aaa', url: `${BASE_URL}user-9/x.jpg` }]);
      bucket.objects = [{ name: 'user-9/x.jpg', size: 1 }];
      bucket.removeError = { message: 'storage unavailable' };

      const body = await (await run()).json();

      expect(body.deleted).toBe(0);
      expect(body.removalsUnconfirmed).toBe(1);
      expect(body.hashRowsDeleted).toBe(0);
      expect(fakeDb.rows('photo_hashes')).toHaveLength(1);
    });

    it('says so when the hash delete fails, rather than reporting a clean sweep', async () => {
      // This route had never written to `photo_hashes` before, so a failure here is
      // a new way for a sweep to be half-done: the object is gone and the poisoned
      // row is still there. Reported, not swallowed — and re-running fixes it.
      fakeDb.seed('meals', []);
      fakeDb.seed('photo_hashes', [{ hash: 'aaa', url: `${BASE_URL}user-9/x.jpg` }]);
      fakeDb.queue('photo_hashes', { data: null, error: { message: 'statement timeout' } });
      bucket.objects = [{ name: 'user-9/x.jpg', size: 1 }];

      const res = await run();
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.deleted).toBe(1);
      expect(body.hashInvalidationComplete).toBe(false);
      expect(body.hashDeletesFailed).toBe(1);
      expect(body.warnings.join(' ')).toContain('statement timeout');
      expect(fakeDb.rows('photo_hashes')).toHaveLength(1);
      expect(
        log.mock.calls.some(
          (call) => (call[0] as { reason?: string })?.reason === 'photo_hashes invalidation incomplete',
        ),
      ).toBe(true);
    });

    it('deletes no hash rows on a dry run, or on a run either gate blocked', async () => {
      fakeDb.seed('meals', []);
      fakeDb.seed('photo_hashes', [{ hash: 'aaa', url: `${BASE_URL}user-9/orphan.jpg` }]);
      bucket.objects = [{ name: 'user-9/orphan.jpg', size: 1 }];

      expect((await run('?dryRun=true')).status).toBe(200);
      expect(fakeDb.rows('photo_hashes')).toHaveLength(1);
      expect(bucket.removed).toEqual([]);

      // Gate 1, live and dry. A cache pruned by a run that refused to delete
      // anything would be MEAL-126's mistake in a new place: acting on a keep-set
      // the route has already said it does not trust.
      fakeDb.queue('meals', { data: null, count: 7 });
      expect((await run()).status).toBe(409);
      expect(fakeDb.rows('photo_hashes')).toHaveLength(1);
      fakeDb.queue('meals', { data: null, count: 7 });
      expect((await run('?dryRun=true')).status).toBe(409);
      expect(fakeDb.rows('photo_hashes')).toHaveLength(1);

      // Gate 2.
      bucket.objects = Array.from({ length: 120 }, (_, i) => ({ name: `user-1/p-${i}.jpg`, size: 1 }));
      expect((await run()).status).toBe(409);
      expect(fakeDb.rows('photo_hashes')).toHaveLength(1);
      expect(bucket.removed).toEqual([]);
    });

    it('chunks the hash delete so a big sweep does not 414', async () => {
      // `.in('url', […])` rides in the query string and a public URL encodes to
      // ~155 bytes, so one delete for 250 objects would be a ~39 KB URI — which the
      // fake rejects exactly like the proxies in front of PostgREST. Unchunked, the
      // rows left behind would be the poisoned ones, on the largest sweeps only.
      const paths = Array.from(
        { length: 250 },
        (_, i) => `user-9/bulk-${String(i).padStart(4, '0')}.jpg`,
      );
      fakeDb.seed('meals', []);
      fakeDb.seed('photo_hashes', paths.map((p, i) => ({ hash: `h-${i}`, url: `${BASE_URL}${p}` })));
      bucket.objects = paths.map((name) => ({ name, size: 1 }));

      // The whole bucket is orphaned, which is what Gate 2 is for; `force=true` is
      // the operator having read the dry-run list and confirmed it.
      const body = await (await run('?force=true')).json();

      expect(body.hashRowsDeleted).toBe(250);
      expect(body.hashInvalidationComplete).toBe(true);
      expect(fakeDb.rows('photo_hashes')).toEqual([]);
    });
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

  // ── MEAL-133: the upload/save window ──────────────────────────────────────
  //
  // `/api/images/upload` returns a public URL BEFORE anything references it — the
  // meal, profile or draft that will point at it is saved in a later request. For
  // those seconds a live photo is referenced by no row anywhere, and a sweep
  // landing in the window deleted it. Neither gate can see one object: the
  // keep-set reconciles perfectly and one photo is nowhere near half the bucket.
  describe('an object may be mid-way through being attached', () => {
    /** Minutes ago, as PostgREST renders `storage.objects.created_at`. */
    const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();

    it('does not delete an object uploaded minutes ago, but does delete an old one', async () => {
      fakeDb.seed('meals', []);
      bucket.objects = [
        { name: 'user-1/just-uploaded.jpg', size: 10, createdAt: minutesAgo(3) },
        { name: 'user-1/abandoned-long-ago.jpg', size: 10, createdAt: minutesAgo(60 * 24 * 30) },
      ];

      const res = await run();
      const body = await res.json();

      expect(res.status).toBe(200);
      // The whole bug: against the unfixed route both are deleted, and the save
      // that follows the upload lands on a URL with nothing behind it.
      expect(bucket.removed).toEqual(['user-1/abandoned-long-ago.jpg']);
      expect(body.objectsTooNewToDelete).toBe(1);
      expect(body.orphanCount).toBe(1);
      // Reported as unreferenced all the same — held back, not overlooked.
      expect(body.unreferencedCount).toBe(2);
      expect(body.ageFilterAvailable).toBe(true);
      expect(body.graceWindowMinutes).toBe(60);
    });

    it('keeps an object whose created_at is null — unknown age is never treated as old', async () => {
      // `storage.objects.created_at` is nullable, so this is a real row and not a
      // hypothetical. A missing age must resolve toward keeping the object; the
      // opposite reading turns every such row back into the bug.
      fakeDb.seed('meals', []);
      bucket.objects = [
        { name: 'user-1/no-timestamp.jpg', size: 10, createdAt: null },
        { name: 'user-1/old.jpg', size: 10 },
      ];

      const res = await run();
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(bucket.removed).toEqual(['user-1/old.jpg']);
      expect(body.objectsTooNewToDelete).toBe(1);
    });

    it('keeps an object whose created_at is not a timestamp at all', async () => {
      // An unexpected shape may not widen the delete set either.
      fakeDb.seed('meals', []);
      bucket.objects = [{ name: 'user-1/garbled.jpg', size: 10, createdAt: 'not a date' }];

      expect((await run()).status).toBe(200);
      expect(bucket.removed).toEqual([]);
    });

    it('refuses to read a number as a timestamp rather than guessing at its unit', async () => {
      // `toEpochMs` takes strings only, and this is the reason. PostgREST renders a
      // `timestamptz` as a string, so a number arriving here means something has
      // already broken upstream — but if it were accepted, epoch SECONDS would be
      // read as epoch milliseconds, put this object in 1970, and make a photo
      // uploaded a moment ago the oldest thing in the bucket. Unknown age keeps the
      // object; a guess in the wrong unit deletes it.
      fakeDb.seed('meals', []);
      bucket.objects = [
        { name: 'user-1/epoch-seconds.jpg', size: 10, createdAt: Math.floor(Date.now() / 1000) },
      ];

      const body = await (await run()).json();

      expect(bucket.removed).toEqual([]);
      expect(body.objectsTooNewToDelete).toBe(1);
      expect(body.orphanCount).toBe(0);
    });

    it('survives a sweep between the upload and the save, then is swept once abandoned', async () => {
      // The bug end to end, through the real upload route: the URL is handed out,
      // the sweep runs before the meal is saved, and the object must still be
      // there afterwards. Then time passes, nothing ever referenced it, and the
      // same sweep is right to take it — the fix is a delay, not an exemption.
      fakeDb.seed('meals', []);
      fakeDb.seed('photo_hashes', []);

      const clock = vi.spyOn(Date, 'now');
      const t0 = new Date().getTime();
      clock.mockReturnValue(t0);

      const uploaded = await uploadImage(jsonRequest('/api/images/upload', {
        method: 'POST',
        body: { imageData: `data:image/png;base64,${Buffer.from('mid-attach').toString('base64')}` },
        token,
      }));
      expect(uploaded.status).toBe(201);
      const path = ((await uploaded.json()).url as string).slice(BASE_URL.length);

      // Twelve seconds later: the user is still on the form.
      clock.mockReturnValue(t0 + 12_000);
      const during = await run();
      expect(during.status).toBe(200);
      expect(bucket.removed).toEqual([]);
      expect(bucket.has(path)).toBe(true);
      expect((await during.json()).objectsTooNewToDelete).toBe(1);

      // Two hours later the save never happened, so it really is an orphan.
      clock.mockReturnValue(t0 + 2 * 60 * 60 * 1000);
      const after = await run();
      expect(after.status).toBe(200);
      expect(bucket.removed).toEqual([path]);
      clock.mockRestore();
    });

    it('does not let young objects dilute the orphan-share ceiling', async () => {
      // Gate 2 is scored on UNREFERENCED objects, not on the delete set. Every one
      // of these 120 is unreferenced — the shape a BASE_URL drift produces — and
      // half of them being new must not drop the share under the ceiling and turn
      // a refusal into a partial sweep.
      fakeDb.seed('meals', []);
      bucket.objects = Array.from({ length: 120 }, (_, i) => ({
        name: `user-1/p-${i}.jpg`,
        size: 100,
        createdAt: i % 2 === 0 ? minutesAgo(1) : minutesAgo(60 * 24 * 30),
      }));

      const res = await run();
      const body = await res.json();

      expect(res.status).toBe(409);
      expect(body.blocked).toBe(true);
      expect(body.orphanShare).toBe(1);
      expect(body.unreferencedCount).toBe(120);
      expect(bucket.removed).toEqual([]);
    });

    it('does not let force=true switch the grace window off along with the share ceiling', async () => {
      // `force` is scoped to Gate 2 — a judgement call about a proportion — and the
      // grace window is not a judgement, it is a fact about how old an object is. The
      // two are easy to conflate because `force` is what the previous test's own
      // error text tells an operator to reach for, and it is reached for on exactly
      // the sweeps where MEAL-133 costs the most: the first pass over a bucket that
      // has never been cleaned, where the share is over the ceiling and hundreds of
      // objects go at once. Wiring `force` into `splitByAge` would reintroduce the
      // bug silently, on the largest sweeps only, and every other test here would
      // still pass — so this is the assertion that says the flag stops at Gate 2.
      fakeDb.seed('meals', []);
      bucket.objects = [
        { name: 'user-1/mid-attach.jpg', size: 100, createdAt: minutesAgo(2) },
        ...Array.from({ length: 119 }, (_, i) => ({
          name: `user-1/p-${String(i).padStart(3, '0')}.jpg`,
          size: 100,
          createdAt: minutesAgo(60 * 24 * 30),
        })),
      ];

      const res = await run('?force=true');
      const body = await res.json();

      // The override did its job: Gate 2 stood down and the old objects went.
      expect(res.status).toBe(200);
      expect(body.forced).toBe(true);
      expect(body.deleted).toBe(119);
      // And the object uploaded two minutes ago is still there.
      expect(bucket.removed).not.toContain('user-1/mid-attach.jpg');
      expect(bucket.has('user-1/mid-attach.jpg')).toBe(true);
      expect(body.objectsTooNewToDelete).toBe(1);
      expect(body.ageFilterAvailable).toBe(true);
    });

    // ── Both shapes of the RPC ──────────────────────────────────────────────
    //
    // The migration that adds `created_at` can only be applied by hand, so this
    // code runs against the old two-column function until it is. Pre-migration
    // behaviour has to be today's behaviour: no age is knowable, so nothing is
    // protected — and the response has to say that plainly, because a sweep with
    // no age filter is a sweep that can still hit MEAL-133.
    it('falls back to the old behaviour, loudly, when the RPC returns no created_at', async () => {
      bucket.rpcHasCreatedAt = false;
      fakeDb.seed('meals', []);
      bucket.objects = [{ name: 'user-1/just-uploaded.jpg', size: 10, createdAt: minutesAgo(1) }];

      const res = await run();
      const body = await res.json();

      expect(res.status).toBe(200);
      // Today's behaviour, not an error and not a silent no-op that would report
      // zero orphans and look like success.
      expect(bucket.removed).toEqual(['user-1/just-uploaded.jpg']);
      expect(body.ageFilterAvailable).toBe(false);
      expect(body.objectsTooNewToDelete).toBe(0);
      expect(body.warnings.join(' ')).toContain('created_at');
      expect(body.warnings.join(' ')).toContain('MEAL-133');
    });

    it('protects the same object once the migration has been applied', async () => {
      // The pair. Same bucket, same sweep, only the function's shape differs — so
      // this pins the protection to the migration rather than to anything else in
      // the fixture, and shows the two shapes are told apart by the column being
      // absent rather than by its value.
      fakeDb.seed('meals', []);
      bucket.objects = [{ name: 'user-1/just-uploaded.jpg', size: 10, createdAt: minutesAgo(1) }];

      const body = await (await run()).json();

      expect(bucket.removed).toEqual([]);
      expect(body.ageFilterAvailable).toBe(true);
      expect(body.objectsTooNewToDelete).toBe(1);
      expect(body.warnings).toBeUndefined();
    });

    it('tells the two shapes apart by the column being present, not by it having a value', async () => {
      // The migration is detected on the KEY (`'created_at' in row`), never on the
      // value, and this is the case where the difference shows. Every object here is
      // post-migration with a null `created_at` — a real row, since
      // `storage.objects.created_at` is nullable. Reading the VALUE instead would
      // conclude the column is absent, fall back to the pre-migration path, and
      // delete the whole bucket while reporting `ageFilterAvailable: true`'s opposite
      // as if the migration had never been applied. The other null test cannot see
      // this, because it seeds a second object with a real timestamp, which makes the
      // column look present under either reading.
      fakeDb.seed('meals', []);
      bucket.objects = [
        { name: 'user-1/a.jpg', size: 10, createdAt: null },
        { name: 'user-1/b.jpg', size: 10, createdAt: null },
      ];

      const res = await run();
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(bucket.removed).toEqual([]);
      // The migration IS applied — unknown age, not an unmigrated function.
      expect(body.ageFilterAvailable).toBe(true);
      expect(body.objectsTooNewToDelete).toBe(2);
      expect(body.warnings).toBeUndefined();
    });
  });

  // ── MEAL-134: the bucket listing is a paged read like any other ────────────
  //
  // `list_storage_objects` is a set-returning function, and PostgREST caps one of
  // those at `db-max-rows` exactly as it caps a table. The route asked for the
  // bucket in a single call, so it saw the first 1000 objects and nothing said so.
  // Under-deleting is the safe direction, but the function has no ORDER BY, so
  // WHICH 1000 was arbitrary: an operator sweeping to reclaim space watched the
  // total plateau while most of the bucket had never been looked at.
  describe('the bucket listing past 1000 objects', () => {
    it('considers every object in a bucket larger than one page', async () => {
      // 1200 objects, 1199 of them live. The single orphan sorts LAST by name, so
      // it is on the second page and the unpaged read could never reach it — this
      // is the assertion that fails when the paging is reverted.
      const live = mealsWithPhotos(1199, 'big');
      fakeDb.seed('meals', live);
      const orphan = { name: 'zz-user-9/past-the-ceiling.jpg', size: 77 };
      bucket.objects = [...objectsFor(live), orphan];

      const res = await run();
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.objectsListed).toBe(1200);
      expect(body.objectListComplete).toBe(true);
      expect(bucket.removed).toEqual([orphan.name]);
      expect(body.estimatedBytes).toBe(77);
    });

    it('says the listing is complete rather than guessing from its length', async () => {
      // The old flag was `length >= 1000`, so a bucket of exactly 1000 objects was
      // reported as "maybe truncated" forever. Paging turns that into a fact.
      const live = mealsWithPhotos(DEFAULT_PAGE_ROWS, 'trunc');
      fakeDb.seed('meals', live);
      bucket.objects = objectsFor(live);

      const body = await (await run('?dryRun=true')).json();

      expect(body.objectsListed).toBe(DEFAULT_PAGE_ROWS);
      expect(body.objectListComplete).toBe(true);
      expect(body.objectListMaybeTruncated).toBe(false);
    });

    it('deletes nothing when a page of the listing fails', async () => {
      // A page that errors is fatal to the whole listing, exactly as it is for the
      // keep-set: `data ?? []` would make a failed page and an exhausted bucket the
      // same value, and everything the missing page held would be absent from the
      // list — which for the OBJECT side is only an under-delete, but leaves every
      // number in the response describing a fraction of the bucket.
      fakeDb.seed('meals', []);
      bucket.objects = [{ name: 'user-9/orphan.jpg', size: 1 }];
      // A full first page, so the read is partial rather than empty, then a failure.
      fakeDb.queue('rpc:list_storage_objects', {
        data: Array.from({ length: DEFAULT_PAGE_ROWS }, (_, i) => ({
          name: `user-1/page-one-${i}.jpg`, size: 1, created_at: '2020-01-01T00:00:00+00:00',
        })),
      });
      fakeDb.queue('rpc:list_storage_objects', { data: null, error: { message: 'connection reset' } });

      const res = await run();
      const body = await res.json();

      expect(res.status).toBe(500);
      expect(body.error).toContain('connection reset');
      expect(bucket.removed).toEqual([]);
    });

    it('refuses when the listing hits its page ceiling', async () => {
      // A bucket that never ends — a paging bug, or 200,000 real objects. Either
      // way the listing is a prefix, so Gate 1 refuses rather than sweeping the
      // part it happens to have seen.
      fakeDb.seed('meals', []);
      const fullPage = Array.from({ length: DEFAULT_PAGE_ROWS }, (_, i) => ({
        name: `user-1/endless-${i}.jpg`, size: 1, created_at: '2020-01-01T00:00:00+00:00',
      }));
      for (let page = 0; page < 200; page++) {
        fakeDb.queue('rpc:list_storage_objects', { data: fullPage });
      }

      const res = await run();
      const body = await res.json();

      expect(res.status).toBe(409);
      expect(body.blocked).toBe(true);
      expect(body.reason).toContain('page ceiling');
      expect(body.objectListComplete).toBe(false);
      expect(body.objectListMaybeTruncated).toBe(true);
      expect(bucket.removed).toEqual([]);
    });

    it('refuses the DRY RUN on an incomplete listing too', async () => {
      // Same reasoning as Gate 1's existing refusal of a dry run: the numbers a dry
      // run prints are the whole point of running one, and these ones would be
      // computed over an unknown fraction of the bucket.
      fakeDb.seed('meals', []);
      const fullPage = Array.from({ length: DEFAULT_PAGE_ROWS }, (_, i) => ({
        name: `user-1/endless-${i}.jpg`, size: 1, created_at: '2020-01-01T00:00:00+00:00',
      }));
      for (let page = 0; page < 200; page++) {
        fakeDb.queue('rpc:list_storage_objects', { data: fullPage });
      }

      const res = await run('?dryRun=true');
      const body = await res.json();

      expect(res.status).toBe(409);
      expect(body.paths).toBeUndefined();
      expect(body.orphanCount).toBeUndefined();
    });

    it('does not let force=true override an incomplete listing', async () => {
      // `force` overrules Gate 2's judgement call, never Gate 1's defect report.
      fakeDb.seed('meals', []);
      const fullPage = Array.from({ length: DEFAULT_PAGE_ROWS }, (_, i) => ({
        name: `user-1/endless-${i}.jpg`, size: 1, created_at: '2020-01-01T00:00:00+00:00',
      }));
      for (let page = 0; page < 200; page++) {
        fakeDb.queue('rpc:list_storage_objects', { data: fullPage });
      }

      expect((await run('?force=true')).status).toBe(409);
      expect(bucket.removed).toEqual([]);
    });

    it('does not count or delete the same object twice when the walk repeats one', async () => {
      // An OFFSET walk over a bucket that is being uploaded to can hand one object
      // back on two pages, because an upload sorting earlier shifts everything after
      // it forward. Names are unique in a bucket, so a repeat is always the walk.
      fakeDb.seed('meals', []);
      const page = Array.from({ length: DEFAULT_PAGE_ROWS }, (_, i) => ({
        name: `user-9/gone-${String(i).padStart(4, '0')}.jpg`, size: 1,
        created_at: '2020-01-01T00:00:00+00:00',
      }));
      fakeDb.queue('rpc:list_storage_objects', { data: page });
      // The shifted page: one object seen again, then the end of the bucket.
      fakeDb.queue('rpc:list_storage_objects', { data: [page[0]] });
      bucket.objects = page.map((o) => ({ name: o.name, size: o.size }));

      const body = await (await run('?force=true')).json();

      expect(body.objectsListed).toBe(DEFAULT_PAGE_ROWS);
      expect(bucket.removed.filter((p) => p === page[0].name)).toEqual([page[0].name]);
      expect(body.estimatedBytes).toBe(DEFAULT_PAGE_ROWS);
    });

    it('orders the listing so the pages partition the bucket', async () => {
      // An OFFSET walk with no ORDER BY may return one row twice and skip another,
      // and a skipped object is one no sweep ever considers however often it runs —
      // MEAL-134's "the total plateaus for no visible reason".
      fakeDb.seed('meals', []);
      bucket.objects = [{ name: 'user-1/only.jpg', size: 1 }];

      await run();

      const listCalls = fakeDb.calls.filter((c) => c.table === 'rpc:list_storage_objects');
      expect(listCalls.some((c) => c.method === 'order' && c.args[0] === 'name')).toBe(true);
      expect(listCalls.some((c) => c.method === 'range')).toBe(true);
    });
  });

  it('still requires an admin', async () => {
    const res = await POST(jsonRequest('/api/admin/storage/cleanup-orphans', { method: 'POST' }));
    expect(res.status).toBe(401);
    expect(bucket.removed).toEqual([]);
  });
});
