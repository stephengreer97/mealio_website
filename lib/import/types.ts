/**
 * Shared contract for the creator meal-import pipeline (MEAL-70 / 71 / 72).
 *
 *   fetch  (MEAL-70)  →  gate  (MEAL-70)  →  extract  (MEAL-71)  →  confidence  (MEAL-72)
 *
 * The three tickets are one pipeline, so the types they exchange live in one
 * file. The load-bearing contract is `ExtractedField`: MEAL-71 emits a value
 * plus the evidence span it claims to have taken that value from, and MEAL-72
 * verifies that span against the source *we* fetched. Nothing the model says
 * about its own confidence is ever used.
 */

// ── Fetch (MEAL-70) ──────────────────────────────────────────────────────────

/**
 * Which structured-data format a recipe was recovered from, if any.
 *
 * Per the MEAL-69 spike only 27% of live creator URLs carry valid JSON-LD
 * `Recipe`, so raw HTML is the primary path and these are fast-paths, not the
 * main road. Microdata/hRecipe adds roughly 4 points of coverage for ~50 lines
 * and no LLM cost, which is why it is read before falling through.
 */
export type StructuredSource = 'json-ld' | 'microdata';

/** Which route the extraction actually took. Logged for every import. */
export type ExtractionPath = 'json-ld' | 'microdata' | 'raw-html';

/**
 * Publishing platform, detected from page markers. Recorded so the MEAL-69
 * coverage question can be re-answered against our own creators' URLs in a few
 * weeks instead of re-argued.
 */
export type Platform =
  | 'wordpress-wprm'
  | 'wordpress-tasty'
  | 'wordpress-yoast'
  | 'wordpress'
  | 'jetpack-recipes'
  | 'squarespace'
  | 'wix'
  | 'ghost'
  | 'substack'
  | 'medium'
  | 'link-in-bio'
  | 'unknown';

/** Cleaned, source-agnostic view of a page. Blogs and videos both reduce to this. */
export interface SourceDocument {
  /** Normalised URL the content was finally read from (post-redirect). */
  url: string;
  /** `<title>` for a page, video title for a video. */
  title: string;
  /** Cleaned page text for a blog; description + captions for a video. */
  text: string;
  /** Normalised `schema.org/Recipe` from JSON-LD *or* microdata, if either is present. */
  jsonLd: RecipeJsonLd | null;
  /** Which format `jsonLd` came from. Null when neither was present. */
  structuredSource: StructuredSource | null;
  /** Serialised structured recipe, used as the verification corpus for MEAL-72. */
  jsonLdRaw: string | null;
  /** og:image / structured image, if any. Candidate for `photoUrl`. */
  imageUrl: string | null;
  /** Detected publishing platform, for telemetry. */
  platform: Platform;
}

/** The subset of schema.org/Recipe we read. Everything is optional in the wild. */
export interface RecipeJsonLd {
  name?: string;
  description?: string;
  image?: string | null;
  recipeIngredient?: string[];
  recipeInstructions?: string[];
  recipeYield?: string | null;
  totalTime?: string | null;
  author?: string | null;
  keywords?: string[];
}

export type FetchFailureReason =
  | 'invalid-url'
  | 'blocked-scheme'
  | 'blocked-private-address'
  | 'blocked-by-robots'
  /**
   * The site refused a server-side client: Cloudflare, Medium, Beacons and
   * friends 403 a plain fetch while working fine in a browser (12% of the
   * MEAL-69 sample). Distinct from every extraction failure — we never saw the
   * page, so nothing downstream may treat the error body as page content.
   */
  | 'blocked-by-site'
  | 'too-many-redirects'
  | 'response-too-large'
  | 'timeout'
  | 'http-error'
  | 'unsupported-content-type'
  | 'network-error';

export interface FetchFailure {
  ok: false;
  reason: FetchFailureReason;
  /** Human/log readable. Always safe to show a creator and to log in the poller. */
  detail: string;
}

export interface FetchSuccess {
  ok: true;
  url: string;
  status: number;
  contentType: string;
  html: string;
  /** Every URL in the redirect chain, starting with the requested one. */
  redirects: string[];
}

export type FetchResult = FetchSuccess | FetchFailure;

// ── Gate (MEAL-70) ───────────────────────────────────────────────────────────

/**
 * Source-agnostic gate input. A blog post supplies cleaned page text; a video
 * supplies description-plus-captions. Designing around HTML and retrofitting
 * video later means writing the gate twice.
 */
export interface GateInput {
  title: string;
  text: string;
  /** True when a valid schema.org/Recipe block was found — a trivially-yes shortcut. */
  hasRecipeJsonLd?: boolean;
}

export type GateVerdictValue = 'yes' | 'no' | 'unsure';

export interface GateVerdict {
  verdict: GateVerdictValue;
  /** Never decoration — the poller logs this to explain why it skipped a post. */
  reason: string;
  /** How the verdict was reached, so a dead classifier is distinguishable from a working one. */
  source: 'json-ld' | 'classifier' | 'no-content' | 'classifier-unavailable';
}

/**
 * Manual import (Phase 1) and the feed poller (Phase 2) want opposite defaults.
 * Same classifier; the caller decides how `unsure` resolves.
 */
export type GateMode = 'manual' | 'poller';

// ── Extraction (MEAL-71) ─────────────────────────────────────────────────────

/**
 * Where a value came from. Set by the model, then checked by MEAL-72 — a
 * claimed `json-ld` derivation whose span isn't in the JSON-LD block is
 * downgraded, not believed.
 */
