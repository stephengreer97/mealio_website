/**
 * Turning an `ImportResult` into publish-form state (MEAL-73).
 *
 * Everything in this file is pure and framework-free so the rules that decide
 * what a creator sees — which fields get flagged, what the flag says, what a
 * rejection says — are testable without a browser or an API key.
 *
 * The one rule worth stating up front: **a confidence level is never minted
 * here.** MEAL-72 computes levels server-side from verified provenance, and
 * this module only presents what it is given.
 *
 * ## Mark the exceptions, not everything
 *
 * An earlier revision put a coloured marker on all nine fields. Nine markers is
 * nine things to scan, and colour ends up doing the work of saying which of
 * them matters — which is exactly the job the evidence should be doing. So:
 *
 *   verified   nothing at all. Silence means we checked it and it held up.
 *   adjusted   a dotted underline, and the source span quoted plainly beneath.
 *   absent     a dotted underline, an empty field, and "add this".
 *
 * The creator reads the evidence directly instead of decoding a symbol, and the
 * form recedes to the fields that need them — DESIGN.md's Quiet Countertop.
 *
 * There is deliberately **no colour token here at all**. The dotted underline
 * and the sentence carry the meaning; colour would be reinforcement at best and
 * a second thing to learn at worst. That also means this file adds nothing to
 * DESIGN.md's palette.
 *
 * Known, pre-existing, and not introduced by this work: the publish button is
 * Tailwind `bg-red-600` = `#DC2626`, byte-identical to DESIGN.md's `error`
 * token. So on screen the "act" red and the "something is wrong" red are the
 * same colour — a live violation of the Two Reds Rule that predates the import
 * flow. Recorded on MEAL-73 rather than fixed here.
 */

import type {
  DraftIngredient,
  FieldConfidence,
  ImportConfidence,
  ImportRejection,
  ImportSuccess,
} from './types';

// ── Serves ───────────────────────────────────────────────────────────────────
//
// There is deliberately no client-side coercion of `draft.serves` here.
//
// An earlier revision took the first number out of a free-text yield so it
// would satisfy the form's `^\d+(-\d+)?$` validation. The product owner ruled
// that out, and correctly: `recipeYield` is often a *volume* — "2 1/2 cups
// guacamole" — and reading that as `serves: 2` is not a formatting fix, it is
// wrong data presented as a fact, with a confidence marker vouching for it.
//
// The pipeline now owns this: it emits an integer or an integer range that
// already matches the form's validation, or nothing at all when the source
// states no people count. Serves is treated here like any other field.

// ── Ingredients ──────────────────────────────────────────────────────────────

/** The publish form's per-row shape. Mirrors `IngredientForm` in the creator portal. */
export interface DraftFormIngredient {
  ingredientName: string;
  measure: string;
  unit: string;
  searchTerm: string | null;
  qty: number;
}

/**
 * `DraftIngredient` → one form row.
 *
 * The pipeline already forces units into the picker's vocabulary, so the only
 * translation left is the picker's 'Qty' label for the internal 'qty' token.
 */
export function draftIngredientToForm(ing: DraftIngredient): DraftFormIngredient {
  const countable = !ing.unit || ing.unit === 'qty';
  return {
    ingredientName: ing.ingredientName,
    measure: countable ? String(ing.qty ?? 1) : (ing.measure ?? ''),
    unit: countable ? 'Qty' : ing.unit,
    searchTerm: ing.searchTerm ?? null,
    qty: ing.qty ?? 1,
  };
}

// ── Whole-form fill ──────────────────────────────────────────────────────────

/** The fields an import can write to, as the form thinks of them. */
export type ImportField =
  | 'name' | 'recipe' | 'story' | 'photoUrl' | 'difficulty' | 'tags' | 'serves' | 'ingredients';

export const FIELD_LABELS: Record<ImportField, string> = {
  name: 'Meal name',
  recipe: 'Recipe instructions',
  story: 'Story',
  photoUrl: 'Photo',
  difficulty: 'Difficulty',
  tags: 'Tags',
  serves: 'Serves',
  ingredients: 'Measurements',
};

