import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';
import { verifyAccessToken, extractTokenFromHeader } from '@/lib/tokens';
import { log } from '@/lib/logger';
import { getCachedTrendingMeals, getCachedAllPresetMeals } from '@/lib/trending-cache';
import { fetchAllPages } from '@/lib/paged-select';
import {
  parsePresetMealFilters,
  matchesPresetMeal,
  isEmpty,
  type FilterableMeal,
} from '@/lib/preset-meal-filters';

// GET /api/preset-meals                        → trending (default), paginated
// GET /api/preset-meals?sort=new               → newest first, paginated
// GET /api/preset-meals?followed=true          → meals from creators you follow
// GET /api/preset-meals?limit=20&offset=0      → explicit pagination
//
// Filters, applied to EVERY feed and applied BEFORE pagination:
//   ?tags=vegetarian,quick        any-of
//   ?difficulty=1,2               any-of
//   ?authors=sarah                any-of, substring, author or creator name
//   ?ingredients=chicken,rice     ALL-of
//   ?excludeIngredients=peanut    NONE-of
//   ?q=curry                      name / author / creator / source
//
// FILTERING AND PAGINATION USED TO BE ON OPPOSITE SIDES OF THE NETWORK. The
// server decided which 20 rows existed and the browser decided which of those
// 20 to show, so "vegetarian" meant "vegetarian among the 20 we happened to
// have" and scrolling revealed more. Anything that narrows a set has to run
// before the set is cut into pages, which is why all six live here now and the
// clients no longer filter at all.
//
// The consequence is that every feed needs its whole candidate set in memory,
// which trending has always had and the other two now get from
// `getCachedAllPresetMeals`. Both share the 10-minute cache and the
// `trending-meals` tag, so this is not a new read pattern, only a wider one.

const PRESET_PAGE_SIZE = 20;

/** Filter, then cut into pages. In that order, which is the whole point. */
function page<T extends FilterableMeal>(
  meals: T[],
  filters: ReturnType<typeof parsePresetMealFilters>,
  offset: number,
  limit: number,
): { presetMeals: T[]; hasMore: boolean; matched: number } {
  const filtered = isEmpty(filters) ? meals : meals.filter((m) => matchesPresetMeal(m, filters));
  return {
    presetMeals: filtered.slice(offset, offset + limit),
    hasMore: filtered.length > offset + limit,
    // What the filter actually found, across everything. The clients can say
    // "18 meals" honestly instead of counting what they happen to be holding.
    matched: filtered.length,
  };
}

export async function GET(request: NextRequest) {
  const token = extractTokenFromHeader(request.headers.get('authorization'));
  const decoded = token ? await verifyAccessToken(token) : null;
  // Guest (unauthenticated) access is allowed for trending and new feeds.
  // The "following" feed requires auth.

  const searchParams = request.nextUrl.searchParams;
  const limit  = Math.min(parseInt(searchParams.get('limit')  || String(PRESET_PAGE_SIZE), 10), 100);
  const offset = Math.max(parseInt(searchParams.get('offset') || '0', 10), 0);
  const filters = parsePresetMealFilters(searchParams);

  // ── Following feed ────────────────────────────────────────────────────────
  if (searchParams.get('followed') === 'true') {
    if (!decoded) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const supabase = createServerSupabaseClient();
    // Paged: a follow missing from this list is a creator whose meals never
    // appear in the Following feed, with nothing on screen to say why.
    const followsRead = await fetchAllPages<{ creator_id: string }>((from, to) =>
      supabase
        .from('creator_follows')
        .select('creator_id')
        .eq('user_id', decoded.userId)
        .order('creator_id', { ascending: true })
        .range(from, to));

    const ids = new Set(followsRead.rows.map((f) => f.creator_id));
    if (ids.size === 0) {
      return NextResponse.json({ presetMeals: [], hasMore: false, matched: 0 });
    }

    // SCOPED IN MEMORY, not with `.in()`, and that fixes a live bug on the way
    // past. The old query put every followed creator id in the query string,
    // and `creator_id=in.(…)` of n uuids is `15 + 37n` bytes -- so a user
    // following 222 creators produced an 8 KB URI, got a 414 back as
    // `data: null`, and saw an empty feed with nothing to explain it
    // (MEAL-112 class). A Set lookup has no URI to overflow.
    let all;
    try {
      all = await getCachedAllPresetMeals();
    } catch (error) {
      log({ event: 'MEAL:GET', status: 'error', error });
      return NextResponse.json({ error: 'Failed to load' }, { status: 500 });
    }
    // ?creators=a,b narrows further, for the creator chips above the feed.
    // Same defect as the rest: picking a creator used to filter the meals
    // already loaded, so choosing someone whose meals sit on page 4 showed an
    // empty feed. Only meaningful inside Following, so it lives here rather
    // than in the shared filter.
    const chosen = (searchParams.get('creators') ?? '')
      .split(',').map((c) => c.trim()).filter(Boolean);
    const pick = chosen.length > 0 ? new Set(chosen) : null;

    const followed = all.filter((m) =>
      !!m.creator_id && ids.has(m.creator_id) && (!pick || pick.has(m.creator_id)));
    return NextResponse.json(page(followed, filters, offset, limit));
  }

  // ── New feed ──────────────────────────────────────────────────────────────
  if (searchParams.get('sort') === 'new') {
    let all;
    try {
      // Already ordered created_at desc by the cache, so nothing to re-sort.
      all = await getCachedAllPresetMeals();
    } catch (error) {
      log({ event: 'MEAL:GET', status: 'error', error });
      return NextResponse.json({ error: 'Failed to load' }, { status: 500 });
    }
    return NextResponse.json(page(all, filters, offset, limit));
  }

  // ── Trending (default) ────────────────────────────────────────────────────
  let allMeals;
  try {
    allMeals = await getCachedTrendingMeals();
  } catch (error) {
    log({ event: 'MEAL:GET', status: 'error', error });
    return NextResponse.json({ error: 'Failed to load' }, { status: 500 });
  }
  return NextResponse.json(page(allMeals, filters, offset, limit));
}
