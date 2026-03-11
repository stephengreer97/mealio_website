import { NextRequest, NextResponse } from 'next/server';
import { verifyAccessToken, extractTokenFromHeader } from '@/lib/tokens';
import { log } from '@/lib/logger';

export const dynamic = 'force-dynamic';

const PIXABAY_API = 'https://pixabay.com/api/';

interface PixabayHit {
  previewURL:   string;
  webformatURL: string;
}

interface PixabayResponse {
  hits: PixabayHit[];
  totalHits: number;
}

async function pixabaySearch(apiKey: string, query: string, perPage: number): Promise<PixabayHit[]> {
  const url =
    `${PIXABAY_API}?key=${apiKey}&q=${encodeURIComponent(query)}` +
    `&image_type=photo&safesearch=true&per_page=${perPage}`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const data = await res.json() as PixabayResponse;
  return data.hits ?? [];
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

  const words = mealName.trim().split(/\s+/);
  const lastWord = words[words.length - 1];
  const lastWordFood = `${lastWord} food`;

  try {
    // Three parallel searches
    const [fullHits, lastWordHits, lastWordFoodHits] = await Promise.all([
      pixabaySearch(apiKey, mealName, 5),       // full name — need ≥2 unique
      pixabaySearch(apiKey, lastWord, 3),        // last word only
      pixabaySearch(apiKey, lastWordFood, 3),    // last word + food
    ]);

    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
    const seenPreviews = new Set<string>();

    function pickUnique(hits: PixabayHit[], n: number): PixabayHit[] {
      const result: PixabayHit[] = [];
      for (const hit of hits) {
        if (seenPreviews.has(hit.previewURL)) continue;
        seenPreviews.add(hit.previewURL);
        result.push(hit);
        if (result.length === n) break;
      }
      return result;
    }

    const selected = [
      ...pickUnique(fullHits, 2),       // 2 from full name
      ...pickUnique(lastWordHits, 1),    // 1 from last word
      ...pickUnique(lastWordFoodHits, 1),// 1 from last word + food
    ];

    log({
      event: 'PHOTO:GENERATE',
      status: selected.length ? 'success' : 'error',
      userId: decoded.userId,
      detail: `"${mealName}" → full:${fullHits.length} lastWord:${lastWordHits.length} lastWordFood:${lastWordFoodHits.length} → selected:${selected.length}`,
    });

    if (!selected.length) {
      return NextResponse.json({ error: 'No images found for this meal name' }, { status: 404 });
    }

    return NextResponse.json({
      thumbs: selected.map(h => h.previewURL),
      fulls:  selected.map(h => `${appUrl}/api/meals/pixabay-image?url=${encodeURIComponent(h.webformatURL)}`),
    }, { status: 201 });

  } catch (err) {
    log({ event: 'PHOTO:GENERATE', status: 'error', userId: decoded.userId, detail: 'Pixabay search threw', error: err });
    return NextResponse.json({ error: 'Image search failed' }, { status: 502 });
  }
}
