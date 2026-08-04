import { NextRequest, NextResponse } from 'next/server';
import { revalidateTag } from 'next/cache';
import { createServerSupabaseClient } from '@/lib/supabase';
import { verifyAccessToken, extractTokenFromHeader } from '@/lib/tokens';
import { resolvePhotoUrl } from '@/lib/photos';
import { publishIdentity, releaseLinkClaim, withdrawImportedItem } from '@/lib/creator-meals';
import { servesChangeError, servesTextOf, tagChangeError } from '@/lib/import/vocab';
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

// PUT /api/creator/meals/:id — edit own preset meal
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const result = await getCreator(request);
  if (!result) {
    return NextResponse.json({ error: 'Creator account required' }, { status: 403 });
  }
  const { creator, userId } = result;

  const supabase = createServerSupabaseClient();

  // Verify ownership. Three columns come back with it:
  //
  //   `tags` and `serves` — what the row already holds is what says whether this
  //   save is *changing* either of them, which is the grandfathering rule below.
  //
  //   `source` — this meal may be holding a claim over that link (MEAL-93), and
  //   an edit that moves the meal to a different link has to give the old one
  //   back.
  const { data: existing } = await supabase
    .from('preset_meals')
    .select('id, tags, serves, source')
    .eq('id', id)
    .eq('creator_id', creator.id)
    .maybeSingle();

  if (!existing) {
    return NextResponse.json({ error: 'Meal not found or not yours' }, { status: 404 });
  }

  const body = await request.json();
  const { name, ingredients, recipe, source, story, photoUrl, difficulty, tags, serves } = body;

  // The same two rules `POST /api/creator/meals` publishes under. Both forms
  // reach this route with the *same* fields from the *same* editor — the mobile
  // portal's Save Meal is a create or an update depending only on whether it was
  // opened on an existing meal — so a cap enforced on one and not the other is
  // no cap at all.
  //
  // But both editors also post both fields on *every* save, touched or not, and
  // meals published before the cap existed carry more than three tags. Checking
  // what arrived rather than what changed made those meals uneditable: a typo
  // fixed in the name came back 400 about tags. So each field is checked only
  // when this save is actually changing it — which is what `tagChangeError` and
  // `servesChangeError` are, and why the stored row is read above.
  const incomingTags = Array.isArray(tags) ? tags : [];
  const tooManyTags = tags !== undefined ? tagChangeError(incomingTags, existing.tags) : null;
  if (tooManyTags) {
    return NextResponse.json({ error: tooManyTags }, { status: 400 });
  }

  const servesText = servesTextOf(serves);
  const badServes = serves !== undefined ? servesChangeError(servesText, existing.serves) : null;
  if (badServes) {
    return NextResponse.json({ error: badServes }, { status: 400 });
  }

  const normalizeUrl = (url?: string) => {
    if (!url?.trim()) return '';
    const u = url.trim();
    return u.startsWith('http://') || u.startsWith('https://') ? u : `https://${u}`;
  };

  const updates: Record<string, unknown> = {};
  if (name)        updates.name        = name.trim();
  if (ingredients) updates.ingredients = ingredients;
  if (recipe !== undefined) updates.recipe = recipe?.trim() || null;
  if (source !== undefined) updates.source = normalizeUrl(source);
  if (story !== undefined) updates.story = story?.trim() || null;
  if (photoUrl !== undefined) {
    updates.photo_url = photoUrl
      ? await resolvePhotoUrl(photoUrl, userId).catch(() => photoUrl)
      : null;
  }
  if (difficulty !== undefined) updates.difficulty = difficulty || null;
  // `servesText` is the column's own shape — the column is text, so a numeric
  // `4` from an older client stores "4" rather than 4, and `0` stores "0",
  // which `SERVES_PATTERN` accepts here and on POST alike. An unchanged value
  // is written back as itself, which is what it already was.
  if (serves !== undefined) updates.serves = servesText || null;
  if (tags !== undefined) updates.tags = incomingTags;

  const { data: meal, error } = await supabase
    .from('preset_meals')
    .update(updates)
    .eq('id', id)
    .select()
    .single();

  if (error) {
    log({ event: 'CREATOR:MEAL_UPDATE', status: 'error', detail: id, error });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // The old link is nobody's any more. Left held, it would refuse the creator's
  // next publish from a page this meal no longer points at — a claim outliving
  // the meal that took it is the thing that makes a link unpublishable for good.
  const before = publishIdentity(existing.source as string | null);
  const after = updates.source !== undefined ? publishIdentity(updates.source as string) : before;
  if (before && before !== after) {
    await releaseLinkClaim(supabase, creator.id, existing.source as string | null).catch(() => {});
  }

  revalidateTag('trending-meals', 'max');
  log({ event: 'CREATOR:MEAL_UPDATE', status: 'success', userId: creator.id, detail: id });
  return NextResponse.json({ meal });
}

// DELETE /api/creator/meals/:id — unpublish own preset meal
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const result = await getCreator(request);
  if (!result) {
    return NextResponse.json({ error: 'Creator account required' }, { status: 403 });
  }
  const { creator } = result;

  const supabase = createServerSupabaseClient();

  // Read before the delete, and returned by the delete itself so the link is
  // read from the row that was actually removed rather than one this request
  // never touched.
  const { data: deleted, error } = await supabase
    .from('preset_meals')
    .delete()
    .eq('id', id)
    .eq('creator_id', creator.id)
    .select('id, source');

  if (error) {
    log({ event: 'CREATOR:MEAL_DELETE', status: 'error', detail: id, error });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Unpublishing gives the link back. The claim was only ever standing in for
  // this meal, and a creator who deletes a meal to republish it — the wrong
  // photo, a typo in the title — must not find that the link they published it
  // from now refuses them, permanently, with an error naming a meal they just
  // removed. A failure here is not a reason to fail the delete: the meal is
  // already gone, and `CLAIM_GRACE_MS` frees the record anyway.
  for (const row of (deleted ?? []) as Array<{ source?: string | null }>) {
    await releaseLinkClaim(supabase, creator.id, row.source ?? null).catch(() => {});
  }

  // And the post it was imported from goes back on the shelf. Same posture as
  // the claim above: the meal is already gone, so a failure here is not a reason
  // to fail the delete — it leaves a post marked imported that no longer is,
  // which is the state this whole call exists to correct rather than to create.
  await withdrawImportedItem(supabase, creator.id, id).catch(() => {});

  revalidateTag('trending-meals', 'max');
  log({ event: 'CREATOR:MEAL_DELETE', status: 'success', userId: creator.id, detail: id });
  return NextResponse.json({ ok: true });
}
