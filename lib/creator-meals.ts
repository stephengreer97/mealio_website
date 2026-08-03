/**
 * Publishing a meal on a creator's behalf.
 *
 * Extracted from `POST /api/creator/meals` when admin sync (MEAL-90) became a
 * second way for a creator meal to reach `preset_meals`. Both callers must agree
 * on attribution — `author` is the display name savers see and `creator_id` is
 * what the profit-share leaderboard counts — and a second hand-written insert is
 * how those two drift apart.
 *
 * Cache invalidation is deliberately *not* here: `revalidateTag` belongs to the
 * request that finished, and admin sync publishes a batch and revalidates once
 * rather than once per meal.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { resolvePhotoUrl } from '@/lib/photos';
import { SERVES_ERROR, SERVES_PATTERN, tagCapError } from '@/lib/import/vocab';
import type { CreatorMealDraft } from '@/lib/import/types';

export interface PublishingCreator {
  id: string;
  display_name: string;
  /** The creator's own user id. Scopes the storage path a photo is copied into. */
  user_id: string;
}

/** The nine fields a creator meal carries. `CreatorMealDraft` is exactly this shape. */
export type CreatorMealInput = Partial<CreatorMealDraft> & Pick<CreatorMealDraft, 'name' | 'ingredients'>;

/** The inserted row. Returned whole: the publish route hands it straight back. */
export interface PublishedMeal {
  id: string;
  name: string;
  [column: string]: unknown;
}

function withScheme(url?: string | null): string {
  const value = url?.trim();
  if (!value) return '';
  return value.startsWith('http://') || value.startsWith('https://') ? value : `https://${value}`;
}

/**
 * Inserts one preset meal attributed to `creator`. Throws on a database error so
 * a batch caller can mark that one item failed and carry on.
 */
export async function publishCreatorMeal(
  supabase: SupabaseClient,
  creator: PublishingCreator,
  input: CreatorMealInput,
): Promise<PublishedMeal> {
  // Checked here as well as at both callers, for the same reason the insert
  // itself is here: this is the one place a row reaches `preset_meals`, so it is
  // the only place that can promise what a published meal looks like. The route
  // is a validating caller; **Approve is not** — it publishes a draft row that
  // may have been written by an older build, or by an import that suggested up
  // to eight tags, and a batch approve of those would otherwise put a six-tag
  // meal on Discover with three of them invisible.
  //
  // Throwing is what a batch caller already handles: `approveDraft` puts the
  // draft back in the queue with this sentence attached, so the operator can
  // deselect down to the cap and approve again.
  const tooManyTags = Array.isArray(input.tags) ? tagCapError(input.tags) : null;
  if (tooManyTags) throw new Error(tooManyTags);
  if (input.serves && !SERVES_PATTERN.test(input.serves)) throw new Error(SERVES_ERROR);

  // A Pixabay stand-in photo is copied into our own bucket rather than
  // hotlinked. A failure here is not a reason to lose the meal — the meal is the
  // thing the creator wrote, the photo is decoration.
  const photoUrl = await resolvePhotoUrl(input.photoUrl, creator.user_id).catch(() => input.photoUrl ?? null);

  const { data, error } = await supabase
    .from('preset_meals')
    .insert({
      name:       input.name.trim(),
      author:     creator.display_name,
      creator_id: creator.id,
      ingredients: input.ingredients,
      source:     withScheme(input.source),
      recipe:     input.recipe?.trim() || null,
      story:      input.story?.trim() || null,
      photo_url:  photoUrl || null,
      difficulty: input.difficulty || null,
      serves:     input.serves || null,
      ...(Array.isArray(input.tags) && input.tags.length ? { tags: input.tags } : {}),
    })
    .select()
    .single();

  if (error || !data) {
    throw new Error(error?.message ?? 'The meal could not be saved.');
  }
  return data as PublishedMeal;
}
