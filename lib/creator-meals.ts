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
import { log, type EventType } from '@/lib/logger';
import { platformSourceForUrl, type PlatformSource } from '@/lib/creator-sources';
import { urlIdentity } from '@/lib/import/ssrf';
import { videoIdFromUrl } from '@/lib/youtube';
import { canonicalizeTags, SERVES_ERROR, SERVES_PATTERN, tagCapError } from '@/lib/import/vocab';
import type { CreatorMealDraft } from '@/lib/import/types';

export interface PublishingCreator {
  id: string;
  display_name: string;
  /** The creator's own user id. Scopes the storage path a photo is copied into. */
  user_id: string;
}

/** The nine fields a creator meal carries. `CreatorMealDraft` is exactly this shape. */
export type CreatorMealInput = Partial<CreatorMealDraft> & Pick<CreatorMealDraft, 'name' | 'ingredients'> & {
  /**
   * One publish attempt's idempotency key, written to `preset_meals`.
   *
   * Null for every path that does not mint one — the admin sync publishes a
   * reviewed batch where the operator's decision is the record, and the partial
   * unique index leaves those rows alone.
   */
  publishToken?: string | null;
};

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

// ── One publish attempt, one meal (MEAL-93) ──────────────────────────────────

/**
 * Longest publish token we will store.
 *
 * A UUID is 36 characters and that is what the portal sends; the room above it
 * is for a client that keys its attempts some other way. The point of a bound is
 * that this value is written to a column, read back into log lines and compared
 * on an index forever after, and none of those places want a client-supplied
 * string of arbitrary length.
 */
const MAX_PUBLISH_TOKEN_CHARS = 128;

export type PublishTokenResult =
  /** `token` is the trimmed key, or null when the request sent none. */
  | { ok: true; token: string | null }
  | { ok: false; error: string };

/**
 * Validates the idempotency key a publish carries.
 *
 * A malformed key is refused rather than dropped. Dropping it would publish the
 * meal with the double-submit protection silently switched off, which is the
 * failure shape this whole mechanism exists to remove — the same reasoning that
 * made `normalizePlatformUrl` refuse a non-string instead of folding it to
 * blank.
 */
export function normalizePublishToken(raw: unknown): PublishTokenResult {
  if (raw === undefined || raw === null) return { ok: true, token: null };
  if (typeof raw !== 'string') {
    return { ok: false, error: 'publishToken must be a string.' };
  }
  const token = raw.trim();
  if (!token) return { ok: true, token: null };
  if (token.length > MAX_PUBLISH_TOKEN_CHARS) {
    return { ok: false, error: `publishToken must be ${MAX_PUBLISH_TOKEN_CHARS} characters or fewer.` };
  }
  return { ok: true, token };
}

/**
 * Raised when `(creator_id, publish_token)` is already taken.
 *
 * Not an error the caller reports: it means the meal this request asked for
 * exists, written by the request that got here first. The caller reads it as
 * success and returns that meal — see `findMealByPublishToken`.
 */
export class PublishTokenTaken extends Error {
  constructor() {
    super('This publish attempt has already produced a meal.');
    this.name = 'PublishTokenTaken';
  }
}

/** Postgres' unique-violation SQLSTATE, as PostgREST reports it. */
const UNIQUE_VIOLATION = '23505';

/** The meal a publish token already produced, for the request that lost the race. */
export async function findMealByPublishToken(
  supabase: SupabaseClient,
  creatorId: string,
  token: string,
): Promise<PublishedMeal | null> {
  const { data } = await supabase
    .from('preset_meals')
    .select()
    .eq('creator_id', creatorId)
    .eq('publish_token', token)
    .maybeSingle();
  return (data as PublishedMeal | null) ?? null;
}

/** A published meal of this creator's that came from the same link. */
export interface DuplicateSource {
  id: string;
  name: string;
}

