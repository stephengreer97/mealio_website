import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';
import { verifyAccessToken, extractTokenFromHeader } from '@/lib/tokens';
import { log } from '@/lib/logger';

async function getUser(request: NextRequest) {
  const token = extractTokenFromHeader(request.headers.get('authorization'));
  if (!token) return null;
  return verifyAccessToken(token);
}

// POST /api/shared/[token]/save — save a shared meal to the authenticated user's account
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const decoded = await getUser(request);
  if (!decoded) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { token } = await params;
  const { storeId } = await request.json();

  if (!storeId) {
    return NextResponse.json({ error: 'storeId is required' }, { status: 400 });
  }

  const supabase = createServerSupabaseClient();

  // Look up the shared meal
  const { data: sharedMeal, error: fetchError } = await supabase
    .from('meals')
    .select('name, ingredients, author, difficulty, serves, website, recipe, photo_url, tags, story')
    .eq('share_token', token)
    .single();

  if (fetchError || !sharedMeal) {
    return NextResponse.json({ error: 'Shared meal not found' }, { status: 404 });
  }

  // Enforce free-tier meal limit
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('subscription_tier')
    .eq('id', decoded.userId)
    .single();

  const tier = profile?.subscription_tier ?? 'free';

  if (tier === 'free') {
    const { count } = await supabase
      .from('meals')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', decoded.userId);

    if ((count ?? 0) >= 3) {
      log({ event: 'MEAL:CREATE', status: 'failed', userId: decoded.userId, reason: 'tier limit reached (shared save)' });
      return NextResponse.json(
        { error: 'Free plan is limited to 3 meals. Upgrade to Full Access to add more.', tierLimitReached: true },
        { status: 403 }
      );
    }
  }

  // Strip store-specific product data from ingredients — only keep generic fields
  const ingredients = (sharedMeal.ingredients ?? []).map((ing: any) => ({
    ingredientName: ing.ingredientName ?? ing.productName ?? ing.product_name ?? ing.name ?? '',
    qty: ing.qty ?? ing.quantity ?? 1,
    unit: ing.unit ?? 'qty',
    ...(ing.measure != null ? { measure: ing.measure } : {}),
    ...(ing.searchTerm != null ? { searchTerm: ing.searchTerm } : {}),
  }));

  // Insert as a new meal for this user
  const { data: meal, error: insertError } = await supabase
    .from('meals')
    .insert({
      user_id: decoded.userId,
      name: sharedMeal.name,
      store_id: storeId,
      ingredients,
      created_at: new Date().toISOString(),
      ...(sharedMeal.author      ? { author: sharedMeal.author }           : {}),
      ...(sharedMeal.difficulty  ? { difficulty: sharedMeal.difficulty }   : {}),
      ...(sharedMeal.website     ? { website: sharedMeal.website }         : {}),
      ...(sharedMeal.recipe      ? { recipe: sharedMeal.recipe }           : {}),
      ...(sharedMeal.photo_url   ? { photo_url: sharedMeal.photo_url }     : {}),
      ...(sharedMeal.serves      ? { serves: sharedMeal.serves }           : {}),
      ...(sharedMeal.tags?.length ? { tags: sharedMeal.tags }              : {}),
      ...(sharedMeal.story       ? { story: sharedMeal.story }             : {}),
    })
    .select()
    .single();

  if (insertError) {
    log({ event: 'MEAL:CREATE', status: 'error', userId: decoded.userId, error: insertError });
    return NextResponse.json({ error: insertError.message }, { status: 500 });
  }

  log({ event: 'MEAL:CREATE', status: 'success', userId: decoded.userId, detail: `from-share:${meal.id}` });
  return NextResponse.json({ meal }, { status: 201 });
}
