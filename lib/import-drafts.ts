/**
 * The admin review queue (MEAL-91).
 *
 * Admin sync used to publish. It now writes a draft here and a person decides,
 * which is the whole ticket: `processSyncItem` computed `result.confidence` on
 * every import and threw it away, so the field-level assessment MEAL-72 exists
 * to produce had never been seen by anyone on this path.
 *
 * Four decisions, and the shape of the file follows them:
 *
 *   approve          publish now — exactly what sync used to do, moved behind a
 *                    button rather than rewritten
 *   sendToCreator    hand the decision to whoever cooked it
 *   edit             fix a wrong measure in place
 *   cancel           decline
 *
 * **Cancel marks, it never deletes.** `creator_source_items` records that the
 * post was imported; a draft row that vanishes leaves that record pointing at
 * nothing, and the next sync or poll of the same post re-imports it and asks
 * again. A declined recipe has to stay declined (the rule MEAL-75 already
 * carries for the poller).
 *
 * Presentation lives in `lib/import/draft-form.ts`, unchanged and shared with
 * the creator portal (MEAL-73). Flagged fields are called out with their reason
 * and source span; fields that verified clean say nothing at all. That is what
 * makes the queue "look at the two we flagged" rather than "read nine fields on
 * every recipe", and it is the same presentation in both places because it is
 * literally the same code.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { publishCreatorMeal, type PublishedMeal, type PublishingCreator } from '@/lib/creator-meals';
import { sendCreatorSyncPublishedEmail } from '@/lib/email';
import { log } from '@/lib/logger';
import {
  fieldStatesFor,
  importedFormValues,
  summarise,
  type FormFieldStates,
  type ImportedFormValues,
  type ImportField,
  type ImportSummary,
} from '@/lib/import/draft-form';
import { canonicalizeIngredient } from '@/lib/import/ingredients';
import { canonicalizeDifficulty, canonicalizeTags, MAX_MEAL_TAGS, SERVES_PATTERN } from '@/lib/import/vocab';
import type { CreatorMealDraft, FieldConfidence, ImportConfidence } from '@/lib/import/types';

// ── Shapes ───────────────────────────────────────────────────────────────────

/** Which queue a draft is sitting in. The column **Send to creator** flips. */
export type DraftReviewBy = 'admin' | 'creator';

/**
 * `pending_review` waiting on a human
 * `approved`       published as the model wrote it
 * `edited`         published after an operator changed a field
 * `cancelled`      declined; the row stays so the post is never re-imported
 */
export type DraftStatus = 'pending_review' | 'approved' | 'edited' | 'cancelled';

export interface ImportDraft {
  id: string;
  creatorId: string;
  /** Display name, for a queue that spans creators. Joined, not stored. */
  creatorName: string | null;
  sourceUrl: string;
  source: string | null;
  itemId: string | null;
  syncRunId: string | null;
  draft: CreatorMealDraft;
  /** MEAL-72's per-field assessment. Null on rows written before it was stored. */
  confidence: ImportConfidence | null;
  status: DraftStatus;
  reviewBy: DraftReviewBy;
  editedAt: string | null;
  decidedAt: string | null;
  decidedBy: string | null;
  publishedMealId: string | null;
  createdAt: string | null;
}

export function toImportDraft(row: Record<string, any>): ImportDraft {
  const creator = row.creators as { display_name?: string } | null | undefined;
  return {
    id: row.id,
    creatorId: row.creator_id,
    creatorName: creator?.display_name ?? null,
    sourceUrl: row.source_url,
    source: row.source ?? null,
    itemId: row.item_id ?? null,
    syncRunId: row.sync_run_id ?? null,
    draft: row.draft as CreatorMealDraft,
    confidence: (row.confidence as ImportConfidence | null) ?? null,
    status: row.status,
    reviewBy: row.review_by ?? 'creator',
    editedAt: row.edited_at ?? null,
    decidedAt: row.decided_at ?? null,
    decidedBy: row.decided_by ?? null,
    publishedMealId: row.published_meal_id ?? null,
    createdAt: row.created_at ?? null,
  };
}

/** The joined shape both the list and the single-draft read ask for. */
export const DRAFT_COLUMNS =
  'id, creator_id, source_url, source, item_id, sync_run_id, draft, confidence, status, ' +
  'review_by, edited_at, decided_at, decided_by, published_meal_id, created_at, ' +
  'creators!creator_id ( display_name )';

