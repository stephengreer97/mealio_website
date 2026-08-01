/**
 * Field-level confidence from provenance, verified server-side (MEAL-72).
 *
 * The obvious implementation — asking the model how confident it is — is wrong
 * and is deliberately not built. Self-reported LLM confidence tracks fluency far
 * better than accuracy; a model will cheerfully report 0.95 on a hallucinated
 * serving size, and an indicator that is wrong in exactly the cases that matter
 * is worse than none, because creators learn to trust it and then get burned.
 *
 * Instead the model returns `{ value, evidence, derivation }` per field, and
 * this module checks **server-side that the evidence span is actually present in
 * the source we fetched**:
 *
 *   🟢 green  Structured data, or verbatim from the page
 *   🟡 amber  Normalised or inferred — span present but the value was restated
 *   🔴 red    No span, or the span is not in the source
 *
 * The property that makes it worth having: a hallucinated ingredient cannot
 * produce a matching span, so it goes red automatically without anyone judging
 * it. Nothing in the model's response is taken on trust — including its claim
 * about where a value came from. A field marked `json-ld` whose span is not in
 * the JSON-LD block is downgraded, not believed.
 */

import type { Confidence, Derivation, FieldConfidence, SourceDocument } from './types';

/** Below this, a near-match is not a match at all. */
export const FUZZY_THRESHOLD = 0.85;

/** Spans longer than this are compared by token containment rather than windowing. */
const LONG_SPAN_CHARS = 1200;

/** Very short spans are too easy to match by accident to be evidence of anything. */
const MIN_SPAN_CHARS = 3;

/**
 * Normalises for comparison. Without this every span fails on an HTML artefact:
 * a non-breaking space, a curly apostrophe the model re-typed straight, a line
 * break where the page had one and the model didn't.
 */
export function normalizeForMatch(input: string): string {
  return input
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”‟″]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(/[  -​  　]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function bigrams(text: string): Map<string, number> {
  const out = new Map<string, number>();
  for (let i = 0; i < text.length - 1; i++) {
    const key = text.slice(i, i + 2);
    out.set(key, (out.get(key) ?? 0) + 1);
  }
  return out;
}

/** Sørensen–Dice over character bigrams: 1 is identical, 0 shares nothing. */
export function diceSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const left = bigrams(a);
  const right = bigrams(b);
  let shared = 0;
  let leftTotal = 0;
  for (const [key, count] of left) {
    leftTotal += count;
    const other = right.get(key);
    if (other) shared += Math.min(count, other);
  }
  let rightTotal = 0;
  for (const count of right.values()) rightTotal += count;
  return (2 * shared) / (leftTotal + rightTotal);
}

export type MatchKind = 'exact' | 'fuzzy' | 'none';

export interface SpanMatch {
  kind: MatchKind;
  score: number;
}

/**
 * Looks for `span` in `corpus`, allowing for re-typed punctuation.
 *
 * Exact means the normalised span is a substring of the normalised corpus.
 * Otherwise we slide a window the width of the span across the corpus and take
 * the best Dice score — near-match is amber, not green.
 */
export function findSpan(span: string, corpus: string): SpanMatch {
  const needle = normalizeForMatch(span);
  const haystack = normalizeForMatch(corpus);
  if (!needle || needle.length < MIN_SPAN_CHARS || !haystack) return { kind: 'none', score: 0 };

  if (haystack.includes(needle)) return { kind: 'exact', score: 1 };

  // Long spans (a whole method, a story paragraph) are compared by how much of
  // their vocabulary the corpus contains — windowing them is both slow and
  // brittle against reflowed whitespace.
  if (needle.length > LONG_SPAN_CHARS) {
    const tokens = needle.split(' ').filter((t) => t.length > 3);
    if (tokens.length === 0) return { kind: 'none', score: 0 };
    const present = tokens.filter((t) => haystack.includes(t)).length;
    const score = present / tokens.length;
    return score >= FUZZY_THRESHOLD ? { kind: 'fuzzy', score } : { kind: 'none', score };
  }

  const words = haystack.split(' ');
  const spanWords = needle.split(' ').length;
  const windowWords = Math.max(1, spanWords);

  let best = 0;
  for (let i = 0; i + 1 <= words.length; i++) {
    const window = words.slice(i, i + windowWords).join(' ');
    const score = diceSimilarity(needle, window);
    if (score > best) best = score;
    if (best === 1) break;
    if (i + windowWords >= words.length) break;
  }

  return best >= FUZZY_THRESHOLD ? { kind: 'fuzzy', score: best } : { kind: 'none', score: best };
}

