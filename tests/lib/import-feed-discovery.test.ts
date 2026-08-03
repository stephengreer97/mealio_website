import { describe, it, expect } from 'vitest';
import { discoverFeed, readFeed } from '@/lib/import/feed-discovery';
import type { RobotsRules, RobotsSource } from '@/lib/import/robots';
import { publicLookup, stubFetch, type StubRoute } from '../helpers/import-stubs';

const HOME = 'https://chefsarah.test/';

const RSS_BODY = `<rss><channel>
  <item><title>Guacamole</title><link>https://chefsarah.test/guacamole</link><pubDate>Tue, 29 Jul 2026 09:00:00 +0000</pubDate></item>
  <item><title>Soup</title><link>https://chefsarah.test/soup</link><pubDate>Mon, 21 Jul 2026 09:00:00 +0000</pubDate></item>
</channel></rss>`;

/** robots.txt that allows everything — the fail-open default. */
const allowAll: RobotsRules = { check: () => ({ allowed: true, detail: 'allowed' }) };

/** The same rules for every origin, so a test can ignore robots entirely. */
function everywhere(rules: RobotsRules): RobotsSource {
  return { for: async () => rules };
}

function options(routes: Record<string, StubRoute>, robots: RobotsRules = allowAll) {
  const { impl, calls } = stubFetch(routes);
  return { calls, options: { robots: everywhere(robots), fetchOptions: { fetchImpl: impl, lookup: publicLookup } } };
}

