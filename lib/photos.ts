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

  // Detect our proxy URL: pathname must be /api/meals/pixabay-image
  let pixabayUrl: string | null = null;
  try {
    const parsed = new URL(photoUrl);
    if (parsed.pathname === PROXY_PATH) {
      const param = parsed.searchParams.get('url');
      if (param?.startsWith('https://pixabay.com/')) {
        pixabayUrl = param;
      }
    }
  } catch {
    // base64 data URLs and other non-http strings land here — pass through
    return photoUrl;
  }

  if (!pixabayUrl) return photoUrl; // already a resolved URL, pass through

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

  const contentType = imgRes.headers.get('content-type') ?? 'image/jpeg';
  const arrayBuf = await imgRes.arrayBuffer();
  const buffer = Buffer.from(arrayBuf);
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
    return photoUrl; // fall back to proxy URL
  }

  const { data: { publicUrl } } = supabase.storage
    .from('meal-photos')
    .getPublicUrl(data.path);

  // Record hash (upsert handles race conditions gracefully)
  await supabase.from('photo_hashes').upsert({ hash, url: publicUrl }, { onConflict: 'hash', ignoreDuplicates: true });

  log({ event: 'PHOTO:UPLOAD', status: 'success', userId, detail: publicUrl });
  return publicUrl;
}
