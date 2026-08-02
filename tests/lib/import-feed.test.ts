import { describe, it, expect } from 'vitest';
import { findFeedLinks, mostRecent, parseFeed, parseSitemap } from '@/lib/import/feed';

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
