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
 * Ceiling on entries taken from one document. A blog sitemap can list every post
 * it has ever published; we only ever want the most recent handful, and parsing
 * 40,000 `<url>` blocks to throw away 39,990 is wasted work on a 2 MB body.
 */
const MAX_PARSED_ENTRIES = 500;

function tag(block: string, name: string): string | null {
  const match = new RegExp(`<(?:\\w+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:\\w+:)?${name}\\s*>`, 'i').exec(block);
  if (!match) return null;
  const value = match[1].replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1');
  const text = decodeEntities(value).replace(/\s+/g, ' ').trim();
  return text || null;
}

function blocks(body: string, name: string): string[] {
  const pattern = new RegExp(`<(?:\\w+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:\\w+:)?${name}\\s*>`, 'gi');
  const out: string[] = [];
  for (const match of body.matchAll(pattern)) {
    out.push(match[1]);
    if (out.length >= MAX_PARSED_ENTRIES) break;
  }
  return out;
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
  const links = [...block.matchAll(/<(?:\w+:)?link\b([^>]*)\/?>/gi)].map((m) => m[1]);
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
  const isAtom = /<(?:\w+:)?feed\b[^>]*>/i.test(body) && /<(?:\w+:)?entry\b/i.test(body);
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

  const rows = blocks(body, isIndex ? 'sitemap' : 'url')
    .map((block) => ({
      url: absolute(tag(block, 'loc'), baseUrl),
      lastmod: toIso(tag(block, 'lastmod')),
    }))
    .filter((row): row is { url: string; lastmod: string | null } => row.url !== null);

  // Undated rows sort last rather than first: a sitemap that dates some entries
  // and not others must not surface the undated ones as "most recent".
  rows.sort((a, b) => (b.lastmod ?? '').localeCompare(a.lastmod ?? ''));

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
  for (const match of html.matchAll(/<link\b([^>]*)>/gi)) {
    const attrs = match[1];
    const rel = /\brel\s*=\s*["']?([^"'>]+)/i.exec(attrs)?.[1]?.toLowerCase() ?? '';
    if (!rel.split(/\s+/).includes('alternate')) continue;
    const type = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs)?.[1]?.toLowerCase() ?? '';
    if (!/^application\/(rss\+xml|atom\+xml)$/.test(type)) continue;
    const href = absolute(/\bhref\s*=\s*["']([^"']+)["']|\bhref\s*=\s*([^"'\s>]+)/i.exec(attrs)?.slice(1).find(Boolean) ?? null, baseUrl);
    if (href && !found.includes(href)) found.push(href);
  }
  return found;
}
