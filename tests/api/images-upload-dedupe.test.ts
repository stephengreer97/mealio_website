import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHash } from 'crypto';
import { fakeDb } from '../helpers/supabase-mock';
import { fakeStorage as bucket, mockSupabaseWithStorage, STORAGE_BASE_URL } from '../helpers/storage-mock';
import { jsonRequest } from '../helpers/request';

// The same bucket double the cleanup route's tests drive, on purpose: MEAL-132 is
// one bug with its write half in the sweep and its read half here, and only a
// shared model of the object side can show both halves. `exists()` in particular
// is modelled with its real three answers — present, absent, and THROWN — because
// this file's whole subject is which of those may prune a cache row.
vi.mock('@/lib/supabase', () => mockSupabaseWithStorage());

const log = vi.fn();
vi.mock('@/lib/logger', () => ({ log: (...args: unknown[]) => log(...args) }));

import { POST as uploadImage } from '@/app/api/images/upload/route';
import { storeImageBuffer } from '@/lib/photos';
import { clearRevocationCache, createAccessToken } from '@/lib/tokens';

const USER = 'user-7';

/** The bytes, as a stable label. Same label ⇒ same buffer ⇒ same sha256. */
const PNG = 'one small png, byte for byte';

const sha = (label: string) => createHash('sha256').update(Buffer.from(label)).digest('hex');
const dataUrl = (label: string) => `data:image/png;base64,${Buffer.from(label).toString('base64')}`;
const publicUrl = (path: string) => `${STORAGE_BASE_URL}${path}`;
const pathOf = (url: string) => url.slice(STORAGE_BASE_URL.length);

/** Every log line's payload, for asserting a decision was said out loud. */
const logged = () => log.mock.calls.map((c) => c[0] as Record<string, unknown>);

/**
 * A dedupe cache that maps these bytes to `url`.
 *
 * The one row is seeded, not written by an earlier upload, because the rows this
 * fix repairs were written by an earlier VERSION of the code — before the sweep
 * pruned what it deleted — and the only thing that distinguishes them is whether
 * the object they name is in the bucket.
 */
function cacheRowFor(url: string) {
  fakeDb.seed('photo_hashes', [{ hash: sha(PNG), url }]);
}

