/**
 * Turning an `ImportResult` into publish-form state (MEAL-73).
 *
 * Everything in this file is pure and framework-free so the rules that decide
 * what a creator sees — which colour a field gets, what a rejection says, what
 * lands in the Serves box — are testable without a browser or an API key.
 *
 * The one rule worth stating up front: **a confidence level is never minted
 * here.** MEAL-72 computes levels server-side from verified provenance, and
 * this module only presents what it is given. If a field is not covered by the
 * response it gets no marker at all rather than an invented one.
 */

import type {
  Confidence,
  DraftIngredient,
  FieldConfidence,
  ImportConfidence,
  ImportRejection,
  ImportSuccess,
} from './types';

// ── Colour ───────────────────────────────────────────────────────────────────

/**
 * The marker palette.
 *
 * Green and red are DESIGN.md's existing semantic tokens (`success` #16A34A,
 * `error` #DC2626). Amber had no token, so one is defined here: **Caution Amber
 * #B45309**.
 *
 * Two constraints picked that value. The Two Reds Rule forbids brand red
 * #DD0031 for a bad-confidence marker — brand red means *act*, and a marker is
 * status, not an action. And the amber has to survive as 12px text on Card
 * White, which rules out the usual mid-amber (#D97706 lands at 3.1:1 against
 * white); #B45309 clears 4.5:1.
 *
 * Colour is never the only channel — every marker also carries a word, because
 * amber and red are the pair a red-green colourblind creator is least able to
 * separate, and this indicator is worthless if it can only be read by hue.
 */
export const MARKER_COLORS: Record<Confidence, { ink: string; fill: string; dot: string }> = {
  green: { ink: '#15803D', fill: '#F0FDF4', dot: '#16A34A' },
  amber: { ink: '#B45309', fill: '#FDF6EC', dot: '#B45309' },
  red: { ink: '#B91C1C', fill: '#FEF2F2', dot: '#DC2626' },
};

/**
 * The word on the marker.
 *
 * Red splits two ways, because "we found nothing" and "we found something we
 * could not verify" ask the creator for different things. Both are red; only
 * the label differs.
 */
export function markerLabel(field: FieldConfidence): string {
  if (field.level === 'green') return 'From the source';
  if (field.level === 'amber') return 'Adjusted';
  return field.derivation === 'absent' ? 'Not found' : 'Unverified';
}

/** Sentence shown when a red field has no span to quote. */
export const NO_EVIDENCE_COPY =
  'Nothing on the page backed this up. Worth typing in yourself.';

// ── Serves ───────────────────────────────────────────────────────────────────

/**
 * Coerces an imported yield into what the Serves box accepts.
 *
 * `draft.serves` is a free-text yield — schema.org `recipeYield` is routinely
 * "2 1/2 cups guacamole" or "4 large bowls" — but the publish form has always
 * validated Serves as `^\d+(-\d+)?$`. Pasting the phrase in verbatim would put
 * a creator one click from a validation error they did not cause, on a field
 * they did not fill, which is precisely the "never worse off" line the ticket
 * draws.
 *
 * So we take the number, and the marker's evidence panel still shows the
 * original phrase — nothing is hidden, it is just not in the box.
 *
 * Returns null when there is no number to take, which leaves the field empty
 * and its marker showing.
 */
export function servesForForm(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const text = String(raw).trim();
  if (!text) return null;

  const range = /(\d+)\s*(?:-|–|—|to)\s*(\d+)/.exec(text);
  if (range) return `${Number(range[1])}-${Number(range[2])}`;

  const single = /\d+/.exec(text);
  return single ? String(Number(single[0])) : null;
}

/** Set when the Serves box shows something shorter than the source phrase. */
export const SERVES_TRIMMED_NOTE =
  'Shortened to fit the Serves box, which takes a number or a range.';

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

/** Everything a successful import writes into the publish form. */
export interface ImportedFormValues {
  name: string;
  source: string;
  story: string;
  recipe: string;
  serves: string;
  /** True when `serves` is a shortened form of `draft.serves`. */
  servesTrimmed: boolean;
  difficulty: number | null;
  /** Capped at the three the form accepts. */
  tags: string[];
  photoUrl: string | null;
  ingredients: DraftFormIngredient[];
}