/**
 * The corpora a source document offers, narrowest first.
 *
 * The split exists because "is this span on the page?" turned out to be the
 * wrong question. A recipe page is mostly *not* the recipe: the recorded
 * cookieandkate fixture carries 345 reader comments, and readers collectively
 * mention every ingredient there is. While the whole page counted as the
 * source, an ingredient lifted from a comment — `roma tomatoes`, from
 * "Add two diced roma tomatoes, seeds removed, and stir", on a recipe whose
 * body says to skip the tomato — satisfied value ⊆ span ⊆ source and read
 * green. Green renders as no marker at all, so the indicator was silent
 * exactly where it was wrong.
 */
export interface VerificationSource {
  /** Serialised JSON-LD as handed to the model. Null when the page had none. */
  jsonLd: string | null;
  /** Page text with comments, related posts and disclosures stripped. */
  recipeText: string;
  /**
   * The full page. A match found only here is real but out of place, so it
   * caps at amber — narrowing arbitrary HTML will never be perfect, and the
   * imperfect case should be visibly uncertain rather than silently wrong.
   */
  pageText: string;
}

export function verificationSourceFor(document: SourceDocument): VerificationSource {
  // The image URL is part of the source we fetched (JSON-LD `image` or the
  // `og:image` meta tag), but `htmlToText` drops meta tags — so it is added back
  // explicitly rather than letting a real photoUrl fail verification.
  const image = document.imageUrl ? `\nimage: ${document.imageUrl}` : '';
  return {
    jsonLd: document.jsonLdRaw,
    recipeText: `${document.title}\n${document.recipeText}${image}`,
    pageText: `${document.title}\n${document.text}${image}`,
  };
}

// ── Value ↔ span verification ────────────────────────────────────────────────

/**
 * How the emitted **value** relates to the evidence span it was supposedly taken
 * from.
 *
 * Checking only that the span exists in the source is not enough, and assuming
 * otherwise is the mistake this type exists to prevent. A model that pairs a
 * fabricated value with a *genuine* sentence lifted off the page passes a
 * span-only check: `serves: "48"` with the evidence "Serve it with tortilla
 * chips at your next party" would read green, because that sentence really is
 * on the page. MEAL-72's stated property — a hallucinated value cannot produce
 * a matching span — only holds if the model also fabricates the span, and we
 * cannot assume that: the page text is attacker-controlled and is interpolated
 * into the extraction prompt, so "it won't think to reuse a real sentence" is
 * not a security boundary.
 *
 * So the chain has to be verified end to end: **value ⊆ span ⊆ source.**
 */
type ValueCheck =
  /** The value appears inside its own span. The strongest claim available. */
  | 'contained'
  /** The value and the span share meaningful vocabulary — a restatement. */
  | 'overlap'
  /** The value has nothing to do with the span it cites. */
  | 'unrelated'
  /** Not free text; containment is the wrong question. See `checkValue`. */
  | 'exempt'
  /** No value at all. */
  | 'empty';

/** Tokens worth comparing — short words match by accident too easily. */
function significantTokens(text: string): string[] {
  return text.split(' ').filter((t) => t.length >= 3);
}