export interface DraftDeps {
  supabase: SupabaseClient;
  publisher?: typeof publishCreatorMeal;
  notifier?: typeof sendCreatorSyncPublishedEmail;
  now?: () => number;
  /**
   * Which queue the decision is being made **for**.
   *
   * The rules for approving, editing and declining are identical on both sides
   * — same conditional writes, same publish, same refusal to delete a cancelled
   * row — so a second set of functions for the creator would be a second set to
   * keep correct. Two things do turn on this one field:
   *
   * **The log event.** MEAL-77's consent story turns on *who* decided, and
   * every line in this file said `ADMIN:` — so a creator approving their own
   * recipe was recorded as an operator publishing under their name, which is
   * exactly the distinction the audit trail exists to make.
   *
   * **The queue the write is allowed to touch.** `review_by` used to be a read
   * filter and nothing else: it decided what a creator was *shown* and never
   * what they could *decide*. An operator pressing "Take it back" flipped the
   * column, the draft left the creator's GET and their badge — and the creator
   * still holding that row could approve it straight to Discover, because
   * `creator_id` had not changed and that was the only thing anyone checked.
   * Every decision below now names the queue it is acting for and `decideDraft`
   * carries it as a predicate, so a draft that has moved refuses the write.
   *
   * Defaults to admin, which is what every caller before MEAL-89 was.
   */
  role?: DraftReviewBy;
}

/** Log event names for a decision, by who made it. See `DraftDeps.role`. */
function events(role: DraftReviewBy | undefined) {
  return role === 'creator'
    ? { approve: 'CREATOR:DRAFT_DECIDE', cancel: 'CREATOR:DRAFT_DECIDE', edit: 'CREATOR:DRAFT_EDIT' } as const
    : { approve: 'ADMIN:DRAFT_APPROVE', cancel: 'ADMIN:DRAFT_CANCEL', edit: 'ADMIN:DRAFT_EDIT' } as const;
}

// ── Presentation ─────────────────────────────────────────────────────────────

/**
 * Stand-in assessment for a draft stored without one.
 *
 * Only pre-MEAL-91 rows can be in this state, and the safe reading of "we have
 * no record of checking this" is not "it checked out". Red flags every field it
 * touches, which is noisy — and correct: the alternative is a queue that shows
 * nine silent fields and thereby claims we verified them.
 */
const UNRECORDED: FieldConfidence = {
  level: 'red',
  derivation: 'absent',
  match: 'none',
  score: 0,
  evidence: null,
  reason: 'No field-level check was recorded for this import.',
};

function confidenceOf(draft: ImportDraft): ImportConfidence {
  if (draft.confidence) return draft.confidence;
  return {
    name: UNRECORDED, recipe: UNRECORDED, story: UNRECORDED, photoUrl: UNRECORDED,
    difficulty: UNRECORDED, tags: UNRECORDED, serves: UNRECORDED,
    ingredients: (draft.draft?.ingredients ?? []).map(() => UNRECORDED),
  };
}

/** Everything the review card needs, from the same rules the creator portal uses. */
export interface DraftReview {
  values: ImportedFormValues;
  states: FormFieldStates;
  summary: ImportSummary;
}

/**
 * A stored draft, presented.
 *
 * `written` is every field the draft has a value for: unlike the live import
 * flow there is no creator mid-edit whose wording has to win, so a field is
 * either something we put on the card or something the source did not have.
 */
export function reviewDraft(draft: ImportDraft): DraftReview {
  const values = importedFormValues({ draft: draft.draft, url: draft.sourceUrl });
  const written = values.provided as Partial<Record<ImportField, boolean>>;
  const states = fieldStatesFor({
    confidence: confidenceOf(draft),
    values,
    written,
    // `empty` and `previous` exist for the live creator flow, where a box may
    // already hold the creator's typing or an earlier import's value. A stored
    // draft is rendered from nothing every time: there is no previous state to
    // carry and every box starts empty, so both are their identity values.
    empty: { name: true, recipe: true, story: true, photoUrl: true, difficulty: true, tags: true, serves: true },
    previous: null,
  });
  return { values, states, summary: summarise(states) };
}

/** One queue row: the draft plus how much of it needs attention. */
export interface QueuedDraft extends ImportDraft {
  summary: ImportSummary;
}

export interface QueueScope {
  /**
   * Narrows the queue to one creator's own drafts (MEAL-89).
   *
   * The admin queue spans creators by design — that is what it is for. The
   * creator's does not, and this is the only thing stopping it: `review_by` is
   * `'creator'` on every poller draft in the table, so a creator queue that
   * filtered on `review_by` alone would hand each creator every other
   * creator's unpublished recipes, with Approve underneath them.
   */
  creatorId?: string;
  limit?: number;
}

/**
 * Everything waiting on a reviewer, flagged items first.
 *
 * Sorted here rather than in SQL because "how many fields need a look" is
 * derived from the confidence jsonb by rules that live in `draft-form.ts`, and
 * a second copy of them in a Postgres expression is a second thing to keep
 * true. Either queue is a handful of rows, not a feed.
 *
 * The order is also the creator's queue ORDER — "3 of 10" counts through this
 * list — so it has to be stable across a reload rather than merely sensible:
 * `created_at` breaks every tie, and no row can drift past another between two
 * reads unless something about it actually changed.
 */
