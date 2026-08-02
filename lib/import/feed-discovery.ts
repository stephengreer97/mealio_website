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

import { findFeedLinks, mostRecent, parseFeed, parseSitemap, type FeedEntry, type FeedKind } from './feed';
import type { RobotsRules } from './robots';
import { safeFetch, type SafeFetchOptions } from './ssrf';

/** Which rung of the ladder found it. Shown to the operator — a `/feed` guess deserves more scrutiny than an advertised link. */
export type FeedDiscoveryVia = 'link-alternate' | 'well-known' | 'sitemap';

export interface DiscoveredFeed {
  url: string;
  kind: FeedKind;
  via: FeedDiscoveryVia;
  /** Most recent first. What the operator is shown to confirm the guess. */
  entries: FeedEntry[];
}

export type FeedDiscoveryResult =
  | { ok: true; feed: DiscoveredFeed }
  | { ok: false; reason: 'blocked-by-robots' | 'blocked-by-site' | 'unreachable' | 'no-feed'; detail: string };

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

export interface DiscoverFeedOptions {
  /** The origin's robots.txt, already loaded — one fetch for the whole ladder. */
  robots: RobotsRules;
  fetchOptions?: SafeFetchOptions;
  /** How many entries to carry back for confirmation and probing. */
  maxEntries?: number;
}

/** A fetch that reports robots refusals separately from network failures. */
async function getDocument(
  url: string,
  options: DiscoverFeedOptions,
): Promise<{ ok: true; url: string; body: string } | { ok: false; reason: string; detail: string }> {
  const robots = options.robots.check(url);
  if (!robots.allowed) return { ok: false, reason: 'blocked-by-robots', detail: robots.detail };

  const result = await safeFetch(url, {
    ...options.fetchOptions,
    accept: FEED_CONTENT_TYPES,
    expected: 'a feed, sitemap or HTML page',
  });
  if (!result.ok) return { ok: false, reason: result.reason, detail: result.detail };
  return { ok: true, url: result.url, body: result.html };
}

function toFeed(body: string, url: string, via: FeedDiscoveryVia, maxEntries: number): DiscoveredFeed | null {
  const parsed = parseFeed(body, url);
  if (!parsed) return null;
  return { url, kind: parsed.kind, via, entries: mostRecent(parsed.entries, maxEntries) };
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
  options: DiscoverFeedOptions,
): Promise<FeedDiscoveryResult> {
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

  for (const href of findFeedLinks(home.body, home.url)) {
    const document = await getDocument(href, options);
    if (!document.ok) continue;
    const feed = toFeed(document.body, document.url, 'link-alternate', maxEntries);
    if (feed) return { ok: true, feed };
  }

  // ── Rung 2: the conventional paths ────────────────────────────────────────
  for (const path of WELL_KNOWN_FEED_PATHS) {
    const document = await getDocument(new URL(path, origin).toString(), options);
    if (!document.ok) continue;
    // A 200 that is not a feed is the normal WordPress answer for a site with
    // feeds disabled — it serves the 404 template with a 200. Parsing, rather
    // than trusting the status, is what tells those apart.
    const feed = toFeed(document.body, document.url, 'well-known', maxEntries);
    if (feed) return { ok: true, feed };
  }

  // ── Rung 3: sitemaps ──────────────────────────────────────────────────────
  for (const path of SITEMAP_PATHS) {
    const document = await getDocument(new URL(path, origin).toString(), options);
    if (!document.ok) continue;

    const sitemap = parseSitemap(document.body, document.url);
    if (!sitemap) continue;

    if (sitemap.entries.length > 0) {
      return {
        ok: true,
        feed: {
          url: document.url,
          kind: 'sitemap',
          via: 'sitemap',
          entries: mostRecent(sitemap.entries, maxEntries),
        },
      };
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
      return {
        ok: true,
        feed: {
          url: childDocument.url,
          kind: 'sitemap',
          via: 'sitemap',
          entries: mostRecent(childSitemap.entries, maxEntries),
        },
      };
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
  options: DiscoverFeedOptions,
): Promise<FeedDiscoveryResult> {
  const maxEntries = options.maxEntries ?? 10;
  const document = await getDocument(feedUrl, options);
  if (!document.ok) {
    const reason =
      document.reason === 'blocked-by-robots' || document.reason === 'blocked-by-site'
        ? document.reason
        : 'unreachable';
    return { ok: false, reason, detail: document.detail };
  }

  const feed = toFeed(document.body, document.url, 'link-alternate', maxEntries);
  if (feed) return { ok: true, feed };

  const sitemap = parseSitemap(document.body, document.url);
  if (sitemap && sitemap.entries.length > 0) {
    return {
      ok: true,
      feed: {
        url: document.url,
        kind: 'sitemap',
        via: 'sitemap',
        entries: mostRecent(sitemap.entries, maxEntries),
      },
    };
  }

  return {
    ok: false,
    reason: 'no-feed',
    detail: `${feedUrl} was fetched but is not a feed or a sitemap we can read.`,
  };
}
