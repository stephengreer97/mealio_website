import { createHash } from 'crypto';
import { createServerSupabaseClient } from './supabase';
import { log } from './logger';

const PROXY_PATH = '/api/meals/pixabay-image';

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

  // Check for existing duplicate
  const { data: existing } = await supabase
    .from('photo_hashes')
    .select('url')
    .eq('hash', hash)
    .maybeSingle();

  if (existing?.url) {
    log({ event: 'PHOTO:UPLOAD', status: 'success', userId, detail: `dedup:${existing.url}` });
    return existing.url;
  }

  const path = `${userId}/${Date.now()}.${ext}`;
  const { data, error } = await supabase.storage
    .from('meal-photos')
    .upload(path, buffer, { contentType, upsert: false });

  if (error) {
    log({ event: 'PHOTO:UPLOAD', status: 'error', userId, detail: 'Supabase Storage upload failed', error });
    return null;
  }

  const { data: { publicUrl } } = supabase.storage
    .from('meal-photos')
    .getPublicUrl(data.path);

  // Record hash (upsert handles race conditions gracefully)
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
