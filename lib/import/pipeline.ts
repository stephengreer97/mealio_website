/**
 * The import pipeline: fetch → gate → extract → confidence.
 *
 * MEAL-70 (fetch + gate), MEAL-71 (extract) and MEAL-72 (confidence) are one
 * system, and this is where they compose. A caller supplies a URL and a mode and
 * gets back either a draft ready to POST to `/api/creator/meals` with a
 * confidence level per field, or a rejection carrying a reason a poller can log.
 *
 * The MEAL-69 spike put JSON-LD coverage at 27%, so the raw-HTML path is the
 * common case and structured data is a fast-path. Both routes land in the same
 * place; `meta.path` records which one ran.
 *
 * Everything external is injected: DNS, fetch, the Anthropic caller, the cache
 * and the telemetry sink. That is what lets the whole pipeline run in tests
 * against recorded fixtures with no network and no API key.
 */

import {
  AnthropicUnavailableError,
  createStructuredCaller,
  type StructuredCaller,
  type StructuredUsage,
} from './anthropic';
import {
  defaultImportCache,
  documentFingerprint,
  gateKey,
  importKey,
  GATE_TTL_MS,
  IMPORT_TTL_MS,
  type ImportCache,
} from './cache';
import { assessField, verificationSourceFor } from './confidence';
import { cartAmount } from './ingredients';
import { createPhotoResolver, nullPhotoResolver, type PhotoResolver } from './photo';
import { extractDraft } from './extract';
import { classifySource, resolveGate } from './gate';
import { toSourceDocument } from './html';
import { checkRobots } from './robots';
import { normalizeUrl, safeFetch, type SafeFetchOptions } from './ssrf';
import { defaultTelemetrySink, summariseConfidence, type TelemetrySink } from './telemetry';
import type {
  ExtractionPath,
  FieldConfidence,
  GateMode,
  GateVerdict,
  ImportConfidence,
  ImportRejection,
  ImportResult,
  ImportSuccess,
  ImportTelemetry,
  ImportUsage,
  Platform,
  SourceDocument,
} from './types';

export interface RunImportOptions {
  /**
   * How an `unsure` gate verdict resolves. `manual` attempts (the creator picked
   * the URL and is watching); `poller` skips (nobody asked).
   */
  mode?: GateMode;
  /** Anthropic seam. Defaults to the real client, which needs `ANTHROPIC_API_KEY`. */
  call?: StructuredCaller;
  cache?: ImportCache;
  /** DNS/fetch/timeout injection for the SSRF-safe fetcher. */
  fetchOptions?: SafeFetchOptions;
  /**
   * A source document the caller already has, which replaces the fetch.
   *
   * Not every source is a page. A YouTube video's document is its title,
   * description and captions, assembled from the uploads feed and the channel
   * owner's grant (MEAL-74) — fetching `watch?v=…` would get a JavaScript shell
   * with no recipe in it, and the gate would truthfully report that it is not a
   * recipe. Everything after this point is unchanged: same gate, same
   * extraction, same confidence assessment.
   */
  document?: SourceDocument;
  /** Set false only in tests; production must honour robots.txt. */
  honourRobots?: boolean;
  /** Skips both cache reads and writes. */
  skipCache?: boolean;
  /**
   * Who the import is for. Scopes the storage path when we copy the page's
   * image into our own bucket. Without it no photo is resolved — we never
   * publish a bare third-party URL, so no user context means no photo.
   */
  userId?: string;
  /** Overrides photo resolution wholesale. Tests inject; production uses `userId`. */
  resolvePhoto?: PhotoResolver;
  /** Where the per-import telemetry line goes. */
  telemetry?: TelemetrySink;
  /** Overridable clock, so duration is testable. */
  now?: () => number;
}

function toImportUsage(usage: StructuredUsage | null): ImportUsage | null {
  return usage
    ? {
        model: usage.model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        costUsd: usage.costUsd,
      }
    : null;
}

