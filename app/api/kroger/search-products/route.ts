import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';
import { verifyAccessToken, extractTokenFromHeader } from '@/lib/tokens';
import {
  decryptKrogerToken,
  encryptKrogerToken,
  refreshKrogerAccessToken,
  krogerSearchProducts,
  scoreProductMatch,
  type KrogerProduct,
} from '@/lib/kroger';
import { log } from '@/lib/logger';
import { getFlag } from '@/lib/flags';

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
 * Returns: { results: Array<{ term, quantity, upc, description, exact, reason, suggestions }> }
 * `term` echoes back productName (ingredientName) for client-side matching.
 */

/**
 * Why an ingredient came back without a match. `no_results` used to absorb all
 * of these; MEAL-19 is about telling them apart, because the honest answer to
 * three of them is not "we found nothing".
 */
type SearchReason =
  | 'matched'
  | 'out_of_stock'           // matches exist here, but none are currently stocked
  | 'unavailable_at_store'   // Kroger lists the product; this store can't fulfil it
  | 'search_error'           // Kroger itself failed — 401/429/5xx, not an empty shelf
  | 'no_results'             // Kroger genuinely returned nothing for every term we tried
  | 'low_confidence';

function buildSearchTerm(base: string, measure: string | null, unit: string): string {
  const full = `${base} ${measure ?? ''} ${unit}`.replace(/\s+/g, ' ').trim();
  return full.split(' ').slice(0, 8).join(' ');
}

/**
 * How well a product Kroger refused to fulfil here must match the ingredient
 * before we are willing to tell the user "Kroger sells this, but not at the
 * store you picked".
 *
 * That sentence is a factual claim about a specific product, and the only thing
 * behind it is a `filter.term` search — which is loose enough that the codebase
 * already has a `low_confidence` reason for exactly this reason. "Ghost Pepper
 * Jelly" returns "Ghost Pepper Hot Sauce"; if the sauce happens to be
 * fulfillable we honestly say "No exact match found", and it would be perverse
 * for the *same* irrelevant result to become a confident claim about the jelly
 * just because the store cannot deliver it.
 *
 * 70 is where `scoreProductMatch` starts scoring at all (it floors anything
 * under 0.7 word overlap, or any missing critical word, to 0), so this is
 * currently "the scorer was willing to call it a match". It is a named constant
 * so the bar can be raised without hunting for the comparison.
 */
const UNAVAILABLE_CLAIM_MIN_SCORE = 70;

/**
 * One rung of the fallback ladder and what its search turned up but dropped.
 * `filteredOut` counts everything the fulfillment filter removed; `unfulfillable`
 * names only the subset Kroger explicitly said this store cannot fulfil. The gap
 * between them is products Kroger returned no fulfillment data for.
 */
type RungEvidence = { term: string; filteredOut: number; unfulfillable: string[] };

/**
 * Statuses where asking again — with different words, on the next rung — is
 * provably pointless and actively harmful. An expired/insufficient grant fails
 * identically for every term, and a 429 is a request budget: spending three
 * more of it per ingredient, ten ingredients at a time, is how MEAL-19's soft
 * quota became a hard outage.
 *
 * 5xx is deliberately NOT here. A transient 500 on one rung says nothing about
 * the next, and breaking on it regressed a case that used to recover: rung 1
 * flakes, rung 2 holds the exact match, and stopping early reported
 * `search_error` with no UPC. Worst case is now 3 requests on a total outage
 * rather than the old 4, so the load argument still holds.
 */