export async function listDraftQueue(
  supabase: SupabaseClient,
  reviewBy: DraftReviewBy,
  scope: QueueScope = {},
): Promise<QueuedDraft[]> {
  let query = supabase
    .from('creator_import_drafts')
    .select(DRAFT_COLUMNS)
    .eq('status', 'pending_review')
    .eq('review_by', reviewBy);

  if (scope.creatorId) query = query.eq('creator_id', scope.creatorId);

  const { data } = await query
    .order('created_at', { ascending: true })
    .limit(scope.limit ?? 200);

  const drafts = ((data ?? []) as Array<Record<string, any>>).map(toImportDraft);
  return drafts
    .map((draft) => ({ ...draft, summary: reviewDraft(draft).summary }))
    .sort((a, b) => {
      // Most-flagged first, so the ones nobody needs to squint at fall to the
      // bottom. Oldest first within a tier — a draft should not be able to sit
      // in the queue forever by being unremarkable.
      if (a.summary.needALook !== b.summary.needALook) return b.summary.needALook - a.summary.needALook;
      return (a.createdAt ?? '').localeCompare(b.createdAt ?? '');
    });
}

/**
 * How many drafts are waiting on this creator. The badge, and nothing else.
 *
 * A count rather than a boolean, because the badge shows the number: "10" tells
 * a creator to set aside time and a dot reads identically for one draft and for
 * twenty, which is the part they actually need in order to decide when to look.
 *
 * `head: true` so no row bodies cross the wire — this runs on every portal load
 * and every app foreground, and the drafts themselves are jsonb recipes. The
 * `review_by` filter is what keeps a draft an operator is still holding out of
 * the creator's number; it is not waiting on them yet, and a badge that counts
 * it would send them to a queue with nothing in it.
 */
export async function countPendingDrafts(supabase: SupabaseClient, creatorId: string): Promise<number> {
  const { count } = await supabase
    .from('creator_import_drafts')
    .select('id', { count: 'exact', head: true })
    .eq('creator_id', creatorId)
    .eq('status', 'pending_review')
    .eq('review_by', 'creator');
  return count ?? 0;
}

/**
 * Whether `id` is a draft `creatorId` is allowed to decide (MEAL-89).
 *
 * Every decision below takes an actor and none of them takes an owner: on the
 * admin path `requireAdmin` is the whole authorisation, and a draft id is a
 * uuid an operator legitimately holds. On the creator path the id is the only
 * thing in the request, so without this any creator could approve or decline
 * any other creator's draft by posting a uuid — publishing to Discover under
 * somebody else's name, which is the exact harm MEAL-77 is about.
 *
 * A pre-check rather than an extra predicate on the conditional write, and it
 * is not a TOCTOU gap: `creator_id` is set at insert and never updated, so an
 * ownership answer cannot go stale between this read and the write that
 * follows. Nothing in this module writes it.
 *
 * Fails CLOSED. A row that does not exist, or a read that errors, answers no.
 */
export async function draftBelongsToCreator(
  supabase: SupabaseClient,
  id: string,
  creatorId: string,
): Promise<boolean> {
  const { data } = await supabase
    .from('creator_import_drafts')
    .select('creator_id')
    .eq('id', id)
    .maybeSingle();
  return Boolean(data) && (data as { creator_id?: string }).creator_id === creatorId;
}

// ── Writing a draft ──────────────────────────────────────────────────────────

export interface NewDraft {
  creatorId: string;
  sourceUrl: string;
  source: string | null;
  itemId: string | null;
  syncRunId: string | null;
  draft: CreatorMealDraft;
  confidence: ImportConfidence;
  reviewBy: DraftReviewBy;
}

/**
 * Queues one extraction for review. Returns the new row's id.
 *
 * `confidence` is stored, not discarded. That single omission in
 * `processSyncItem` is what made every green field on this path a claim nobody
 * had ever checked.
 */
export async function createImportDraft(supabase: SupabaseClient, input: NewDraft): Promise<string> {
  const { data, error } = await supabase
    .from('creator_import_drafts')
    .insert({
      creator_id: input.creatorId,
      source_url: input.sourceUrl,
      source: input.source,
      item_id: input.itemId,
      sync_run_id: input.syncRunId,
      draft: input.draft,
      confidence: input.confidence,
      status: 'pending_review',
      review_by: input.reviewBy,
    })
    .select('id')
    .single();

  if (error || !data) {
    throw new Error(error?.message ?? 'The draft could not be queued for review.');
  }
  return (data as { id: string }).id;
}

// ── Decisions ────────────────────────────────────────────────────────────────

export type DraftDecision =
  | { ok: true; draft: ImportDraft }
  | { ok: false; error: string };

