import { describe, it, expect } from 'vitest';
import { findFeedLinks, mostRecent, parseFeed, parseFeedTtlSeconds, parseSitemap } from '@/lib/import/feed';

const RSS = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <title>Chef Sarah</title>
  <item>
    <title><![CDATA[Best Guacamole]]></title>
    <link>https://chefsarah.test/guacamole</link>
    <guid isPermaLink="false">post-9</guid>
    <pubDate>Tue, 29 Jul 2026 09:00:00 +0000</pubDate>
  </item>
  <item>
    <title>Kitchen tour &amp; haul</title>
    <link>/kitchen-tour</link>
    <pubDate>Mon, 21 Jul 2026 09:00:00 +0000</pubDate>
  </item>
</channel></rss>`;

const ATOM = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>Black Bean Soup</title>
    <link rel="edit" href="https://chefsarah.test/edit/1"/>
    <link rel="alternate" href="https://chefsarah.test/soup"/>
    <id>tag:chefsarah.test,2026:1</id>
    <published>2026-07-30T10:00:00Z</published>
  </entry>
</feed>`;

describe('import/feed — RSS and Atom', () => {
  it('reads RSS items, CDATA titles, entities and relative links', () => {
    const parsed = parseFeed(RSS, 'https://chefsarah.test/feed')!;
    expect(parsed.kind).toBe('rss');
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.entries[0]).toMatchObject({
      id: 'post-9',
      url: 'https://chefsarah.test/guacamole',
      title: 'Best Guacamole',
    });
    expect(parsed.entries[0].publishedAt).toBe('2026-07-29T09:00:00.000Z');
    // Relative <link> resolved against the feed it came from.
    expect(parsed.entries[1].url).toBe('https://chefsarah.test/kitchen-tour');
    expect(parsed.entries[1].title).toBe('Kitchen tour & haul');
    // No guid — the URL is the identity.
    expect(parsed.entries[1].id).toBe('https://chefsarah.test/kitchen-tour');
  });

  it('reads Atom and takes the alternate link, not the first one', () => {
    // An Atom entry commonly carries edit/replies/enclosure links too; only
    // `alternate` is the post a human would read.
    const parsed = parseFeed(ATOM, 'https://chefsarah.test/atom.xml')!;
    expect(parsed.kind).toBe('atom');
    expect(parsed.entries[0].url).toBe('https://chefsarah.test/soup');
    expect(parsed.entries[0].id).toBe('tag:chefsarah.test,2026:1');
  });

  it('returns null for a body that is not a feed', () => {
    // The load-bearing case: WordPress serves its 404 template with a 200
    // status at /feed when feeds are off. Parsing, not the status code, is what
    // tells "no feed here" from "feed found".
    expect(parseFeed('<html><body><h1>Not found</h1></body></html>', 'https://x.test/feed')).toBeNull();
    expect(parseFeed('', 'https://x.test/feed')).toBeNull();
  });

  it('skips entries with no fetchable link rather than failing the feed', () => {
    const feed = '<rss><channel><item><title>No link</title></item><item><title>Ok</title><link>https://x.test/a</link></item></channel></rss>';
    expect(parseFeed(feed, 'https://x.test/feed')!.entries).toHaveLength(1);
  });

  it('ignores a javascript: link', () => {
    const feed = '<rss><channel><item><link>javascript:alert(1)</link></item></channel></rss>';
    expect(parseFeed(feed, 'https://x.test/feed')).toBeNull();
  });
});

describe('import/feed — sitemaps', () => {
  const SITEMAP = `<?xml version="1.0"?>
  <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
    <url><loc>https://chefsarah.test/old</loc><lastmod>2024-01-01</lastmod></url>
    <url><loc>https://chefsarah.test/new</loc><lastmod>2026-07-30T10:00:00+00:00</lastmod></url>
    <url><loc>https://chefsarah.test/undated</loc></url>
  </urlset>`;

  it('sorts by lastmod, newest first, undated last', () => {
    // Undated rows must not float to the top: a sitemap that dates some entries
    // and not others would otherwise report its oldest pages as newest.
    const parsed = parseSitemap(SITEMAP, 'https://chefsarah.test/sitemap.xml')!;
    expect(parsed.entries.map((e) => e.url)).toEqual([
      'https://chefsarah.test/new',
      'https://chefsarah.test/old',
      'https://chefsarah.test/undated',
    ]);
    expect(parsed.children).toEqual([]);
  });

  it('reads a sitemap index as children, not entries', () => {
    const index = `<sitemapindex>
      <sitemap><loc>https://chefsarah.test/page-sitemap.xml</loc><lastmod>2025-01-01</lastmod></sitemap>
      <sitemap><loc>https://chefsarah.test/post-sitemap.xml</loc><lastmod>2026-07-30</lastmod></sitemap>
    </sitemapindex>`;
    const parsed = parseSitemap(index, 'https://chefsarah.test/sitemap.xml')!;
    expect(parsed.entries).toEqual([]);
    expect(parsed.children[0]).toBe('https://chefsarah.test/post-sitemap.xml');
  });

  it('returns null for anything that is not a sitemap', () => {
    expect(parseSitemap('<html></html>', 'https://x.test/sitemap.xml')).toBeNull();
  });

  it('keeps the newest rows of an oldest-first sitemap, not the first ones it read', () => {
    // WordPress emits post sitemaps oldest-first. Capping the scan in document
    // order and sorting afterwards discarded exactly the entries the probe and
    // the poller exist to see, so the probe measured a creator's oldest posts
    // and the poller would never have found anything new.
    const rows = Array.from({ length: 600 }, (_, i) =>
      `<url><loc>https://x.test/post-${i}</loc><lastmod>${new Date(Date.UTC(2020, 0, 1) + i * 86_400_000).toISOString()}</lastmod></url>`,
    ).join('');

    const parsed = parseSitemap(`<urlset>${rows}</urlset>`, 'https://x.test/sitemap.xml')!;
    expect(parsed.entries[0].url).toBe('https://x.test/post-599');
    expect(mostRecent(parsed.entries, 3).map((e) => e.url)).toEqual([
      'https://x.test/post-599',
      'https://x.test/post-598',
      'https://x.test/post-597',
    ]);
  });
});

