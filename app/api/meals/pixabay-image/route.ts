import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const WORKER_URL    = (process.env.PIXABAY_WORKER_URL ?? '').replace(/\/$/, '');
const WORKER_SECRET = process.env.PIXABAY_WORKER_SECRET ?? '';

// Proxy for Pixabay webformatURL images. Routes through the Cloudflare Worker
// which adds the required Referer header and uses Cloudflare's shared IPs.
export async function GET(request: NextRequest) {
  const url = request.nextUrl.searchParams.get('url') ?? '';

  if (!url.startsWith('https://pixabay.com/')) {
    return new NextResponse('Bad Request', { status: 400 });
  }

  let imgRes: Response;
  try {
    imgRes = await fetch(
      `${WORKER_URL}/image?url=${encodeURIComponent(url)}`,
      {
        headers: { 'Authorization': `Bearer ${WORKER_SECRET}` },
        next: { revalidate: 86400 },
      },
    );
  } catch {
    return new NextResponse('Fetch failed', { status: 502 });
  }

  if (!imgRes.ok) {
    return new NextResponse('Image unavailable', { status: imgRes.status });
  }

  const contentType = imgRes.headers.get('content-type') ?? 'image/jpeg';
  const buffer = await imgRes.arrayBuffer();

  return new NextResponse(buffer, {
    headers: {
      'Content-Type':  contentType,
      'Cache-Control': 'public, max-age=86400',
    },
  });
}
