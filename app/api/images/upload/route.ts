import { NextRequest, NextResponse } from 'next/server';
import { createHash } from 'crypto';
import { createServerSupabaseClient } from '@/lib/supabase';
import { verifyAccessToken, extractTokenFromHeader } from '@/lib/tokens';
import { MEAL_PHOTOS_BUCKET, verifiedDedupeUrl } from '@/lib/photos';
import { log } from '@/lib/logger';

export const dynamic = 'force-dynamic';

const MAX_IMAGE_BYTES = 40 * 1024 * 1024; // 40 MB

// SVG intentionally excluded — it can contain embedded scripts (XSS risk).
const EXT_MAP: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png':  'png',
  'image/gif':  'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
};

export async function POST(request: NextRequest) {
  const token = extractTokenFromHeader(request.headers.get('authorization'));
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const decoded = await verifyAccessToken(token);
  if (!decoded) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { imageData } = await request.json();
  if (!imageData || typeof imageData !== 'string') {
    return NextResponse.json({ error: 'imageData is required' }, { status: 400 });
  }

  // Parse data URL: "data:<mime>;base64,<data>"
  const match = imageData.match(/^data:([^;]+);base64,([\s\S]+)$/);
  if (!match) {
    return NextResponse.json({ error: 'Invalid image data URL' }, { status: 400 });
  }
  const mimeType = match[1];
  if (!EXT_MAP[mimeType]) {
    return NextResponse.json({ error: 'Unsupported image type' }, { status: 415 });
  }
  const base64Data = match[2];
  const ext = EXT_MAP[mimeType];

  const buffer = Buffer.from(base64Data, 'base64');
  if (buffer.length > MAX_IMAGE_BYTES) {
    return NextResponse.json({ error: 'Image too large (max 40 MB)' }, { status: 413 });
  }
  const hash = createHash('sha256').update(buffer).digest('hex');

  const supabase = createServerSupabaseClient();

  // Check for existing duplicate — shared with `storeImageBuffer` rather than
  // written twice, because the two copies of this lookup are what let the two
  // copies of the MEAL-132 bug exist. A hit whose object has been swept is a
  // cache MISS here, so the bytes are re-stored and the poisoned row repaired.
  const deduped = await verifiedDedupeUrl(supabase, hash, decoded.userId, 'IMAGE:UPLOAD');

  if (deduped) {
    log({ event: 'IMAGE:UPLOAD', status: 'success', userId: decoded.userId, reason: 'dedup', detail: deduped.split('/').pop() });
    return NextResponse.json({ url: deduped }, { status: 200 });
  }

  const path = `${decoded.userId}/${Date.now()}.${ext}`;
  const { error: uploadError } = await supabase.storage
    .from(MEAL_PHOTOS_BUCKET)
    .upload(path, buffer, { contentType: mimeType, upsert: false });

  if (uploadError) {
    log({ event: 'IMAGE:UPLOAD', status: 'error', userId: decoded.userId, error: uploadError });
    return NextResponse.json({ error: uploadError.message }, { status: 500 });
  }

  const { data: { publicUrl } } = supabase.storage
    .from(MEAL_PHOTOS_BUCKET)
    .getPublicUrl(path);

  // Record hash (upsert handles race conditions gracefully). `ignoreDuplicates`
  // leaves an existing row for this hash untouched, which is why a poisoned row
  // is DELETED on the read side rather than corrected here.
  await supabase.from('photo_hashes').upsert({ hash, url: publicUrl }, { onConflict: 'hash', ignoreDuplicates: true });

  log({ event: 'IMAGE:UPLOAD', status: 'success', userId: decoded.userId, detail: path });
  return NextResponse.json({ url: publicUrl }, { status: 201 });
}
