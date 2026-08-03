/**
 * Feed discovery for a creator's website (MEAL-81).
 *
 * A creator gives us `chefsarah.com`. To poll them we need the one URL that
 * lists what they publish. The ladder, in order:
 *
 *   1. `<link rel="alternate" type="application/rss+xml">` on the homepage —
 *      the only rung where the site has *told* us, so it outranks every guess.
 *   2. The conventional paths (`/feed` and friends). WordPress and Substack.
 *   3. `sitemap.xml` / `post-sitemap.xml`, read for `<lastmod>`.
 *   4. Nothing — ask the creator.
 *
 * Rung 3 is not padding. MEAL-69 measured JSON-LD coverage as
 * platform-determined: WordPress-with-a-recipe-plugin scored 10/10, while
 * Substack, Medium, Ghost, Wix, Blogger and hand-rolled sites scored 0 for 29.
 * Those same platforms have the least uniform feed conventions and several of
 * them publish reliable sitemaps, so the fallback covers exactly the sites where
 * the rungs above it are measured to fail.
 *
 * **Whatever is discovered is confirmed back to a human before anything is
 * stored.** Discovery is a guess made from a hostname, and a silent wrong guess
 * starts importing a stranger's recipes under a creator's name. Nothing here
 * writes to the database; it returns the feed *and* its most recent entries so
 * an operator can look at them and say yes.
 */

import { isOnSameSite } from '@/lib/creator-sources';
import {
  findFeedLinks,
  mostRecent,
  parseFeed,
  parseFeedTtlSeconds,
  parseSitemap,
  type FeedEntry,
  type FeedKind,
} from './feed';
import type { RobotsSource } from './robots';
import { safeFetch, type ConditionalValidators, type SafeFetchOptions } from './ssrf';

/** Which rung of the ladder found it. Shown to the operator — a `/feed` guess deserves more scrutiny than an advertised link. */
export type FeedDiscoveryVia = 'link-alternate' | 'well-known' | 'sitemap';

export interface DiscoveredFeed {
  url: string;
  kind: FeedKind;
  via: FeedDiscoveryVia;
  /** Most recent first. What the operator is shown to confirm the guess. */
  entries: FeedEntry[];
  /**
   * What to replay on the next conditional read, so an unchanged feed costs a
   * 304 rather than a body (MEAL-75). Null members where the server declared
   * none.
   */
  validators: ConditionalValidators;
  /**
   * The re-read interval the publisher advertises, in seconds, or null. From
   * `<ttl>` / `<sy:updatePeriod>` in the body, or `Cache-Control: max-age`.
   */
  ttlSeconds: number | null;
}

export type FeedDiscoveryResult =
  | { ok: true; feed: DiscoveredFeed }
  | {
      ok: false;
      reason:
        | 'blocked-by-robots'
        | 'blocked-by-site'
        | 'unreachable'
        | 'no-feed'
        /** Only reachable from `readFeed` with `conditional` set. Nothing has changed. */
        | 'not-modified';
      detail: string;
    };

/**
 * Conventional feed paths, tried only when the homepage advertised nothing.
 *
 * `/feed` is WordPress and Substack; `/rss` is Ghost; `/feed.xml` is the common
 * static-site-generator output. Three GETs is a fair price for the sites that
 * have a perfectly good feed and simply never linked it, and it is only ever
 * paid on sites where rung 1 came up empty.
 */
const WELL_KNOWN_FEED_PATHS = ['/feed', '/rss', '/feed.xml'];

/** Tried in order. Yoast publishes an index at `/sitemap_index.xml`. */
const SITEMAP_PATHS = ['/sitemap.xml', '/post-sitemap.xml', '/sitemap_index.xml'];

/**
 * Feeds are served under half a dozen content types and a fair number of sites
 * mislabel them as `text/html`. The body is parsed either way and a non-feed
 * body simply fails to parse, so the type check here is a cheap filter, not the
 * decision.
 */
const FEED_CONTENT_TYPES = /xml|json|text\/html|text\/plain/i;

/**
 * How many advertised `<link rel="alternate">` hrefs are followed.
 *
 * A creator's homepage is attacker-controlled from the moment they apply, and
 * every href on it becomes a server-side fetch at an address its author chose. A
 * page carrying 2,000 of them produced 2,000 sequential cross-origin requests
 * from one *Check viability* click. Real sites advertise a handful: the main
 * feed, the comments feed, occasionally one per category.
 */
const MAX_ADVERTISED_FEEDS = 5;

/**
 * Wall-clock ceiling on the whole ladder.
 *
 * The serial worst case is eight fetches, and at the fetcher's default 10s
 * timeout that is 80 seconds against the viability route's `maxDuration = 60` —
 * before any adversarial input. The function would be killed mid-ladder and the
 * operator would see a network error instead of a report naming what was tried.
 * This stops in time to say so.
 */
const DISCOVERY_BUDGET_MS = 30_000;

/** Per-fetch budget, so one slow rung cannot spend the whole ladder's. */
const DISCOVERY_TIMEOUT_MS = 8_000;