export function importedFormValues(result: ImportSuccess): ImportedFormValues {
  const draft = result.draft;
  const serves = servesForForm(draft.serves);
  return {
    name: draft.name ?? '',
    source: draft.source || result.url,
    story: draft.story ?? '',
    recipe: draft.recipe ?? '',
    serves: serves ?? '',
    servesTrimmed: Boolean(serves && draft.serves && serves !== draft.serves.trim()),
    difficulty: draft.difficulty ?? null,
    // The pipeline may return up to eight; the form has always taken three.
    tags: (draft.tags ?? []).slice(0, 3),
    photoUrl: draft.photoUrl ?? null,
    ingredients: (draft.ingredients ?? []).map(draftIngredientToForm),
  };
}

// ── Markers ──────────────────────────────────────────────────────────────────

/**
 * The confidence map as the form holds it.
 *
 * Nullable per field because a marker is dropped the moment the creator edits
 * that field: once they have typed over it, the value is theirs and a level
 * computed from our extraction no longer describes what is on screen. A stale
 * green is worse than no marker.
 */
export interface FormMarkers {
  name: FieldConfidence | null;
  recipe: FieldConfidence | null;
  story: FieldConfidence | null;
  photoUrl: FieldConfidence | null;
  difficulty: FieldConfidence | null;
  tags: FieldConfidence | null;
  serves: FieldConfidence | null;
  /** Index-aligned with the form's ingredient rows. */
  ingredients: (FieldConfidence | null)[];
}

export type ScalarMarkerField = Exclude<keyof FormMarkers, 'ingredients'>;

export function markersFrom(confidence: ImportConfidence): FormMarkers {
  return {
    name: confidence.name ?? null,
    recipe: confidence.recipe ?? null,
    story: confidence.story ?? null,
    photoUrl: confidence.photoUrl ?? null,
    difficulty: confidence.difficulty ?? null,
    tags: confidence.tags ?? null,
    serves: confidence.serves ?? null,
    ingredients: [...(confidence.ingredients ?? [])],
  };
}

export function clearScalarMarker(markers: FormMarkers | null, field: ScalarMarkerField): FormMarkers | null {
  if (!markers || !markers[field]) return markers;
  return { ...markers, [field]: null };
}

export function clearIngredientMarker(markers: FormMarkers | null, index: number): FormMarkers | null {
  if (!markers || !markers.ingredients[index]) return markers;
  const ingredients = [...markers.ingredients];
  ingredients[index] = null;
  return { ...markers, ingredients };
}

/** Keeps markers index-aligned when a row is removed. */
export function removeIngredientMarker(markers: FormMarkers | null, index: number): FormMarkers | null {
  if (!markers) return markers;
  return { ...markers, ingredients: markers.ingredients.filter((_, i) => i !== index) };
}

/** Keeps markers index-aligned when a blank row is added. A new row has no provenance. */
export function appendIngredientMarker(markers: FormMarkers | null): FormMarkers | null {
  if (!markers) return markers;
  return { ...markers, ingredients: [...markers.ingredients, null] };
}

// ── Summary ──────────────────────────────────────────────────────────────────

export interface MarkerSummary {
  green: number;
  amber: number;
  red: number;
  total: number;
}

export function summarise(markers: FormMarkers | null): MarkerSummary {
  const empty = { green: 0, amber: 0, red: 0, total: 0 };
  if (!markers) return empty;
  const all = [
    markers.name, markers.recipe, markers.story, markers.photoUrl,
    markers.difficulty, markers.tags, markers.serves, ...markers.ingredients,
  ].filter((f): f is FieldConfidence => Boolean(f));

  return all.reduce((acc, field) => {
    acc[field.level] += 1;
    acc.total += 1;
    return acc;
  }, { ...empty });
}

/**
 * The one-line read on an import.
 *
 * Counts, not a score. "11 fields from the source, 2 adjusted, 1 to check" is
 * something a creator can act on; "92% confident" is not.
 */
export function summaryLine(summary: MarkerSummary): string {
  const parts: string[] = [];
  if (summary.green) parts.push(`${summary.green} from the source`);
  if (summary.amber) parts.push(`${summary.amber} adjusted`);
  if (summary.red) parts.push(`${summary.red} to check`);
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
