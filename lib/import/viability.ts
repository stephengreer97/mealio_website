/**
 * The onboarding viability check (MEAL-81).
 *
 * If `primary_source` is set to TikTok for a creator whose captions are not
 * recipes, the engine produces nothing, forever, silently. Same for a Reels
 * creator who never writes the recipe out. Nobody notices, because "no imports
 * yet" and "no imports ever" look identical from the outside.
 *
 * So before a creator is committed to a source, we take their last ~10 items and
 * run each one through the gate that the poller will use anyway (MEAL-70,
 * `classifySource`). It costs pennies and it turns the reviewer's judgement call
 * into a measurement, answered before anything is promised to anyone:
 *
 *   - most pass          → set the source, enable
 *   - none on this one   → try another of their links
 *   - none anywhere      → this creator is **not importable**, and they are told
 *                          so, rather than the feature quietly doing nothing
 *
 * Only `website` can be probed today. YouTube, Instagram and TikTok need OAuth
 * connections that do not exist yet (MEAL-74 / 82 / 83), so their probes report
 * `unavailable` and name the ticket. They are deliberately *not* stubbed to
 * return "viable" — a check that cannot run must never look like a check that
 * passed, since that is the exact failure this whole ticket exists to prevent.
 */

import {
  knownUnsupportedSource,
  unsupportedSourceById,
  SOURCE_LABELS,
  type PlatformSource,
  type UnsupportedSource,
  type ViabilityOutcome,
} from '@/lib/creator-sources';
import { createStructuredCaller, type StructuredCaller } from './anthropic';
import { discoverFeed, readFeed, type DiscoveredFeed } from './feed-discovery';
import { classifySource } from './gate';
import { toSourceDocument } from './html';
import { loadRobots } from './robots';
import { safeFetch, type SafeFetchOptions } from './ssrf';
import type { FeedEntry } from './feed';
import type { GateVerdictValue } from './types';

/** How many recent items a check reads. "~10" from the ticket. */
export const VIABILITY_SAMPLE_SIZE = 10;

/**
 * Share of readable items that must pass for a source to count as viable.
 *
 * "Most pass" in the ticket. Half is the reading that fails safe: at 3-in-10 the
 * source technically works, but a creator whose feed is mostly not recipes gets
 * a poller that fires rarely, and an operator should see that number rather than
 * a green tick.
 */
export const VIABLE_PASS_RATIO = 0.5;

/** How many item pages are fetched at once. Ten serial fetches would blow the function budget. */
const FETCH_CONCURRENCY = 4;

/** Per-item fetch budget. Ten of these have to fit inside one admin request. */
const ITEM_TIMEOUT_MS = 8_000;

/**
 * Re-exported from `creator-sources` so callers of the check have one import.
 * It lives there because the admin UI needs the type and the roll-up, and this
 * module pulls in undici — a client bundle must not follow it.
 */
export type { ViabilityOutcome };

export interface ViabilityItem {
  url: string;
  title: string;
  /** `error` means the item could not be read, so it was never gated. */
  verdict: GateVerdictValue | 'error';
  /** The gate's own sentence, or the fetch failure. Stands on its own in a log. */
  reason: string;
}

export interface ViabilityReport {
  source: PlatformSource;
  outcome: ViabilityOutcome;
  /** One paragraph an operator can act on without reading the item list. */
  summary: string;
  /** Items the gate actually saw a verdict for. */
  checked: number;
  passed: number;
  items: ViabilityItem[];
  /**
   * The feed we would poll, with its most recent entries — shown so a human
   * confirms the discovery before it is stored. Never written here.
   */
  feed: { url: string; kind: DiscoveredFeed['kind']; via: DiscoveredFeed['via']; entries: FeedEntry[] } | null;
  unsupported: UnsupportedSource | null;
  costUsd: number;
}

// ── The probe seam ───────────────────────────────────────────────────────────

/** One item as a probe hands it over: already reduced to what the gate takes. */
export interface ProbedItem {
  url: string;
  title: string;
  /** Cleaned page text for a blog; description + captions for a video. */
  text: string;
  hasRecipeJsonLd: boolean;
  /** Set when the item could not be read. Such items are reported, never gated. */
  error?: string;
}

export interface ProbeContext {
  fetchOptions?: SafeFetchOptions;
  /** A feed URL an operator already confirmed. Skips discovery when present. */
  feedUrl?: string | null;
  maxItems: number;
}

export type ProbeResult =
  | { ok: true; items: ProbedItem[]; feed?: DiscoveredFeed }
  | { ok: false; detail: string; unsupportedId?: string };

