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

/** The verification corpora a source document offers. */
export interface VerificationSource {
  /** Serialised JSON-LD as handed to the model. Null when the page had none. */
  jsonLd: string | null;
  /** Cleaned page text plus the title. */
  pageText: string;
}

export function verificationSourceFor(document: SourceDocument): VerificationSource {
  // The image URL is part of the source we fetched (JSON-LD `image` or the
  // `og:image` meta tag), but `htmlToText` drops meta tags — so it is added back
  // explicitly rather than letting a real photoUrl fail verification.
  const image = document.imageUrl ? `\nimage: ${document.imageUrl}` : '';
  return {
    jsonLd: document.jsonLdRaw,
    pageText: `${document.title}\n${document.text}${image}`,
  };
}

function levelFor(derivation: Derivation, match: MatchKind): Confidence {
  if (match === 'none') return 'red';
  switch (derivation) {
    case 'json-ld':
      // Structured data, and we confirmed the span really is in that block.
      return match === 'exact' ? 'green' : 'amber';
    case 'page-text':
      // Verbatim from the page is green; a re-typed near-match is not.
      return match === 'exact' ? 'green' : 'amber';
    case 'normalized':
    case 'inferred':
      // The span checks out but the value is a restatement of it — "a knob of
      // butter" became "2 tbsp". Never green, however good the span match.
      return 'amber';
    case 'absent':
    default:
      return 'red';
  }
}

function reasonFor(derivation: Derivation, match: MatchKind, hasSpan: boolean): string {
  if (!hasSpan) return 'No evidence span — the value is not traceable to the source.';
  if (match === 'none') return 'Evidence span was not found in the page we fetched.';
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
 * `json-ld` claims are checked against the JSON-LD block specifically; every
 * other derivation may draw on the page text or the JSON-LD.
 */
export function assessField(
  evidence: string | null,
  derivation: Derivation,
  source: VerificationSource,
): FieldConfidence {
  const span = evidence?.trim() ?? '';

  if (!span || derivation === 'absent') {
    return {
      level: 'red',
      derivation,
      match: 'none',
      score: 0,
      evidence: span || null,
      reason: reasonFor(derivation, 'none', Boolean(span)),
    };
  }

  let match: SpanMatch;
  if (derivation === 'json-ld') {
    // A json-ld claim with no json-ld on the page is a fabricated provenance.
    match = source.jsonLd ? findSpan(span, source.jsonLd) : { kind: 'none', score: 0 };
  } else {
    const inPage = findSpan(span, source.pageText);
    const inJsonLd = source.jsonLd ? findSpan(span, source.jsonLd) : { kind: 'none' as const, score: 0 };
    match = inPage.score >= inJsonLd.score ? inPage : inJsonLd;
  }

  return {
    level: levelFor(derivation, match.kind),
    derivation,
    match: match.kind,
    score: Math.round(match.score * 1000) / 1000,
    evidence: span,
    reason: reasonFor(derivation, match.kind, true),
  };
}
