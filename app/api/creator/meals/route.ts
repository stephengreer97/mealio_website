import { NextRequest, NextResponse } from 'next/server';
import { revalidateTag } from 'next/cache';
import { createServerSupabaseClient } from '@/lib/supabase';
import { verifyAccessToken, extractTokenFromHeader } from '@/lib/tokens';
import {
  claimPublishFromLink,
  findMealByPublishToken,
  findMealFromSameLink,
  normalizePublishToken,
  publishCreatorMeal,
  publishIdentity,
  PublishTokenTaken,
  withScheme,
  type PublishClaim,
} from '@/lib/creator-meals';
import { canonicalizeTags, SERVES_ERROR, SERVES_PATTERN, tagCapError } from '@/lib/import/vocab';
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

  // Canonicalised first, then counted — the order the draft PATCH already uses.
  // Counting raw made the cap a count of *strings*: three arbitrary ones matched
  // no Discover filter and looked like typos on the card, and three copies of
  // 'Vegan' rendered three identical chips and still passed. Both forms pick
  // from `MEAL_TAGS` and cannot produce either, so nothing a picker sends is
  // changed by this; it is the hand-written request that is.
  //
  // Dropping an out-of-vocabulary tag is not the same concession as trimming an
  // over-cap one: the tag was never selectable and would never have matched
  // anything. Over-cap is still refused, not trimmed.
  const canonicalTags = Array.isArray(tags) ? canonicalizeTags(tags.map(String)) : undefined;
  const tooManyTags = canonicalTags ? tagCapError(canonicalTags) : null;
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

  // Both refusals above run before the link claim below is taken. A claim taken
  // for a request that is then refused would hold the link with no meal behind
  // it until it aged out, and tell the creator they had already published
  // something that does not exist.

  // ── One publish attempt, one meal (MEAL-93) ───────────────────────────────
  //
  // The claim below cannot close this on its own: it is deliberately skipped
  // once the creator has confirmed the duplicate prompt, because it cannot tell
  // a second recipe from the same page apart from a second click on the same
  // button. So a double-click, a browser retrying a slow POST, or two goes at
  // "Publish anyway" each produced a meal.
  //
  // The token is the thing that *can* tell them apart, because only the client
  // knows which of its submissions are the same submission. It is minted once
  // per publish attempt in the portal — not per click — so a repeat carries the
  // same value and loses on `preset_meals_publish_token_key`, while a genuine
  // second recipe carries a new one. Nothing here mints one: a token this route
  // generated would be new on every request and would guarantee nothing.
  const tokenResult = normalizePublishToken(body.publishToken);
  if (!tokenResult.ok) {
    return NextResponse.json({ error: tokenResult.error }, { status: 400 });
  }
  const publishToken = tokenResult.token;

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
              'A meal from this link was published a moment ago. Check your meals below before publishing it again.',
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
      {
        name, ingredients, recipe, source, story, photoUrl, difficulty,
        tags: canonicalTags,
        serves: servesText || null,
        publishToken,
      },
    );
  } catch (err) {
    // The index refused a second meal for this attempt, which means the first
    // one landed. That is the outcome the creator asked for, so it is a success
    // and it answers with the meal that exists — reporting an error here would
    // send them looking for a publish that worked, and a retry of the retry
    // would find the same thing again.
    //
    // The claim is deliberately *not* released: the meal behind it is real and
    // still holds the link.
    if (err instanceof PublishTokenTaken && publishToken) {
      const first = await findMealByPublishToken(supabase, creator.id, publishToken);
      if (first) {
        log({ event: 'CREATOR:MEAL_CREATE', status: 'success', userId: creator.id, detail: `repeat of publish token, id=${first.id}` });
        return NextResponse.json({ meal: first }, { status: 200 });
      }
    }
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
