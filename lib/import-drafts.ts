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
  SCALAR_FIELDS,
  summarise,
  type FormFieldStates,
  type ImportedFormValues,
  type ImportField,
  type ImportSummary,
} from '@/lib/import/draft-form';
import { canonicalizeIngredient } from '@/lib/import/ingredients';
import { canonicalizeDifficulty, canonicalizeTags, SERVES_PATTERN } from '@/lib/import/vocab';
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
  // `empty` and `previous` exist for the live creator flow, where a box may
  // already hold the creator's typing or an earlier import's value. The queue
  // renders a stored draft into fresh boxes every time, so nothing is mid-edit
  // and there are no earlier states on screen to preserve — both are their
  // identity values.
  const states = fieldStatesFor({
    confidence: confidenceOf(draft),
    values,
    written,
    empty: Object.fromEntries(SCALAR_FIELDS.map((f) => [f, true])) as Record<(typeof SCALAR_FIELDS)[number], boolean>,
    previous: null,
  });
  return { values, states, summary: summarise(states) };
}

/** One queue row: the draft plus how much of it needs attention. */
export interface QueuedDraft extends ImportDraft {
  summary: ImportSummary;
}

/**
 * Everything waiting on the admin, flagged items first.
 *
 * Sorted here rather than in SQL because "how many fields need a look" is
 * derived from the confidence jsonb by rules that live in `draft-form.ts`, and
 * a second copy of them in a Postgres expression is a second thing to keep
 * true. The admin queue is a handful of rows, not a feed.
 */
