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

import { canonicalizeTags, MAX_MEAL_TAGS, SERVES_ERROR, SERVES_PATTERN, tagCapError } from './vocab';
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
  /**
   * Preparation, carried into the form so publishing keeps it (MEAL-102).
   *
   * The publish form binds an input to it as of MEAL-165. Carrying it here is
   * what makes that possible: the import fills the publish form and the publish
   * form is what gets POSTed, so a prep the extraction captured would otherwise
   * be thrown away on its way to the meal.
   */
  prep?: string | null;
}

/**
 * `DraftIngredient` → one form row.
 *
 * The pipeline already forces units into the picker's vocabulary, and the
 * picker's countable option is now spelled the same as the stored token, so
 * there is no translation left to do.
 */
export function draftIngredientToForm(ing: DraftIngredient): DraftFormIngredient {
  const countable = !ing.unit || ing.unit === 'qty';
  const count = ing.qty ?? 1;
  return {
    ingredientName: ing.ingredientName,
    // A count of one is left blank rather than typed as "1". Every line the
    // source gave no amount for — "many grinds of black pepper", "salt to
    // taste" — arrives here as a countable 1, and printing that reads as a
    // quantity we found rather than one we defaulted to. Blank is also what a
    // creator would have typed, and `fromFormIng` parses it straight back to 1.
    measure: countable ? (count > 1 ? String(count) : '') : (ing.measure ?? ''),
    unit: countable ? 'qty' : ing.unit,
    searchTerm: ing.searchTerm ?? null,
    qty: ing.qty ?? 1,
    // Omitted rather than nulled, so a row with no preparation produces the
    // same form row it produced before the field existed.
    ...(ing.prep ? { prep: ing.prep } : {}),
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

// ── What would stop this publishing ──────────────────────────────────────────

/** One reason a draft cannot be published, and the field it is about. */
export interface PublishBlocker {
  field: ImportField;
  /** The server's own sentence, so the preview and the refusal say the same thing. */
  message: string;
}

/**
 * Everything that would make `publishCreatorMeal` refuse this draft.
 *
 * The rules were only discoverable by pressing Approve and losing: a draft
 * written before the tag cap shipped carries eight tags, `publishCreatorMeal`
 * throws, and `approveDraft` correctly rolls the row back to `pending_review` —
 * so the creator's only signal was a failure on the one button that is supposed
 * to be the end of the job. Every one of these is knowable while they are still
 * looking at the recipe.
 *
 * **The rules are imported, never restated.** `tagCapError`, `canonicalizeTags`,
 * `SERVES_PATTERN` and `SERVES_ERROR` are the same four `publishCreatorMeal`
 * enforces, applied in the same order and against the same canonicalised list —
 * a second copy of the cap is a second place for it to be `3` in one file and
 * `4` in another, and a preview that lies about publishability is worse than no
 * preview because it is trusted. `tests/lib/publish-blockers.test.ts` runs a
 * blocked draft through the real publish path and asserts the sentences match.
 *
 * The two `editableDraft` refuses that `publishCreatorMeal` does not reach —
 * an empty name, no ingredients — are here too. They are the same wording, and
 * a nameless meal on Discover is not a thing to let through on the technicality
 * that the insert would have accepted it.
 *
 * Order is the card's order, so a list of blockers reads down the preview.
 */
export function publishBlockers(draft: {
  name?: string | null;
  serves?: string | null;
  tags?: string[] | null;
  ingredients?: unknown[] | null;
}): PublishBlocker[] {
  const blockers: PublishBlocker[] = [];

  if (!draft.name?.trim()) blockers.push({ field: 'name', message: 'A meal name is required.' });

  const tags = Array.isArray(draft.tags) ? canonicalizeTags(draft.tags.map(String)) : [];
  const tooManyTags = tagCapError(tags);
  if (tooManyTags) blockers.push({ field: 'tags', message: tooManyTags });

  const serves = draft.serves?.trim();
  if (serves && !SERVES_PATTERN.test(serves)) blockers.push({ field: 'serves', message: SERVES_ERROR });

  if (!Array.isArray(draft.ingredients) || draft.ingredients.length === 0) {
    blockers.push({ field: 'ingredients', message: 'At least one ingredient is required.' });
  }

  return blockers;
}

/** Shown on the Tags marker when the import found more than the form accepts. */
export function tagsTrimmedNote(found: number, kept: number): string | null {
  if (found <= kept) return null;
  return `We found ${found} tags and kept the first ${kept}. The form takes ${kept}.`;
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

/**
 * Narrowed to the two members this needs, so a stored draft can be presented by
 * the same rules as a live import. The admin review queue (MEAL-91) reads a
 * `creator_import_drafts` row, which carries the draft and the URL it came from
 * but none of the rest of an `ImportSuccess`.
 */
export type FormFillSource = Pick<ImportSuccess, 'draft' | 'url'>;

export function importedFormValues(result: FormFillSource): ImportedFormValues {
  const draft = result.draft;
  const allTags = draft.tags ?? [];
  const tags = allTags.slice(0, MAX_MEAL_TAGS);
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
 * Stand-in confidence for a row `confidence.ingredients` has no entry for.
 *
 * The two lists are index-aligned when they leave the pipeline, but results are
 * persisted in the idempotency cache, so an entry written by an older build can
 * come back shorter than the rows it describes. Silence is a claim here — it
 * says "we checked this and it held up" — so a row we cannot account for is
 * flagged rather than quietly left clean.
 */
const UNMATCHED_INGREDIENT: FieldConfidence = {
  level: 'red',
  derivation: 'absent',
  match: 'none',
  score: 0,
  evidence: null,
  reason: 'We could not match this row back to anything we read.',
};

export interface FieldStatesInput {
  confidence: ImportConfidence;
  values: ImportedFormValues;
  /** Which fields this import actually wrote into the form. */
  written: Partial<Record<ImportField, boolean>>;
  /** True for a scalar field whose box was empty just before this import landed. */
  empty: Record<ScalarField, boolean>;
  /** States from an earlier import, for the boxes this one left alone. */
  previous: FormFieldStates | null;
}

/**
 * Builds the field states from an import.
 *
 * Every state here is a claim about **the value that is on screen**, which is
 * the rule the three branches below fall out of:
 *
 *  - We wrote the box, so our assessment of what we wrote describes it.
 *  - The source had nothing *and* the box is empty, so "add this" is true.
 *  - Otherwise the box holds something we did not just put there — the
 *    creator's typing, or a previous import's value we had no replacement for —
 *    and whatever was true of it before is still true of it now. Replacing that
 *    with this import's state is how a second import came to hang "Not found in
 *    the source" on a box still showing the first import's value, and how it
 *    came to strip the callouts off ingredient rows it never touched.
 *
 * `written` is not the same as `provided`: a field the import had a value for
 * can still be skipped because the creator typed in that box while the request
 * was in flight, and their work wins.
 */
export function fieldStatesFor(input: FieldStatesInput): FormFieldStates {
  const { confidence, values, written, empty, previous } = input;

  const state = (field: ScalarField): FieldState | null => {
    if (written[field]) return { confidence: confidence[field], written: true };
    if (!values.provided[field] && empty[field]) {
      return { confidence: confidence[field], written: false };
    }
    return previous?.[field] ?? null;
  };

  return {
    name: state('name'),
    recipe: state('recipe'),
    story: state('story'),
    photoUrl: state('photoUrl'),
    difficulty: state('difficulty'),
    tags: state('tags'),
    serves: state('serves'),
    // Zipped to the rows we put on screen, not simply copied: a confidence list
    // shorter than the draft would otherwise leave its tail of rows unflagged,
    // and one longer would count levels against rows that do not exist.
    ingredients: written.ingredients
      ? values.ingredients.map((_, i) => ({
          confidence: confidence.ingredients?.[i] ?? UNMATCHED_INGREDIENT,
          written: true,
        }))
      : (previous?.ingredients ?? []),
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

/** Matched outer quote pairs, straight and curly. */
const QUOTE_PAIRS: [string, string][] = [
  ['"', '"'],
  ['“', '”'],
  ['‘', '’'],
  ["'", "'"],
];

function unwrapQuotes(text: string): string {
  for (const [open, close] of QUOTE_PAIRS) {
    if (text.length > open.length + close.length && text.startsWith(open) && text.endsWith(close)) {
      return text.slice(open.length, -close.length).trim();
    }
  }
  return text;
}

export function truncateEvidence(span: string, max = EVIDENCE_MAX_CHARS): string {
  // The UI wraps every span in its own quotation marks, so a span that already
  // carries them renders as ""…"". Recipe lines quite reasonably contain quotes
  // — a heading, an aside, a model copying a quoted line character for
  // character as it was told to. Strip only a matched outer pair, and only
  // once: a span that genuinely opens with a quote and closes without one is
  // left alone rather than silently rebalanced.
  const text = unwrapQuotes(span.replace(/\s+/g, ' ').trim());
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

  const { level, evidence, derivation, reason } = state.confidence;
  const quote = evidence ? truncateEvidence(evidence) : null;

  if (!state.written) {
    // An empty box does not mean an empty page. `extract.ts` deliberately keeps
    // the span for a value it rejected "so the reason can explain what we saw",
    // and dropping it here told the creator we found nothing in exactly the
    // case the guacamole fixture was built around: Serves is empty because the
    // page's only yield is "2 1/2 cups guacamole", which is a volume rather
    // than a head count. The span is the part they can act on.
    return quote
      ? { kind: 'absent', text: 'We found this but couldn’t use it. Add this.', evidence: quote }
      : { kind: 'absent', text: 'Not found in the source. Add this', evidence: null };
  }

  // Checked before the green shortcut below. A generated value is one we chose
  // rather than one we read, and that is worth saying whatever level it carries
  // — the pipeline pins generated to amber or red today, and if that ever
  // changes this must not start silently vouching for a stand-in.
  //
  // There is no span to quote and nothing a quote could honestly say. The
  // pipeline's own `reason` is written to be shown, and this is the one field
  // where our value is a placeholder; a creator publishing a stock photo they
  // never looked at is worse than an empty photo slot.
  if (derivation === 'generated') {
    return { kind: 'generated', text: reason, evidence: null };
  }

  if (level === 'green') return null;

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
      ? 'We couldn’t find this in the source. Check it.'
      : 'Nothing in the source backed this up. Check it.',
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
  /**
   * Every field this import touched. Each one is in exactly one of the two
   * counts below, so they add up — an earlier version also reported how many
   * fields were *populated*, which is a second axis and made the arithmetic
   * look broken. How many to check is what a creator needs; how many we filled
   * is our bookkeeping.
   */
  total: number;
  /** Verified against the source. Green only. */
  verified: number;
  /** Flagged: adjusted, unverified, or nothing found. */
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
  const empty = { total: 0, verified: 0, needALook: 0 };
  if (!states) return empty;

  const all = [...SCALAR_FIELDS.map(f => states[f]), ...states.ingredients]
    .filter((s): s is FieldState => Boolean(s));

  return all.reduce((acc, state) => {
    acc.total += 1;
    // Verified and flagged are exhaustive and mutually exclusive: `noticeFor`
    // returns null for exactly the written-and-green fields.
    if (noticeFor(state)) acc.needALook += 1;
    else acc.verified += 1;
    return acc;
  }, { ...empty });
}

/**
 * "4 of 15 fields verified. 11 need a look."
 *
 * Counts, never a score — a "92% confident" badge is the anti-pattern MEAL-72
 * exists to avoid.
 */
export function summaryLine(summary: ImportSummary): string {
  const verified = `${summary.verified} of ${summary.total} field${summary.total === 1 ? '' : 's'} verified.`;
  if (summary.needALook === 0) return verified;
  return `${verified} ${summary.needALook} need${summary.needALook === 1 ? 's' : ''} a look.`;
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
  return 'Read from the page text. No structured recipe data was published.';
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

/**
 * Marks a rejection this UI synthesised from a failed request rather than one
 * the pipeline returned. `rejectionCopy` keys off it, because `stage` cannot
 * tell the two apart — that field is typed to the pipeline's four stages, and
 * none of them happened.
 */
export const TRANSPORT_REASON = 'request-failed';

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
  // A transport failure never reached the pipeline, so none of the stage
  // headings describe it. `transportRejection` has to pick some stage to
  // satisfy the shared shape, and the one it picks used to put "We couldn't
  // open that link" above a 403 from our *own* endpoint — sending the creator
  // off to check a URL that is perfectly fine.
  if (rejection.reason === TRANSPORT_REASON) {
    return {
      heading: 'We couldn’t complete that import',
      detail: rejection.detail,
      next: 'Nothing has been changed. Try again in a moment, or fill the form in below. Your link is already in the Recipe URL box.',
    };
  }

  return {
    heading: STAGE_HEADINGS[rejection.stage] ?? 'That import didn’t work',
    detail: rejection.detail,
    next:
      rejection.stage === 'gate'
        ? 'If it is a recipe, fill the form in below. Your link is already in the Recipe URL box.'
        : 'Fill the form in below instead. Nothing has been changed, and your link is already in the Recipe URL box.',
  };
}

/** Shown when the endpoint itself fails — not a pipeline rejection, but the creator still needs a next step. */
export function transportRejection(url: string, detail: string): ImportRejection {
  return {
    status: 'rejected',
    url,
    stage: 'fetch',
    reason: TRANSPORT_REASON,
    detail,
    meta: { cached: false },
  };
}
