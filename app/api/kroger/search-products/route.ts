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
 * Body: { ingredients: Array<{ productName: string; searchTerm?: string | null; unit?: string; measure?: string | null; quantity?: number }>, locationId?: string }
 *
 * For each ingredient:
 *   - If searchTerm is set, use it directly.
 *   - Else if unit is not 'qty', try "<productName> <measure> <unit>" (capped at 8 words).
 *     If that returns no suggestions, fall back to just "<productName>".
 *   - Else use productName directly.
 *
 * Returns: { results: Array<{ term, quantity, upc, description, exact, suggestions }> }
 * `term` echoes back productName (ingredientName) for client-side matching.
 */

function buildSearchTerm(base: string, measure: string | null, unit: string): string {
  const full = `${base} ${measure ?? ''} ${unit}`.replace(/\s+/g, ' ').trim();
  return full.split(' ').slice(0, 8).join(' ');
}
export async function POST(request: NextRequest) {
  const token = extractTokenFromHeader(request.headers.get('authorization'));
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const decoded = await verifyAccessToken(token);
  if (!decoded) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  if (!process.env.KROGER_CLIENT_ID) {
    return NextResponse.json({ error: 'Kroger integration not configured' }, { status: 503 });
  }

  const body = await request.json();
  const ingredients: Array<{ productName: string; searchTerm?: string | null; unit?: string; measure?: string | null; quantity?: number }> = body?.ingredients ?? [];
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
    reason: 'matched' | 'out_of_stock' | 'no_results' | 'low_confidence';
    suggestions: Array<{ upc: string; description: string }>;
  }> = [];

  for (let i = 0; i < ingredients.length; i += BATCH) {
    const batch = ingredients.slice(i, i + BATCH);
    const batchResults = await Promise.all(
      batch.map(async (ing) => {
        const base = ing.productName;
        const unit = ing.unit ?? 'qty';
        const usesMeasurement = !ing.searchTerm && unit !== 'qty';

        // Determine the actual search string
        let searchStr: string;
        let suggestions: Awaited<ReturnType<typeof krogerSearchProducts>>;

        if (ing.searchTerm) {
          // User already picked a product — search with their chosen term
          searchStr = ing.searchTerm;
          suggestions = await krogerSearchProducts(userAccessToken, searchStr, locationId, 10);
          // Repeat once in case of a transient empty response
          if (suggestions.length === 0) {
            suggestions = await krogerSearchProducts(userAccessToken, searchStr, locationId, 10);
          }
          // Retry 1: fall back to ingredientName + measure/unit (if non-qty)
          if (suggestions.length === 0 && unit !== 'qty') {
            searchStr = buildSearchTerm(base, ing.measure ?? null, unit);
            suggestions = await krogerSearchProducts(userAccessToken, searchStr, locationId, 10);
          }
          // Retry 2: fall back to bare ingredientName
          if (suggestions.length === 0) {
            searchStr = base.split(' ').slice(0, 8).join(' ');
            suggestions = await krogerSearchProducts(userAccessToken, searchStr, locationId, 10);
          }
        } else if (usesMeasurement) {
          // Search with just the ingredient name (no measure/unit)
          searchStr = base.split(' ').slice(0, 8).join(' ');
          suggestions = await krogerSearchProducts(userAccessToken, searchStr, locationId, 10);
        } else {
          searchStr = base.split(' ').slice(0, 8).join(' ');
          suggestions = await krogerSearchProducts(userAccessToken, searchStr, locationId, 10);
        }

        // Score against the chosen product name (searchTerm), falling back to ingredient name.
        // Also try matching against description + size to catch weight items like
        // "Flat Whole Beef Brisket" + "avg 5.1 lbs" → "Flat Whole Beef Brisket, avg 5.1 lbs".
        const scoreTarget = ing.searchTerm ?? base;
        const scored = suggestions.map(s => {
          const primary = scoreProductMatch(scoreTarget, s.description);
          if (primary === 100) return { s, score: 100 };
          const withSize = s.size ? scoreProductMatch(scoreTarget, `${s.description}, ${s.size}`) : 0;
          return { s, score: Math.max(primary, withSize) };
        });
        const sortedScored = [...scored].sort((a, b) => b.score - a.score);
        const exactMatch = sortedScored.find(({ s, score }) => score === 100 && s.stockLevel !== 'TEMPORARILY_OUT_OF_STOCK');
        const outOfStockExact = !exactMatch && sortedScored.find(({ s, score }) => score === 100 && s.stockLevel === 'TEMPORARILY_OUT_OF_STOCK');
        const top = exactMatch?.s ?? sortedScored[0]?.s ?? null;

        const strippedTarget = scoreTarget.replace(/,\s*avg\s+[\d.]+\s*\w+\s*$/i, '').trim();
        console.log('[Kroger:match] searched:', JSON.stringify(searchStr), '| scored against:', JSON.stringify(strippedTarget));
        console.log('[Kroger:match] suggestions:', sortedScored.map(({ s, score }) => `${score} — ${s.description}${s.size ? ', ' + s.size : ''}`).join(' | ') || '(none)');
        console.log('[Kroger:match] selected:', top ? `${top.description} (exact=${!!exactMatch})` : '(none)');

        const filteredSuggestions = sortedScored.map(({ s }) => s).filter(s => s.stockLevel !== 'TEMPORARILY_OUT_OF_STOCK');
        const reason = exactMatch ? 'matched'
          : outOfStockExact ? 'out_of_stock'
          : filteredSuggestions.length === 0 ? 'no_results'
          : 'low_confidence';

        return {
          term: base,
          quantity: ing.quantity ?? 1,
          upc: top?.upc ?? null,
          description: top?.description ?? null,
          exact: !!exactMatch,
          reason,
          suggestions: filteredSuggestions,
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
