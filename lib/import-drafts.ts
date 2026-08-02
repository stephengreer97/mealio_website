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
  const states = fieldStatesFor(confidenceOf(draft), values, written);
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
 * Publishes one draft.
 *
 * This is what `processSyncItem` used to do inline; the code is the same call,
 * just no longer reachable without someone pressing a button. `edited` rather
 * than `approved` when an operator changed a field, so months later the row
 * still answers "did a human rewrite what the model produced?".
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
    // Two tabs, or a double-click. Publishing twice would put the same recipe on
    // Discover twice under a creator's name, which is exactly the failure this
    // queue exists to prevent.
    return { ok: false, error: `That draft was already ${draft.status.replace('_', ' ')}.` };
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
    return { ok: false, error: `Publishing failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  const nowIso = new Date(now()).toISOString();
  await deps.supabase
    .from('creator_import_drafts')
    .update({
      status: draft.editedAt ? 'edited' : 'approved',
      decided_at: nowIso,
      decided_by: adminUserId,
      published_meal_id: meal.id,
      updated_at: nowIso,
    })
    .eq('id', id);

  // The durable record already says `imported` — it was written when the draft
  // was created — but it now points at a live meal, and the operator reading
  // `creator_source_items` next month should see which one.
  if (draft.itemId && draft.source) {
    await deps.supabase
      .from('creator_source_items')
      .update({ draft_id: draft.id, updated_at: nowIso })
      .eq('creator_id', draft.creatorId)
      .eq('source', draft.source)
      .eq('item_id', draft.itemId);
  }

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
 * Moves a draft into the creator's own queue.
 *
 * The escape hatch for "this looks right, but I am not the person who cooked
 * it". Without it an unsure operator has only approve or delete, and both are
 * worse than asking. Status stays `pending_review` — the decision has been
 * handed over, not made.
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
  await deps.supabase
    .from('creator_import_drafts')
    .update({ review_by: 'creator', sent_to_creator_at: nowIso, sent_to_creator_by: adminUserId, updated_at: nowIso })
    .eq('id', id);

  log({
    event: 'ADMIN:DRAFT_HANDOFF',
    status: 'success',
    userId: adminUserId,
    detail: `draft=${id} creator=${loaded.draft.creatorId}`,
  });

  return { ok: true, draft: { ...loaded.draft, reviewBy: 'creator' } };
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
  await deps.supabase
    .from('creator_import_drafts')
    .update({ status: 'cancelled', decided_at: nowIso, decided_by: adminUserId, updated_at: nowIso })
    .eq('id', id);

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

  await deps.supabase
    .from('creator_import_drafts')
    .update({ draft: next, confidence, edited_at: nowIso, updated_at: nowIso })
    .eq('id', id);

  log({ event: 'ADMIN:DRAFT_EDIT', status: 'success', userId: adminUserId, detail: `draft=${id}` });

  return { ok: true, draft: { ...loaded.draft, draft: next, confidence, editedAt: nowIso } };
}
