import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';
import { verifyAccessToken, extractTokenFromHeader } from '@/lib/tokens';
import {
  decryptKrogerToken,
  encryptKrogerToken,
  refreshKrogerAccessToken,
  krogerSearchProducts,
  scoreProductMatch,
} from '@/lib/kroger';
import { log } from '@/lib/logger';

export const dynamic = 'force-dynamic';

/**
 * POST /api/kroger/search-products
 * Body: { ingredients: Array<{ productName: string; quantity?: number }>, locationId?: string }
 *
 * Searches Kroger for each ingredient and returns per-ingredient results with
 * an `exact` flag indicating whether the match is confident enough to auto-add.
 *
 * Returns: { results: Array<{ term, quantity, upc, description, exact }> }
 */
export async function POST(request: NextRequest) {
  const token = extractTokenFromHeader(request.headers.get('authorization'));
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const decoded = await verifyAccessToken(token);
  if (!decoded) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  if (!process.env.KROGER_CLIENT_ID) {
    return NextResponse.json({ error: 'Kroger integration not configured' }, { status: 503 });
  }

  const body = await request.json();
  const ingredients: Array<{ productName: string; quantity?: number }> = body?.ingredients ?? [];
  const requestedLocationId: string | undefined = body?.locationId;

  if (!ingredients.length) {
    return NextResponse.json({ error: 'No ingredients provided' }, { status: 400 });
  }

  const supabase = createServerSupabaseClient();
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('kroger_refresh_token, kroger_location_id')
    .eq('id', decoded.userId)
    .single();

  if (!profile?.kroger_refresh_token) {
    return NextResponse.json({ error: 'Kroger account not connected' }, { status: 403 });
  }

  const locationId = requestedLocationId ?? profile.kroger_location_id;
  if (!locationId) {
    return NextResponse.json({ error: 'No Kroger store selected' }, { status: 400 });
  }

  let userAccessToken: string;
  try {
    const decryptedRefresh = decryptKrogerToken(profile.kroger_refresh_token);
    const { accessToken, newRefreshToken } = await refreshKrogerAccessToken(decryptedRefresh);
    userAccessToken = accessToken;
    if (newRefreshToken) {
      await supabase
        .from('user_profiles')
        .update({ kroger_refresh_token: encryptKrogerToken(newRefreshToken) })
        .eq('id', decoded.userId);
    }
  } catch (err) {
    log({ event: 'KROGER:SEARCH_PRODUCTS', status: 'error', userId: decoded.userId, reason: 'token_error', error: String(err) });
    return NextResponse.json({ error: 'Failed to authenticate with Kroger' }, { status: 502 });
  }

  const BATCH = 10;
  const results: Array<{
    term: string; quantity: number;
    upc: string | null; description: string | null; exact: boolean;
    suggestions: Array<{ upc: string; description: string }>;
  }> = [];

  for (let i = 0; i < ingredients.length; i += BATCH) {
    const batch = ingredients.slice(i, i + BATCH);
    const batchResults = await Promise.all(
      batch.map(async (ing) => {
        const suggestions = await krogerSearchProducts(userAccessToken, ing.productName, locationId, 5);
        const top = suggestions[0] ?? null;
        return {
          term: ing.productName,
          quantity: ing.quantity ?? 1,
          upc: top?.upc ?? null,
          description: top?.description ?? null,
          exact: top ? scoreProductMatch(ing.productName, top.description) >= 70 : false,
          suggestions,
        };
      })
    );
    results.push(...batchResults);
  }

  log({
    event: 'KROGER:SEARCH_PRODUCTS',
    status: 'success',
    userId: decoded.userId,
    detail: `found=${results.filter(r => r.upc).length} total=${results.length}`,
  });

  return NextResponse.json({ results });
}