/** Reads one draft, with the creator fields a publish and an email both need. */
async function loadDraft(
  supabase: SupabaseClient,
  id: string,
): Promise<{ draft: ImportDraft; creator: PublishingCreator & { email: string | null } } | null> {
  const { data } = await supabase
    .from('creator_import_drafts')
    .select(
      'id, creator_id, source_url, source, item_id, sync_run_id, draft, confidence, status, ' +
        'review_by, edited_at, decided_at, decided_by, published_meal_id, created_at, ' +
        'creators!creator_id ( id, display_name, user_id, user_profiles!user_id ( email ) )',
    )
    .eq('id', id)
    .maybeSingle();

  if (!data) return null;
  const row = data as Record<string, any>;
  const creatorRow = (row.creators ?? {}) as Record<string, any>;
  return {
    draft: toImportDraft(row),
    creator: {
      id: creatorRow.id ?? row.creator_id,
      display_name: creatorRow.display_name ?? '',
      user_id: creatorRow.user_id ?? '',
      email: (creatorRow.user_profiles as { email?: string } | null)?.email ?? null,
    },
  };
}

/**
 * One published meal, for the email that follows a batch of approvals.
 * `creatorId` rides along because a batch can span creators and each of them
 * gets their own message.
 */
export interface ApprovedMeal {
  draftId: string;
  creatorId: string;
  creatorName: string;
  creatorEmail: string | null;
  meal: PublishedMeal;
}

/**
 * Takes a draft out of `pending_review`, or reports that somebody else already did.
 *
 * Every decision in this file is a conditional write, and it is the same three
 * lines each time: patch the row **only while it is still pending and still in
 * the queue the caller is acting for**, ask for the rows that changed, and act
 * only if one came back. Read the status, check it in JavaScript, then write —
 * the shape this replaces — is three round trips with two gaps in it, and two
 * tabs or one retried `fetch` fit through either. Postgres re-evaluates the
 * predicate under the row lock, so of two simultaneous callers exactly one is
 * handed a row.
 *
 * `queue` is the second half of that, and it is why authority lives here rather
 * than at the two route handlers. `review_by` is what "Take it back" flips and
 * what `sendDraftToCreator` flips the other way, so a decision made against the
 * queue a draft has just left is a decision by somebody it is no longer waiting
 * on. Checking it before the write instead would be a real TOCTOU gap — unlike
 * `creator_id`, which is set at insert and never updated, `review_by` changes
 * under a reviewer who has the card open, which is the entire scenario.
 *
 * A draft is in exactly one queue: `review_by` is a single column, so this
 * predicate can never be true of both callers at once.
 */
async function decideDraft(
  deps: DraftDeps,
  id: string,
  queue: DraftReviewBy,
  patch: Record<string, unknown>,
): Promise<boolean> {
  const { data } = await deps.supabase
    .from('creator_import_drafts')
    .update(patch)
    .eq('id', id)
    .eq('status', 'pending_review')
    .eq('review_by', queue)
    .select('id');
  return Array.isArray(data) && data.length > 0;
}

/**
 * The sentence for a decision aimed at a queue the draft is no longer in.
 *
 * Read before the write for the wording only — the refusal itself is the
 * predicate in `decideDraft`, which is what holds when the handover lands
 * between this read and that write. Said plainly and from the reviewer's side:
 * a creator whose recipe was taken back is not being refused, they are being
 * told somebody else is looking at it.
 */
function movedQueues(draft: ImportDraft, queue: DraftReviewBy): string {
  return queue === 'creator'
    ? 'The Mealio team took that one back to look at it themselves, so it is not waiting on you any more.'
    : `That draft is waiting on ${draft.creatorName || 'the creator'}. Take it back before deciding it.`;
}

/**
 * Publishes one draft.
 *
 * This is what `processSyncItem` used to do inline; the code is the same call,
 * just no longer reachable without someone pressing a button. `edited` rather
 * than `approved` when an operator changed a field, so months later the row
 * still answers "did a human rewrite what the model produced?".
 *
 * The decision is written **before** the publish, not after. Two tabs both
 * reading `pending_review` and both publishing is two `preset_meals` rows for
 * one draft under a creator's name, two Discover entries and two "your recipe
 * is live" emails naming different meals — and nothing in `preset_meals` stops
 * it. Claiming first costs a rollback on the failure path below, which is the
 * cheaper of the two prices.
 */
