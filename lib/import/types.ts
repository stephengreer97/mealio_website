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
  /** Not sniffed from markup: set by the YouTube reader, which knows (MEAL-74). */
  | 'youtube'
  /** Likewise, set by the readers behind an OAuth grant (MEAL-82 / MEAL-83). */
  | 'instagram'
  | 'tiktok'
  | 'unknown';

/**
 * What became of a video's captions (MEAL-138).
 *
 * Captions are the fallback for a video whose description is too thin for the
 * gate to judge on, and there are five ways that can end. The distinction the
 * whole type exists for is between the last two and `none`: **"this video has no
 * captions" and "we were not allowed to read this video's captions" are
 * different facts about different things**, the first about the creator's video
 * and the second about our grant. Collapsing them — which is what returning
 * `null` for both did — makes a permission problem look like a content problem,
 * and a permission problem looking like a content problem is one nobody fixes.
 *
 *   - `not-needed`     — the description was substantial. Nothing was fetched.
 *   - `no-grant`       — no access token at hand, so no caption call is possible.
 *                        Description-only import, which is ordinary.
 *   - `used`           — a track was read and merged into `text`.
 *   - `none`           — the grant *can* read captions and this video has none.
 *                        A fact about the video.
 *   - `missing-scope`  — the connection carries no `youtube.force-ssl` grant, so
 *                        `captions.list` is refused (HTTP 403) whatever the video
 *                        holds. A fact about our access, and fixable by asking —
 *                        by asking, and by nothing else: it is not retried on a
 *                        timer, because the creator granting the permission is
 *                        the only thing that changes the answer.
 *   - `unavailable`    — YouTube answered, but not with a track we could read.
 *                        **Two populations, and only one of them earns a retry.**
 *                        A 5xx or a timed-out download is worth another go; a
 *                        non-scope 403 (third-party caption access off, a track
 *                        marked non-downloadable) and a track over the byte cap
 *                        end the same way every time and cost 250 quota units a
 *                        go to find out. `captionFailureIsFinal` in `lib/youtube`
 *                        is what tells the two apart downstream.
 */
export type CaptionsOutcome = 'not-needed' | 'no-grant' | 'used' | 'none' | 'missing-scope' | 'unavailable';

/** Cleaned, source-agnostic view of a page. Blogs and videos both reduce to this. */
export interface SourceDocument {
  /** Normalised URL the content was finally read from (post-redirect). */
  url: string;
  /** `<title>` for a page, video title for a video. */
  title: string;
  /** Cleaned page text for a blog; description + captions for a video. */
  text: string;
  /**
   * The same text with comment threads, related-post rails and disclosure
   * blocks stripped — the corpus MEAL-72 verifies evidence spans against.
   *
   * The distinction is load-bearing, not cosmetic. The recorded cookieandkate
   * fixture carries 345 reader comments, and while they counted as "the
   * source" an ingredient quoted out of one verified green: comments mention
   * every ingredient under the sun, so a hallucination could always find a
   * home. A value that matches only outside this region is capped at amber.
   */
  recipeText: string;
  /** Normalised `schema.org/Recipe` from JSON-LD *or* microdata, if either is present. */
  jsonLd: RecipeJsonLd | null;
  /** Which format `jsonLd` came from. Null when neither was present. */
  structuredSource: StructuredSource | null;
  /** Serialised structured recipe, used as the verification corpus for MEAL-72. */
  jsonLdRaw: string | null;
  /** og:image / structured image, if any. Candidate for `photoUrl`. */
  imageUrl: string | null;
  /**
   * What became of the caption fallback (MEAL-138). Video sources only; absent
   * for a blog, which has no such thing.
   *
   * **This field exists because its absence was a bug.** A video whose
   * description was too thin to judge and whose captions we were refused
   * produced a document identical to one for a video that genuinely has no
   * captions — same short `text`, same everything — so the gate rejected both
   * with "too little readable text", the sync marked both `rejected`
   * (permanent, never retried), and nothing anywhere recorded that we had been
   * refused rather than answered. See `captionsDetail` and `CaptionsOutcome`.
   */
  captions?: CaptionsOutcome;
  /**
   * The sentence behind a `captions` value that names a failure. Creator-facing
   * — it reaches `creator_source_items.detail` and the catalogue — so it says
   * what happened and what would fix it, and never quotes a token.
   */
  captionsDetail?: string | null;
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
  | 'network-error'
  /**
   * The server answered a conditional request with `304 Not Modified`
   * (MEAL-75). Not a failure in any ordinary sense — it is the *good* answer,
   * and the reason a poller that runs every day costs a publisher a few hundred
   * bytes rather than a page render. It sits in this union because it is the
   * one other way a fetch can return no body, and only a caller that sent
   * `If-None-Match`/`If-Modified-Since` can ever see it.
   */
  | 'not-modified';

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
   * photo. It is deliberately not `inferred`: nothing about the source implied
   * this value, we chose it, and saying otherwise would be the quiet
   * mislabelling this whole model exists to prevent. Always amber: the value is
   * real and usable, but the creator needs to know we picked it.
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
  /**
   * What the recipe asks be done to the product — "finely diced", "drained and
   * rinsed", "at room temperature". Null when the line names none (MEAL-102).
   *
   * It used to be thrown away: the prompt said to drop preparation notes along
   * with amounts and units, so "1 onion, finely diced" reached the creator as
   * "1 onion" and the cooking instruction the source actually gave was gone.
   *
   * It is a **separate field and not part of the name** for one reason.
   * `productName` doubles as the grocery search term, and a store searched for
   * "diced onion" does not return a worse onion — it returns nothing. See the
   * warning on `DraftIngredient.prep`.
   */
  prep: string | null;
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
  /**
   * Preparation, rendered after the name the way a recipe writes it —
   * "1 onion, finely diced" (MEAL-102).
   *
   * **Never a search term, and never part of one.** The add-to-cart gate is
   * exact-after-normalisation equality against `searchTerm ?? ingredientName`
   * — `app/api/kroger/search-products/route.ts` on this side, and
   * `WebViewCartSheet.tsx` on the app's. Prep reaching either field does not
   * add the wrong product; it matches nothing at all and drops the item into
   * review looking like a matching bug rather than the data bug it is. So prep
   * is carried beside the name and concatenated into it at no point in the
   * pipeline.
   *
   * **Optional, and absent rather than null when there is none.** Every
   * ingredient imported before this field existed has no `prep` key, and a row
   * with nothing to say has to serialise identically to one of those — that is
   * what makes the field additive and leaves the whole existing catalogue
   * untouched. `canonicalizeIngredient` therefore omits the key entirely
   * rather than writing `prep: null`.
   */
  prep?: string;
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