/** Shown on the Tags marker when the import found more than the form accepts. */
export function tagsTrimmedNote(found: number, kept: number): string | null {
  if (found <= kept) return null;
  return `We found ${found} tags and kept the first ${kept} — the form takes ${kept}.`;
}

/** Everything a successful import can write into the publish form. */
export interface ImportedFormValues {
  name: string;
  source: string;
  story: string;
  recipe: string;
  serves: string;
  difficulty: number | null;
  /** Capped at the three the form accepts. */
  tags: string[];
  /** Set when the import found more tags than the form can hold. */
  tagsNote: string | null;
  photoUrl: string | null;
  ingredients: DraftFormIngredient[];
  /**
   * Which fields the import actually has a value for.
   *
   * The form writes only these, and marks only these. A field the import came
   * back empty on is left exactly as the creator left it — importing must not
   * blank out work someone already did — and carries no marker, because a
   * confidence level is a claim about a value we put on screen. A green badge
   * beside an empty box is a claim about nothing.
   */
  provided: Record<ImportField, boolean>;
}

export function importedFormValues(result: ImportSuccess): ImportedFormValues {
  const draft = result.draft;
  const allTags = draft.tags ?? [];
  const tags = allTags.slice(0, 3);
  const ingredients = (draft.ingredients ?? []).map(draftIngredientToForm);

  return {
    name: draft.name ?? '',
    source: draft.source || result.url,
    story: draft.story ?? '',
    recipe: draft.recipe ?? '',
    serves: draft.serves ?? '',
    difficulty: draft.difficulty ?? null,
    tags,
    tagsNote: tagsTrimmedNote(allTags.length, tags.length),
    photoUrl: draft.photoUrl ?? null,
    ingredients,
    provided: {
      name: Boolean(draft.name?.trim()),
      recipe: Boolean(draft.recipe?.trim()),
      story: Boolean(draft.story?.trim()),
      photoUrl: Boolean(draft.photoUrl?.trim()),
      difficulty: draft.difficulty != null,
      tags: tags.length > 0,
      serves: Boolean(draft.serves?.trim()),
      ingredients: ingredients.length > 0,
    },
  };
}

// ── Field state ──────────────────────────────────────────────────────────────

/**
 * What became of one field in an import.
 *
 *  - `written`  we put a value in the box; `confidence` describes that value.
 *  - `absent`   the source had nothing, so the box is empty and stays the
 *               creator's to fill.
 *  - `kept`     the creator was editing this box while the import ran, so their
 *               wording won and we say nothing about it. Represented by the
 *               absence of a state, not by a value here.
 */
export interface FieldState {
  confidence: FieldConfidence;
  written: boolean;
}

/**
 * Per-field state as the form holds it.
 *
 * Nullable because a field's state is dropped the moment the creator edits it:
 * once they have typed over a value, a level computed from our extraction no
 * longer describes what is on screen, and a stale flag is worse than none.
 */
export interface FormFieldStates {
  name: FieldState | null;
  recipe: FieldState | null;
  story: FieldState | null;
  photoUrl: FieldState | null;
  difficulty: FieldState | null;
  tags: FieldState | null;
  serves: FieldState | null;
  /** Index-aligned with the form's ingredient rows. */
  ingredients: (FieldState | null)[];
}

export type ScalarField = Exclude<keyof FormFieldStates, 'ingredients'>;

export const SCALAR_FIELDS: ScalarField[] =
  ['name', 'recipe', 'story', 'photoUrl', 'difficulty', 'tags', 'serves'];

/**
 * Builds the field states from an import.
 *
 * `written` is not the same as `provided`: a field the import had a value for
 * can still be skipped because the creator typed in that box while the request
 * was in flight, and their work wins. A skipped field gets no state at all —
 * we have nothing to say about a value we did not put there.
 */
export function fieldStatesFor(
  confidence: ImportConfidence,
  values: ImportedFormValues,
  written: Partial<Record<ImportField, boolean>>,
): FormFieldStates {
  const state = (field: ScalarField): FieldState | null => {
    if (written[field]) return { confidence: confidence[field], written: true };
    // Not written and not provided means the source had nothing — worth saying.
    // Not written but provided means the creator was mid-edit — say nothing.
    if (!values.provided[field]) return { confidence: confidence[field], written: false };
    return null;
  };

  return {
    name: state('name'),
    recipe: state('recipe'),
    story: state('story'),
    photoUrl: state('photoUrl'),
    difficulty: state('difficulty'),
    tags: state('tags'),
    serves: state('serves'),
    ingredients: written.ingredients
      ? (confidence.ingredients ?? []).map(c => ({ confidence: c, written: true }))
      : [],
  };
}

