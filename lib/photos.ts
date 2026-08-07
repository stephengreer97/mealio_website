import { createHash } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createServerSupabaseClient } from './supabase';
import { log, type EventType } from './logger';

const PROXY_PATH = '/api/meals/pixabay-image';

/**
 * The bucket every stored photo lives in.
 *
 * Named once because three things now have to agree about it: the upload, the
 * public URL the dedupe row records, and the probe that decides whether that row
 * is still true.
 */
export const MEAL_PHOTOS_BUCKET = 'meal-photos';

/**
 * How long the dedupe cache's existence probe may take before it is abandoned.
 *
 * Three seconds. The probe exists to SAVE an upload, so it is only worth paying
 * for while it stays much cheaper than the upload it avoids: a HEAD against the
 * same storage service answers in tens of milliseconds when that service is
 * healthy, and past a couple of seconds "slow" and "down" stop being worth
 * telling apart. Abandoning it costs one redundant upload; waiting on it costs
 * the whole request, on every upload of already-seen bytes, for as long as
 * storage is unwell — which is how a cache lookup becomes an outage.
 *
 * `exists()` takes no `AbortSignal`, so the deadline is a race and the loser runs
 * to completion. That costs one pending promise resolution, not a held request.
 */
const PRESENCE_TIMEOUT_MS = 3_000;

/** What a probe of the object behind a cached URL established. */
type Presence =
  /** Storage answered that the object is there. */
  | 'present'
  /** Storage answered that it is NOT there. An answer, not a failure. */
  | 'absent'
  /** Neither could be established: a 5xx, a network fault, or the deadline. */
  | 'unknown';

/**
 * Turns a stored public URL back into its path within `MEAL_PHOTOS_BUCKET`, or
 * null when the URL is not one of ours.
 *
 * The prefix is asked of `getPublicUrl` rather than hardcoded, because the row's
 * `url` was WRITTEN by `getPublicUrl` — deriving the prefix from the same
 * function that produced the string is the only way the two cannot drift, and a
 * fourth hardcoded copy of the storage host (there are three already) is a fourth
 * thing that can be wrong about which project's bucket this is. A prefix that
 * did drift makes every URL foreign, which is the safe direction below.
 */
function toObjectPath(supabase: SupabaseClient, url: string): string | null {
  const { data: { publicUrl: base } } = supabase.storage
    .from(MEAL_PHOTOS_BUCKET)
    .getPublicUrl('');
  if (!base || !url.startsWith(base)) return null;
  return url.slice(base.length) || null;
}

/**
 * Does the object at `path` still exist?
 *
 * `exists()` is the cheapest sufficient check of the four storage offers, and the
 * only one whose three answers are already distinct:
 *
 *  - `exists()` is a HEAD on the authenticated object endpoint. No body in either
 *    direction, no image bytes, one round trip. Present → `{ data: true }`;
 *    missing → `{ data: false }` (storage's own 404/400, resolved not thrown);
 *    anything else — 5xx, DNS, a dropped socket — THROWS, so a failure can never
 *    be mistaken for an absence. That last property is the one that matters, and
 *    it is why this is a two-line function instead of error-string matching.
 *  - A HEAD on the PUBLIC URL is the same shape but answers from the CDN, which
 *    caches. It can serve 200 for an object deleted a minute ago and 404 for one
 *    just written, so it can be wrong in both directions — and being wrong in the
 *    first is exactly the bug this code exists to fix.
 *  - `list(prefix, { search })` works, but it is a POST that returns matching
 *    rows, and `search` is a substring match rather than an equality, so the
 *    caller has to re-filter the result for its own filename to be sure. More
 *    bytes, more code, same information.
 *  - `createSignedUrl` signs a URL as a side effect of proving existence — a
 *    write-shaped operation, pointless for a public bucket, and it reports a
 *    missing object as a 400 whose message has to be string-matched.
 *  - Downloading a byte range transfers image bytes to answer a yes/no question,
 *    which is strictly more expensive than any of the above.
 */
