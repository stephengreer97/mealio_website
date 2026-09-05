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
 *
 * What green does **not** mean, since green renders as no marker at all and the
 * temptation is to read it as more than it is: it means the span was found in
 * the text we extracted from the markup we fetched, inside the part of that
 * markup we were able to identify as the recipe. It does not mean a reader can
 * see the sentence on the page — `htmlToText` drops the elements the markup
 * itself declares hidden, but hiding done by a stylesheet class is invisible to
 * us. And identifying the recipe is pattern matching that can fail outright, so
 * the case where it did is detected and demoted rather than assumed away.
 */

import { statedAmounts, statedUnits, type CartAmount } from './ingredients';
import type { Confidence, Derivation, FieldConfidence, SourceDocument } from './types';

/** Below this, a near-match is not a match at all. */
export const FUZZY_THRESHOLD = 0.85;

/** Spans longer than this are compared by token containment rather than windowing. */
const LONG_SPAN_CHARS = 1200;

/** Very short spans are too easy to match by accident to be evidence of anything. */
const MIN_SPAN_CHARS = 3;

/**
 * Ceiling on the span we keep and show.
 *
 * The model's `evidence` is echoed into `FieldConfidence`, which is cached,
 * returned to the browser and rendered as the thing the creator is asked to
 * check — and it is model output over attacker-controlled page text, so it needs
 * a ceiling like every other such field. A span that runs to a thousand
 * characters is not evidence anyone can check anyway; the longest ingredient
 * line in the recorded fixtures is 96. The span is *verified* whole and
 * truncated only on the way out, so trimming it can never turn a real match into
 * a miss.
 */
const MAX_EVIDENCE_CHARS = 600;

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

interface Bigrams {
  counts: Map<string, number>;
  total: number;
}