/**
 * What a platform has to provide to be checkable.
 *
 * The website implementation is here; YouTube, Instagram and TikTok plug in
 * behind the same interface once their OAuth connections land. Everything above
 * this line — the gate loop, the pass ratio, the three outcomes — is written
 * against `SourceProbe` and does not change when they do.
 */
export interface SourceProbe {
  source: PlatformSource;
  probe(link: string, context: ProbeContext): Promise<ProbeResult>;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Website probe: discover (or re-read) the feed, then read the most recent
 * entries.
 *
 * robots.txt is loaded once for the origin and consulted for every URL,
 * including each item page — ten requests to a creator's own site should not
 * involve ten requests for the same robots.txt.
 */
export const websiteProbe: SourceProbe = {
  source: 'website',

  async probe(link, context) {
    let origin: string;
    try {
      origin = new URL(link).origin;
    } catch {
      return { ok: false, detail: `"${link}" is not a URL we can fetch.` };
    }

    const robots = await loadRobots(origin, context.fetchOptions);
    const discoveryOptions = {
      robots,
      fetchOptions: context.fetchOptions,
      maxEntries: context.maxItems,
    };

    // A confirmed feed is used as given. Re-deriving a feed that a human already
    // approved would make the approval meaningless.
    const discovery = context.feedUrl
      ? await readFeed(context.feedUrl, discoveryOptions)
      : await discoverFeed(link, discoveryOptions);

    if (!discovery.ok) {
      // A site that 403s our fetcher is the Medium failure mode, whether or not
      // it is on a medium.com host — worth saying so, because the operator's
      // next move is the same either way.
      return discovery.reason === 'blocked-by-site'
        ? { ok: false, detail: discovery.detail, unsupportedId: 'medium' }
        : { ok: false, detail: discovery.detail };
    }

    const entries = discovery.feed.entries.slice(0, context.maxItems);
    if (entries.length === 0) {
      return { ok: false, detail: `${discovery.feed.url} is a valid feed but lists no entries.` };
    }

    const items = await mapWithConcurrency(entries, FETCH_CONCURRENCY, async (entry): Promise<ProbedItem> => {
      const allowed = robots.check(entry.url);
      if (!allowed.allowed) {
        return { url: entry.url, title: entry.title ?? entry.url, text: '', hasRecipeJsonLd: false, error: allowed.detail };
      }

      const fetched = await safeFetch(entry.url, {
        timeoutMs: ITEM_TIMEOUT_MS,
        ...context.fetchOptions,
      });
      if (!fetched.ok) {
        return { url: entry.url, title: entry.title ?? entry.url, text: '', hasRecipeJsonLd: false, error: fetched.detail };
      }

      const document = toSourceDocument(fetched.url, fetched.html);
      return {
        url: entry.url,
        title: document.title || entry.title || entry.url,
        text: document.text,
        hasRecipeJsonLd: Boolean(document.jsonLd),
      };
    });

    return { ok: true, items, feed: discovery.feed };
  },
};

/**
 * A probe for a platform whose connection has not been built yet.
 *
 * It fails, loudly, naming the ticket. The tempting alternative — return no
 * items and let the caller decide — reads as "nothing passed", which is the one
 * thing this must never be confused with.
 */
function pendingConnectionProbe(source: PlatformSource, ticket: string): SourceProbe {
  return {
    source,
    async probe() {
      return {
        ok: false,
        detail:
          `${SOURCE_LABELS[source]} cannot be checked yet: it needs the ${SOURCE_LABELS[source]} ` +
          `account connection from ${ticket}, which is not built. Their ${SOURCE_LABELS[source]} ` +
          'link is stored and this check will work once that lands. Until then this is *not* a ' +
          'pass — do not set this as the source of truth on the strength of it.',
      };
    },
  };
}

export const SOURCE_PROBES: Record<PlatformSource, SourceProbe> = {
  website: websiteProbe,
  youtube: pendingConnectionProbe('youtube', 'MEAL-74'),
  instagram: pendingConnectionProbe('instagram', 'MEAL-82'),
  tiktok: pendingConnectionProbe('tiktok', 'MEAL-83'),
};

// ── The check ────────────────────────────────────────────────────────────────

export interface ViabilityOptions {
  /** Anthropic seam. Defaults to the real client, which needs `ANTHROPIC_API_KEY`. */
  call?: StructuredCaller;
  fetchOptions?: SafeFetchOptions;
  /** A feed URL already confirmed by an operator. Website only. */
  feedUrl?: string | null;
  maxItems?: number;
  /** Overridable probe registry, so a future platform (or a test) can slot in. */
  probes?: Record<PlatformSource, SourceProbe>;
}

function report(partial: Partial<ViabilityReport> & Pick<ViabilityReport, 'source' | 'outcome' | 'summary'>): ViabilityReport {
  return {
    checked: 0,
    passed: 0,
    items: [],
    feed: null,
    unsupported: null,
    costUsd: 0,
    ...partial,
  };
}

/**
 * Runs the check for one creator on one source. Reads only — the operator
 * commits the result themselves, including the discovered feed URL.
 */
export async function runViabilityCheck(
  source: PlatformSource,
  link: string,
  options: ViabilityOptions = {},
): Promise<ViabilityReport> {
  // ── Known-unsupported, before anything is fetched ─────────────────────────
  const unsupported = knownUnsupportedSource(link);
  if (unsupported) {
    return report({
      source,
      outcome: 'unsupported',
      summary: `${unsupported.label} is a known-unsupported source. ${unsupported.detail}`,
      unsupported,
    });
  }

  const probes = options.probes ?? SOURCE_PROBES;
  const maxItems = options.maxItems ?? VIABILITY_SAMPLE_SIZE;

  const probed = await probes[source].probe(link, {
    fetchOptions: options.fetchOptions,
    feedUrl: options.feedUrl,
    maxItems,
  });

  if (!probed.ok) {
    const matched = probed.unsupportedId ? unsupportedSourceById(probed.unsupportedId) : null;
    return report({
      source,
      outcome: matched ? 'unsupported' : 'unavailable',
      summary: matched
        ? `${probed.detail}\n\nThis is the ${matched.label} failure mode. ${matched.detail}`
        : `${SOURCE_LABELS[source]} could not be checked: ${probed.detail}`,
      unsupported: matched,
    });
  }

  // ── Gate every readable item ──────────────────────────────────────────────
  const call = options.call ?? createStructuredCaller();
  let costUsd = 0;
  const items: ViabilityItem[] = [];
  let checked = 0;
  let passed = 0;
  let unavailableVerdicts = 0;

  for (const item of probed.items) {
    if (item.error) {
      items.push({ url: item.url, title: item.title, verdict: 'error', reason: item.error });
      continue;
    }

    const result = await classifySource(
      { title: item.title, text: item.text, hasRecipeJsonLd: item.hasRecipeJsonLd },
      { call },
    );
    costUsd += result.usage?.costUsd ?? 0;

    // A classifier outage is not evidence about the creator. Counting it as a
    // failed item would report "not importable" for a working blog.
    if (result.verdict.source === 'classifier-unavailable') {
      unavailableVerdicts++;
      items.push({ url: item.url, title: item.title, verdict: 'error', reason: result.verdict.reason });
      continue;
    }

    checked++;
    if (result.verdict.verdict === 'yes') passed++;
    items.push({
      url: item.url,
      title: item.title,
      verdict: result.verdict.verdict,
      reason: result.verdict.reason,
    });
  }

  const feed = probed.feed
    ? { url: probed.feed.url, kind: probed.feed.kind, via: probed.feed.via, entries: probed.feed.entries }
    : null;
  const base = { source, checked, passed, items, feed, costUsd, unsupported: null };

  if (checked === 0) {
    return report({
      ...base,
      outcome: 'unavailable',
      summary:
        unavailableVerdicts > 0
          ? `The classifier could not be reached for any of the ${probed.items.length} items, so nothing was ` +
            'measured. This says nothing about the creator — retry once the classifier is back.'
          : `None of the ${probed.items.length} most recent items could be read, so nothing was measured. ` +
            'Check the item list for what each one returned.',
    });
  }

  const ratio = passed / checked;
  if (passed === 0) {
    return report({
      ...base,
      outcome: 'not-viable',
      summary:
        `None of the ${checked} most recent ${SOURCE_LABELS[source]} items read as a recipe. ` +
        'Try another of their links. If every link they gave us comes back like this, this creator ' +
        'is not importable — tell them so rather than onboarding them into a feature that will ' +
        'silently do nothing.',
    });
  }
  if (ratio < VIABLE_PASS_RATIO) {
    return report({
      ...base,
      outcome: 'partial',
      summary:
        `${passed} of ${checked} recent ${SOURCE_LABELS[source]} items read as a recipe. The source works, ` +
        'but most of what they publish is not a recipe, so imports will be infrequent. Check their ' +
        'other links before committing to this one.',
    });
  }

  return report({
    ...base,
    outcome: 'viable',
    summary:
      `${passed} of ${checked} recent ${SOURCE_LABELS[source]} items read as a recipe. This source is ` +
      'importable — confirm the feed below, set it as the source of truth, and turn import on.',
  });
}

