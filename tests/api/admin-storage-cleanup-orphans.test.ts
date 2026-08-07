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
      const sweep = await run();
      const body = await sweep.json();
      expect(sweep.status).toBe(200);
      expect(bucket.removed).toEqual([deadPath]);

      clock.mockReturnValue(t0 + 9_999);
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