export async function listDraftQueue(
  supabase: SupabaseClient,
  reviewBy: DraftReviewBy,
  limit = 200,
): Promise<QueuedDraft[]> {
  const { data } = await supabase
    .from('creator_import_drafts')
    .select(DRAFT_COLUMNS)
    .eq('status', 'pending_review')
    .eq('review_by', reviewBy)
    .order('created_at', { ascending: true })
    .limit(limit);

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
 * lines each time: patch the row **only while it is still pending**, ask for the
 * rows that changed, and act only if one came back. Read the status, check it in
 * JavaScript, then write — the shape this replaces — is three round trips with
 * two gaps in it, and two tabs or one retried `fetch` fit through either.
 * Postgres re-evaluates the predicate under the row lock, so of two simultaneous
 * callers exactly one is handed a row.
 */
async function decideDraft(
  deps: DraftDeps,
  id: string,
  patch: Record<string, unknown>,
): Promise<boolean> {
  const { data } = await deps.supabase
    .from('creator_import_drafts')
    .update(patch)
    .eq('id', id)
    .eq('status', 'pending_review')
    .select('id');
  return Array.isArray(data) && data.length > 0;
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

  const loaded = await loadDraft(deps.supabase, id);
  if (!loaded) return { ok: false, error: 'That draft no longer exists.' };
  const { draft, creator } = loaded;

  if (draft.status !== 'pending_review') {
    return { ok: false, error: `That draft was already ${draft.status.replace('_', ' ')}.` };
  }

  const nowIso = new Date(now()).toISOString();
  const claimed = await decideDraft(deps, id, {
    status: draft.editedAt ? 'edited' : 'approved',
    decided_at: nowIso,
    decided_by: adminUserId,
    updated_at: nowIso,
  });
  if (!claimed) {
    // Somebody else decided it between the read above and this write. Which way
    // does not matter: it is no longer ours to publish.
    return { ok: false, error: 'That draft was already decided in another tab.' };
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
    event: 'ADMIN:DRAFT_APPROVE',
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
 * Is there a creator-facing review queue to hand a draft to?
 *
 * **No, and this is the switch that says so.** `review_by = 'creator'` is read
 * by exactly one query in this repository — `listDraftQueue`, from
 * `/api/admin/import-drafts`, which asks for `'admin'`. There is no creator
 * endpoint, no creator screen, and no admin action that used to set it back:
 * MEAL-89 is the ticket for all three and it is not built. Flipping the column
 * therefore did not hand the decision to anyone, it removed the draft from the
 * only queue anybody reads, while `creator_source_items` said `imported` so no
 * later sync would bring the post back. First click, recipe gone, and the
 * screen said "It is in their queue now, not yours."
 *
 * Turn this on in the same commit that adds the creator's queue, not before.
 */
export const CREATOR_REVIEW_QUEUE_EXISTS = false;

/** What an operator is told instead, and why. The UI shows this on the button. */
export const HANDOFF_UNAVAILABLE =
  'Send to creator is off until the creator review queue exists (MEAL-89). ' +
  'Handing a draft over today would move it out of this queue and into nothing — ' +
  'no creator can see it and no later sync re-imports it. Approve it, edit it, or decline it.';

/**
 * Moves a draft into the creator's own queue.
 *
 * The escape hatch for "this looks right, but I am not the person who cooked
 * it". Without it an unsure operator has only approve or delete, and both are
 * worse than asking — which is why this is disabled rather than deleted: the
 * code is right, the queue it hands to is missing. Status stays
 * `pending_review` — the decision would be handed over, not made.
 */
export async function sendDraftToCreator(
  deps: DraftDeps,
  id: string,
  adminUserId: string,
): Promise<DraftDecision> {
  // Checked before anything is read, let alone written. A one-way trapdoor is
  // not a thing to leave switched on and warn about.
  if (!CREATOR_REVIEW_QUEUE_EXISTS) return { ok: false, error: HANDOFF_UNAVAILABLE };

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
  const moved = await decideDraft(deps, id, {
    review_by: 'creator',
    sent_to_creator_at: nowIso,
    sent_to_creator_by: adminUserId,
    updated_at: nowIso,
  });
  if (!moved) return { ok: false, error: 'That draft was already decided in another tab.' };

  log({
    event: 'ADMIN:DRAFT_HANDOFF',
    status: 'success',
    userId: adminUserId,
    detail: `draft=${id} creator=${loaded.draft.creatorId}`,
  });

  return { ok: true, draft: { ...loaded.draft, reviewBy: 'creator' } };
}

/**
 * Everything an operator handed to a creator before the button was switched off.
 *
 * These rows are in no queue: out of the admin's by `review_by`, and into one
 * that does not exist. Listing them is what makes that recoverable rather than
 * silent — the alternative is a recipe that vanished on a click nobody can now
 * see the effect of. Keyed on `sent_to_creator_at` rather than on `review_by`
 * alone, so the poller's own drafts (`review_by` defaults to `'creator'`) are
 * not swept into an admin screen they do not belong on.
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
 * The columns a stranded row needs, and no more.
 *
 * `?scope=all` renders three strings per row — the name, the creator, the host —
 * and posts the id back to reclaim it. `review_by` and `sent_to_creator_at` are
 * here because they are what says *which* of the three lists a pending draft
 * belongs to (see `queueOf`), not because anything renders them.
 *
 * Deliberately not `DRAFT_COLUMNS`: that carries the full `draft` and
 * `confidence` jsonb for a card nothing on this path draws, at roughly 6 KB a
 * row before the review is even computed.
 */
const PENDING_COLUMNS =
  'id, source_url, draft, review_by, sent_to_creator_at, created_at, creators!creator_id ( display_name )';

/** A pending draft as the escape hatch reads it: enough to name it and to place it. */
export interface PendingDraft {
  id: string;
  /** The draft's meal name, which may be empty — the row still has a source URL. */
  name: string;
  sourceUrl: string;
  creatorName: string | null;
  reviewBy: DraftReviewBy;
  sentToCreatorAt: string | null;
  createdAt: string | null;
}

/**
 * Which of the three lists a pending draft belongs to, decided by the row.
 *
 * `review_by` is CHECK-constrained to `'admin' | 'creator'`, so these three
 * cases are exhaustive and mutually exclusive, and they are exactly the WHERE
 * clauses of `listDraftQueue('admin')`, `listHandedOverDrafts` and the gap
 * between them.
 *
 * Decided from the row rather than by subtracting the other two lists' ids: both
 * of those are capped at 200, so a set difference calls the 201st row of the
 * admin's own queue "in no queue at all" and then fails to reclaim it.
 */
export function queueOf(draft: PendingDraft): 'admin' | 'handed-over' | 'none' {
  if (draft.reviewBy === 'admin') return 'admin';
  return draft.sentToCreatorAt ? 'handed-over' : 'none';
}

/** What `listAllPendingDrafts` found, and whether it found all of it. */
export interface AllPendingDrafts {
  drafts: PendingDraft[];
  /**
   * Every pending draft there is, counted by the database rather than by the
   * length of the page above. `truncated` is the difference between the two, and
   * it exists so no screen can promise a completeness the page size withholds.
   */
  total: number;
  limit: number;
  truncated: boolean;
}

/**
 * Every draft still waiting on somebody, whatever queue it nominally belongs to.
 *
 * The escape hatch. The other two queries are both narrower than "pending", on
 * purpose:
 *
 *   - `listDraftQueue(supabase, 'admin')` wants `review_by = 'admin'`.
 *   - `listHandedOverDrafts` wants `review_by = 'creator'` **and** a
 *     `sent_to_creator_at`, so the poller's own drafts stay off an admin screen
 *     they do not belong on.
 *
 * Between them sits a real gap: a poller draft (`review_by` defaults to
 * `'creator'`, `sent_to_creator_at` never set) is in neither list, and the
 * creator queue that would show it does not exist (MEAL-89). It is invisible to
 * everyone while `creator_source_items` records the post as imported, so no
 * later sync brings it back.
 *
 * Keyed on `status` alone for that reason: if a row is pending, it comes back.
 * But a page is still a page — `limit` rows of it, oldest first — so the count
 * is asked for **exactly** and returned separately. A caller that reports
 * `drafts.length` as a total is reporting the page size; `total` and `truncated`
 * are what let a screen say "the oldest 500 of 812" instead of a guarantee it
 * cannot keep.
 *
 * Since this is the query people will read looking for stranded rows: a draft
 * whose creator is gone cannot exist, and nothing is left behind by the deletion
 * either. `creator_import_drafts`, `creator_source_items`, `creator_source_state`
 * and `creator_platform_accounts` all cascade from `creators`, so a deleted
 * creator takes the drafts *and* the record of which posts were already
 * imported. Re-adding them starts genuinely clean rather than half-imported.
 *
 * What a deletion cannot do quietly is take published meals with it:
 * `preset_meals.creator_id` and `meals.creator_id` are NO ACTION, so Postgres
 * refuses the delete outright while any published meal still points at them.
 */
export async function listAllPendingDrafts(
  supabase: SupabaseClient,
  limit = 500,
): Promise<AllPendingDrafts> {
  const { data, count } = await supabase
    .from('creator_import_drafts')
    // `count: 'exact'` is a second aggregate over the same WHERE clause, not a
    // second round trip, and it is what makes the total independent of `limit`.
    .select(PENDING_COLUMNS, { count: 'exact' })
    .eq('status', 'pending_review')
    .order('created_at', { ascending: true })
    .limit(limit);

  const drafts = ((data ?? []) as Array<Record<string, any>>).map(toPendingDraft);
  const counted = typeof count === 'number' ? count : null;
  // With a count, truncation is arithmetic. Without one — an older PostgREST, a
  // proxy that dropped the Content-Range — a full page is the only signal there
  // is, and "there may be more" is the reading that cannot mislead.
  return {
    drafts,
    total: counted ?? drafts.length,
    limit,
    truncated: counted === null ? drafts.length >= limit : counted > drafts.length,
  };
}

function toPendingDraft(row: Record<string, any>): PendingDraft {
  const creator = row.creators as { display_name?: string } | null | undefined;
  return {
    id: row.id,
    name: (row.draft as CreatorMealDraft | null)?.name ?? '',
    sourceUrl: row.source_url,
    creatorName: creator?.display_name ?? null,
    reviewBy: row.review_by ?? 'creator',
    sentToCreatorAt: row.sent_to_creator_at ?? null,
    createdAt: row.created_at ?? null,
  };
}

/**
 * Brings a handed-over draft back into the admin queue.
 *
 * The action that did not exist, which is half of why the handoff was a
 * trapdoor: nothing could undo it. Deliberately not conditional on
 * `sent_to_creator_at` — a row in `review_by = 'creator'` that an operator can
 * see and wants back should come back.
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
  const taken = await decideDraft(deps, id, { review_by: 'admin', updated_at: nowIso });
  if (!taken) return { ok: false, error: 'That draft was already decided in another tab.' };

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
  const loaded = await loadDraft(deps.supabase, id);
  if (!loaded) return { ok: false, error: 'That draft no longer exists.' };
  if (loaded.draft.status !== 'pending_review') {
    return { ok: false, error: `That draft was already ${loaded.draft.status.replace('_', ' ')}.` };
  }

  const nowIso = new Date(now()).toISOString();
  // Conditional for the same reason approve is: a decline interleaved with an
  // approval must not leave the row `cancelled` — out of the queue, nobody
  // looking at it again — with a live meal on Discover behind it that nobody
  // will ever unpublish.
  const declined = await decideDraft(deps, id, {
    status: 'cancelled',
    decided_at: nowIso,
    decided_by: adminUserId,
    updated_at: nowIso,
  });
  if (!declined) return { ok: false, error: 'That draft was already decided in another tab.' };

  log({
    event: 'ADMIN:DRAFT_CANCEL',
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
 * The same shape and the same constraints `POST /api/creator/meals` publishes,
 * because Approve feeds this straight into `publishCreatorMeal` — a draft that
 * would be rejected at publish time is better rejected while the operator is
 * still looking at it than left in the queue to fail later.
 *
 * The vocabularies are re-applied rather than trusted: tags outside the picker
 * and units outside the editor's list are what the pipeline already normalises,
 * and a hand-edited request is exactly where an unknown one would arrive.
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
      tags: canonicalizeTags(Array.isArray(input.tags) ? input.tags.map(String) : []),
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
  const loaded = await loadDraft(deps.supabase, id);
  if (!loaded) return { ok: false, error: 'That draft no longer exists.' };
  if (loaded.draft.status !== 'pending_review') {
    return { ok: false, error: `That draft was already ${loaded.draft.status.replace('_', ' ')}.` };
  }

  const confidence = stripEditedConfidence(loaded.draft.draft, next, loaded.draft.confidence);
  const nowIso = new Date(now()).toISOString();

  // Also conditional: an edit landing on a draft somebody else has just approved
  // would rewrite the recipe out from under a meal already on Discover, and the
  // operator would be told their correction was saved.
  const saved = await decideDraft(deps, id, {
    draft: next,
    confidence,
    edited_at: nowIso,
    updated_at: nowIso,
  });
  if (!saved) return { ok: false, error: 'That draft was decided in another tab before this could be saved.' };

  log({ event: 'ADMIN:DRAFT_EDIT', status: 'success', userId: adminUserId, detail: `draft=${id}` });

  return { ok: true, draft: { ...loaded.draft, draft: next, confidence, editedAt: nowIso } };
}