export interface DiscoverFeedOptions {
  /** robots.txt per origin. Fetched once each, however many rungs are walked. */
  robots: RobotsSource;
  fetchOptions?: SafeFetchOptions;
  /** How many entries to carry back for confirmation and probing. */
  maxEntries?: number;
  /**
   * Validators from the last read of this exact feed (MEAL-75).
   *
   * Honoured by `readFeed` only. The discovery *ladder* has nothing to be
   * conditional about — it is walking addresses it has never fetched — and a
   * `304` mid-ladder would be indistinguishable from "this rung is not a feed".
   */
  conditional?: ConditionalValidators;
}

/** The ladder's own bookkeeping, threaded through every fetch it makes. */
interface Ladder extends DiscoverFeedOptions {
  now: () => number;
  deadline: number;
}

function ladder(options: DiscoverFeedOptions): Ladder {
  const now = options.fetchOptions?.now ?? Date.now;
  return { ...options, now, deadline: now() + DISCOVERY_BUDGET_MS };
}

/** One fetched document, plus the HTTP caching metadata a re-read needs. */
interface FetchedDocument {
  ok: true;
  url: string;
  body: string;
  validators: ConditionalValidators;
  cacheControl: string | null;
}

/** A fetch that reports robots refusals separately from network failures. */
async function getDocument(
  url: string,
  options: Ladder,
  conditional?: ConditionalValidators,
): Promise<FetchedDocument | { ok: false; reason: string; detail: string }> {
  const remaining = options.deadline - options.now();
  if (remaining <= 0) {
    return { ok: false, reason: 'unreachable', detail: `Gave up looking for a feed after ${DISCOVERY_BUDGET_MS}ms.` };
  }

  const robots = (await options.robots.for(url)).check(url);
  if (!robots.allowed) return { ok: false, reason: 'blocked-by-robots', detail: robots.detail };

  const result = await safeFetch(url, {
    ...options.fetchOptions,
    accept: FEED_CONTENT_TYPES,
    expected: 'a feed, sitemap or HTML page',
    conditional,
    // After the spread: the ladder's budget is not a caller's to widen, and a
    // rung that outlives the budget has already lost the ones behind it.
    timeoutMs: Math.min(DISCOVERY_TIMEOUT_MS, remaining),
  });
  if (!result.ok) return { ok: false, reason: result.reason, detail: result.detail };
  return {
    ok: true,
    url: result.url,
    body: result.html,
    validators: { etag: result.etag, lastModified: result.lastModified },
    cacheControl: result.cacheControl,
  };
}

/**
 * `Cache-Control: max-age`, in seconds, or null.
 *
 * `no-cache`/`no-store` deliberately yield null rather than zero: the publisher
 * is saying "do not serve this from a cache", not "come back immediately", and
 * reading it as a zero-second TTL would turn a caching instruction into an
 * invitation to poll as fast as we like.
 */
