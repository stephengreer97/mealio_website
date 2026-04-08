import { NextRequest, NextResponse } from 'next/server';
import { createHash } from 'crypto';
import { createServerSupabaseClient } from '@/lib/supabase';
import { verifyAccessToken, extractTokenFromHeader } from '@/lib/tokens';
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

  // Check for existing duplicate
  const { data: existing } = await supabase
    .from('photo_hashes')
    .select('url')
    .eq('hash', hash)
    .maybeSingle();

  if (existing?.url) {
    log({ event: 'IMAGE:UPLOAD', status: 'success', userId: decoded.userId, reason: 'dedup', detail: existing.url.split('/').pop() });
    return NextResponse.json({ url: existing.url }, { status: 200 });
  }

  const path = `${decoded.userId}/${Date.now()}.${ext}`;
  const { error: uploadError } = await supabase.storage
    .from('meal-photos')
    .upload(path, buffer, { contentType: mimeType, upsert: false });

  if (uploadError) {
    log({ event: 'IMAGE:UPLOAD', status: 'error', userId: decoded.userId, error: uploadError });
    return NextResponse.json({ error: uploadError.message }, { status: 500 });
  }

  const { data: { publicUrl } } = supabase.storage
    .from('meal-photos')
    .getPublicUrl(path);

  // Record hash (upsert handles race conditions gracefully)
  await supabase.from('photo_hashes').upsert({ hash, url: publicUrl }, { onConflict: 'hash', ignoreDuplicates: true });

  log({ event: 'IMAGE:UPLOAD', status: 'success', userId: decoded.userId, detail: path });
  return NextResponse.json({ url: publicUrl }, { status: 201 });
}