describe('the photo dedupe cache must not hand back a URL whose object is gone', () => {
  let token: string;

  const upload = (label = PNG) =>
    uploadImage(jsonRequest('/api/images/upload', {
      method: 'POST',
      body: { imageData: dataUrl(label) },
      token,
    }));

  beforeEach(async () => {
    fakeDb.reset();
    bucket.reset();
    log.mockClear();
    token = await createAccessToken(USER, 'cook@mealio.co');
    clearRevocationCache();
    fakeDb.seed('user_profiles', [
      { id: USER, email: 'cook@mealio.co', tokens_invalidated_at: null },
    ]);
    fakeDb.seed('photo_hashes', []);
  });

  // ── MEAL-132, read side ─────────────────────────────────────────────────────
  //
  // A `photo_hashes` row is a claim that these exact bytes are already stored at
  // this URL. Trusting it without checking made a deleted object PERMANENT: the
  // next upload of those bytes matched the row, was handed a URL with nothing
  // behind it, and saved a meal or a draft with a broken image — and re-uploading
  // could not fix it, because dedupe kept answering the same way for the same
  // bytes. The sweep no longer leaves such rows behind, but every row a past sweep
  // poisoned is still poisoned, and only the read side can repair those.

  it('refuses a dedupe hit whose object was swept, and heals the row', async () => {
    const deadPath = `${USER}/swept-by-an-older-sweep.png`;
    const deadUrl = publicUrl(deadPath);
    cacheRowFor(deadUrl);
    // The state the fix is for: a row, and no object. Nothing else about the row
    // says anything is wrong with it.
    expect(bucket.has(deadPath)).toBe(false);

    const res = await upload();
    const body = await res.json();

    // 201 is the store-it path and 200 is the dedupe path, so the status alone
    // says dedupe was refused rather than merely answering differently.
    expect(res.status).toBe(201);
    expect(body.url).not.toBe(deadUrl);
    expect(bucket.existsCalls).toEqual([deadPath]);
    // A real object stands behind what was handed back.
    expect(bucket.names()).toEqual([pathOf(body.url)]);

    // Healed, and this is the assertion the DELETE exists for. The insert that
    // follows an upload is `upsert(…, { ignoreDuplicates: true })` — ON CONFLICT
    // DO NOTHING — so a poisoned row left in place is not corrected by it. Without
    // dropping the row first, this table would still name the dead object.
    expect(fakeDb.rows('photo_hashes')).toEqual([{ hash: sha(PNG), url: body.url }]);

    // And the poisoning is gone rather than deferred: the NEXT upload of the same
    // bytes dedupes against the healed row, which is the behaviour the cache is
    // for. Against the unfixed code this call returned the dead URL forever.
    const again = await upload();
    expect(again.status).toBe(200);
    expect((await again.json()).url).toBe(body.url);
  });

  it('returns the cached URL when the object is still there, and uploads nothing', async () => {
    const livePath = `${USER}/still-here.png`;
    const liveUrl = publicUrl(livePath);
    cacheRowFor(liveUrl);
    bucket.objects = [{ name: livePath, size: 26 }];

    const res = await upload();

    expect(res.status).toBe(200);
    expect((await res.json()).url).toBe(liveUrl);
    expect(bucket.existsCalls).toEqual([livePath]);
    // The saving the cache exists for. Verifying a hit must not cost the upload it
    // is avoiding — a check that stored the bytes anyway would be a slower no-op.
    expect(bucket.uploaded).toEqual([]);
    expect(bucket.names()).toEqual([livePath]);
    expect(fakeDb.rows('photo_hashes')).toEqual([{ hash: sha(PNG), url: liveUrl }]);
  });

  it('puts no existence check in front of a FRESH upload', async () => {
    // The cost promise, and the basis on which checking every hit was chosen over
    // the alternatives: an image nobody has uploaded before pays nothing for this.
    // There is no row to verify, so there is nothing to ask storage about, and the
    // request is byte for byte the one it always was — one select, then the upload.
    //
    // Pinned rather than assumed, because the cheap way to write this fix is a
    // probe before the row lookup, and that would put a storage round trip in
    // front of every upload in the product to guard against something only a
    // REPEAT upload can hit.
    const res = await upload();

    expect(res.status).toBe(201);
    expect(bucket.existsCalls).toEqual([]);
    expect(bucket.uploaded).toHaveLength(1);
    expect(fakeDb.rows('photo_hashes')).toEqual([
      { hash: sha(PNG), url: publicUrl(bucket.uploaded[0]) },
    ]);
  });

  it('stores a duplicate rather than hand back a URL it could not verify', async () => {
    // The direction this fails in, asserted. The probe threw — a storage 5xx, a
    // dead socket — so NOTHING was established about the object.
    //
    // The two ways to be wrong here are not symmetrical. Returning the cached URL
    // when it happens to be dead is a broken image the user cannot fix, because
    // re-uploading the same photo reaches this same row: that is the bug, and it
    // is permanent. Uploading when the cache was in fact fine stores one duplicate
    // object — the caller gets a live URL, nobody sees anything wrong, and the
    // older copy becomes an orphan the sweep reclaims. So: upload.
    const cachedPath = `${USER}/probably-fine.png`;
    const cachedUrl = publicUrl(cachedPath);
    cacheRowFor(cachedUrl);
    bucket.objects = [{ name: cachedPath, size: 26 }];
    bucket.existsError = new Error('503 Service Unavailable');

    const res = await upload();
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.url).not.toBe(cachedUrl);
    // Both copies now exist — the cost of choosing this direction, made visible.
    expect(bucket.names()).toEqual([cachedPath, pathOf(body.url)]);

    // The row is NOT dropped. Only a PROVEN absence may prune the cache, which is
    // the same rule the write half follows: a failed probe is not evidence the
    // object went away, and deleting on it would lose dedupe for a live image.
    expect(fakeDb.rows('photo_hashes')).toEqual([{ hash: sha(PNG), url: cachedUrl }]);

    // And not silently: a probe that never succeeds means every repeat upload is
    // quietly storing a second copy, so the choice is logged as a problem.
    expect(logged()).toContainEqual(expect.objectContaining({
      event: 'IMAGE:UPLOAD', status: 'error', reason: 'dedupe hit unverified',
    }));
  });

  it('abandons a probe that hangs instead of holding the upload open', async () => {
    // The bound on the new dependency. A cache lookup that waits on storage
    // without a deadline is how a dedupe hit becomes an outage: storage stops
    // answering and every upload of already-seen bytes hangs with it. The deadline
    // resolves to the same "unverified" answer as an error, so the upload
    // completes — degrading to the behaviour that predates the cache entirely.
    cacheRowFor(publicUrl(`${USER}/never-answers.png`));
    bucket.existsHangs = true;

    vi.useFakeTimers();
    try {
      const pending = upload();
      // `exists()` will never settle, so only the timer can end this.
      await vi.advanceTimersByTimeAsync(4_000);
      const res = await pending;
      expect(res.status).toBe(201);
      expect(bucket.uploaded).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('still stores the bytes when the heal delete itself fails', async () => {
    // Queued ahead of the seeded table, in the order the route asks: the dedupe
    // select answers with the poisoned row, then the delete that would heal it
    // fails. The row therefore survives, and that is the honest degradation —
    // THIS caller's image works, and the lie is still there for the next one, so
    // it is reported rather than folded into a success.
    const deadUrl = publicUrl(`${USER}/gone.png`);
    cacheRowFor(deadUrl);
    fakeDb.queue('photo_hashes', { data: { url: deadUrl } });
    fakeDb.queue('photo_hashes', { data: null, error: { message: 'statement timeout' } });

    const res = await upload();
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.url).not.toBe(deadUrl);
    expect(bucket.names()).toEqual([pathOf(body.url)]);
    expect(fakeDb.rows('photo_hashes')).toEqual([{ hash: sha(PNG), url: deadUrl }]);
    expect(logged()).toContainEqual(expect.objectContaining({
      status: 'error', reason: 'dedupe row heal failed',
    }));
  });

  it('trusts a cached URL that is not in our bucket, without a round trip', async () => {
    // No object of ours, so no sweep of ours could have deleted it and the
    // poisoning cannot apply — and there is no bucket path to probe even if it
    // could. Trusted exactly as it always was, and for free.
    const foreign = 'https://images.example.com/legacy/cover.png';
    cacheRowFor(foreign);

    const res = await upload();

    expect(res.status).toBe(200);
    expect((await res.json()).url).toBe(foreign);
    expect(bucket.existsCalls).toEqual([]);
    expect(bucket.uploaded).toEqual([]);
  });

  // ── The other call site ─────────────────────────────────────────────────────
  //
  // `storeImageBuffer` is the link-import and Pixabay path. It had its own copy of
  // the dedupe lookup, which is how one bug came to have two homes; both now go
  // through `verifiedDedupeUrl`. These two assert that the shared code is actually
  // reached from here, not that the logic works twice.
  describe('storeImageBuffer, the import path', () => {
    it('heals a poisoned row rather than returning the dead URL', async () => {
      const deadPath = `${USER}/imported-then-swept.png`;
      const deadUrl = publicUrl(deadPath);
      cacheRowFor(deadUrl);

      const stored = await storeImageBuffer(Buffer.from(PNG), 'image/png', USER);

      expect(stored).not.toBe(deadUrl);
      expect(bucket.existsCalls).toEqual([deadPath]);
      expect(bucket.names()).toEqual([pathOf(stored!)]);
      expect(fakeDb.rows('photo_hashes')).toEqual([{ hash: sha(PNG), url: stored }]);
    });

    it('pays nothing on a fresh upload', async () => {
      const stored = await storeImageBuffer(Buffer.from(PNG), 'image/png', USER);

      expect(stored).toBe(publicUrl(bucket.uploaded[0]));
      expect(bucket.existsCalls).toEqual([]);
    });
  });
});