function bigrams(text: string): Bigrams {
  const counts = new Map<string, number>();
  for (let i = 0; i < text.length - 1; i++) {
    const key = text.slice(i, i + 2);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return { counts, total: Math.max(0, text.length - 1) };
}

/** Sørensen–Dice against a needle whose bigrams have already been counted. */
function diceAgainst(needle: Bigrams, text: string): number {
  if (needle.total === 0 || text.length < 2) return 0;
  const right = bigrams(text);
  let shared = 0;
  for (const [key, count] of needle.counts) {
    const other = right.counts.get(key);
    if (other) shared += Math.min(count, other);
  }
  return (2 * shared) / (needle.total + right.total);
}

/** Sørensen–Dice over character bigrams: 1 is identical, 0 shares nothing. */
export function diceSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  return diceAgainst(bigrams(a), b);
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
 *
 * A span the corpus provably cannot match is rejected before any window is
 * built. `score` is then 0 rather than the true best, which is information we
 * have just proved is below the threshold and which nothing reads: a `none`
 * result loses the corpus tie-break in `assessField` whatever its score.
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

  // The needle's bigrams are the same for every window, and they were being
  // counted per window: a 1,200-character span against a 24,000-character corpus
  // is ~4,000 windows, each rebuilding a 1,200-entry map before comparing
  // anything. Counted once, the loop only pays for the window.
  const needleBigrams = bigrams(needle);

  // The sweep below is the expensive path, and the case that always pays for all
  // of it is the one that matters: a span that is *not* in the corpus never hits
  // the `best === 1` early exit, so it costs a full sweep every time. That is
  // three sweeps per field and up to 32 fields on one page — 27 s of blocked
  // event loop against the route's 60 s budget, bought with a hallucinated span.
  //
  // Every window is a contiguous run of the corpus, so its bigram counts are
  // bounded by the corpus's, and so is its overlap with the needle. That makes
  // `2 * overlap(needle, corpus) / needleTotal` an upper bound on the Dice score
  // of *every* window at once: one pass over the corpus can prove no window
  // reaches the threshold, without building a single one. Sound in the only
  // direction that matters — it can skip work, never a match.
  const inCorpus = bigrams(haystack);
  let reachable = 0;
  for (const [key, count] of needleBigrams.counts) {
    const available = inCorpus.counts.get(key);
    if (available) reachable += Math.min(count, available);
  }
  if ((2 * reachable) / needleBigrams.total < FUZZY_THRESHOLD) return { kind: 'none', score: 0 };

  const words = haystack.split(' ');
  const spanWords = needle.split(' ').length;
  const windowWords = Math.max(1, spanWords);

  let best = 0;
  for (let i = 0; i + 1 <= words.length; i++) {
    const window = words.slice(i, i + windowWords).join(' ');
    const score = diceAgainst(needleBigrams, window);
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
  /**
   * Page text with comments, related posts, disclosures and anything the markup
   * says is hidden stripped out.
   *
   * Narrowing is pattern matching against `id` and `class`, so it can fail to
   * narrow at all — and on the layouts it cannot parse it returns the page
   * unchanged. That case is detected rather than assumed away; see
   * `assessField`. It also cannot see hiding done by a stylesheet class, so
   * "in the recipe region" means "in the part of the markup we could identify
   * as the recipe", not "a reader can see this".
   */
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

/**
 * How the row's **amount** relates to the span it was taken from.
 *
 * The product name is not the only thing that reaches the cart. `checkValue`
 * only ever sees the product name, so `12 cups kosher salt` cited to
 * "1 teaspoon kosher salt, more to taste" passed every check we had and read
 * green — a 48× error on a page that plainly states the right number, wearing a
 * badge saying it came from the page's structured data. The amount is in the
 * same span that was matched, so verification can simply ask for it.
 */
type AmountCheck =
  /** The number, and the unit if the row names one, are both in the span. */
  | 'stated'
  /** The row's amount is not in the span it cites. */
  | 'unstated'
  /** Not an ingredient row, or a row that carries no amount. */
  | 'exempt';

/**
 * Checks a row's amount against the span the model cited for it.
 *
 * Both halves have to hold. The number alone is not enough — "bake for 12
 * minutes" would license `12 cups` — so a row that names a unit must find that
 * unit in the span too, canonicalised, because a page writes "teaspoon" where
 * the picker's vocabulary says "tsp".
 */
function checkAmount(amount: CartAmount | null | undefined, span: string): AmountCheck {
  if (!amount) return 'exempt';
  // Written amounts are decimal thirds and sixths often enough that an exact
  // comparison would reject "1/3 cup" restated as 0.333.
  if (!statedAmounts(span).some((stated) => Math.abs(stated - amount.value) < 0.005)) {
    return 'unstated';
  }
  if (amount.unit && !statedUnits(span).has(amount.unit)) return 'unstated';
  return 'stated';
}

/** Which corpus the evidence span was found in. */
type MatchRegion =
  /** Inside a recipe region that is genuinely narrower than the page. */
  | 'recipe'
  /** On the page, outside the recipe region — a comment, a rail, a disclosure. */
  | 'page'
  /** On the page, and we could not tell the recipe apart from the furniture. */
  | 'unnarrowed';

/**
 * Whether the recipe region is actually narrower than the page.
 *
 * `htmlToText(html, { dropBoilerplate: true })` matches `id` and `class` against
 * a list of markers, and on a layout that names its furniture something the list
 * does not cover it hands back the page unchanged — nav, author bio, related
 * posts, comment thread and all. Nothing said so, so `region` stayed `recipe`
 * and every one of those spans verified green: the demotion that exists
 * precisely for page furniture was silently inert on exactly the layouts that
 * defeated the narrowing, which is the failure mode a fail-open always has.
 *
 * Equality is the signal, and it is available for free. If narrowing removed
 * nothing then there is no recipe region — there is only a page — and a hit has
 * to be reported as what it is.
 */
function isNarrowed(source: VerificationSource): boolean {
  return source.recipeText !== source.pageText;
}

function levelFor(
  derivation: Derivation,
  match: MatchKind,
  value: ValueCheck,
  region: MatchRegion,
  amount: AmountCheck,
): Confidence {
  if (match === 'none') return 'red';
  if (value === 'empty') return 'red';

  // A value that has nothing to do with the span it cites is not evidenced by
  // that span, however real the span is. This is the case a span-only check
  // waves through.
  if (value === 'unrelated') return 'red';

  // The span is real but we cannot place it inside the recipe — either it sits
  // outside the region, or there was no region to sit inside. Never green: the
  // creator has to look at it.
  if (region !== 'recipe') return 'amber';

  // An amount nobody wrote down is amber, not red: the product name did check
  // out and the row is usable, so red — "we found nothing" — would be a lie
  // about the half that verified. Amber puts a marker on the row, which is the
  // whole ask: green renders as no marker at all, and this is precisely the
  // number a creator has to look at before it reaches a cart. That applies
  // whatever the derivation claims. `normalized` is *allowed* to restate an
  // amount — "a knob of butter" becoming "2 tbsp" — but restating is not
  // inventing, and a restatement of something the span does not say has nothing
  // underneath it either.
  if (amount === 'unstated') return 'amber';

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
  amount: AmountCheck = 'exempt',
): string {
  if (!hasSpan) return 'No evidence span. The value is not traceable to the source.';
  if (match === 'none') return 'Evidence span was not found in the page we fetched.';
  if (value === 'empty') return 'No value was extracted for this field.';
  if (value === 'unrelated') {
    return 'The evidence span is real, but it does not contain or support this value.';
  }
  if (region === 'page') {
    return 'Found on the page but outside the recipe itself. It may have come from a reader ' +
      'comment or a related post, so check it.';
  }
  if (region === 'unnarrowed') {
    return 'Found on the page, but on this layout we could not tell the recipe apart from the ' +
      'rest of it, so this could have come from anywhere on the page. Check it.';
  }
  if (amount === 'unstated') {
    return 'The product name checks out, but the amount and unit are not stated in the ' +
      'evidence span. Check them before this reaches a cart.';
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
  if (derivation === 'normalized') return 'Restated from the source. Check the amount and unit.';
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
 * Plus a check on the corpus itself: green is only available for a span found
 * inside a recipe region that is genuinely narrower than the page. Where the
 * narrowing found nothing to remove there is no such region, and the field is
 * demoted rather than credited to a region that does not exist.
 *
 * `value` is the emitted value for this field. For an ingredient, pass the
 * canonicalised product name — it is what reaches the cart and what a
 * hallucination invents — **and pass `amount` as well**. The amount is the other
 * half of what reaches the cart, and checking only the name is how
 * `12 cups kosher salt` read green off a page that says `1 teaspoon`.
 */
export function assessField(
  value: unknown,
  evidence: string | null,
  derivation: Derivation,
  source: VerificationSource,
  /** The row's amount, for an ingredient. Omitted for every other field. */
  amount?: CartAmount | null,
): FieldConfidence {
  const span = evidence?.trim() ?? '';
  // Verified whole, shown trimmed. See MAX_EVIDENCE_CHARS.
  const shown = span.length > MAX_EVIDENCE_CHARS ? `${span.slice(0, MAX_EVIDENCE_CHARS)}…` : span;

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
      reason: shown || 'Chosen by Mealio, not found on the page.',
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
      // A recipe region that is the whole page is not a recipe region, and a hit
      // in it says only "somewhere on the page". The JSON-LD block is narrow by
      // construction, so a win there is unaffected.
      if (best === inRecipe && !isNarrowed(source)) region = 'unnarrowed';
    } else {
      const inPage = findSpan(span, source.pageText);
      match = inPage;
      if (inPage.kind !== 'none') region = 'page';
    }
  }

  const valueCheck = checkValue(value, span);
  const amountCheck = checkAmount(amount, span);

  return {
    level: levelFor(derivation, match.kind, valueCheck, region, amountCheck),
    derivation,
    match: match.kind,
    score: Math.round(match.score * 1000) / 1000,
    evidence: shown,
    reason: reasonFor(derivation, match.kind, true, valueCheck, region, amountCheck),
  };
}