describe('import/feed — a body that is trying to hurt us', () => {
  /**
   * The regression this file did not have.
   *
   * `<item\b[^>]*>([\s\S]*?)</item\s*>` over a body whose closing tag never
   * arrives expands the lazy span to end-of-input from every start position:
   * 36 ms at 64 KB, 596 ms at 256 KB, 9 s at 1 MB, 39 s at 2 MB. That is
   * synchronous CPU on a single-threaded runtime — the whole function instance,
   * not just the request — and one *Check viability* click walks a ladder with
   * seven parse opportunities. The fetcher's 2 MB cap is a network budget and
   * bounds none of it.
   *
   * The bound below is deliberately loose. It is not a benchmark; it is the line
   * between linear and quadratic, and a fifth occurrence of this bug lands
   * several orders of magnitude the wrong side of it.
   */
  const BUDGET_MS = 2_000;

  it.each([
    ['an RSS body of 175k unclosed <item> tags', '<rss><channel>' + '<item x="1">'.repeat(175_000)],
    ['a sitemap of 190k unclosed <url> tags', '<urlset>' + '<url a="1">'.repeat(190_000)],
    ['350k unterminated tags — no ">" anywhere', '<rss><channel><item>' + '<link '.repeat(350_000)],
  ])('parses %s without blocking the event loop', (_label, body) => {
    const started = Date.now();
    // Both parsers run over the same body in `readFeed`, so both are timed.
    parseFeed(body, 'https://x.test/feed');
    parseSitemap(body, 'https://x.test/sitemap.xml');
    findFeedLinks(body, 'https://x.test/');
    expect(Date.now() - started).toBeLessThan(BUDGET_MS);
  });
});

describe('import/feed — helpers', () => {
  it('finds an advertised feed link, quoted or not, and ignores other alternates', () => {
    const html = `<head>
      <link rel="alternate" type="application/rss+xml" href="/feed" title="RSS">
      <link rel=alternate type=application/atom+xml href=https://chefsarah.test/atom.xml>
      <link rel="alternate" hreflang="fr" href="/fr/">
      <link rel="stylesheet" href="/x.css">
    </head>`;
    expect(findFeedLinks(html, 'https://chefsarah.test/')).toEqual([
      'https://chefsarah.test/feed',
      'https://chefsarah.test/atom.xml',
    ]);
  });

  it('takes the most recent N, undated last', () => {
    const entries = [
      { id: '1', url: 'a', title: null, publishedAt: null },
      { id: '2', url: 'b', title: null, publishedAt: '2026-01-01T00:00:00.000Z' },
      { id: '3', url: 'c', title: null, publishedAt: '2026-06-01T00:00:00.000Z' },
    ];
    expect(mostRecent(entries, 2).map((e) => e.id)).toEqual(['3', '2']);
  });
});

describe('import/feed — the interval a publisher advertises (MEAL-75)', () => {
  const channel = (inner: string) => `<rss><channel>${inner}<item><link>https://x.test/a</link></item></channel></rss>`;

  it('reads <ttl> as minutes', () => {
    expect(parseFeedTtlSeconds(channel('<ttl>60</ttl>'))).toBe(3600);
  });

  it('reads the syndication module WordPress emits on every feed it serves', () => {
    expect(parseFeedTtlSeconds(channel('<sy:updatePeriod>hourly</sy:updatePeriod>'))).toBe(3600);
    expect(parseFeedTtlSeconds(channel('<sy:updatePeriod>daily</sy:updatePeriod>'))).toBe(86_400);
  });

  it('treats updateFrequency as a divisor — "twice hourly" is every 30 minutes', () => {
    const body = channel('<sy:updatePeriod>hourly</sy:updatePeriod><sy:updateFrequency>2</sy:updateFrequency>');
    expect(parseFeedTtlSeconds(body)).toBe(1800);
  });

  it('prefers <ttl> when a feed carries both, and says nothing when it carries neither', () => {
    expect(parseFeedTtlSeconds(channel('<ttl>5</ttl><sy:updatePeriod>weekly</sy:updatePeriod>'))).toBe(300);
    expect(parseFeedTtlSeconds(channel(''))).toBeNull();
    // Not zero: a nonsense value is a value we cannot honour, and reading it as
    // "no delay" would turn a malformed feed into permission to poll flat out.
    expect(parseFeedTtlSeconds(channel('<ttl>soon</ttl>'))).toBeNull();
  });
});
