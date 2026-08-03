import { NextRequest, NextResponse } from 'next/server';
import { revalidateTag } from 'next/cache';
import { createServerSupabaseClient } from '@/lib/supabase';
import { verifyAccessToken, extractTokenFromHeader } from '@/lib/tokens';
import { publishCreatorMeal } from '@/lib/creator-meals';
import { SERVES_ERROR, SERVES_PATTERN, tagCapError } from '@/lib/import/vocab';
import { log } from '@/lib/logger';

async function getCreator(request: NextRequest) {
  const token = extractTokenFromHeader(request.headers.get('authorization'));
  if (!token) return null;
  const decoded = await verifyAccessToken(token);
  if (!decoded) return null;

  const supabase = createServerSupabaseClient();
  const { data: creator } = await supabase
    .from('creators')
    .select('id, display_name')
    .eq('user_id', decoded.userId)
    .maybeSingle();

  if (!creator) return null;
  return { creator, userId: decoded.userId };
}

// POST /api/creator/meals — publish a new preset meal
export async function POST(request: NextRequest) {
  const result = await getCreator(request);
  if (!result) {
    return NextResponse.json({ error: 'Creator account required' }, { status: 403 });
  }
  const { creator, userId } = result;

  const body = await request.json();
  const { name, ingredients, recipe, source, story, photoUrl, difficulty, tags, serves } = body;

  if (!name?.trim() || !Array.isArray(ingredients) || ingredients.length === 0) {
    return NextResponse.json({ error: 'name and ingredients are required' }, { status: 400 });
  }

  // Both forms cap their pickers at three, so an over-cap list is a client that
  // has drifted from the rule rather than a creator to be corrected — but it is
  // still refused here, not trimmed. Uncanonicalised, unlike the draft PATCH:
  // this route stores what it is given, so the count that matters is the count
  // that would be written.
  const tooManyTags = Array.isArray(tags) ? tagCapError(tags) : null;
  if (tooManyTags) {
    return NextResponse.json({ error: tooManyTags }, { status: 400 });
  }

  // `serves` is a head count, and the column is free text. `SERVES_PATTERN` is
  // the rule the extraction already applies and the draft editor already
  // enforces; this route accepted "2 1/2 cups" and put it on the card.
  const servesText = serves == null ? '' : String(serves).trim();
  if (servesText && !SERVES_PATTERN.test(servesText)) {
    return NextResponse.json({ error: SERVES_ERROR }, { status: 400 });
  }

  // The insert itself is shared with admin sync (MEAL-90) so attribution — the
  // author name savers see, and the creator_id the profit share counts — is
  // written in exactly one place.
  const supabase = createServerSupabaseClient();
  let meal;
  try {
    meal = await publishCreatorMeal(
      supabase,
      { id: creator.id, display_name: creator.display_name, user_id: userId },
      { name, ingredients, recipe, source, story, photoUrl, difficulty, tags, serves: servesText || null },
    );
  } catch (err) {
    log({ event: 'CREATOR:MEAL_CREATE', status: 'error', userId: creator.id, detail: String(err) });
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Publish failed' }, { status: 500 });
  }

  revalidateTag('trending-meals', 'max');
  log({ event: 'CREATOR:MEAL_CREATE', status: 'success', userId: creator.id, detail: `id=${meal.id} name="${meal.name}"` });
  return NextResponse.json({ meal }, { status: 201 });
}