/**
 * Compares an emitted value against the span the model cited for it.
 *
 * Two value shapes are exempt, because containment is the wrong test rather
 * than a test we are skipping:
 *
 *  - **Numbers** (`difficulty`) are a 1–5 judgement, not a quotation. "Medium"
 *    is not a word that appears in the page; the honest guarantee is that it is
 *    an inference, which caps it at amber regardless.
 *  - **String arrays** (`tags`) are drawn from a closed vocabulary that
 *    `canonicalizeTags` enforces against `MEAL_TAGS`. A tag that is not one of
 *    ours is dropped before it ever reaches here, which is a stronger guarantee
 *    than span containment, and legitimate tags ("Vegan") rarely appear
 *    verbatim in the text that implies them.
 *
 * Everything else — names, ingredient product names, yields, methods, stories,
 * photo URLs — is free text lifted from the page, and must be traceable into
 * the span that claims to source it.
 */
function checkValue(value: unknown, span: string): ValueCheck {
  if (value == null) return 'empty';
  if (typeof value === 'number') return Number.isFinite(value) ? 'exempt' : 'empty';
  if (Array.isArray(value)) return value.length > 0 ? 'exempt' : 'empty';

  const needle = normalizeForMatch(String(value));
  if (!needle) return 'empty';

  const haystack = normalizeForMatch(span);
  if (haystack.includes(needle)) return 'contained';

  // A restatement still has to be about the same thing: "a knob of butter"
  // becoming "2 tbsp butter" shares "butter"; "saffron threads" shares nothing.
  const valueTokens = significantTokens(needle);
  const spanTokens = new Set(significantTokens(haystack));
  if (valueTokens.length === 0) {
    // Purely short/numeric free text ("48", "4"). Only a containment hit counts;
    // there is no vocabulary to overlap on, and accepting it on overlap alone is
    // exactly the `serves: "48"` hole.
    return 'unrelated';
  }
  const shared = valueTokens.filter((t) => spanTokens.has(t)).length;
  return shared / valueTokens.length >= 0.5 ? 'overlap' : 'unrelated';
}

/** Which corpus the evidence span was found in. */
type MatchRegion = 'recipe' | 'page';

function levelFor(
  derivation: Derivation,
  match: MatchKind,
  value: ValueCheck,
  region: MatchRegion,
): Confidence {
  if (match === 'none') return 'red';
  if (value === 'empty') return 'red';

  // A value that has nothing to do with the span it cites is not evidenced by
  // that span, however real the span is. This is the case a span-only check
  // waves through.
  if (value === 'unrelated') return 'red';

  // The span is real but sits outside the recipe — a reader comment, a related
  // post, a disclosure. Never green: the creator has to look at it.
  if (region === 'page') return 'amber';

  switch (derivation) {
    case 'json-ld':
    case 'page-text':
      // A verbatim claim has to survive both halves of the chain: the span is
      // in the source, *and* the value is in the span. Green requires the value
      // to be *contained* in its span — `overlap` is a restatement mislabelled
      // as a quotation, and `exempt` means we could not check containment at
      // all, which is not evidence of anything. `derivation` is the model's
      // free choice, so an unchecked value must never be promoted by claiming
      // to be a quotation: `difficulty: 5` cited to "Coriander is cilantro btw"
      // was reading green on exactly this path.
      return match === 'exact' && value === 'contained' ? 'green' : 'amber';
    case 'normalized':
    case 'inferred':
      // The span checks out and the value is drawn from it, but the value is a
      // restatement — "a knob of butter" became "2 tbsp". Never green, however
      // good the span match.
      return 'amber';
    case 'generated':
      // Handled before we get here; a generated value has no span to verify.
      return 'amber';
    case 'absent':
    default:
      return 'red';
  }
}