export async function approveDraft(
  deps: DraftDeps,
  id: string,
  adminUserId: string,
): Promise<{ ok: true; approved: ApprovedMeal } | { ok: false; error: string }> {
  const publisher = deps.publisher ?? publishCreatorMeal;
  const now = deps.now ?? Date.now;
  const queue = deps.role ?? 'admin';

  const loaded = await loadDraft(deps.supabase, id);
  if (!loaded) return { ok: false, error: 'That draft no longer exists.' };
  const { draft, creator } = loaded;

  if (draft.status !== 'pending_review') {
    return { ok: false, error: `That draft was already ${draft.status.replace('_', ' ')}.` };
  }
  // Publishing is the decision that cannot be taken back, so it is the one this
  // matters most for: a creator holding a draft an operator has just reclaimed
  // must not be able to put it on Discover under their own name.
  if (draft.reviewBy !== queue) return { ok: false, error: movedQueues(draft, queue) };

  const nowIso = new Date(now()).toISOString();
  const claimed = await decideDraft(deps, id, queue, {
    status: draft.editedAt ? 'edited' : 'approved',
    decided_at: nowIso,
    decided_by: adminUserId,
    updated_at: nowIso,
  });
  if (!claimed) {
    // Somebody else decided it, or moved it to the other queue, between the read
    // above and this write. Which does not matter: it is no longer ours to
    // publish.
    return { ok: false, error: 'That draft was already decided or taken back in another tab.' };
  }

  let meal: PublishedMeal;
  try {
    // Narrowed deliberately: `creator` also carries the address to notify, and
    // an email has no business reaching the row insert.
    meal = await publisher(
      deps.supabase,
      { id: creator.id, display_name: creator.display_name, user_id: creator.user_id },
      draft.draft,
    );
  } catch (err) {
    // Put it back. A draft left `approved` with no meal behind it has gone from
    // the queue without publishing — invisible to the operator and to the
    // creator both, which is the one outcome worse than a failed publish.
    await deps.supabase
      .from('creator_import_drafts')
      .update({ status: 'pending_review', decided_at: null, decided_by: null, updated_at: nowIso })
      .eq('id', id)
      .eq('decided_by', adminUserId)
      .is('published_meal_id', null);
    return { ok: false, error: `Publishing failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  await deps.supabase
    .from('creator_import_drafts')
    .update({ published_meal_id: meal.id, updated_at: nowIso })
    .eq('id', id);

  // Nothing is written to `creator_source_items` here. It already says
  // `imported` and already points at this draft — `recordItem` wrote both at
  // sync time — and the table has no column for a meal, so the update that used
  // to sit here wrote the value that was already in the row while its comment
  // claimed the record now pointed at something live.

  log({
    event: events(deps.role).approve,
    status: 'success',
    userId: adminUserId,
    detail: `draft=${id} creator=${draft.creatorId} meal=${meal.id} ${draft.editedAt ? 'edited' : 'as-extracted'}`,
  });

  return {
    ok: true,
    approved: {
      draftId: id,
      creatorId: draft.creatorId,
      creatorName: creator.display_name,
      creatorEmail: creator.email,
      meal,
    },
  };
}

/**
 * Tells each creator what just went live under their name.
 *
 * One message per creator per batch, listing only what published — a creator
 * who did not ask for this sync does not need the operator's gate rejections.
 * Nothing published means nothing sent.
 *
 * Transactional, never `sendMarketingEmail`: a creator who unsubscribed from
 * campaigns still has to be told that nine recipes are live under their name,
 * and `marketing_opt_out` must not be able to suppress that.
 */
export async function notifyApproved(
  deps: DraftDeps,
  approved: ApprovedMeal[],
): Promise<{ sent: number; errors: string[] }> {
  const notifier = deps.notifier ?? sendCreatorSyncPublishedEmail;
  if (approved.length === 0) return { sent: 0, errors: [] };

  const byCreator = new Map<string, ApprovedMeal[]>();
  for (const entry of approved) {
    const list = byCreator.get(entry.creatorId) ?? [];
    list.push(entry);
    byCreator.set(entry.creatorId, list);
  }

  let sent = 0;
  const errors: string[] = [];

  for (const [creatorId, entries] of byCreator) {
    const { creatorName, creatorEmail } = entries[0];
    if (!creatorEmail) {
      errors.push(`${creatorName || 'That creator'} has no email address on file, so nobody was told.`);
      log({ event: 'ADMIN:DRAFT_NOTIFY', status: 'error', userId: creatorId, reason: 'creator has no email address' });
      continue;
    }
    try {
      await notifier(
        creatorEmail,
        creatorName,
        entries.map((entry) => ({ id: entry.meal.id, name: entry.meal.name })),
      );
      sent += 1;
      log({ event: 'ADMIN:DRAFT_NOTIFY', status: 'success', userId: creatorId, detail: `meals=${entries.length}` });
    } catch (err) {
      // The meals are live either way. Saying so is the point: an operator who
      // thinks the creator was told when they were not is the failure mode.
      errors.push(
        `${creatorName || 'That creator'} was NOT told about ${entries.length} published ` +
          `${entries.length === 1 ? 'recipe' : 'recipes'}: ${err instanceof Error ? err.message : String(err)}`,
      );
      log({ event: 'ADMIN:DRAFT_NOTIFY', status: 'error', userId: creatorId, error: err });
    }
  }

  return { sent, errors };
}

/**
 * Moves a draft into the creator's own queue.
 *
 * The escape hatch for "this looks right, but I am not the person who cooked
 * it". Without it an unsure operator has only approve or delete, and both are
 * worse than asking. Status stays `pending_review` — the decision is handed
 * over, not made.
 *
 * This was a disabled button until MEAL-89. `review_by = 'creator'` was read by
 * exactly one query in this repository and it asked for `'admin'`, so flipping
 * the column did not hand the decision to anyone: it removed the draft from the
 * only queue anybody read, while `creator_source_items` said `imported` so no
 * later poll brought the post back. A `CREATOR_REVIEW_QUEUE_EXISTS` constant
 * held the trapdoor shut and is gone with the same commit that built the far
 * side — `GET /api/creator/import-drafts` now reads exactly these rows, the
 * portal and the app's Creator tab both render them, and `countPendingDrafts`
 * puts the number on a badge so the handoff is visible without being opened.
 */
export async function sendDraftToCreator(
  deps: DraftDeps,
  id: string,
  adminUserId: string,
): Promise<DraftDecision> {
  const now = deps.now ?? Date.now;
  const loaded = await loadDraft(deps.supabase, id);
  if (!loaded) return { ok: false, error: 'That draft no longer exists.' };
  if (loaded.draft.status !== 'pending_review') {
    return { ok: false, error: `That draft was already ${loaded.draft.status.replace('_', ' ')}.` };
  }
  if (loaded.draft.reviewBy === 'creator') {
    return { ok: false, error: 'That draft is already waiting on the creator.' };
  }

  const nowIso = new Date(now()).toISOString();
  // Acting on the admin queue, which is the one a draft has to be in to be
  // handed over. The `reviewBy === 'creator'` refusal above is the friendly
  // wording; this is the predicate that holds when it changes underneath.
  const moved = await decideDraft(deps, id, 'admin', {
    review_by: 'creator',
    sent_to_creator_at: nowIso,
    sent_to_creator_by: adminUserId,
    updated_at: nowIso,
  });
  if (!moved) return { ok: false, error: 'That draft was already decided or handed over in another tab.' };

  log({
    event: 'ADMIN:DRAFT_HANDOFF',
    status: 'success',
    userId: adminUserId,
    detail: `draft=${id} creator=${loaded.draft.creatorId}`,
  });

  return { ok: true, draft: { ...loaded.draft, reviewBy: 'creator' } };
}

/**
 * Everything an operator has handed to a creator and the creator has not
 * decided yet.
 *
 * Before MEAL-89 these rows were in no queue at all — out of the admin's by
 * `review_by`, and into one that did not exist — and listing them was the only
 * thing keeping that recoverable. The creator's queue now reads them, so this
 * has become the ordinary "what am I waiting on somebody else for" list: a
 * handoff is an operator's decision to stop deciding, and a decision whose
 * effect they cannot see afterwards is one they cannot correct.
 *
 * Keyed on `sent_to_creator_at` rather than on `review_by` alone, so the
 * poller's own drafts (`review_by` defaults to `'creator'`) are not swept into
 * an admin screen they do not belong on. Those were never the admin's to watch.
 */
export async function listHandedOverDrafts(supabase: SupabaseClient, limit = 200): Promise<QueuedDraft[]> {
  const { data } = await supabase
    .from('creator_import_drafts')
    .select(DRAFT_COLUMNS)
    .eq('status', 'pending_review')
    .eq('review_by', 'creator')
    .not('sent_to_creator_at', 'is', null)
    .order('created_at', { ascending: true })
    .limit(limit);

  return ((data ?? []) as Array<Record<string, any>>)
    .map(toImportDraft)
    .map((draft) => ({ ...draft, summary: reviewDraft(draft).summary }));
}

/**
 * Brings a handed-over draft back into the admin queue.
 *
 * The action that did not exist, which is half of why the handoff was a
 * trapdoor: nothing could undo it. Still worth having now that the far side is
 * built — a creator who has gone quiet for a month should not be the reason a
 * recipe sits undecided forever. Deliberately not conditional on
 * `sent_to_creator_at` — a row in `review_by = 'creator'` that an operator can
 * see and wants back should come back.
 *
 * Conditional on `pending_review` like every other decision, so taking one back
 * cannot undo an approval the creator made a second earlier and drop a live
 * meal's draft into the admin queue as though nothing had been published.
 */
export async function reclaimDraft(deps: DraftDeps, id: string, adminUserId: string): Promise<DraftDecision> {
  const now = deps.now ?? Date.now;
  const loaded = await loadDraft(deps.supabase, id);
  if (!loaded) return { ok: false, error: 'That draft no longer exists.' };
  if (loaded.draft.status !== 'pending_review') {
    return { ok: false, error: `That draft was already ${loaded.draft.status.replace('_', ' ')}.` };
  }
  if (loaded.draft.reviewBy === 'admin') {
    return { ok: false, error: 'That draft is already in your queue.' };
  }

  const nowIso = new Date(now()).toISOString();
  // The queue it is being taken FROM, not the one it is going to — this is the
  // one caller whose `role` and whose target queue are different things, which
  // is why `decideDraft` takes the queue rather than reading `deps.role`.
  const taken = await decideDraft(deps, id, 'creator', { review_by: 'admin', updated_at: nowIso });
  if (!taken) return { ok: false, error: 'That draft was already decided or taken back in another tab.' };

  log({
    event: 'ADMIN:DRAFT_RECLAIM',
    status: 'success',
    userId: adminUserId,
    detail: `draft=${id} creator=${loaded.draft.creatorId}`,
  });

  return { ok: true, draft: { ...loaded.draft, reviewBy: 'admin' } };
}

/**
 * Declines a draft. **Marks, never removes.**
 *
 * `creator_source_items` still says this post was imported, so the next sync or
 * poll skips it. Delete the row instead and that record points at nothing, the
 * post comes back next cycle, and a human gets asked about a recipe they already
 * said no to.
 */
export async function cancelDraft(deps: DraftDeps, id: string, adminUserId: string): Promise<DraftDecision> {
  const now = deps.now ?? Date.now;
  const queue = deps.role ?? 'admin';
  const loaded = await loadDraft(deps.supabase, id);
  if (!loaded) return { ok: false, error: 'That draft no longer exists.' };
  if (loaded.draft.status !== 'pending_review') {
    return { ok: false, error: `That draft was already ${loaded.draft.status.replace('_', ' ')}.` };
  }
  // Declining is permanent in the way that matters — the row stays `cancelled`
  // and no later poll re-offers the post — so a creator must not be able to
  // decline a draft out from under the operator who took it back to look at.
  if (loaded.draft.reviewBy !== queue) return { ok: false, error: movedQueues(loaded.draft, queue) };

  const nowIso = new Date(now()).toISOString();
  // Conditional for the same reason approve is: a decline interleaved with an
  // approval must not leave the row `cancelled` — out of the queue, nobody
  // looking at it again — with a live meal on Discover behind it that nobody
  // will ever unpublish.
  const declined = await decideDraft(deps, id, queue, {
    status: 'cancelled',
    decided_at: nowIso,
    decided_by: adminUserId,
    updated_at: nowIso,
  });
  if (!declined) return { ok: false, error: 'That draft was already decided or taken back in another tab.' };

  log({
    event: events(deps.role).cancel,
    status: 'success',
    userId: adminUserId,
    detail: `draft=${id} creator=${loaded.draft.creatorId} url=${JSON.stringify(loaded.draft.sourceUrl)}`,
  });

  return { ok: true, draft: { ...loaded.draft, status: 'cancelled' } };
}

const EDITED_REASON = 'An operator changed this, so our check of the model’s value no longer applies.';

/**
 * Validates the nine fields the edit form posts back.
 *
 * The same shape `publishCreatorMeal` takes, because Approve feeds this
 * straight into it — a draft that would be rejected at publish time is better
 * rejected while the reviewer is still looking at it than left in the queue to
 * fail later.
 *
 * The vocabularies are re-applied rather than trusted: tags outside the picker
 * and units outside the editor's list are what the pipeline already normalises,
 * and a hand-edited request is exactly where an unknown one would arrive.
 *
 * The constraints are this module's, NOT `POST /api/creator/meals`'s. That
 * route enforces neither the tag cap nor `SERVES_PATTERN`, and the mobile
 * portal's publish form offers an uncapped tag picker on top of it — so making
 * these rules retrospective there would silently drop tags creators are
 * choosing today. It is a real gap and it wants its own change, with the app's
 * picker moved in the same release. Here they are enforced because both editors
 * that reach this function already refuse a fourth tag, and a rule the client
 * shows and the server does not hold is a rule only for people using the UI.
 */
export function editableDraft(raw: unknown): { ok: true; draft: CreatorMealDraft } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'draft is required' };
  const input = raw as Record<string, unknown>;

  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name) return { ok: false, error: 'A meal name is required.' };

  if (!Array.isArray(input.ingredients)) return { ok: false, error: 'ingredients must be a list.' };
  const ingredients = (input.ingredients as Array<Record<string, unknown>>)
    .map((row) =>
      canonicalizeIngredient({
        productName: String(row?.ingredientName ?? ''),
        measure: row?.measure == null ? null : String(row.measure),
        unit: String(row?.unit ?? ''),
        qty: Number(row?.qty ?? 1),
        evidence: null,
        derivation: 'page-text',
      }),
    )
    .filter((row): row is NonNullable<typeof row> => row !== null);
  if (ingredients.length === 0) return { ok: false, error: 'At least one ingredient is required.' };

  const serves = typeof input.serves === 'string' ? input.serves.trim() : '';
  if (serves && !SERVES_PATTERN.test(serves)) {
    return { ok: false, error: 'Serves must be a number or a range, like 4 or 2-4.' };
  }

  // Refused rather than trimmed, for the same reason `serves` is: a draft can
  // arrive from extraction carrying more than the cap, and quietly dropping the
  // ones past the third would take away tags the reviewer is looking at without
  // saying which. Neither editor can produce this — both stop at the cap — so
  // the only ways here are a draft that came in with more, and a hand-written
  // request.
  const tags = canonicalizeTags(Array.isArray(input.tags) ? input.tags.map(String) : []);
  if (tags.length > MAX_MEAL_TAGS) {
    return {
      ok: false,
      error: `That is ${tags.length} tags. Keep at most ${MAX_MEAL_TAGS} — a meal is only shown under three.`,
    };
  }

  const text = (value: unknown): string | null => {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    return trimmed || null;
  };

  return {
    ok: true,
    draft: {
      name,
      ingredients,
      recipe: text(input.recipe),
      source: typeof input.source === 'string' ? input.source.trim() : '',
      story: text(input.story),
      photoUrl: text(input.photoUrl),
      difficulty: canonicalizeDifficulty(typeof input.difficulty === 'number' ? input.difficulty : null),
      tags,
      serves: serves || null,
    },
  };
}

/**
 * Drops the assessment for every field an operator rewrote.
 *
 * A green on `serves` is a claim that *the model's* value matched the source. It
 * says nothing about the number a human typed over it, and leaving it in place
 * would have our verification vouching for their edit. Same rule the creator
 * portal applies live via `clearScalarState`; here it has to survive a round
 * trip through the database.
 */
export function stripEditedConfidence(
  before: CreatorMealDraft,
  after: CreatorMealDraft,
  confidence: ImportConfidence | null,
): ImportConfidence | null {
  if (!confidence) return null;

  const cleared = { ...confidence };
  const scalars = ['name', 'recipe', 'story', 'photoUrl', 'difficulty', 'serves'] as const;
  for (const field of scalars) {
    if (before[field] !== after[field]) cleared[field] = { ...UNRECORDED, reason: EDITED_REASON };
  }
  if (JSON.stringify(before.tags ?? []) !== JSON.stringify(after.tags ?? [])) {
    cleared.tags = { ...UNRECORDED, reason: EDITED_REASON };
  }

  cleared.ingredients = (after.ingredients ?? []).map((row, i) => {
    const was = (before.ingredients ?? [])[i];
    const same = was && JSON.stringify(was) === JSON.stringify(row);
    return same ? (confidence.ingredients ?? [])[i] ?? UNRECORDED : { ...UNRECORDED, reason: EDITED_REASON };
  });

  return cleared;
}

/**
 * Saves an operator's edits without deciding anything.
 *
 * The draft stays in the queue. Editing is a fix, not an approval — someone
 * correcting a measure should still get to look at the card afterwards and then
 * choose, rather than having the correction publish for them.
 */
export async function editDraft(
  deps: DraftDeps,
  id: string,
  next: CreatorMealDraft,
  adminUserId: string,
): Promise<DraftDecision> {
  const now = deps.now ?? Date.now;
  const queue = deps.role ?? 'admin';
  const loaded = await loadDraft(deps.supabase, id);
  if (!loaded) return { ok: false, error: 'That draft no longer exists.' };
  if (loaded.draft.status !== 'pending_review') {
    return { ok: false, error: `That draft was already ${loaded.draft.status.replace('_', ' ')}.` };
  }
  // The quietest of the three, and the reason it is refused rather than merged:
  // an edit from the other queue rewrites the recipe under whoever is reading
  // the card right now, and neither of them is told the other exists.
  if (loaded.draft.reviewBy !== queue) return { ok: false, error: movedQueues(loaded.draft, queue) };

  const confidence = stripEditedConfidence(loaded.draft.draft, next, loaded.draft.confidence);
  const nowIso = new Date(now()).toISOString();

  // Also conditional: an edit landing on a draft somebody else has just approved
  // would rewrite the recipe out from under a meal already on Discover, and the
  // operator would be told their correction was saved.
  const saved = await decideDraft(deps, id, queue, {
    draft: next,
    confidence,
    edited_at: nowIso,
    updated_at: nowIso,
  });
  if (!saved) return { ok: false, error: 'That draft was decided or taken back in another tab before this could be saved.' };

  log({ event: events(deps.role).edit, status: 'success', userId: adminUserId, detail: `draft=${id}` });

  return { ok: true, draft: { ...loaded.draft, draft: next, confidence, editedAt: nowIso } };
}