export async function runImport(rawUrl: string, options: RunImportOptions = {}): Promise<ImportResult> {
  const mode: GateMode = options.mode ?? 'manual';
  const cache = options.cache ?? defaultImportCache;
  const useCache = !options.skipCache;
  const honourRobots = options.honourRobots !== false;
  const emit = options.telemetry ?? defaultTelemetrySink;
  const now = options.now ?? Date.now;
  const startedAt = now();
  // Undefined for the fetched path, so those keys are unchanged. A supplied
  // document keys on its own content instead, because the URL alone cannot tell
  // it apart from the page at the same address — see `documentFingerprint`.
  const cacheScope = options.document ? documentFingerprint(options.document) : undefined;

  // Tracks how far we got, so an unexpected throw is attributed to the right
  // stage rather than always blamed on the fetch.
  let stage: ImportRejection['stage'] = 'fetch';

  // The cache is an injectable interface, and the durable implementation the
  // poller will want can fail in ways the in-memory one never does. A cache
  // outage must degrade to a slow import, never to a failed one.
  const cacheGet = async <T>(key: string): Promise<T | null> => {
    try {
      return await cache.get<T>(key);
    } catch {
      return null;
    }
  };
  const cacheSet = async <T>(key: string, value: T, ttl: number): Promise<void> => {
    try {
      await cache.set(key, value, ttl);
    } catch {
      /* a write we could not make is not a reason to fail the import */
    }
  };

  // Every exit from this function goes through `finish`, so no path can escape
  // without a telemetry line.
  const finish = <T extends ImportResult>(result: T, event: Partial<ImportTelemetry>): T => {
    emit({
      url: result.url,
      outcome: result.status === 'ok' ? 'ok' : 'rejected',
      stage: result.status === 'ok' ? 'complete' : result.stage,
      reason: result.status === 'ok' ? null : result.reason,
      platform: null,
      path: null,
      gateVerdict: null,
      gateSource: null,
      cached: result.meta.cached,
      ingredientCount: null,
      confidence: null,
      costUsd: 0,
      durationMs: now() - startedAt,
      ...event,
    });
    return result;
  };

  const rejection = (
    url: string,
    stage: ImportRejection['stage'],
    reason: string,
    detail: string,
    extra: { gate?: GateVerdict; path?: ExtractionPath; platform?: Platform } = {},
  ): ImportRejection => ({
    status: 'rejected',
    url,
    stage,
    reason,
    detail,
    ...(extra.gate ? { gate: extra.gate } : {}),
    meta: { cached: false, ...(extra.path ? { path: extra.path } : {}), ...(extra.platform ? { platform: extra.platform } : {}) },
  });

  const url = normalizeUrl(rawUrl);
  if (!url) {
    return finish(
      rejection(
        rawUrl,
        'fetch',
        'invalid-url',
        'That does not look like an http or https link. Paste the full URL of the post.',
      ),
      {},
    );
  }

  // Wrapped so the "every exit emits telemetry" invariant survives an
  // *unexpected* failure too — a durable ImportCache throwing, a pathological
  // page breaking the stripper. Without this an escaping exception is the one
  // path that leaves no trace, which is precisely the path worth tracing.
  try {
  if (useCache) {
    const cached = await cacheGet<ImportResult>(importKey(url, cacheScope));
    if (cached) {
      const hit = { ...cached, meta: { ...cached.meta, cached: true } } as ImportResult;
      return finish(hit, {
        platform: hit.meta.platform ?? null,
        path: hit.meta.path ?? null,
        cached: true,
        ...(hit.status === 'ok'
          ? {
              gateVerdict: hit.gate.verdict,
              gateSource: hit.gate.source,
              ingredientCount: hit.draft.ingredients.length,
            }
          : {}),
      });
    }
  }

  let document: SourceDocument;
  /** Empty for a caller-supplied document: nothing was fetched, so nothing redirected. */
  let redirects: string[] = [];

  // A caller-supplied document is content we already hold, obtained through an
  // API the creator authorised rather than by crawling a page — so there is no
  // request for robots.txt to have an opinion about, and nothing to fetch.
  if (options.document) {
    document = options.document;
  } else {
    // ── robots.txt ──────────────────────────────────────────────────────────
    stage = 'robots';
    if (honourRobots) {
      const robots = await checkRobots(url, options.fetchOptions);
      if (!robots.allowed) {
        const result = rejection(url, 'robots', 'blocked-by-robots', robots.detail);
        if (useCache) await cacheSet(importKey(url, cacheScope), result, IMPORT_TTL_MS);
        return finish(result, {});
      }
    }

    // ── fetch ───────────────────────────────────────────────────────────────
    stage = 'fetch';
    const fetched = await safeFetch(url, options.fetchOptions);
    if (!fetched.ok) {
      // Not cached: fetch failures are usually transient (timeout, 5xx, bot
      // challenge) and a creator retrying immediately deserves a fresh attempt.
      // `blocked-by-site` in particular means we never saw the page — it must
      // never be reported as an extraction failure.
      return finish(rejection(url, 'fetch', fetched.reason, fetched.detail), {});
    }
    document = toSourceDocument(fetched.url, fetched.html);
    redirects = fetched.redirects;
  }

  stage = 'gate';
  const platform = document.platform;

  // Link-in-bio pages are unsupported, not merely hard. The MEAL-69 spike's
  // beacons.ai case had 311 characters of body text and no recipe anywhere on
  // it — there is nothing on the page for any model to find, so this is a
  // deterministic rejection with a message that tells the creator what to paste
  // instead, rather than an extraction call that cannot succeed.
  if (platform === 'link-in-bio') {
    const result = rejection(
      url,
      'gate',
      'link-in-bio',
      'That is a link-in-bio page, which only holds links — there is no recipe on it to read. ' +
        'Open the recipe itself and paste that link instead.',
      { platform },
    );
    if (useCache) await cacheSet(importKey(url, cacheScope), result, IMPORT_TTL_MS);
    return finish(result, { platform });
  }

  /**
   * A video whose description was too thin to judge and whose captions we could
   * not read (MEAL-138).
   *
   * This has to stop *before* the gate, and the reason is the whole ticket. The
   * document is a short description and nothing else, so `classifySource` rejects
   * it with `no-content` — "too little readable text ... link-in-bio and landing
   * pages look like this" — and `stage: 'gate'` is what `admin-sync` reads as
   * **`rejected`**: a verdict on the post, permanent, never retried. So a
   * permission we were refused was being recorded as a fact about somebody's
   * video, in a sentence about landing pages, on a row nothing would ever look at
   * again.
   *
   * `stage: 'fetch'` is not a euphemism: a fetch we needed was refused, we never
   * saw the material, and nothing here has an opinion about the video. It maps to
   * `failed` rather than `rejected`, and it is not cached, so the video is still
   * importable the moment the permission exists.
   *
   * **It is not picked up by a sweep, and this comment used to say it was.** The
   * poller's retry window is three poll intervals from the *first sighting of the
   * video* — 45 minutes — so a creator who grants the scope that evening was never
   * going to be inside it, and inside it every attempt is the identical refusal at
   * 50 quota units, ending in a `lost` signal that tells an operator the recipe
   * has to be imported by hand when a permission fixes it. So the detail carries
   * `CAPTIONS_NO_AUTO_RETRY` and the sweep skips these (see `retryable` in
   * `lib/creator-poller.ts`): granting the permission and re-importing from the
   * catalogue is the recovery, which is exactly what a `rejected` row allowed too.
   * What this ticket buys is that the row says *why*, to the person who can fix
   * it, instead of calling somebody's video contentless.
   *
   * `missing-scope` and `unavailable` both land here. A caption call that 500'd on
   * a thin-description video is no more a verdict on the video than a refused one
   * is, and it was reaching the same permanent rejection. Those two are not the
   * same about retrying, and they do not have to be: `unavailable` marks its own
   * deterministic half the same way, and the transient half is retried.
   */
  if (document.captions === 'missing-scope' || document.captions === 'unavailable') {
    const result = rejection(
      url,
      'fetch',
      `captions-${document.captions}`,
      document.captionsDetail ??
        'This video’s description was too short to read a recipe from, and its captions could not be read.',
      { platform },
    );
    return finish(result, { platform });
  }

  // ── gate ──────────────────────────────────────────────────────────────────
  let verdict = useCache ? await cacheGet<GateVerdict>(gateKey(url, cacheScope)) : null;
  let gateUsage: StructuredUsage | null = null;

  if (!verdict) {
    const result = await classifySource(
      { title: document.title, text: document.text, hasRecipeJsonLd: Boolean(document.jsonLd) },
      { call: options.call ?? safeDefaultCaller() },
    );
    verdict = result.verdict;
    gateUsage = result.usage;
    // An `unavailable` verdict is a transient outage, not a fact about the URL.
    if (useCache && verdict.source !== 'classifier-unavailable') {
      await cacheSet(gateKey(url, cacheScope), verdict, GATE_TTL_MS);
    }
  }

  const decision = resolveGate(verdict, mode);
  if (!decision.proceed) {
    const result = rejection(url, 'gate', `gate-${verdict.verdict}`, decision.reason, {
      gate: verdict,
      platform,
    });
    if (useCache && verdict.verdict === 'no') {
      await cacheSet(importKey(url, cacheScope), result, IMPORT_TTL_MS);
    }
    return finish(result, {
      platform,
      gateVerdict: verdict.verdict,
      gateSource: verdict.source,
      costUsd: gateUsage?.costUsd ?? 0,
    });
  }

  // ── extract ───────────────────────────────────────────────────────────────
  stage = 'extract';
  let extraction;
  try {
    const resolvePhoto =
      options.resolvePhoto ??
      (options.userId ? createPhotoResolver(options.userId, options.fetchOptions) : nullPhotoResolver);
    extraction = await extractDraft(document, {
      call: options.call ?? safeDefaultCaller(),
      resolvePhoto,
    });
  } catch (err) {
    const detail = err instanceof AnthropicUnavailableError ? err.message : String(err);
    return finish(
      rejection(url, 'extract', 'extraction-failed', detail, { gate: verdict, platform }),
      {
        platform,
        path: document.structuredSource ?? 'raw-html',
        gateVerdict: verdict.verdict,
        gateSource: verdict.source,
        costUsd: gateUsage?.costUsd ?? 0,
      },
    );
  }

  // ── confidence ────────────────────────────────────────────────────────────
  const source = verificationSourceFor(document);
  const field = (f: {
    value: unknown;
    evidence: string | null;
    derivation: FieldConfidence['derivation'];
  }) => assessField(f.value, f.evidence, f.derivation, source);

  const ingredientConfidence: FieldConfidence[] = extraction.keptIngredientIndices.map((index, position) => {
    const item = extraction.output.ingredients[index];
    // The canonicalised row, not the raw one: it is what reaches the cart, so it
    // is what has to be traceable back into the evidence span — the amount as
    // much as the product name.
    const row = extraction.draft.ingredients[position];
    return assessField(row.ingredientName, item.evidence, item.derivation, source, cartAmount(row, item));
  });

  const confidence: ImportConfidence = {
    name: field(extraction.output.name),
    recipe: field(extraction.output.recipe),
    story: field(extraction.output.story),
    photoUrl: field(extraction.output.photoUrl),
    difficulty: field(extraction.output.difficulty),
    tags: field(extraction.output.tags),
    serves: field(extraction.output.serves),
    ingredients: ingredientConfidence,
  };

  const success: ImportSuccess = {
    status: 'ok',
    url,
    draft: extraction.draft,
    confidence,
    gate: verdict,
    meta: {
      usedJsonLd: extraction.usedJsonLd,
      path: extraction.path,
      platform,
      cached: false,
      redirects,
      usage: toImportUsage(extraction.usage),
      gateUsage: toImportUsage(gateUsage),
    },
  };

  if (useCache) await cacheSet(importKey(url, cacheScope), success, IMPORT_TTL_MS);

  const allFields = [
    confidence.name, confidence.recipe, confidence.story, confidence.photoUrl,
    confidence.difficulty, confidence.tags, confidence.serves, ...confidence.ingredients,
  ];

  return finish(success, {
    platform,
    path: extraction.path,
    gateVerdict: verdict.verdict,
    gateSource: verdict.source,
    ingredientCount: success.draft.ingredients.length,
    confidence: summariseConfidence(allFields),
    costUsd: (extraction.usage.costUsd ?? 0) + (gateUsage?.costUsd ?? 0),
  });
  } catch (err) {
    return finish(
      rejection(
        url,
        stage,
        'internal-error',
        `The import failed unexpectedly while we were ${stage === 'extract' ? 'reading the recipe' : 'reading the page'}. ` +
          `Please try again. (${err instanceof Error ? err.message : String(err)})`,
      ),
      {},
    );
  }
}

/**
 * Builds the production caller lazily. Constructing it is cheap and does not
 * touch the network; the missing-key error surfaces on first use, which is what
 * turns "no API key" into a clean rejection instead of a crash at import time.
 */
let memoisedCaller: StructuredCaller | null = null;
function safeDefaultCaller(): StructuredCaller {
  if (!memoisedCaller) memoisedCaller = createStructuredCaller();
  return memoisedCaller;
}

/** Test hook: clears the memoised production caller. */
export function __resetDefaultCaller(): void {
  memoisedCaller = null;
}