export function clearScalarState(states: FormFieldStates | null, field: ScalarField): FormFieldStates | null {
  if (!states || !states[field]) return states;
  return { ...states, [field]: null };
}

export function clearIngredientState(states: FormFieldStates | null, index: number): FormFieldStates | null {
  if (!states || !states.ingredients[index]) return states;
  const ingredients = [...states.ingredients];
  ingredients[index] = null;
  return { ...states, ingredients };
}

/** Keeps states index-aligned when a row is removed. */
export function removeIngredientState(states: FormFieldStates | null, index: number): FormFieldStates | null {
  if (!states) return states;
  return { ...states, ingredients: states.ingredients.filter((_, i) => i !== index) };
}

/** Keeps states index-aligned when a blank row is added. A new row has no provenance. */
export function appendIngredientState(states: FormFieldStates | null): FormFieldStates | null {
  if (!states) return states;
  return { ...states, ingredients: [...states.ingredients, null] };
}

// ── Notices ──────────────────────────────────────────────────────────────────

/**
 * How long a quoted span may get before it is cut.
 *
 * Every flagged ingredient row grows by its quote, and a recipe with eight
 * flagged rows on a 390px phone turns into a wall. Two lines of 11px text is
 * roughly this many characters, so the cut bounds each row's height without
 * hiding the part of the span that identifies it.
 */
export const EVIDENCE_MAX_CHARS = 120;