function reasonFor(
  derivation: Derivation,
  match: MatchKind,
  hasSpan: boolean,
  value: ValueCheck,
  region: MatchRegion = 'recipe',
): string {
  if (!hasSpan) return 'No evidence span — the value is not traceable to the source.';
  if (match === 'none') return 'Evidence span was not found in the page we fetched.';
  if (value === 'empty') return 'No value was extracted for this field.';
  if (value === 'unrelated') {
    return 'The evidence span is real, but it does not contain or support this value.';
  }
  if (region === 'page') {
    return 'Found on the page but outside the recipe itself — it may have come from a reader ' +
      'comment or a related post, so check it.';
  }
  if (value === 'exempt') {
    return derivation === 'inferred' || derivation === 'normalized'
      ? 'Inferred from the source as a whole, not stated outright.'
      : 'We could not check this value against its evidence span directly.';
  }

  const verbatim = derivation === 'json-ld' || derivation === 'page-text';
  if (verbatim && value === 'overlap') {
    return 'Marked as quoted, but the value is not verbatim within its evidence span.';
  }
  if (derivation === 'json-ld') {
    return match === 'exact'
      ? 'Taken from the page’s structured recipe data.'
      : 'Close to the structured recipe data but not verbatim.';
  }
  if (derivation === 'page-text') {
    return match === 'exact' ? 'Verbatim from the page.' : 'Near-verbatim from the page.';
  }
  if (derivation === 'normalized') return 'Restated from the source — check the amount and unit.';
  return 'Inferred from the source as a whole, not stated outright.';
}

/**
 * Verifies one field's provenance and assigns its confidence.
 *
 * Two independent checks, both of which have to pass:
 *
 *  1. **span ⊆ source** — the span the model cited really is in the page we
 *     fetched. `json-ld` claims are checked against the JSON-LD block
 *     specifically, so a fabricated provenance is downgraded rather than
 *     believed; other derivations may draw on the page text or the JSON-LD.
 *  2. **value ⊆ span** — the value really is in the span it cites. Without this
 *     a fabricated value riding a genuine sentence reads green.
 *
 * `value` is the emitted value for this field. For an ingredient, pass the
 * product name: it is the part that reaches the cart and the part a
 * hallucination invents, while the amount and unit are exactly what a
 * `normalized` derivation is allowed to restate.
 */
export function assessField(
  value: unknown,
  evidence: string | null,
  derivation: Derivation,
  source: VerificationSource,
): FieldConfidence {
  const span = evidence?.trim() ?? '';

  // A generated value makes no claim about the source, so there is no span to
  // verify — the provenance is a fact about our own pipeline. Amber, always:
  // the value is real and usable, but the creator has to know we chose it.
  if (derivation === 'generated') {
    return {
      level: value == null || value === '' ? 'red' : 'amber',
      derivation,
      match: 'none',
      score: 0,
      evidence: null,
      reason: span || 'Chosen by Mealio — not found on the page.',
    };
  }

  if (!span || derivation === 'absent') {
    return {
      level: 'red',
      derivation,
      match: 'none',
      score: 0,
      evidence: span || null,
      reason: reasonFor(derivation, 'none', Boolean(span), 'empty'),
    };
  }

  let match: SpanMatch;
  let region: MatchRegion = 'recipe';

  if (derivation === 'json-ld') {
    // A json-ld claim with no json-ld on the page is a fabricated provenance.
    // The Recipe node is already the narrowest corpus there is.
    match = source.jsonLd ? findSpan(span, source.jsonLd) : { kind: 'none', score: 0 };
  } else {
    // Narrowest first. Only if the span is nowhere in the recipe region do we
    // fall back to the whole page — and a hit there is capped at amber, because
    // it means the span came from a comment, a related post, or a disclosure.
    const inJsonLd = source.jsonLd ? findSpan(span, source.jsonLd) : { kind: 'none' as const, score: 0 };
    const inRecipe = findSpan(span, source.recipeText);
    const best = inRecipe.score >= inJsonLd.score ? inRecipe : inJsonLd;

    if (best.kind !== 'none') {
      match = best;
    } else {
      const inPage = findSpan(span, source.pageText);
      match = inPage;
      if (inPage.kind !== 'none') region = 'page';
    }
  }

  const valueCheck = checkValue(value, span);

  return {
    level: levelFor(derivation, match.kind, valueCheck, region),
    derivation,
    match: match.kind,
    score: Math.round(match.score * 1000) / 1000,
    evidence: span,
    reason: reasonFor(derivation, match.kind, true, valueCheck, region),
  };
}
