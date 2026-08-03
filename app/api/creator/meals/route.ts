import { NextRequest, NextResponse } from 'next/server';
import { revalidateTag } from 'next/cache';
import { createServerSupabaseClient } from '@/lib/supabase';
import { verifyAccessToken, extractTokenFromHeader } from '@/lib/tokens';
import {
  claimPublishFromLink,
  findMealFromSameLink,
  publishCreatorMeal,
  publishIdentity,
  withScheme,
  type PublishClaim,
} from '@/lib/creator-meals';
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

  const supabase = createServerSupabaseClient();

  // ── The same link, twice (MEAL-93) ────────────────────────────────────────
  //
  // Warned, never blocked. A creator can legitimately publish two meals from one
  // page — a post with two recipes, a "three ways with…" — and a hard uniqueness
  // rule would make that impossible with no way around it. So a second publish
  // from a link they have already used asks first, names the meal it found, and
  // goes ahead on `confirmDuplicate`.
  //
  // The claim below is the other half, and it is not the prompt: see
  // `claimPublishFromLink` for the race the prompt cannot see.
  const identity = publishIdentity(source);
  let claim: PublishClaim | null = null;

  if (identity) {
    const existing = await findMealFromSameLink(supabase, creator.id, identity);
    if (existing && body.confirmDuplicate !== true) {
      return NextResponse.json(
        {
          error: `You already published "${existing.name}" from this link.`,
          duplicate: existing,
        },
        { status: 409 },
      );
    }

    // Skipped once they have confirmed: the claim is held by the meal they were
    // just shown, and taking it again is what would make the second recipe from
    // one page impossible.
    if (!existing) {
      claim = await claimPublishFromLink(supabase, creator.id, withScheme(source), identity);
      if (!claim.ok) {
        return NextResponse.json(
          {
            error:
              'A meal from this link was published a moment ago — check your meals below before publishing it again.',
          },
          { status: 409 },
        );
      }
    }
  }

  // The insert itself is shared with admin sync (MEAL-90) so attribution — the
  // author name savers see, and the creator_id the profit share counts — is
  // written in exactly one place.
  let meal;
  try {
    meal = await publishCreatorMeal(
      supabase,
      { id: creator.id, display_name: creator.display_name, user_id: userId },
      { name, ingredients, recipe, source, story, photoUrl, difficulty, tags, serves },
    );
  } catch (err) {
    // Give the link back. A claim with no meal behind it would tell this creator
    // for ever that they had already published something that does not exist.
    if (claim?.ok) await claim.release().catch(() => {});
    log({ event: 'CREATOR:MEAL_CREATE', status: 'error', userId: creator.id, detail: String(err) });
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Publish failed' }, { status: 500 });
  }

  revalidateTag('trending-meals', 'max');
  log({ event: 'CREATOR:MEAL_CREATE', status: 'success', userId: creator.id, detail: `id=${meal.id} name="${meal.name}"` });
  return NextResponse.json({ meal }, { status: 201 });
}
