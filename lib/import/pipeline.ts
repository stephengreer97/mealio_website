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
  gateKey,
  importKey,
  GATE_TTL_MS,
  IMPORT_TTL_MS,
  type ImportCache,
} from './cache';
import { assessField, verificationSourceFor } from './confidence';
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
  /** Set false only in tests; production must honour robots.txt. */
  honourRobots?: boolean;
  /** Skips both cache reads and writes. */
  skipCache?: boolean;
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

  if (useCache) {
    const cached = await cache.get<ImportResult>(importKey(url));
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

  // ── robots.txt ────────────────────────────────────────────────────────────
  if (honourRobots) {
    const robots = await checkRobots(url, options.fetchOptions);
    if (!robots.allowed) {
      const result = rejection(url, 'robots', 'blocked-by-robots', robots.detail);
      if (useCache) await cache.set(importKey(url), result, IMPORT_TTL_MS);
      return finish(result, {});
    }
  }

  // ── fetch ─────────────────────────────────────────────────────────────────
  const fetched = await safeFetch(url, options.fetchOptions);
  if (!fetched.ok) {
    // Not cached: fetch failures are usually transient (timeout, 5xx, bot
    // challenge) and a creator retrying immediately deserves a fresh attempt.
    // `blocked-by-site` in particular means we never saw the page — it must
    // never be reported as an extraction failure.
    return finish(rejection(url, 'fetch', fetched.reason, fetched.detail), {});
  }

  const document = toSourceDocument(fetched.url, fetched.html);
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
    if (useCache) await cache.set(importKey(url), result, IMPORT_TTL_MS);
    return finish(result, { platform });
  }

  // ── gate ──────────────────────────────────────────────────────────────────
  let verdict = useCache ? await cache.get<GateVerdict>(gateKey(url)) : null;
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
      await cache.set(gateKey(url), verdict, GATE_TTL_MS);
    }
  }

  const decision = resolveGate(verdict, mode);
  if (!decision.proceed) {
    const result = rejection(url, 'gate', `gate-${verdict.verdict}`, decision.reason, {
      gate: verdict,
      platform,
    });
    if (useCache && verdict.verdict === 'no') {
      await cache.set(importKey(url), result, IMPORT_TTL_MS);
    }
    return finish(result, {
      platform,
      gateVerdict: verdict.verdict,
      gateSource: verdict.source,
      costUsd: gateUsage?.costUsd ?? 0,
    });
  }

  // ── extract ───────────────────────────────────────────────────────────────
  let extraction;
  try {
    extraction = await extractDraft(document, { call: options.call ?? safeDefaultCaller() });
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
  const field = (f: { evidence: string | null; derivation: FieldConfidence['derivation'] }) =>
    assessField(f.evidence, f.derivation, source);

  const ingredientConfidence: FieldConfidence[] = extraction.keptIngredientIndices.map((index) => {
    const item = extraction.output.ingredients[index];
    return assessField(item.evidence, item.derivation, source);
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
      redirects: fetched.redirects,
      usage: toImportUsage(extraction.usage),
      gateUsage: toImportUsage(gateUsage),
    },
  };

  if (useCache) await cache.set(importKey(url), success, IMPORT_TTL_MS);

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
