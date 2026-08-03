/**
 * Feed and sitemap parsing (MEAL-81).
 *
 * The only question these parsers answer is **"what has this site published
 * recently, and at what URLs?"** — not what any of it says. Bodies are never
 * read here; the viability probe and the poller fetch the entries themselves.
 * That is what makes the sitemap rung worth having: `<lastmod>` spots new URLs
 * without downloading a single page.
 *
 * Regex rather than an XML parser, matching `html-text.ts`: the repository has
 * no XML dependency, feeds in the wild are frequently not well-formed anyway,
 * and a parser that throws on one bad character is worse here than one that
 * skips it.
 */

import { decodeEntities } from './html-text';

export type FeedKind = 'rss' | 'atom' | 'sitemap';

export interface FeedEntry {
  /** Feed guid / Atom id, falling back to the URL. Stable per platform. */
  id: string;
  url: string;
  title: string | null;
  /** ISO 8601, or null when the feed gave no usable date. */
  publishedAt: string | null;
}

/**
 * Ceiling on entries *kept* from one document. A blog sitemap can list every post
 * it has ever published; we only ever want the most recent handful.
 */
const MAX_PARSED_ENTRIES = 500;

/**
 * Ceiling on entries *scanned* before the newest are chosen. These differ for a
 * reason: WordPress emits post sitemaps oldest-first, so truncating the scan in
 * document order and sorting afterwards discarded exactly the rows the probe and
 * the poller exist to see — the probe measured a creator's oldest posts and the
 * poller would never have found anything new.
 */
const MAX_SCANNED_BLOCKS = 5_000;

/** A start tag's attribute run, and one element's content. Both generous. */
const MAX_ATTRS_CHARS = 4_000;
const MAX_BLOCK_CHARS = 500_000;

/**
 * Element scanning without a backtracking quantifier.
 *
 * The regex this replaces — `<item\b[^>]*>([\s\S]*?)</item\s*>` — expands its
 * lazy span to end-of-input from *every* start position when the closing tag
 * never arrives: 36 ms at 64 KB, 9 s at 1 MB, 39 s at 2 MB, and 392 s on a body
 * with no `>` in it at all. That is synchronous CPU on a single-threaded
 * runtime, so it stalls the whole function instance rather than one request, and
 * one viability check walks a ladder with seven parse opportunities.
 *
 * Bounding the quantifiers is not enough at this size — the engine still retries
 * from every one of ~350k positions. So the open tag is found by a pattern that
 * cannot backtrack (no quantifier spans content), and both `>` and the closing
 * tag are located by forward search from there. Every character is visited a
 * constant number of times.
 *
 * The two early `return`s are what make the pathological cases linear: if there
 * is no `>` after this position, or no closing tag after it, neither exists for
 * any later start position either.
 */
function eachElement(
  body: string,
  lower: string,
  name: string,
  onElement: (inner: string, attrs: string) => boolean,
): void {
  // The haystack is lowercased, so the needle must be too — callers pass names
  // as they appear in the spec (`pubDate`, `lastmod`), not as they appear here.
  const lowerName = name.toLowerCase();
  const open = new RegExp(`<(?:[a-z0-9-]+:)?${lowerName}\\b`, 'g');
  const close = new RegExp(`</(?:[a-z0-9-]+:)?${lowerName}\\s*>`, 'g');

  let match: RegExpExecArray | null;
  while ((match = open.exec(lower)) !== null) {
    const attrsFrom = match.index + match[0].length;
    const gt = lower.indexOf('>', attrsFrom);
    if (gt === -1) return;
    if (gt - attrsFrom > MAX_ATTRS_CHARS) {
      open.lastIndex = attrsFrom;
      continue;
    }

    close.lastIndex = gt + 1;
    const closing = close.exec(lower);
    if (!closing) return;
    if (closing.index - gt > MAX_BLOCK_CHARS) {
      open.lastIndex = gt + 1;
      continue;
    }

    if (!onElement(body.slice(gt + 1, closing.index), body.slice(attrsFrom, gt))) return;
    open.lastIndex = closing.index + closing[0].length;
  }
}

function tag(block: string, name: string): string | null {
  let inner: string | null = null;
  eachElement(block, block.toLowerCase(), name, (content) => {
    inner = content;
    return false; // first hit wins, matching the non-global exec this replaces
  });
  if (inner === null) return null;

  const value = (inner as string).replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1');
  const text = decodeEntities(value).replace(/\s+/g, ' ').trim();
  return text || null;
}

function blocks(body: string, name: string, limit = MAX_PARSED_ENTRIES): string[] {
  const out: string[] = [];
  eachElement(body, body.toLowerCase(), name, (inner) => {
    out.push(inner);
    return out.length < limit;
  });
  return out;
}

