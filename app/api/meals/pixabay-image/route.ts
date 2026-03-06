import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

// Proxy for Pixabay webformatURL images. Browsers can't load pixabay.com/get/ URLs
// directly because Pixabay's CDN requires Referer: https://pixabay.com/. This route
// adds that header server-side and streams the image back.
export async function GET(request: NextRequest) {
  const url = request.nextUrl.searchParams.get('url') ?? '';

  if (!url.startsWith('https://pixabay.com/')) {
    return new NextResponse('Bad Request', { status: 400 });
  }

  let imgRes: Response;
  try {
    imgRes = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Mealio/1.0; +https://mealio.co)',
        'Referer':    'https://pixabay.com/',
        'Accept':     'image/webp,image/png,image/*,*/*',
      },
    });
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