/**
 * How many of a creator's meals the duplicate prompt reads.
 *
 * The comparison is on a folded identity, which no index can serve, so this is
 * an unfiltered read of the creator's own rows. Unbounded it inherits
 * PostgREST's default page instead — 1000 rows, silently, with no error and no
 * marker saying the answer was truncated, so the prompt would simply stop firing
 * for the most prolific creators and nothing would say why. A stated bound with
 * the newest rows inside it is a limit we chose; the other kind is one we found
 * out about. Newest first because a repeat publish is a repeat of recent work.
 *
 * The prompt is a warning, never a block — the hard guarantee is the claim
 * below, which is an indexed lookup on one key and is not affected by this.
 */
const DUPLICATE_SCAN_LIMIT = 500;

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
    .not('source', 'is', null)
    .order('created_at', { ascending: false })
    .limit(DUPLICATE_SCAN_LIMIT);

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

/**
 * How long a hand-publish claim with no meal behind it is believed.
 *
 * The caller only claims when no meal of this creator's holds the link, so a
 * record already sitting there is one of two things: the twin of a request still
 * in flight, or an orphan whose request died between the claim and the insert.
 * Nothing on the row tells them apart — `release()` runs from a `catch`, and a
 * killed function runs no `catch` — so age does. A publish is one photo copy and
 * one insert inside a serverless invocation that is killed after seconds; five
 * minutes is far past any of that, which makes a claim older than this one
 * nobody is coming back for.
 *
 * The consequence of the two mistakes is why the window is generous rather than
 * tight: taking over too early publishes a second meal, waiting too long only
 * delays a retry the creator can make themselves.
 */
export const CLAIM_GRACE_MS = 5 * 60 * 1000;

/**
 * The `item_id` a hand publish's record has to land under.
 *
 * Per source, because the poller's key is per source: YouTube records are keyed
 * on the bare video id (`parseUploadsFeed`), and a record written under a URL is
 * one the sync will never find — it re-imports the post the creator published by
 * hand, which is the exact promise this record exists to keep. The folded
 * identity is right for a website, where a feed's own guid is a URL anyway.
 *
 * Instagram and TikTok have no catalog yet (MEAL-82 / 83), so there is no key to
 * agree with; they fold to the identity and this is the one place that changes
 * when those land.
 *
 * Shared with the one-link admin sync, which starts from a pasted URL for the
 * same reason a hand publish does. Two hand paths deriving this separately is
 * how they would come to disagree about what one video is called.
 */
export function sourceItemId(source: PlatformSource, identity: string): string {
  return (source === 'youtube' && videoIdFromUrl(identity)) || identity;
}

/** Drops a hand publish's claim, so the link can be published from again. */
async function dropClaim(
  supabase: SupabaseClient,
  creatorId: string,
  source: PlatformSource,
  itemId: string,
): Promise<void> {
  await supabase
    .from('creator_source_items')
    .delete()
    .eq('creator_id', creatorId)
    .eq('source', source)
    .eq('item_id', itemId)
    // Never a record the sync owns. Those carry a draft in the review queue, and
    // deleting one here would strand it.
    .is('draft_id', null);
}

/**
 * Releases the claim a published meal holds over its link.
 *
 * Called when the meal stops holding it — deleted, or edited onto a different
 * link. Without this the record outlives the meal it was protecting, and since
 * the record is what the *next* publish is refused against, deleting a meal
 * (a typo in the title, the wrong photo — the ordinary reasons) would lock its
 * link out of publishing for good, with an error saying a meal exists that does
 * not. Deleting rather than reverting to `seen`: the meal is gone, so the post
 * genuinely is un-imported and a later sync should offer it again.
 */
export async function releaseLinkClaim(
  supabase: SupabaseClient,
  creatorId: string,
  sourceUrl: string | null | undefined,
): Promise<void> {
  const identity = publishIdentity(sourceUrl);
  if (!identity) return;
  const source = platformSourceForUrl(identity);
  await dropClaim(supabase, creatorId, source, sourceItemId(source, identity));
}

/** Half of the `creator_source_items` key, with the creator that owns it. */
export interface SourceItemKey {
  creatorId: string;
  source: string;
  itemId: string;
}