/**
 * Reads the attributes of every `<name …>` start tag, including empty elements.
 * Same linear discipline as `eachElement`, for the tags that have no content.
 */
function eachStartTag(body: string, name: string, onTag: (attrs: string) => void): void {
  const lower = body.toLowerCase();
  const open = new RegExp(`<(?:[a-z0-9-]+:)?${name.toLowerCase()}\\b`, 'g');

  let match: RegExpExecArray | null;
  while ((match = open.exec(lower)) !== null) {
    const attrsFrom = match.index + match[0].length;
    const gt = lower.indexOf('>', attrsFrom);
    if (gt === -1) return;
    if (gt - attrsFrom <= MAX_ATTRS_CHARS) onTag(body.slice(attrsFrom, gt));
    open.lastIndex = gt + 1;
  }
}

/** Resolves a possibly-relative feed href against the document it came from. */
function absolute(href: string | null, baseUrl: string): string | null {
  if (!href) return null;
  try {
    const url = new URL(href, baseUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.username = '';
    url.password = '';
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

/** Normalises a feed date to ISO. RFC 822 (RSS) and ISO 8601 (Atom) both land here. */
function toIso(value: string | null): string | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

/**
 * Atom's `<link>` is an empty element carrying `rel` and `href`, and an entry
 * commonly has several — `alternate` is the human-readable post, `replies` and
 * `enclosure` are not. RSS's `<link>` is a text node instead, handled by `tag`.
 */
function atomLink(block: string, baseUrl: string): string | null {
  const links: string[] = [];
  eachStartTag(block, 'link', (attrs) => links.push(attrs.replace(/\/$/, '')));
  const href = (attrs: string) => /\bhref\s*=\s*["']?([^"'\s>]+)/i.exec(attrs)?.[1] ?? null;
  const rel = (attrs: string) => /\brel\s*=\s*["']?([^"'\s>]+)/i.exec(attrs)?.[1]?.toLowerCase() ?? null;

  const alternate = links.find((attrs) => rel(attrs) === 'alternate' || rel(attrs) === null);
  return absolute(alternate ? href(alternate) : null, baseUrl);
}

export interface ParsedFeed {
  kind: FeedKind;
  entries: FeedEntry[];
}

/**
 * Parses an RSS or Atom document. Returns null when the body is neither — which
 * is how the discovery ladder tells "this site has no feed at /feed" from "this
 * site returned its 404 page with a 200 status", a very common WordPress-adjacent
 * behaviour.
 */
export function parseFeed(body: string, baseUrl: string): ParsedFeed | null {
  // No `[^>]*>` on the atom probe: on a body with no `>` in it that scans to
  // end-of-input from every `<feed` position, and the name alone identifies it.
  const isAtom = /<(?:\w+:)?feed\b/i.test(body) && /<(?:\w+:)?entry\b/i.test(body);
  const isRss = /<(?:\w+:)?rss\b|<(?:\w+:)?channel\b/i.test(body) && /<(?:\w+:)?item\b/i.test(body);
  if (!isAtom && !isRss) return null;

  const kind: FeedKind = isAtom ? 'atom' : 'rss';
  const entries: FeedEntry[] = [];

  for (const block of blocks(body, isAtom ? 'entry' : 'item')) {
    const url = isAtom ? atomLink(block, baseUrl) : absolute(tag(block, 'link'), baseUrl);
    if (!url) continue; // An entry with no link is not something we can fetch.
    entries.push({
      id: tag(block, isAtom ? 'id' : 'guid') ?? url,
      url,
      title: tag(block, 'title'),
      publishedAt: toIso(
        isAtom ? (tag(block, 'published') ?? tag(block, 'updated')) : (tag(block, 'pubDate') ?? tag(block, 'date')),
      ),
    });
  }

  return entries.length > 0 ? { kind, entries } : null;
}

/**
 * How often the publisher says they want to be re-read, in seconds, or null.
 *
 * Two spellings, both common enough to be worth reading (MEAL-75):
 *
 *   `<ttl>`                RSS 2.0, in **minutes**.
 *   `<sy:updatePeriod>`    the syndication module, a word plus an optional
 *   `<sy:updateFrequency>` count of times per period. WordPress emits it on
 *                          every feed it serves, so it is the one most of our
 *                          creators will actually have.
 *
 * Honouring this is not merely polite. It is the interval the publisher asked
 * for, in writing, on their own feed — which makes it the strongest available
 * defence of our cadence if anyone ever asks why we are hitting their site.
 *
 * Read from the channel, not from an entry: `tag` takes the first match in
 * document order and both elements are channel-level in every real feed.
 */
export function parseFeedTtlSeconds(body: string): number | null {
  const minutes = Number(tag(body, 'ttl'));
  if (Number.isFinite(minutes) && minutes > 0) return Math.round(minutes * 60);

  const period = tag(body, 'updatePeriod')?.toLowerCase();
  const seconds = period ? UPDATE_PERIOD_SECONDS[period] : undefined;
  if (!seconds) return null;

  // "twice hourly" is `hourly` with a frequency of 2 — a divisor, not a
  // multiplier. Absent, zero or nonsense means once per period.
  const frequency = Number(tag(body, 'updateFrequency'));
  const divisor = Number.isFinite(frequency) && frequency > 0 ? frequency : 1;
  return Math.max(1, Math.round(seconds / divisor));
}

const UPDATE_PERIOD_SECONDS: Record<string, number> = {
  hourly: 3_600,
  daily: 86_400,
  weekly: 604_800,
  monthly: 2_592_000,
  yearly: 31_536_000,
};

export interface ParsedSitemap {
  entries: FeedEntry[];
  /** Child sitemaps from a `<sitemapindex>`, most recently modified first. */
  children: string[];
}

/**
 * Parses a sitemap or a sitemap index.
 *
 * This rung exists because MEAL-69 measured JSON-LD coverage as
 * platform-determined — WordPress-with-a-recipe-plugin scored 10/10 while
 * Substack, Ghost, Wix, Blogger and hand-rolled sites scored 0 for 29 — and
 * those same platforms have the least uniform feed conventions. Several of them
 * publish a reliable sitemap, so the fallback fills the gap exactly where the
 * primary route has already been measured to fail.
 */
export function parseSitemap(body: string, baseUrl: string): ParsedSitemap | null {
  const isIndex = /<sitemapindex\b/i.test(body);
  const isUrlset = /<urlset\b/i.test(body);
  if (!isIndex && !isUrlset) return null;

  // Scanned wide, kept narrow. Sorting only what survived a document-order
  // truncation is how the newest posts got thrown away on an oldest-first
  // sitemap — the cap has to come after the sort, not before it.
  const rows = blocks(body, isIndex ? 'sitemap' : 'url', MAX_SCANNED_BLOCKS)
    .map((block) => ({
      url: absolute(tag(block, 'loc'), baseUrl),
      lastmod: toIso(tag(block, 'lastmod')),
    }))
    .filter((row): row is { url: string; lastmod: string | null } => row.url !== null);

  // Undated rows sort last rather than first: a sitemap that dates some entries
  // and not others must not surface the undated ones as "most recent".
  rows.sort((a, b) => (b.lastmod ?? '').localeCompare(a.lastmod ?? ''));
  rows.splice(MAX_PARSED_ENTRIES);

  if (isIndex) {
    return { entries: [], children: rows.map((row) => row.url) };
  }

  return {
    entries: rows.map((row) => ({
      id: row.url,
      url: row.url,
      // A sitemap carries no titles. The probe fetches each page anyway, and the
      // page's own `<title>` is the one worth showing.
      title: null,
      publishedAt: row.lastmod,
    })),
    children: [],
  };
}

/** Most recent first, undated entries last, capped at `limit`. */
export function mostRecent(entries: FeedEntry[], limit: number): FeedEntry[] {
  // A stable sort keeps feed order for entries that share a date (or have
  // none) — feeds are usually already newest-first, so that is the best guess
  // available when the dates cannot decide.
  return [...entries]
    .sort((a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? ''))
    .slice(0, limit);
}

/**
 * Finds a feed advertised by `<link rel="alternate">` in a page's head.
 *
 * Rung one of the discovery ladder, and the only rung the site itself has
 * explicitly told us about — so a hit here is worth more than any guess below it.
 */
export function findFeedLinks(html: string, baseUrl: string): string[] {
  const found: string[] = [];
  eachStartTag(html, 'link', (attrs) => {
    const rel = /\brel\s*=\s*["']?([^"'>]+)/i.exec(attrs)?.[1]?.toLowerCase() ?? '';
    if (!rel.split(/\s+/).includes('alternate')) return;
    const type = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs)?.[1]?.toLowerCase() ?? '';
    if (!/^application\/(rss\+xml|atom\+xml)$/.test(type)) return;
    const href = absolute(/\bhref\s*=\s*["']([^"']+)["']|\bhref\s*=\s*([^"'\s>]+)/i.exec(attrs)?.slice(1).find(Boolean) ?? null, baseUrl);
    if (href && !found.includes(href)) found.push(href);
  });
  return found;
}