export type Derivation =
  /** Copied from a schema.org/Recipe field. */
  | 'json-ld'
  /** Copied verbatim out of the page text. */
  | 'page-text'
  /** Restated from the source: unit conversion, "a knob of" → "2 tbsp". */
  | 'normalized'
  /** Judged from the source as a whole — tags, difficulty. */
  | 'inferred'
  /**
   * Produced by us, not found on the page — currently only a Pixabay stand-in
   * photo. Always amber: a placeholder we chose is not something we read, and
   * folding it into `inferred` would be the same dishonesty the confidence
   * model exists to prevent.
   */
  | 'generated'
  /** Not present in the source at all. */
  | 'absent';

/** One extracted value plus the provenance MEAL-72 verifies. */
export interface ExtractedField<T> {
  value: T;
  /**
   * The span of source text the model claims this value came from. Null means
   * the model is asserting it had nothing to point at, which reads red.
   */
  evidence: string | null;
  derivation: Derivation;
}

/** An ingredient as the model returns it, before shape canonicalisation. */
export interface ExtractedIngredient {
  /** Product to search for in the store — the name only, no quantity. */
  productName: string;
  /** Numeric amount, or null when the source gives none ("salt to taste"). */
  measure: string | null;
  /** Unit token; 'qty' for countable items. */
  unit: string;
  /** Count for countable items. */
  qty: number;
  evidence: string | null;
  derivation: Derivation;
}

/** Raw model output. Same shape from the JSON-LD path and the raw-text path. */
export interface ExtractionOutput {
  name: ExtractedField<string>;
  ingredients: ExtractedIngredient[];
  recipe: ExtractedField<string>;
  story: ExtractedField<string>;
  photoUrl: ExtractedField<string>;
  difficulty: ExtractedField<number | null>;
  tags: ExtractedField<string[]>;
  serves: ExtractedField<string>;
}

// ── Confidence (MEAL-72) ─────────────────────────────────────────────────────

export type Confidence = 'green' | 'amber' | 'red';

export interface FieldConfidence {
  level: Confidence;
  derivation: Derivation;
  /** How the evidence span compared to the source we fetched. */
  match: 'exact' | 'fuzzy' | 'none';
  /** 0–1 similarity of the best-matching window. 1 for an exact hit. */
  score: number;
  /** The span the model claimed, echoed back so the UI can highlight it. */
  evidence: string | null;
  /** Short explanation, e.g. "no evidence span" or "unit converted". */
  reason: string;
}

// ── Pipeline output ──────────────────────────────────────────────────────────

/** Exactly the nine fields `POST /api/creator/meals` accepts. */
export interface CreatorMealDraft {
  name: string;
  ingredients: DraftIngredient[];
  recipe: string | null;
  source: string;
  story: string | null;
  photoUrl: string | null;
  difficulty: number | null;
  tags: string[];
  serves: string | null;
}

/**
 * Canonical ingredient shape, matching `normalizeIngredients` in the mobile app
 * (`src/lib/normalizeIngredients.ts`). The pipeline emits this so a draft can be
 * POSTed to `/api/creator/meals` untouched.
 */
export interface DraftIngredient {
  ingredientName: string;
  qty: number;
  productQty: number;
  unit: string;
  measure: string | null;
  searchTerm: string | null;
}

export interface ImportConfidence {
  name: FieldConfidence;
  recipe: FieldConfidence;
  story: FieldConfidence;
  photoUrl: FieldConfidence;
  difficulty: FieldConfidence;
  tags: FieldConfidence;
  serves: FieldConfidence;
  /** Per-ingredient, index-aligned with `draft.ingredients`. One bad row is one red row. */
  ingredients: FieldConfidence[];
}

export interface ImportUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Estimated USD for this import, from the model's published per-MTok rates. */
  costUsd: number;
}

export interface ImportSuccess {
  status: 'ok';
  url: string;
  draft: CreatorMealDraft;
  confidence: ImportConfidence;
  gate: GateVerdict;
  meta: {
    /** True when structured data (JSON-LD or microdata) fed the extraction. */
    usedJsonLd: boolean;
    /** Which route was taken. Logged for every import. */
    path: ExtractionPath;
    platform: Platform;
    /** True when this result came from the idempotency cache. */
    cached: boolean;
    redirects: string[];
    /** Extraction call. Null when the result came from cache. */
    usage: ImportUsage | null;
    /** Gate call. Null when the structured-data shortcut made the classifier unnecessary. */
    gateUsage: ImportUsage | null;
  };
}

export interface ImportRejection {
  status: 'rejected';
  url: string;
  /** Which stage stopped the pipeline. */
  stage: 'fetch' | 'robots' | 'gate' | 'extract';
  /** Machine-readable; `FetchFailureReason` values pass through unchanged. */
  reason: string;
  /** Loggable explanation. The poller records this so a dead feed is visible. */
  detail: string;
  /** Present when the gate ran, so a skip can be explained. */
  gate?: GateVerdict;
  meta: {
    cached: boolean;
    /** Absent when we never got a page to look at. */
    path?: ExtractionPath;
    platform?: Platform;
  };
}

export type ImportResult = ImportSuccess | ImportRejection;

/**
 * One structured line per import attempt.
 *
 * There is no real creator data to calibrate against yet, so this is how the
 * MEAL-69 coverage question gets re-answered against our own users: platform,
 * path taken, and the resulting confidence spread, recorded from day one.
 */
export interface ImportTelemetry {
  url: string;
  outcome: 'ok' | 'rejected';
  stage: 'fetch' | 'robots' | 'gate' | 'extract' | 'complete';
  reason: string | null;
  platform: Platform | null;
  path: ExtractionPath | null;
  gateVerdict: GateVerdictValue | null;
  gateSource: GateVerdict['source'] | null;
  cached: boolean;
  ingredientCount: number | null;
  /** How many fields landed on each level — the calibration signal. */
  confidence: { green: number; amber: number; red: number } | null;
  costUsd: number;
  durationMs: number;
}
