import { NextRequest, NextResponse } from 'next/server';
import { verifyAccessToken, extractTokenFromHeader } from '@/lib/tokens';
import { log } from '@/lib/logger';

export const dynamic = 'force-dynamic';

const PIXABAY_API = 'https://pixabay.com/api/';

interface PixabayHit {
  previewURL:   string;   // cdn.pixabay.com — direct, stable, no expiry, ~150px
  webformatURL: string;   // pixabay.com/get/ — requires Referer, routed through proxy
}

interface PixabayResponse {
  hits: PixabayHit[];
  totalHits: number;
}

export async function POST(request: NextRequest) {
  const token = extractTokenFromHeader(request.headers.get('authorization'));
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const decoded = await verifyAccessToken(token);
  if (!decoded) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json();
  const mealName: string = (body.mealName ?? '').trim();
  if (!mealName) {
    return NextResponse.json({ error: 'mealName is required' }, { status: 400 });
  }

  const apiKey = process.env.PIXABAY_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: 'Pixabay not configured' }, { status: 500 });
  }

  const query = encodeURIComponent(mealName);
  const pixabayUrl =
    `${PIXABAY_API}?key=${apiKey}&q=${query}` +
    `&image_type=photo&safesearch=true&per_page=3`;

  try {
    const searchRes = await fetch(pixabayUrl);
    if (!searchRes.ok) {
      const errBody = await searchRes.text().catch(() => '');
      log({ event: 'PHOTO:GENERATE', status: 'error', userId: decoded.userId, detail: `Pixabay search HTTP ${searchRes.status}: ${errBody.slice(0, 200)}` });
      return NextResponse.json({ error: 'Image search failed' }, { status: 502 });
    }
    const rawBody = await searchRes.text();
    let searchData: PixabayResponse;
    try {
      searchData = JSON.parse(rawBody) as PixabayResponse;
    } catch {
      log({ event: 'PHOTO:GENERATE', status: 'error', userId: decoded.userId, detail: `Pixabay non-JSON: ${rawBody.slice(0, 300)}` });
      return NextResponse.json({ error: 'Image search failed', _raw: rawBody.slice(0, 500) }, { status: 502 });
    }
    const hits = searchData.hits ?? [];

    // Log the full structure of the first hit so we can see exactly what Pixabay returns
    log({ event: 'PHOTO:GENERATE', status: hits.length ? 'success' : 'error', userId: decoded.userId, detail: `${mealName} — ${hits.length}/${searchData.totalHits} hits — firstHit: ${JSON.stringify(hits[0] ?? null).slice(0, 300)}` });

    if (!hits.length) {
      return NextResponse.json({ error: 'No images found for this meal name', _raw: rawBody.slice(0, 500) }, { status: 404 });
    }

    // thumbs: previewURL → cdn.pixabay.com, stable CDN, no expiry, ~150px (fine for picker)
    // fulls: route webformatURL through proxy which adds required Referer header, 640px
    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
    return NextResponse.json({
      thumbs: hits.map(h => h.previewURL),
      fulls:  hits.map(h => `${appUrl}/api/meals/pixabay-image?url=${encodeURIComponent(h.webformatURL)}`),
    }, { status: 201 });
  } catch (err) {
    log({ event: 'PHOTO:GENERATE', status: 'error', userId: decoded.userId, detail: 'Pixabay search threw', error: err });
    return NextResponse.json({ error: 'Image search failed' }, { status: 502 });
  }
}
