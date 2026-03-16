import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';
import { verifyAccessToken, extractTokenFromHeader } from '@/lib/tokens';
import { log } from '@/lib/logger';
import { getCachedTrendingMeals } from '@/lib/trending-cache';

// GET /api/preset-meals                        → trending (default), paginated
// GET /api/preset-meals?sort=new               → newest first, paginated
// GET /api/preset-meals?limit=20&offset=0      → explicit pagination
const PRESET_PAGE_SIZE = 20;

export async function GET(request: NextRequest) {
  const token = extractTokenFromHeader(request.headers.get('authorization'));
  const decoded = token ? await verifyAccessToken(token) : null;
  // Guest (unauthenticated) access is allowed for trending and new feeds.
  // The "following" feed requires auth.

  const supabase = createServerSupabaseClient();
  const searchParams = request.nextUrl.searchParams;

  const limit  = Math.min(parseInt(searchParams.get('limit')  || String(PRESET_PAGE_SIZE), 10), 100);
  const offset = Math.max(parseInt(searchParams.get('offset') || '0', 10), 0);
  const tagsParam = searchParams.get('tags');
  const tags = tagsParam ? tagsParam.split(',').map((t) => t.trim()).filter(Boolean) : [];

  // ── Following feed ────────────────────────────────────────────────────────
  if (searchParams.get('followed') === 'true') {
    if (!decoded) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const { data: follows } = await supabase
      .from('creator_follows')
      .select('creator_id')
      .eq('user_id', decoded.userId);

    const ids = (follows ?? []).map((f: any) => f.creator_id);
    if (ids.length === 0) {
      return NextResponse.json({ presetMeals: [], hasMore: false });
    }

    let query = supabase
      .from('preset_meals')
      .select(`
        id, name, source, recipe, story, ingredients, photo_url, author, difficulty, serves, creator_id, created_at, tags,
        creators!creator_id ( display_name, social_handle )
      `, { count: 'exact' })
      .in('creator_id', ids)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (tags.length > 0) query = query.overlaps('tags', tags) as typeof query;

    const { data, error, count } = await query;

    if (error) {
      log({ event: 'MEAL:GET', status: 'error', error });
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const meals = (data ?? []).map((m: any) => ({
      ...m,
      creator_name:   m.creators?.display_name  ?? null,
      creator_social: m.creators?.social_handle ?? null,
      creators:       undefined,
    }));

    const hasMore = (count ?? 0) > offset + meals.length;
    return NextResponse.json({ presetMeals: meals, hasMore });
  }

  if (searchParams.get('sort') === 'new') {
    let query = supabase
      .from('preset_meals')
      .select(`
        id, name, source, recipe, story, ingredients, photo_url, author, difficulty, serves, creator_id, created_at, tags,
        creators!creator_id ( display_name, social_handle )
      `, { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (tags.length > 0) query = query.overlaps('tags', tags) as typeof query;

    const { data, error, count } = await query;

    if (error) {
      log({ event: 'MEAL:GET', status: 'error', error });
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const meals = (data ?? []).map((m: any) => ({
      ...m,
      creator_name:   m.creators?.display_name  ?? null,
      creator_social: m.creators?.social_handle ?? null,
      creators:       undefined,
    }));

    const hasMore = (count ?? 0) > offset + meals.length;
    return NextResponse.json({ presetMeals: meals, hasMore });
  }

  // Default: trending sort via cached RPC (10-minute cache)
  let allMeals;
  try {
    allMeals = await getCachedTrendingMeals();
  } catch (error) {
    log({ event: 'MEAL:GET', status: 'error', error });
    return NextResponse.json({ error: 'Failed to load' }, { status: 500 });
  }

  const filtered = tags.length > 0
    ? allMeals.filter((m: any) => Array.isArray(m.tags) && tags.some((t) => m.tags.includes(t)))
    : allMeals;
  const fetched = filtered.slice(offset, offset + limit);
  const hasMore = filtered.length > offset + limit;
  return NextResponse.json({ presetMeals: fetched, hasMore });
}
