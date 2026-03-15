import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';
import { verifyAccessToken, extractTokenFromHeader } from '@/lib/tokens';
import { getCachedTrendingMeals } from '@/lib/trending-cache';

const HANDLE_RE = /^[a-z0-9_-]{3,30}$/;
const RESERVED_HANDLES = new Set([
  'about', 'account', 'admin', 'api', 'check-email', 'creator', 'discover',
  'fonts', 'forgot-password', 'help', 'meal', 'my-meals', 'pricing', 'privacy',
  'reset-password', 'robots', 'sitemap', 'signout', 'terms', 'verify-email',
  'mealio', 'app', 'www', 'mail', 'support',
]);

// PATCH /api/creator/me — update creator profile fields
export async function PATCH(request: NextRequest) {
  const token = extractTokenFromHeader(request.headers.get('authorization'));
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const decoded = await verifyAccessToken(token);
  if (!decoded) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const supabase = createServerSupabaseClient();
  const body = await request.json();
  const { photoUrl, handle, bio, socialHandle } = body;

  const updates: Record<string, unknown> = {};

  if (photoUrl !== undefined) updates.photo_url = photoUrl ?? null;
  if (bio !== undefined) updates.bio = typeof bio === 'string' ? (bio.trim() || null) : null;
  if (socialHandle !== undefined) updates.social_handle = typeof socialHandle === 'string' ? (socialHandle.trim() || null) : null;

  if (handle !== undefined) {
    const h = (handle ?? '').toLowerCase().trim();
    if (h === '') {
      updates.handle = null;
    } else {
      if (!HANDLE_RE.test(h)) {
        return NextResponse.json(
          { error: 'Handle must be 3–30 characters and contain only letters, numbers, hyphens, or underscores.' },
          { status: 400 }
        );
      }
      if (RESERVED_HANDLES.has(h)) {
        return NextResponse.json({ error: 'That handle is not available.' }, { status: 400 });
      }
      // Check uniqueness (exclude self)
      const { data: existing } = await supabase
        .from('creators')
        .select('id')
        .eq('handle', h)
        .neq('user_id', decoded.userId)
        .maybeSingle();
      if (existing) {
        return NextResponse.json({ error: 'That handle is already taken.' }, { status: 409 });
      }
      updates.handle = h;
    }
  }

  if (Object.keys(updates).length === 0) return NextResponse.json({ ok: true });

  const { error } = await supabase
    .from('creators')
    .update(updates)
    .eq('user_id', decoded.userId);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

// GET /api/creator/me — creator profile + their meals with save stats
export async function GET(request: NextRequest) {
  const token = extractTokenFromHeader(request.headers.get('authorization'));
  if (!token) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const decoded = await verifyAccessToken(token);
  if (!decoded) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = createServerSupabaseClient();

  // Get creator profile
  const { data: creator, error: creatorError } = await supabase
    .from('creators')
    .select('id, display_name, bio, social_handle, photo_url, approved_at, handle')
    .eq('user_id', decoded.userId)
    .maybeSingle();

  if (creatorError) {
    return NextResponse.json({ error: creatorError.message }, { status: 500 });
  }

  if (!creator) {
    // Check for pending application
    const { data: application } = await supabase
      .from('creator_applications')
      .select('status, created_at')
      .eq('user_id', decoded.userId)
      .maybeSingle();

    return NextResponse.json({ creator: null, application: application ?? null });
  }

  // Get their meals — direct query for full editable fields + cached RPC for trending score
  const [{ data: myMealsRaw }, allMealsRpc] = await Promise.all([
    supabase
      .from('preset_meals')
      .select('id, name, photo_url, difficulty, ingredients, recipe, source, story, tags')
      .eq('creator_id', creator.id)
      .order('created_at', { ascending: false }),
    getCachedTrendingMeals().catch(() => []),
  ]);

  const allScores = allMealsRpc;
  const rawScores = allScores.map(m => Number(m.trending_score));
  const minScore = rawScores.length > 0 ? Math.min(...rawScores) : 0;
  const maxScore = rawScores.length > 0 ? Math.max(...rawScores) : 1;
  const scoreRange = maxScore - minScore || 1;
  const normalize = (raw: number) => Math.round(1 + ((raw - minScore) / scoreRange) * 99);

  const trendingMap = new Map(allScores.map(m => [m.id, m.trending_score]));

  const mealIds = (myMealsRaw ?? []).map((m: { id: string }) => m.id);

  const now = new Date();
  const quarterStart = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1).toISOString();
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const safeMealIds = mealIds.length > 0 ? mealIds : ['00000000-0000-0000-0000-000000000000'];

  // Creator's own saves (aggregate + per-meal)
  const [
    { count: saves30d },
    { count: savesQtr },
    { count: savesAll },
    { data: perMealSavesRaw },
  ] = await Promise.all([
    supabase.from('preset_meal_saves').select('id', { count: 'exact', head: true })
      .in('preset_meal_id', safeMealIds).gte('saved_at', thirtyDaysAgo),
    supabase.from('preset_meal_saves').select('id', { count: 'exact', head: true })
      .in('preset_meal_id', safeMealIds).gte('saved_at', quarterStart),
    supabase.from('preset_meal_saves').select('id', { count: 'exact', head: true })
      .in('preset_meal_id', safeMealIds),
    supabase.from('preset_meal_saves').select('preset_meal_id')
      .in('preset_meal_id', safeMealIds),
  ]);

  // Count saves per meal
  const perMealSavesMap = new Map<string, number>();
  for (const row of (perMealSavesRaw ?? [])) {
    const id = (row as { preset_meal_id: string }).preset_meal_id;
    perMealSavesMap.set(id, (perMealSavesMap.get(id) ?? 0) + 1);
  }

  const myMeals = (myMealsRaw ?? []).map(m => ({
    ...m,
    trending_score: normalize(trendingMap.get(m.id) ?? minScore),
    saves_all: perMealSavesMap.get(m.id) ?? 0,
  })).sort((a, b) => b.trending_score - a.trending_score);

  // Platform totals for creator meals only (denominator for revenue share) + follower count
  const [
    { count: totalCreatorQtrSaves },
    { count: totalCreatorAlltimeSaves },
    { count: followerCount },
  ] = await Promise.all([
    supabase.from('preset_meal_saves')
      .select('id, preset_meals!preset_meal_id!inner(creator_id)', { count: 'exact', head: true })
      .gte('saved_at', quarterStart)
      .not('preset_meals.creator_id', 'is', null),
    supabase.from('preset_meal_saves')
      .select('id, preset_meals!preset_meal_id!inner(creator_id)', { count: 'exact', head: true })
      .not('preset_meals.creator_id', 'is', null),
    supabase.from('creator_follows')
      .select('id', { count: 'exact', head: true })
      .eq('creator_id', creator.id),
  ]);

  const creatorQtrSaves = savesQtr ?? 0;
  const creatorAlltimeSaves = savesAll ?? 0;
  const totalQtr = totalCreatorQtrSaves ?? 0;
  const totalAll = totalCreatorAlltimeSaves ?? 0;

  const qtrPct     = totalQtr > 0 ? (creatorQtrSaves    / totalQtr * 100) : 0;
  const alltimePct = totalAll > 0 ? (creatorAlltimeSaves / totalAll * 100) : 0;
  const combinedSharePct = (qtrPct * 0.5) + (alltimePct * 0.5);

  return NextResponse.json({
    creator,
    meals: myMeals,
    stats: {
      followers:               followerCount ?? 0,
      savesQtr:                creatorQtrSaves,
      savesAll:                creatorAlltimeSaves,
      totalCreatorQtrSaves:    totalQtr,
      totalCreatorAlltimeSaves: totalAll,
      qtrPct,
      alltimePct,
      combinedSharePct,
    },
  });
}
