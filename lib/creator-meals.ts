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
import { platformSourceForUrl } from '@/lib/creator-sources';
import { urlIdentity } from '@/lib/import/ssrf';
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

/**
 * What gets stored in `preset_meals.source`.
 *
 * Exported because the duplicate check has to fold the *stored* value, not the
 * typed one: a creator who types `chefsarah.com/x` today and pastes
 * `https://chefsarah.com/x` tomorrow published the same link twice, and a
 * comparison made before this ran would not know it.
 */
export function withScheme(url?: string | null): string {
  const value = url?.trim();
  if (!value) return '';
  return value.startsWith('http://') || value.startsWith('https://') ? value : `https://${value}`;
}

/**
 * The identity two publishes of one link share, or null when there is no
 * usable link. `urlIdentity` folds scheme, `www.`, tracking parameters and a
 * trailing slash — without it `http://x/y`, `https://x/y` and `https://www.x/y`
 * are three different meals and no duplicate check ever fires.
 */
export function publishIdentity(source?: string | null): string | null {
  const url = withScheme(source);
  return url ? urlIdentity(url) : null;
}

/** A published meal of this creator's that came from the same link. */
export interface DuplicateSource {
  id: string;
  name: string;
}

/**
 * Has this creator already published a meal from this link?
 *
 * Compared in memory rather than in SQL because the stored `source` is whatever
 * the creator typed and the comparison is on its folded identity — there is no
 * index to use and a creator's own meals are a handful of rows.
 */
export async function findMealFromSameLink(
  supabase: SupabaseClient,
  creatorId: string,
  identity: string,
): Promise<DuplicateSource | null> {
  const { data } = await supabase
    .from('preset_meals')
    .select('id, name, source')
    .eq('creator_id', creatorId)
    .not('source', 'is', null);

  const match = ((data ?? []) as Array<Record<string, any>>).find(
    (meal) => typeof meal.source === 'string' && publishIdentity(meal.source) === identity,
  );
  return match ? { id: String(match.id), name: String(match.name ?? '') } : null;
}

/**
 * Claims a link for one publish, so a repeat is recognised instead of re-run.
 *
 * The prompt in the portal handles the deliberate case — a creator publishing a
 * second recipe from a post with two of them. It cannot handle a double-click, a
 * browser retrying a slow POST, or two tabs, because there the second request
 * arrives before the first has written anything and there is nothing yet to warn
 * about. That is the same read-then-write race MEAL-91's review found in
 * `approveDraft`, and it wants the same answer: claim first, and let the
 * database decide who won.
 *
 * The claim is a `creator_source_items` row, keyed exactly the way the one-link
 * admin sync keys a pasted URL — `(creator_id, source, item_id)` with the folded
 * identity as the item. That UNIQUE constraint is already the idempotency
 * guarantee for the poller (MEAL-75), and it serves the same purpose here: two
 * racing inserts, one winner. It also means a post a creator published by hand
 * is not later re-imported from underneath them.
 *
 * `imported` with **no** `draft_id` is what a hand publish looks like; the sync
 * always writes a draft id alongside that status. A record carrying one says a
 * draft exists in the review queue, which is not a published meal and must not
 * block a creator publishing their own — so it yields rather than refusing.
 */
export type PublishClaim =
  | { ok: true; release: () => Promise<void> }
  | { ok: false };

export async function claimPublishFromLink(
  supabase: SupabaseClient,
  creatorId: string,
  sourceUrl: string,
  identity: string,
  now: () => number = Date.now,
): Promise<PublishClaim> {
  const source = platformSourceForUrl(identity);
  const nowIso = new Date(now()).toISOString();
  const detail = 'Published by the creator from the portal.';
  const key = { creator_id: creatorId, source, item_id: identity };
  const noop = { ok: true as const, release: async () => {} };

  const { data: existing } = await supabase
    .from('creator_source_items')
    .select('id, status, draft_id, detail')
    .eq('creator_id', creatorId)
    .eq('source', source)
    .eq('item_id', identity)
    .maybeSingle();

  const record = existing as Record<string, any> | null;

  if (record && record.status === 'imported') {
    // Somebody holds it. Ours (no draft id) means this creator already published
    // from this link — a moment ago in a twin request, or in an earlier session.
    return record.draft_id ? noop : { ok: false };
  }

  if (record) {
    // A `seen`, `failed` or `rejected` record from a sync or the poller. Claimed
    // with the same conditional-update shape `decideDraft` uses: the write is
    // the test, so two requests cannot both read `seen` and both proceed.
    const { data: claimed } = await supabase
      .from('creator_source_items')
      .update({ status: 'imported', detail, updated_at: nowIso })
      .eq('id', record.id)
      .neq('status', 'imported')
      .select('id');
    if (!Array.isArray(claimed) || claimed.length === 0) return { ok: false };
    const previous = String(record.status);
    return {
      ok: true,
      release: async () => {
        await supabase
          .from('creator_source_items')
          .update({ status: previous, detail: record.detail ?? null, updated_at: new Date(now()).toISOString() })
          .eq('id', record.id);
      },
    };
  }

  // No record at all. The insert is the atomic decider: the loser of a race gets
  // the unique violation rather than a second meal.
  const { error } = await supabase
    .from('creator_source_items')
    .insert({ ...key, url: sourceUrl, status: 'imported', detail, updated_at: nowIso });
  if (error) return { ok: false };

  return {
    ok: true,
    // A claim with no meal behind it would block this link forever, and the
    // creator would be told they had already published something that does not
    // exist. Released the moment the insert it was protecting fails.
    release: async () => {
      await supabase
        .from('creator_source_items')
        .delete()
        .eq('creator_id', creatorId)
        .eq('source', source)
        .eq('item_id', identity)
        .is('draft_id', null);
    },
  };
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