const FATAL_UPSTREAM_STATUSES = new Set([401, 403, 429]);
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
  const storeId: string | undefined = body?.storeId;
  const mealNames: string[] = body?.mealNames ?? [];

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

  const debugMode = await getFlag('debug_mode');

  const BATCH = 10;
  const results: Array<{
    term: string; quantity: number;
    upc: string | null; description: string | null; exact: boolean;
    reason: SearchReason;
    suggestions: Array<{ upc: string; description: string }>;
  }> = [];
  /** HTTP statuses Kroger returned, so the log line names the real failure. */
  const upstreamStatuses: number[] = [];

  for (let i = 0; i < ingredients.length; i += BATCH) {
    const batch = ingredients.slice(i, i + BATCH);
    const batchResults = await Promise.all(
      batch.map(async (ing) => {
        const base = ing.productName;
        const unit = ing.unit ?? 'qty';
        const bare = base.split(' ').slice(0, 8).join(' ');

        // Terms to try, widest-specificity first. A saved searchTerm is a
        // *display* string ("Kroger Whole Milk, 1 gal"), so it misses often
        // enough to need the ingredient name behind it.
        const ladder = ing.searchTerm
          ? [
              ing.searchTerm,
              ...(unit !== 'qty' ? [buildSearchTerm(base, ing.measure ?? null, unit)] : []),
              bare,
            ]
          : [bare];

        let searchStr = ladder[0];
        let suggestions: KrogerProduct[] = [];
        /** Per rung, so a rung-1 leftover is never inherited by rung 3's verdict. */
        const rungs: RungEvidence[] = [];
        const rungStatuses: number[] = [];

        for (const candidate of ladder) {
          searchStr = candidate;
          const outcome = await krogerSearchProducts(userAccessToken, candidate, locationId, 10, 0, debugMode);
          if (!outcome.ok) {
            rungStatuses.push(outcome.status);
            // Stop only where re-asking cannot help (see FATAL_UPSTREAM_STATUSES).
            if (FATAL_UPSTREAM_STATUSES.has(outcome.status)) break;
            continue;
          }
          rungs.push({ term: candidate, filteredOut: outcome.filteredOut, unfulfillable: outcome.unfulfillable });
          if (outcome.products.length > 0) { suggestions = outcome.products; break; }
        }
        upstreamStatuses.push(...rungStatuses);

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
        console.log(`[Kroger] "${searchStr}" → ${suggestions.map(s => s.description).join(' | ') || '(no results)'}`);
        if (debugMode) {
          console.log('[Kroger:match] searched:', JSON.stringify(searchStr), '| scored against:', JSON.stringify(strippedTarget));
          console.log('[Kroger:match] suggestions:', sortedScored.map(({ s, score }) => `${score} — ${s.description}${s.size ? ', ' + s.size : ''}`).join(' | ') || '(none)');
          console.log('[Kroger:match] selected:', top ? `${top.description} (exact=${!!exactMatch})` : '(none)');
          // Per rung, because "the store cannot fulfil it" is decided from these
          // and a total told you nothing about which search produced it.
          console.log('[Kroger:match] dropped by fulfillment filter:',
            rungs.map(r => `${JSON.stringify(r.term)} dropped=${r.filteredOut} unfulfillable=[${r.unfulfillable.join(' | ')}]`).join(' ; ') || '(none)');
        }

        // "Kroger sells this, but not at the store you picked" needs a product
        // that is (a) one Kroger returned, (b) one this store explicitly said it
        // cannot fulfil, and (c) plausibly the thing the user asked for. Only
        // (a) and (b) used to be checked, via a count that had accumulated
        // across every rung. Each dropped description is now re-scored here
        // rather than trusted for having come from some rung, against both the
        // saved display string and the bare ingredient name — the display
        // string carries size noise ("Kroger Whole Milk, 1 gal") that sinks an
        // otherwise perfect description below the floor.
        const sellsItElsewhere = rungs.some(rung =>
          rung.unfulfillable.some(desc =>
            Math.max(scoreProductMatch(scoreTarget, desc), scoreProductMatch(base, desc)) >= UNAVAILABLE_CLAIM_MIN_SCORE
          )
        );

        const filteredSuggestions = sortedScored.map(({ s }) => s).filter(s => s.stockLevel !== 'TEMPORARILY_OUT_OF_STOCK');
        // Upstream failures are checked last, not first: a rung may now flake
        // and a later rung still hold the answer, and having the answer beats
        // reporting the flake.
        const reason: SearchReason =
            exactMatch ? 'matched'
          : outOfStockExact ? 'out_of_stock'
          : filteredSuggestions.length > 0 ? 'low_confidence'
          // Nothing to offer. Which of the four reasons it is depends on what
          // Kroger actually said, not on the empty list we ended up with.
          : suggestions.length > 0 ? 'out_of_stock'
          : rungStatuses.length > 0 ? 'search_error'
          : sellsItElsewhere ? 'unavailable_at_store'
          : 'no_results';

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

  // MEAL-19: the old line only counted hits, so a run where Kroger 429'd every
  // request and one where the store simply stocks nothing logged identically.
  //
  // `failed` counts ingredients that ended with nothing to show because of an
  // upstream failure; `requests` counts refused calls. They differ now that a
  // 5xx on one rung can be recovered by the next, and the gap between them is
  // exactly the flakiness the ladder is absorbing — worth seeing.
  if (upstreamStatuses.length) {
    log({
      event: 'KROGER:SEARCH_PRODUCTS',
      status: 'error',
      userId: decoded.userId,
      email: decoded.email,
      reason: 'upstream_error',
      detail: `failed=${results.filter(r => r.reason === 'search_error').length}/${results.length}`
        + ` requests=${upstreamStatuses.length} statuses=${[...new Set(upstreamStatuses)].sort((a, b) => a - b).join(',')}`
        + ` store=${storeId ?? locationId}`,
    });
  }

  const tally = (r: SearchReason) => results.filter(x => x.reason === r).length;
  log({
    event: 'KROGER:SEARCH_PRODUCTS',
    status: 'success',
    userId: decoded.userId,
    email: decoded.email,
    detail: `found=${results.filter(r => r.upc).length} total=${results.length}`
      + ` empty=${tally('no_results')} unavailable=${tally('unavailable_at_store')} oos=${tally('out_of_stock')} errored=${tally('search_error')}`
      + ` store=${storeId ?? locationId} meals=${mealNames.join(', ') || '(unknown)'}`,
  });

  return NextResponse.json({ results });
}