async function objectPresence(supabase: SupabaseClient, path: string): Promise<Presence> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const probe: Promise<Presence> = supabase.storage
    .from(MEAL_PHOTOS_BUCKET)
    .exists(path)
    .then(
      ({ data }) => (data === true ? 'present' : 'absent'),
      // Rejection handled HERE rather than by a try/catch around the race: once
      // the deadline wins, nobody is awaiting this promise, and a storage 5xx
      // arriving afterwards would be an unhandled rejection.
      () => 'unknown',
    );

  const deadline = new Promise<Presence>((resolve) => {
    timer = setTimeout(() => resolve('unknown'), PRESENCE_TIMEOUT_MS);
  });

  try {
    return await Promise.race([probe, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Drops a `photo_hashes` row that points at an object storage says is gone.
 *
 * DELETE rather than an update to the new URL, for a reason that is not a matter
 * of taste: the insert both writers use is
 * `upsert({ hash, url }, { onConflict: 'hash', ignoreDuplicates: true })`, and
 * `ignoreDuplicates` means a row already holding this hash is LEFT ALONE. So an
 * upload that finds a poisoned row and leaves it in place repairs nothing — the
 * bytes are re-stored, this caller gets a working URL, and the very next caller
 * is handed the dead one again. Removing the row is what lets the existing insert
 * path recreate it correctly, with no change to that path's race behaviour.
 *
 * Done BEFORE the upload, and independently of whether the upload then succeeds.
 * The row is a lie either way; deleting it destroys no information and cannot
 * make things worse, and an upload that fails afterwards leaves the next attempt
 * a clean miss instead of the same dead URL.
 *
 * Keyed on the dead URL as well as the hash, so this is a compare-and-swap: if a
 * concurrent upload of the same bytes has already repaired the row, its live URL
 * does not match and this delete removes nothing rather than throwing away a good
 * row and orphaning the object it named.
 */
async function dropPoisonedRow(
  supabase: SupabaseClient,
  hash: string,
  deadUrl: string,
): Promise<boolean> {
  const { error } = await supabase
    .from('photo_hashes')
    .delete()
    .eq('hash', hash)
    .eq('url', deadUrl);
  return !error;
}

/**
 * The deduped URL for these bytes, but only if a real object still stands behind
 * it. Returns null — a cache MISS — in every other case, so the caller uploads.
 *
 * MEAL-132, read side. `photo_hashes` maps sha256 → stored URL and is consulted
 * before every upload. Trusting a row without checking the object made a deleted
 * object permanent: the next upload of those exact bytes matched the row, was
 * handed the URL of something that no longer existed, and saved a meal or a draft
 * with a broken image. Re-uploading could not fix it, because dedupe kept
 * answering the same way for the same bytes. The write-side fix (the sweep now
 * prunes the rows of objects it destroys) stops NEW poisoning; only checking on
 * read repairs the rows that past sweeps already poisoned, which is the whole
 * point of doing it here.
 *
 * THE COST PROMISE. The probe happens only on a cache HIT. A fresh upload — no
 * row for these bytes — takes exactly the path it always took: one select, then
 * the upload. It gains no round trip, and that is asserted rather than assumed
 * (`tests/api/images-upload-dedupe.test.ts`). This is the basis on which reading
 * every hit was chosen over any of the alternatives, so it has to stay true: any
 * probe moved above the row check makes every upload in the product pay for a
 * problem only re-uploads can have.
 *
 * ERROR DIRECTION. When the probe cannot establish either answer, this reports a
 * miss and the caller uploads. The two ways to be wrong are not symmetrical:
 *
 *  - Returning a cached URL whose object is gone is a broken image on the user's
 *    meal that the user CANNOT fix — re-uploading the same photo reaches this
 *    same row and gets the same dead URL. It is the bug, and it is permanent.
 *  - Uploading when the cache was in fact fine stores one duplicate object. The
 *    caller gets a live URL, nobody sees anything wrong, and the older copy
 *    becomes an orphan that the cleanup sweep reclaims. Bounded and
 *    self-correcting.
 *
 * So an unverifiable probe degrades to "behave as though the cache were empty",
 * which is precisely the behaviour that predates the cache — it adds no new hard
 * dependency on storage. If storage is genuinely down the upload that follows
 * fails and is reported the way it always was, rather than the probe inventing a
 * second failure mode. And it is not silent: an unverified hit is logged at
 * `error`, because a probe that never succeeds means every repeat upload is
 * quietly storing a duplicate.
 */
export async function verifiedDedupeUrl(
  supabase: SupabaseClient,
  hash: string,
  userId: string,
  event: EventType,
): Promise<string | null> {
  const { data: existing } = await supabase
    .from('photo_hashes')
    .select('url')
    .eq('hash', hash)
    .maybeSingle();

  const cachedUrl: string | null = existing?.url ?? null;
  if (!cachedUrl) return null; // No row. Nothing to verify, nothing to pay for.

  const path = toObjectPath(supabase, cachedUrl);
  if (!path) {
    // Not a URL in our bucket, so there is no object of ours to probe and no
    // sweep of ours that could have deleted it — the poisoning this guards
    // against cannot apply. Trusted as it always was, and without a round trip.
    return cachedUrl;
  }

  const presence = await objectPresence(supabase, path);

  if (presence === 'present') return cachedUrl;

  if (presence === 'unknown') {
    log({
      event, status: 'error', userId,
      reason: 'dedupe hit unverified',
      detail: `storing a possible duplicate rather than risk a dead URL: ${path}`,
    });
    return null;
  }

  const repaired = await dropPoisonedRow(supabase, hash, cachedUrl);
  log({
    event,
    // Not `success`: an object referenced by the cache went missing, which is
    // either a sweep that predates the write-side fix or something worse.
    status: repaired ? 'failed' : 'error',
    userId,
    reason: repaired ? 'dedupe row healed' : 'dedupe row heal failed',
    detail: repaired
      ? `dropped photo_hashes row for missing object ${path}; re-storing the bytes`
      // The upload still goes ahead, so this caller's image works. The lie stays
      // in the table for the next one, which is worth a line in the log.
      : `photo_hashes row for missing object ${path} could not be dropped`,
  });
  return null;
}

/**
 * If photoUrl is a Mealio Pixabay proxy URL, downloads the full-size image and
 * uploads it to Supabase Storage (meal-photos bucket), returning the permanent
 * public URL. All other URLs (base64, Supabase, external) are returned unchanged.
 */
export async function resolvePhotoUrl(
  photoUrl: string | null | undefined,
  userId: string,
): Promise<string | null | undefined> {
  if (!photoUrl) return photoUrl;

  // Detect Pixabay URLs that need to be permanently stored
  let pixabayUrl: string | null = null;
  try {
    const parsed = new URL(photoUrl);
    if (parsed.pathname === PROXY_PATH) {
      // Mealio proxy URL — extract the original Pixabay webformatURL
      const param = parsed.searchParams.get('url');
      if (param?.startsWith('https://pixabay.com/')) {
        pixabayUrl = param;
      }
    } else if (parsed.hostname === 'cdn.pixabay.com' || parsed.hostname === 'pixabay.com') {
      // Direct Pixabay CDN/get URL — hotlink-blocked, route through worker
      pixabayUrl = photoUrl;
    }
  } catch {
    // base64 data URLs and other non-http strings land here — pass through
    return photoUrl;
  }

  if (!pixabayUrl) return photoUrl; // already a resolved URL (e.g. Supabase Storage), pass through

  const workerUrl    = (process.env.PIXABAY_WORKER_URL ?? '').replace(/\/$/, '');
  const workerSecret = process.env.PIXABAY_WORKER_SECRET ?? '';

  // Download via Cloudflare Worker (adds required Referer header, uses shared IPs)
  let imgRes: Response;
  try {
    imgRes = await fetch(
      `${workerUrl}/image?url=${encodeURIComponent(pixabayUrl)}`,
      {
        headers: { 'Authorization': `Bearer ${workerSecret}` },
        next: { revalidate: 86400 },
      },
    );
  } catch (err) {
    log({ event: 'PHOTO:UPLOAD', status: 'error', userId, detail: 'Pixabay fetch failed', error: err });
    return photoUrl; // fall back to proxy URL — better than nothing
  }

  if (!imgRes.ok) {
    log({ event: 'PHOTO:UPLOAD', status: 'error', userId, detail: `Pixabay HTTP ${imgRes.status}` });
    return photoUrl;
  }

  let buffer: Buffer;
  let contentType: string;
  try {
    contentType = imgRes.headers.get('content-type') ?? 'image/jpeg';
    const arrayBuf = await imgRes.arrayBuffer();
    buffer = Buffer.from(arrayBuf);
  } catch (err) {
    log({ event: 'PHOTO:UPLOAD', status: 'error', userId, detail: 'Pixabay body read failed', error: err });
    return photoUrl;
  }

  const stored = await storeImageBuffer(buffer, contentType, userId);
  return stored ?? photoUrl; // fall back to proxy URL
}

/**
 * Stores image bytes in the meal-photos bucket and returns the permanent public
 * URL, or null if the upload failed.
 *
 * Extracted from `resolvePhotoUrl` so the link-import pipeline can store a
 * creator's own page image through exactly this path — same hash dedup, same
 * bucket, same public-URL shape — rather than growing a second uploader beside
 * it.
 */
export async function storeImageBuffer(
  buffer: Buffer,
  contentType: string,
  userId: string,
): Promise<string | null> {
  const hash = createHash('sha256').update(buffer).digest('hex');
  const ext = contentType.includes('png') ? 'png' : contentType.includes('webp') ? 'webp' : 'jpg';

  const supabase = createServerSupabaseClient();

  // Check for existing duplicate — and that the object it names is still there.
  // A hit whose object has been swept is a cache MISS, not a URL to hand back.
  const deduped = await verifiedDedupeUrl(supabase, hash, userId, 'PHOTO:UPLOAD');
  if (deduped) {
    log({ event: 'PHOTO:UPLOAD', status: 'success', userId, detail: `dedup:${deduped}` });
    return deduped;
  }

  const path = `${userId}/${Date.now()}.${ext}`;
  const { data, error } = await supabase.storage
    .from(MEAL_PHOTOS_BUCKET)
    .upload(path, buffer, { contentType, upsert: false });

  if (error) {
    log({ event: 'PHOTO:UPLOAD', status: 'error', userId, detail: 'Supabase Storage upload failed', error });
    return null;
  }

  const { data: { publicUrl } } = supabase.storage
    .from(MEAL_PHOTOS_BUCKET)
    .getPublicUrl(data.path);

  // Record hash (upsert handles race conditions gracefully). `ignoreDuplicates`
  // means this does NOT overwrite a row already holding the hash, which is why
  // `verifiedDedupeUrl` deletes a poisoned row rather than leaving it for this
  // line to correct — see `dropPoisonedRow`.
  await supabase.from('photo_hashes').upsert({ hash, url: publicUrl }, { onConflict: 'hash', ignoreDuplicates: true });

  log({ event: 'PHOTO:UPLOAD', status: 'success', userId, detail: publicUrl });
  return publicUrl;
}

const WORKER_URL = (process.env.PIXABAY_WORKER_URL ?? '').replace(/\/$/, '');
const WORKER_SECRET = process.env.PIXABAY_WORKER_SECRET ?? '';

export interface PixabayHit {
  previewURL: string;
  webformatURL: string;
}

/**
 * Searches Pixabay through the Cloudflare worker.
 *
 * Lifted out of `app/api/meals/generate-photo/route.ts` so the route and the
 * link-import pipeline share one implementation — the worker URL, the auth
 * header and the cache window are all easy to get subtly wrong twice.
 */
export async function pixabaySearch(query: string, perPage = 5): Promise<PixabayHit[]> {
  const apiKey = process.env.PIXABAY_API_KEY;
  if (!apiKey || !WORKER_URL) return [];
  const url =
    `${WORKER_URL}/api?key=${apiKey}&q=${encodeURIComponent(query)}` +
    `&image_type=photo&safesearch=true&per_page=${perPage}`;
  // Cache search results for 1 hour — same meal name always returns the same images
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${WORKER_SECRET}` },
    next: { revalidate: 3600 },
  });
  if (!res.ok) return [];
  const data = (await res.json()) as { hits?: PixabayHit[] };
  return data.hits ?? [];
}

/** Wraps a Pixabay `webformatURL` in the proxy URL `resolvePhotoUrl` understands. */
export function pixabayProxyUrl(webformatURL: string): string {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
  return `${appUrl}${PROXY_PATH}?url=${encodeURIComponent(webformatURL)}`;
}

/**
 * Finds a stand-in photo for a meal name and stores it in our own bucket.
 *
 * Used when a source page has no usable image. Returns a permanent Supabase URL
 * or null — never a Pixabay URL, because storing is the whole point.
 */
export async function pixabayPhotoFor(mealName: string, userId: string): Promise<string | null> {
  const name = mealName.trim();
  if (!name) return null;

  const words = name.split(/\s+/);
  const lastWord = words[words.length - 1];

  // Same widening the generate-photo route uses: full name, then the head noun.
  for (const query of [name, `${lastWord} food`]) {
    let hits: PixabayHit[] = [];
    try {
      hits = await pixabaySearch(query, 3);
    } catch (err) {
      log({ event: 'PHOTO:GENERATE', status: 'error', userId, detail: `Pixabay search threw for "${query}"`, error: err });
      continue;
    }
    for (const hit of hits) {
      const stored = await resolvePhotoUrl(pixabayProxyUrl(hit.webformatURL), userId);
      // resolvePhotoUrl returns the proxy URL unchanged when storage fails; a
      // proxy URL is not a photo we can publish, so treat that as a miss.
      if (stored && !stored.includes(PROXY_PATH)) return stored;
    }
  }

  log({ event: 'PHOTO:GENERATE', status: 'error', userId, detail: `No Pixabay result for "${name}"` });
  return null;
}