function maxAgeSeconds(cacheControl: string | null): number | null {
  if (!cacheControl) return null;
  const seconds = Number(/(?:^|[\s,])max-age\s*=\s*(\d+)/i.exec(cacheControl)?.[1]);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

/**
 * The publisher's advertised interval: whatever the feed body says, else what
 * the HTTP layer says. The body wins because `<ttl>` is the author's stated
 * publishing rhythm while `max-age` is frequently a CDN default nobody chose.
 */
function advertisedTtl(document: FetchedDocument): number | null {
  return parseFeedTtlSeconds(document.body) ?? maxAgeSeconds(document.cacheControl);
}

function toFeed(document: FetchedDocument, via: FeedDiscoveryVia, maxEntries: number): DiscoveredFeed | null {
  const parsed = parseFeed(document.body, document.url);
  if (!parsed) return null;
  return {
    url: document.url,
    kind: parsed.kind,
    via,
    entries: mostRecent(parsed.entries, maxEntries),
    validators: document.validators,
    ttlSeconds: advertisedTtl(document),
  };
}

/**
 * A sitemap presented as a feed. No `<ttl>` exists in the sitemap schema, so the
 * only interval a sitemap can advertise is the HTTP one.
 */
function toSitemapFeed(document: FetchedDocument, entries: FeedEntry[], maxEntries: number): DiscoveredFeed {
  return {
    url: document.url,
    kind: 'sitemap',
    via: 'sitemap',
    entries: mostRecent(entries, maxEntries),
    validators: document.validators,
    ttlSeconds: maxAgeSeconds(document.cacheControl),
  };
}

/**
 * Walks the ladder for `siteUrl`.
 *
 * Fetches are made from the site's **origin**, not the path the creator pasted:
 * a creator commonly gives us a link to one favourite post, and the feed lives
 * at the root.
 */
export async function discoverFeed(
  siteUrl: string,
  discoverOptions: DiscoverFeedOptions,
): Promise<FeedDiscoveryResult> {
  const options = ladder(discoverOptions);
  const maxEntries = options.maxEntries ?? 10;

  let origin: string;
  try {
    origin = new URL(siteUrl).origin;
  } catch {
    return { ok: false, reason: 'unreachable', detail: `"${siteUrl}" is not a URL we can fetch.` };
  }

  // ── Rung 1: what the site advertises ──────────────────────────────────────
  const home = await getDocument(new URL('/', origin).toString(), options);
  if (!home.ok) {
    // A homepage we cannot read is the end of the road, and *which* failure it
    // was matters: a 403 is a site refusing automated readers (Medium, and
    // Cloudflare in a bad mood), which is a different conversation with the
    // creator than a site that is simply down.
    if (home.reason === 'blocked-by-robots') {
      return { ok: false, reason: 'blocked-by-robots', detail: home.detail };
    }
    if (home.reason === 'blocked-by-site') {
      return { ok: false, reason: 'blocked-by-site', detail: home.detail };
    }
    return { ok: false, reason: 'unreachable', detail: home.detail };
  }

  // Only the creator's own site, and only a few of them. `feed_url` means "where
  // this creator publishes" — an advertised href pointing anywhere else is not
  // that, whatever the page says, and following one turns a homepage into a list
  // of addresses our server will fetch on request. Filtered before the cap so a
  // wall of decoys cannot crowd out the one real feed.
  const advertised = findFeedLinks(home.body, home.url)
    .filter((href) => isOnSameSite(origin, href))
    .slice(0, MAX_ADVERTISED_FEEDS);

  for (const href of advertised) {
    const document = await getDocument(href, options);
    if (!document.ok) continue;
    const feed = toFeed(document, 'link-alternate', maxEntries);
    if (feed) return { ok: true, feed };
  }

  // ── Rung 2: the conventional paths ────────────────────────────────────────
  for (const path of WELL_KNOWN_FEED_PATHS) {
    const document = await getDocument(new URL(path, origin).toString(), options);
    if (!document.ok) continue;
    // A 200 that is not a feed is the normal WordPress answer for a site with
    // feeds disabled — it serves the 404 template with a 200. Parsing, rather
    // than trusting the status, is what tells those apart.
    const feed = toFeed(document, 'well-known', maxEntries);
    if (feed) return { ok: true, feed };
  }

  // ── Rung 3: sitemaps ──────────────────────────────────────────────────────
  for (const path of SITEMAP_PATHS) {
    const document = await getDocument(new URL(path, origin).toString(), options);
    if (!document.ok) continue;

    const sitemap = parseSitemap(document.body, document.url);
    if (!sitemap) continue;

    if (sitemap.entries.length > 0) {
      return { ok: true, feed: toSitemapFeed(document, sitemap.entries, maxEntries) };
    }

    // A sitemap index. Follow one level only — prefer a child that names posts
    // (Yoast's `post-sitemap.xml`), else the most recently modified, which
    // `parseSitemap` has already sorted to the front.
    const child = sitemap.children.find((url) => /post|article|recipe|blog/i.test(url)) ?? sitemap.children[0];
    if (!child) continue;

    const childDocument = await getDocument(child, options);
    if (!childDocument.ok) continue;
    const childSitemap = parseSitemap(childDocument.body, childDocument.url);
    if (childSitemap && childSitemap.entries.length > 0) {
      return { ok: true, feed: toSitemapFeed(childDocument, childSitemap.entries, maxEntries) };
    }
  }

  return {
    ok: false,
    reason: 'no-feed',
    detail:
      `No feed found for ${origin}. Tried the homepage's <link rel="alternate">, ` +
      `${WELL_KNOWN_FEED_PATHS.join(', ')} and ${SITEMAP_PATHS.join(', ')}. ` +
      'Ask the creator for their feed URL.',
  };
}

/**
 * Reads a feed URL an operator (or the creator) supplied, rather than guessing.
 *
 * The last rung of the ladder is "ask the creator", and this is where that
 * answer lands. Also used to re-read a `feed_url` that was confirmed earlier, so
 * a stored feed is never silently re-derived.
 */
export async function readFeed(
  feedUrl: string,
  readOptions: DiscoverFeedOptions,
): Promise<FeedDiscoveryResult> {
  const options = ladder(readOptions);
  const maxEntries = options.maxEntries ?? 10;
  const document = await getDocument(feedUrl, options, options.conditional);
  if (!document.ok) {
    const reason =
      document.reason === 'blocked-by-robots' ||
      document.reason === 'blocked-by-site' ||
      document.reason === 'not-modified'
        ? document.reason
        : 'unreachable';
    return { ok: false, reason, detail: document.detail };
  }

  const feed = toFeed(document, 'link-alternate', maxEntries);
  if (feed) return { ok: true, feed };

  const sitemap = parseSitemap(document.body, document.url);
  if (sitemap && sitemap.entries.length > 0) {
    return { ok: true, feed: toSitemapFeed(document, sitemap.entries, maxEntries) };
  }

  return {
    ok: false,
    reason: 'no-feed',
    detail: `${feedUrl} was fetched but is not a feed or a sitemap we can read.`,
  };
}