/**
 * Moves one source item off `imported`, so the post it names is offerable again.
 *
 * Two decisions reach this: a creator deleting a published meal, and a human
 * declining the draft a post produced. They mean different things and log under
 * different events, but the write is the same one and the parts that are easy to
 * get wrong are shared.
 *
 * **Guarded on `imported`.** A row a later run, a poller retry or an operator
 * has already moved on is not this decision's to rewrite — without the guard, a
 * decline landing after the same post has been re-imported would mark the *new*
 * import declined.
 *
 * **Never cleared.** The same table tells the poller what it has already seen,
 * and it treats any record as seen whatever its status. Deleting the row would
 * have the next poll find an unrecognised post, import it, get declined again,
 * and round it goes — which is exactly what a decline exists to stop. A status
 * the poller ignores and the catalogue offers is what makes re-import a request
 * rather than a loop.
 *
 * **Says so out loud.** Every caller ignores the outcome — the meal is already
 * deleted, the draft is already declined, and refusing either of those over
 * bookkeeping would be worse — but "ignored by the caller" and "invisible to us"
 * are different things, and the first attempt at the withdraw failed silently:
 * the row kept saying `imported`, the checklist kept refusing the post, and
 * nothing anywhere said why. A CHECK constraint that does not know the value
 * being written is the likeliest cause and looks exactly like this.
 */
export async function releaseImportedItem(
  supabase: SupabaseClient,
  key: SourceItemKey,
  next: { status: 'withdrawn' | 'rejected' | 'declined'; detail?: string },
  event: { name: EventType; detail: string },
): Promise<void> {
  const patch: Record<string, unknown> = { status: next.status, updated_at: new Date().toISOString() };
  // Only when the caller has something to say. The column is what the catalogue
  // shows on hover, and overwriting a gate's explanation with an empty one loses
  // the only account of why a post was refused.
  if (next.detail !== undefined) patch.detail = next.detail;

  const { data, error } = await supabase
    .from('creator_source_items')
    .update(patch)
    .eq('creator_id', key.creatorId)
    .eq('source', key.source)
    .eq('item_id', key.itemId)
    .eq('status', 'imported')
    // Asked for, because "the guard declined" and "the write worked" are the two
    // outcomes worth telling apart and a matchless UPDATE reports neither an
    // error nor a row. `changed=0` in the log is how a row that has moved on —
    // or a key that never named one — stops being indistinguishable from a
    // success.
    .select('item_id');

  log({
    event: event.name,
    status: error ? 'error' : 'success',
    detail: `${event.detail} source=${key.source} item=${key.itemId} changed=${Array.isArray(data) ? data.length : 0}`,
    ...(error ? { error } : {}),
  });
}

/**
 * Marks a deleted meal's source post as withdrawn rather than imported.
 *
 * Deleting a meal used to leave `creator_source_items` saying `imported`
 * forever, so the post could never be imported again: the catalogue showed it
 * as already in and `recordItem` refused it server-side. A creator who deleted
 * a meal to redo it found the post they made it from permanently out of reach.
 *
 * Not cleared, though, and the difference is the whole design. The same table
 * tells the *poller* what it has already seen — it treats any record as seen,
 * whatever its status — so wiping the row would have the next poll find an
 * unrecognised post and import it again, the creator delete it again, and round
 * it goes. And deleting a meal often means "I do not want this on Mealio",
 * which is precisely what that loop overrides.
 *
 * `withdrawn` answers both. The poller still sees a record and leaves it alone;
 * the catalogue and `recordItem` both test for the exact string `imported`, so
 * a withdrawn post becomes tickable again and re-imports on request. Automatic
 * sync stays away, a deliberate re-import is one click.
 *
 * The declined-draft half of the same problem is `cancelDraft`'s (MEAL-99),
 * which writes `declined` through the same guarded update.
 */
export async function withdrawImportedItem(
  supabase: SupabaseClient,
  creatorId: string,
  mealId: string,
): Promise<void> {
  // The draft is what knows which post the meal came from: `published_meal_id`
  // was written at publish, and `item_id` is half the `creator_source_items`
  // key. A meal published by hand has no draft and nothing to withdraw.
  const { data: draft } = await supabase
    .from('creator_import_drafts')
    .select('source, item_id')
    .eq('creator_id', creatorId)
    .eq('published_meal_id', mealId)
    .maybeSingle();

  const row = draft as { source?: string | null; item_id?: string | null } | null;
  if (!row?.source || !row.item_id) return;

  // No detail: the row's own account of what happened to it — the gate's
  // sentence, an operator's note — outlives this and is still the truth about
  // the post.
  await releaseImportedItem(
    supabase,
    { creatorId, source: row.source, itemId: row.item_id },
    { status: 'withdrawn' },
    { name: 'CREATOR:SOURCE_WITHDRAW', detail: `creator=${creatorId} meal=${mealId}` },
  );
}

