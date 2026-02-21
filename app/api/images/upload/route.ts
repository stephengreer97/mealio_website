import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';
import { verifyAccessToken, extractTokenFromHeader } from '@/lib/tokens';

export const dynamic = 'force-dynamic';

const EXT_MAP: Record<string, string> = {
  'image/jpeg':  'jpg',
  'image/png':   'png',
  'image/gif':   'gif',
  'image/webp':  'webp',
  'image/svg+xml': 'svg',
  'image/bmp':   'bmp',
  'image/avif':  'avif',
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
  const base64Data = match[2];
  const ext = EXT_MAP[mimeType] ?? 'jpg';

  const buffer = Buffer.from(base64Data, 'base64');
  const path = `${decoded.userId}/${Date.now()}.${ext}`;

  const supabase = createServerSupabaseClient();
  const { error: uploadError } = await supabase.storage
    .from('meal-photos')
    .upload(path, buffer, { contentType: mimeType, upsert: false });

  if (uploadError) {
    console.error('Image upload error:', uploadError);
    return NextResponse.json({ error: uploadError.message }, { status: 500 });
  }

  const { data: { publicUrl } } = supabase.storage
    .from('meal-photos')
    .getPublicUrl(path);

  return NextResponse.json({ url: publicUrl }, { status: 201 });
}
