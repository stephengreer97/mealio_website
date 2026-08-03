import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';
import { verifyAccessToken, extractTokenFromHeader } from '@/lib/tokens';
import { log } from '@/lib/logger';
import { resolvePhotoUrl } from '@/lib/photos';
import { tagCapError } from '@/lib/import/vocab';

async function getUser(request: NextRequest) {
  const token = extractTokenFromHeader(request.headers.get('authorization'));
  if (!token) return null;
  return verifyAccessToken(token);
}

// GET /api/meals — return all meals for the authenticated user
export async function GET(request: NextRequest) {
  const decoded = await getUser(request);
  if (!decoded) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = createServerSupabaseClient();
  const { data: meals, error } = await supabase
    .from('meals')
    .select('*')
    .eq('user_id', decoded.userId)
    .eq('is_active', true)
    .order('created_at', { ascending: false });

  if (error) {
    log({ event: 'MEAL:GET', status: 'error', userId: decoded.userId, error });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ meals });
}

// POST /api/meals — create a new meal
export async function POST(request: NextRequest) {
  const decoded = await getUser(request);
  if (!decoded) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await request.json();
  const { name, storeId, ingredients, createdAt, presetMealId, website, recipe, story, photoUrl, author, difficulty, tags, creatorId, serves } = body;

  if (!name || !storeId || !Array.isArray(ingredients)) {
    return NextResponse.json({ error: 'name, storeId, and ingredients are required' }, { status: 400 });
  }

  // The same cap `preset_meals` publishes under, because `my-meals` renders and
  // filters a personal meal exactly the way Discover renders a published one: the
  // card shows `tags.slice(0, MAX_MEAL_TAGS)` and the filter matches the whole
  // array, so a fourth tag is invisible on screen and still pulls the meal up
  // under a filter with nothing on it saying why. A create is always a change,
  // so there is nothing to grandfather here.
  //
  // Uncanonicalised, unlike the creator publish route: this picker deliberately
  // takes a custom tag ("Grandma's", "Tuesday") that no vocabulary knows, and
  // these tags are private to the one account that wrote them.
  //
  // `serves` is deliberately NOT checked here, and the asymmetry with
  // `/api/creator/meals` is the point. The `serves` rule exists because an
  // import reads a *yield* off a stranger's recipe page and prints it on a card
  // in Discover as a head count. A personal meal is typed by the one person who
  // reads it and goes nowhere else, and the mobile forms that write it are plain
  // text inputs with no client-side check — enforcing it here would surface a
  // raw server sentence in an Alert on a field nobody else ever sees. The web
  // form checks it as a courtesy; that is the right altitude for this field.
  const tooManyTags = Array.isArray(tags) ? tagCapError(tags) : null;
  if (tooManyTags) {
    return NextResponse.json({ error: tooManyTags }, { status: 400 });
  }

  const supabase = createServerSupabaseClient();

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
      .eq('user_id', decoded.userId)
      .eq('is_active', true);

    if ((count ?? 0) >= 3) {
      log({ event: 'MEAL:CREATE', status: 'failed', userId: decoded.userId, reason: 'tier limit reached' });
      return NextResponse.json(
        { error: 'Free plan is limited to 3 meals. Upgrade to Full Access to add more.', tierLimitReached: true },
        { status: 403 }
      );
    }
  }
  const resolvedPhotoUrl = await resolvePhotoUrl(photoUrl, decoded.userId).catch(() => photoUrl ?? null);

  const { data: meal, error } = await supabase
    .from('meals')
    .insert({
      user_id: decoded.userId,
      name,
      store_id: storeId,
      ingredients,
      created_at: createdAt ? new Date(createdAt).toISOString() : new Date().toISOString(),
      ...(presetMealId ? { preset_meal_id: presetMealId } : {}),
      ...(website   ? { website }   : {}),
      ...(recipe    ? { recipe }    : {}),
      ...(story     ? { story }     : {}),
      ...(resolvedPhotoUrl  ? { photo_url: resolvedPhotoUrl } : {}),
      ...(author     ? { author }     : {}),
      ...(difficulty ? { difficulty } : {}),
      ...(Array.isArray(tags) && tags.length ? { tags } : {}),
      ...(creatorId ? { creator_id: creatorId } : {}),
      ...(serves    ? { serves }    : {}),
    })
    .select()
    .single();

  if (error) {
    log({ event: 'MEAL:CREATE', status: 'error', userId: decoded.userId, error });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  log({ event: 'MEAL:CREATE', status: 'success', userId: decoded.userId, detail: meal.id });
  return NextResponse.json({ meal }, { status: 201 });
}