export async function claimPublishFromLink(
  supabase: SupabaseClient,
  creatorId: string,
  sourceUrl: string,
  identity: string,
  now: () => number = Date.now,
): Promise<PublishClaim> {
  const source = platformSourceForUrl(identity);
  const itemId = sourceItemId(source, identity);
  const nowIso = new Date(now()).toISOString();
  const detail = 'Published by the creator from the portal.';
  const key = { creator_id: creatorId, source, item_id: itemId };
  const noop = { ok: true as const, release: async () => {} };

  const { data: existing } = await supabase
    .from('creator_source_items')
    .select('id, status, draft_id, detail, updated_at')
    .eq('creator_id', creatorId)
    .eq('source', source)
    .eq('item_id', itemId)
    .maybeSingle();

  const record = existing as Record<string, any> | null;

  if (record && record.status === 'imported') {
    // Somebody holds it. A draft id says the sync does, and a draft is not a
    // published meal, so it yields.
    if (record.draft_id) return noop;

    // Ours, and no meal of this creator's is behind it — the caller checked
    // before it got here. Either a twin request is still in flight or the one
    // that claimed this never came back. Age is the only thing that tells them
    // apart, and a stale claim has to be recoverable: it is the difference
    // between a creator retrying and a link nobody can ever publish from again.
    const claimedAt = Date.parse(String(record.updated_at ?? ''));
    if (!Number.isFinite(claimedAt) || now() - claimedAt <= CLAIM_GRACE_MS) {
      return { ok: false };
    }

    // Taken over with the timestamp as the condition, so two requests that both
    // decide it is stale cannot both win — the same "the write is the test"
    // shape as the branch below, on the one column that distinguishes them.
    const { data: taken } = await supabase
      .from('creator_source_items')
      .update({ detail, updated_at: nowIso })
      .eq('id', record.id)
      .eq('updated_at', record.updated_at)
      .select('id');
    if (!Array.isArray(taken) || taken.length === 0) return { ok: false };
    return { ok: true, release: () => dropClaim(supabase, creatorId, source, itemId) };
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
    // exist. Released the moment the insert it was protecting fails — and, for
    // the failure no `catch` can see, aged out by `CLAIM_GRACE_MS` above.
    release: () => dropClaim(supabase, creatorId, source, itemId),
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
  //
  // Canonicalised before it is counted, for the same reason and in the same
  // order as the draft PATCH: the count that matters is the count of tags that
  // can actually match a Discover filter, and a duplicate renders twice on the
  // card while passing a count of strings.
  const tags = Array.isArray(input.tags) ? canonicalizeTags(input.tags.map(String)) : undefined;
  const tooManyTags = tags ? tagCapError(tags) : null;
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
      // Only when one was minted. The index is partial, so a null here is a row
      // that simply does not take part — which is every meal published before
      // this existed and every meal the admin sync publishes.
      ...(input.publishToken ? { publish_token: input.publishToken } : {}),
      // The canonicalised list from above, not `input.tags`: the row that lands
      // in `preset_meals` has to be the same list the cap was counted against.
      ...(tags && tags.length ? { tags } : {}),
    })
    .select()
    .single();

  // The index decided that this attempt's meal already exists. Told apart from
  // every other insert failure here rather than by the caller matching on a
  // message, because the two answers are opposites: one is a 500, the other is
  // the meal the creator asked for.
  if (error && (error as { code?: string }).code === UNIQUE_VIOLATION && input.publishToken) {
    throw new PublishTokenTaken();
  }
  if (error || !data) {
    throw new Error(error?.message ?? 'The meal could not be saved.');
  }
  return data as PublishedMeal;
}