export function truncateEvidence(span: string, max = EVIDENCE_MAX_CHARS): string {
  const text = span.replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  // Cut on a word boundary so the tail is not a fragment of a word.
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

export type NoticeKind = 'adjusted' | 'unverified' | 'absent' | 'generated';

/** The line rendered under a flagged field. Verified fields produce none. */
export interface FieldNotice {
  kind: NoticeKind;
  /** Leading sentence. Empty for `adjusted`, where the quote says it all. */
  text: string;
  /** Source span to quote, already truncated. Null when there is nothing to quote. */
  evidence: string | null;
}

/**
 * The notice for one field, or null when there is nothing to say.
 *
 * Silence is the common case and is load-bearing: it means we checked the value
 * against the source and it held up. The summary line is what tells a creator
 * that silence means checked rather than skipped.
 */
export function noticeFor(state: FieldState | null): FieldNotice | null {
  if (!state) return null;

  if (!state.written) {
    return { kind: 'absent', text: 'Not found in the source — add this', evidence: null };
  }

  const { level, evidence, derivation, reason } = state.confidence;
  if (level === 'green') return null;

  const quote = evidence ? truncateEvidence(evidence) : null;

  // A `generated` value — today only a Pixabay stand-in photo — was not read
  // off the page at all, so there is no span to quote and nothing a quote could
  // honestly say. The pipeline's own `reason` is written to be shown, and this
  // is the one field where our value is a placeholder we chose rather than
  // something we found; a creator publishing a stock photo they never looked at
  // is worse than an empty photo slot.
  if (derivation === 'generated') {
    return { kind: 'generated', text: reason, evidence: null };
  }

  if (level === 'amber') {
    // With a span, the quote is the whole message. Without one, the pipeline's
    // reason is — an empty notice would be worse than none.
    return quote
      ? { kind: 'adjusted', text: '', evidence: quote }
      : { kind: 'adjusted', text: reason, evidence: null };
  }

  // Red on a value we did write: the span did not check out against the page.
  // The value stays in the box — it is the creator's to keep, fix or delete,
  // and deleting it for them would be its own kind of wrong.
  return {
    kind: 'unverified',
    text: quote
      ? 'We couldn’t find this in the source — check it.'
      : 'Nothing in the source backed this up — check it.',
    evidence: quote,
  };
}

export function noticesFor(states: FormFieldStates | null) {
  return {
    name: noticeFor(states?.name ?? null),
    recipe: noticeFor(states?.recipe ?? null),
    story: noticeFor(states?.story ?? null),
    photoUrl: noticeFor(states?.photoUrl ?? null),
    difficulty: noticeFor(states?.difficulty ?? null),
    tags: noticeFor(states?.tags ?? null),
    serves: noticeFor(states?.serves ?? null),
    ingredients: (states?.ingredients ?? []).map(noticeFor),
  };
}

// ── Summary ──────────────────────────────────────────────────────────────────

export interface ImportSummary {
  /** Fields still holding a value this import put there. */
  filled: number;
  /** Of those, how many we verified against the source. Green only. */
  verified: number;
  /** Flagged fields: adjusted, unverified, or nothing found. */
  needALook: number;
}

/**
 * The counts above the form.
 *
 * `verified` means *we checked this value against the source and it matched* —
 * never merely *we filled it in*. A photo that came from a generated stand-in
 * rather than the creator's page is not verified and lands in `needALook` with
 * its own reason, which falls out of counting green only.
 */
export function summarise(states: FormFieldStates | null): ImportSummary {
  const empty = { filled: 0, verified: 0, needALook: 0 };
  if (!states) return empty;

  const all = [...SCALAR_FIELDS.map(f => states[f]), ...states.ingredients]
    .filter((s): s is FieldState => Boolean(s));

  return all.reduce((acc, state) => {
    if (state.written) {
      acc.filled += 1;
      if (state.confidence.level === 'green') acc.verified += 1;
    }
    if (noticeFor(state)) acc.needALook += 1;
    return acc;
  }, { ...empty });
}

/** "6 verified · 3 need a look" — counts, never a score. A "92% confident" badge would be the anti-pattern MEAL-72 exists to avoid. */
export function summaryLine(summary: ImportSummary): string {
  const parts = [`${summary.verified} verified`];
  parts.push(summary.needALook > 0 ? `${summary.needALook} need a look` : 'nothing flagged');
  return parts.join(' · ');
}

/** Bare hostname, for telling a creator which page we read. */
export function hostLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** How the recipe was read, in one short phrase. Explains why the greens are green. */
export function pathLabel(meta: ImportSuccess['meta']): string {
  if (meta.path === 'json-ld') return 'Read from the page’s structured recipe data.';
  if (meta.path === 'microdata') return 'Read from the page’s embedded recipe markup.';
  return 'Read from the page text — no structured recipe data was published.';
}

// ── Rejection ────────────────────────────────────────────────────────────────

export interface RejectionCopy {
  /** Plain-language heading for the stage that stopped us. */
  heading: string;
  /** The pipeline's own `detail`, passed through untouched — it is already creator-safe. */
  detail: string;
  /** What the creator can do next. Never a dead end. */
  next: string;
}

const STAGE_HEADINGS: Record<ImportRejection['stage'], string> = {
  fetch: 'We couldn’t open that link',
  robots: 'That site asks us not to read it automatically',
  gate: 'That page doesn’t look like a recipe',
  extract: 'We couldn’t pull a recipe out of that page',
};

/**
 * Copy for a failed import.
 *
 * `detail` is rendered verbatim: the pipeline writes it for a creator's eyes
 * already, and rewriting it here would fork the wording every time a new
 * failure reason is added upstream.
 *
 * Rejection is the common case in any environment without an API key, so this
 * path gets the same care as the success path — a heading that says which part
 * failed, the reason as written, and a next step that costs nothing.
 */
export function rejectionCopy(rejection: ImportRejection): RejectionCopy {
  return {
    heading: STAGE_HEADINGS[rejection.stage] ?? 'That import didn’t work',
    detail: rejection.detail,
    next:
      rejection.stage === 'gate'
        ? 'If it is a recipe, fill the form in below — your link is already in the Recipe URL box.'
        : 'Fill the form in below instead. Nothing has been changed, and your link is already in the Recipe URL box.',
  };
}

/** Shown when the endpoint itself fails — not a pipeline rejection, but the creator still needs a next step. */
export function transportRejection(url: string, detail: string): ImportRejection {
  return {
    status: 'rejected',
    url,
    stage: 'fetch',
    reason: 'request-failed',
    detail,
    meta: { cached: false },
  };
}