describe('import/feed-discovery — the ladder', () => {
  it('rung 1: takes the feed the homepage advertises', async () => {
    const { options: opts, calls } = options({
      [HOME]: { body: '<head><link rel="alternate" type="application/rss+xml" href="/feed.xml"></head>' },
      'https://chefsarah.test/feed.xml': { body: RSS_BODY, headers: { 'content-type': 'application/rss+xml' } },
    });

    const result = await discoverFeed('https://chefsarah.test/some/post', opts);
    expect(result.ok && result.feed).toMatchObject({
      url: 'https://chefsarah.test/feed.xml',
      kind: 'rss',
      via: 'link-alternate',
    });
    // Discovery starts at the origin, not at the path the creator pasted — the
    // feed lives at the root and they commonly link one favourite post.
    expect(calls[0]).toBe(HOME);
  });

  it('rung 2: falls back to the conventional paths', async () => {
    const { options: opts } = options({
      [HOME]: { body: '<html><head><title>Chef Sarah</title></head></html>' },
      'https://chefsarah.test/feed': { body: RSS_BODY },
    });

    const result = await discoverFeed('https://chefsarah.test', opts);
    expect(result.ok && result.feed.via).toBe('well-known');
    expect(result.ok && result.feed.entries).toHaveLength(2);
  });

  it('does not mistake a 200 HTML page at /feed for a feed', async () => {
    // WordPress with feeds disabled serves its 404 template with a 200 status.
    // Trusting the status here would store a feed URL that never yields a post.
    const { options: opts } = options({
      [HOME]: { body: '<html></html>' },
      'https://chefsarah.test/feed': { body: '<html><body>Nothing here</body></html>' },
      'https://chefsarah.test/sitemap.xml': {
        body: '<urlset><url><loc>https://chefsarah.test/tacos</loc><lastmod>2026-07-30</lastmod></url></urlset>',
        headers: { 'content-type': 'application/xml' },
      },
    });

    const result = await discoverFeed('https://chefsarah.test', opts);
    expect(result.ok && result.feed).toMatchObject({ via: 'sitemap', kind: 'sitemap' });
    expect(result.ok && result.feed.entries[0].url).toBe('https://chefsarah.test/tacos');
  });

  it('rung 3: follows a sitemap index one level to the post sitemap', async () => {
    const { options: opts } = options({
      [HOME]: { body: '<html></html>' },
      'https://chefsarah.test/sitemap.xml': {
        body: `<sitemapindex>
          <sitemap><loc>https://chefsarah.test/page-sitemap.xml</loc><lastmod>2025-01-01</lastmod></sitemap>
          <sitemap><loc>https://chefsarah.test/post-sitemap.xml</loc><lastmod>2026-07-30</lastmod></sitemap>
        </sitemapindex>`,
      },
      'https://chefsarah.test/post-sitemap.xml': {
        body: '<urlset><url><loc>https://chefsarah.test/tacos</loc><lastmod>2026-07-30</lastmod></url></urlset>',
      },
    });

    const result = await discoverFeed('https://chefsarah.test', opts);
    expect(result.ok && result.feed.url).toBe('https://chefsarah.test/post-sitemap.xml');
  });

  it('gives up with an explanation naming what it tried', async () => {
    const { options: opts } = options({ [HOME]: { body: '<html></html>' } });
    const result = await discoverFeed('https://chefsarah.test', opts);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe('no-feed');
    expect(!result.ok && result.detail).toMatch(/sitemap\.xml/);
    expect(!result.ok && result.detail).toMatch(/Ask the creator/i);
  });

  it('never fetches a path robots.txt disallows', async () => {
    const robots: RobotsRules = {
      check: (url) => ({ allowed: !url.includes('/feed'), detail: 'Disallowed by robots.txt' }),
    };
    const { options: opts, calls } = options(
      {
        [HOME]: { body: '<head><link rel="alternate" type="application/rss+xml" href="/feed"></head>' },
        'https://chefsarah.test/feed': { body: RSS_BODY },
        'https://chefsarah.test/sitemap.xml': {
          body: '<urlset><url><loc>https://chefsarah.test/tacos</loc></url></urlset>',
        },
      },
      robots,
    );

    const result = await discoverFeed('https://chefsarah.test', opts);
    expect(calls).not.toContain('https://chefsarah.test/feed');
    expect(result.ok && result.feed.via).toBe('sitemap');
  });

  it('reports a site that refuses server-side readers as its own failure', async () => {
    // Distinct from "we read the site and found no feed": a 403 means we never
    // saw the page, and the conversation with the creator is a different one.
    const { options: opts } = options({ [HOME]: { status: 403, body: 'forbidden' } });
    const result = await discoverFeed('https://chefsarah.test', opts);
    expect(!result.ok && result.reason).toBe('blocked-by-site');
  });

  describe('a homepage is not a list of addresses we will fetch', () => {
    it('follows no advertised feed off the creator’s own site', async () => {
      // 2,000 of these produced 2,000 sequential cross-origin fetches, at
      // attacker-chosen hosts, from one *Check viability* click. `feed_url`
      // means "where this creator publishes"; none of these are that.
      const decoys = Array.from({ length: 2_000 }, (_, i) =>
        `<link rel="alternate" type="application/rss+xml" href="https://victim-${i}.example/wp-login.php">`,
      ).join('');
      const { options: opts, calls } = options({ [HOME]: { body: `<head>${decoys}</head>` } });

      const result = await discoverFeed('https://chefsarah.test', opts);
      expect(calls.filter((url) => url.includes('victim-'))).toEqual([]);
      expect(!result.ok && result.reason).toBe('no-feed');
    });

    it('follows only a handful of advertised feeds, even on the creator’s own site', async () => {
      const many = Array.from({ length: 50 }, (_, i) =>
        `<link rel="alternate" type="application/rss+xml" href="/feed-${i}.xml">`,
      ).join('');
      const { options: opts, calls } = options({ [HOME]: { body: `<head>${many}</head>` } });

      await discoverFeed('https://chefsarah.test', opts);
      expect(calls.filter((url) => url.includes('/feed-')).length).toBeLessThanOrEqual(5);
    });

    it('still finds the one real feed buried in a wall of off-site decoys', async () => {
      // The cap is applied after the filter for exactly this reason: a wall of
      // decoys must not be able to push the genuine feed out of the window.
      const decoys = Array.from({ length: 2_000 }, (_, i) =>
        `<link rel="alternate" type="application/rss+xml" href="https://victim-${i}.example/x">`,
      ).join('');
      const { options: opts } = options({
        [HOME]: { body: `<head>${decoys}<link rel="alternate" type="application/rss+xml" href="/feed.xml"></head>` },
        'https://chefsarah.test/feed.xml': { body: RSS_BODY },
      });

      const result = await discoverFeed('https://chefsarah.test', opts);
      expect(result.ok && result.feed.url).toBe('https://chefsarah.test/feed.xml');
    });
  });

  it('refuses a private address before any request is made', async () => {
    const { options: opts, calls } = options({});
    const result = await discoverFeed('http://169.254.169.254/', opts);
    expect(!result.ok && result.reason).toBe('unreachable');
    expect(!result.ok && result.detail).toMatch(/private or reserved/i);
    expect(calls).toEqual([]);
  });
});

describe('import/feed-discovery — reading a confirmed feed', () => {
  it('reads the given URL without re-running discovery', async () => {
    const { options: opts, calls } = options({ 'https://chefsarah.test/custom.xml': { body: RSS_BODY } });
    const result = await readFeed('https://chefsarah.test/custom.xml', opts);
    expect(result.ok && result.feed.entries).toHaveLength(2);
    // One request: a feed a human confirmed is never re-derived.
    expect(calls).toEqual(['https://chefsarah.test/custom.xml']);
  });

  it('accepts a sitemap as a confirmed feed', async () => {
    const { options: opts } = options({
      'https://chefsarah.test/sitemap.xml': {
        body: '<urlset><url><loc>https://chefsarah.test/tacos</loc><lastmod>2026-07-30</lastmod></url></urlset>',
      },
    });
    const result = await readFeed('https://chefsarah.test/sitemap.xml', opts);
    expect(result.ok && result.feed.kind).toBe('sitemap');
  });

  it('says so when the confirmed URL is not a feed at all', async () => {
    const { options: opts } = options({ 'https://chefsarah.test/nope': { body: '<html></html>' } });
    const result = await readFeed('https://chefsarah.test/nope', opts);
    expect(!result.ok && result.reason).toBe('no-feed');
  });
});
