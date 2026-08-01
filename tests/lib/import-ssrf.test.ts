import { describe, it, expect } from 'vitest';
import {
  assertPublicUrl,
  isPrivateAddress,
  normalizeUrl,
  safeFetch,
  MAX_RESPONSE_BYTES,
} from '@/lib/import/ssrf';
import { endlessBody, hangingFetch, lookupMap, publicLookup, stubFetch } from '../helpers/import-stubs';

/**
 * SSRF is the real risk on this branch: we fetch a user-supplied URL from our
 * own server, inside Vercel's network. These tests are the acceptance criteria
 * for MEAL-70, including the redirect case that most implementations miss.
 */
describe('import/ssrf — address classification', () => {
  it.each([
    ['10.0.0.1', '10/8'],
    ['10.255.255.255', '10/8 upper'],
    ['172.16.0.1', '172.16/12'],
    ['172.31.255.254', '172.16/12 upper'],
    ['192.168.1.1', '192.168/16'],
    ['127.0.0.1', '127/8 loopback'],
    ['127.1.2.3', '127/8 non-obvious'],
    ['169.254.169.254', '169.254/16 — cloud instance metadata'],
    ['0.0.0.0', 'unspecified'],
    ['100.64.0.1', 'carrier NAT'],
    ['::1', 'IPv6 loopback'],
    ['fc00::1', 'fc00::/7 unique local'],
    ['fd12:3456:789a::1', 'fd00::/8 unique local'],
    ['fe80::1', 'link-local'],
    ['::ffff:127.0.0.1', 'IPv4-mapped loopback'],
    ['::ffff:169.254.169.254', 'IPv4-mapped metadata'],
    ['::', 'IPv6 unspecified'],
  ])('rejects %s (%s)', (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it.each([
    ['93.184.216.34', 'public IPv4'],
    ['8.8.8.8', 'public IPv4'],
    ['172.32.0.1', 'just above 172.16/12'],
    ['172.15.255.255', 'just below 172.16/12'],
    ['2606:2800:220:1:248:1893:25c8:1946', 'public IPv6'],
  ])('allows %s (%s)', (address) => {
    expect(isPrivateAddress(address)).toBe(false);
  });
});

describe('import/ssrf — assertPublicUrl', () => {
  it('rejects non-http schemes', async () => {
    for (const url of ['file:///etc/passwd', 'gopher://x/', 'data:text/html,<b>x', 'ftp://x/']) {
      const result = await assertPublicUrl(url, publicLookup);
      expect(result?.reason).toBe('blocked-scheme');
    }
  });

  it('rejects an IP literal in a private range without resolving', async () => {
    const result = await assertPublicUrl('http://169.254.169.254/latest/meta-data/', publicLookup);
    expect(result?.reason).toBe('blocked-private-address');
    expect(result?.detail).toContain('169.254.169.254');
  });

  it('rejects localhost and .internal hostnames outright', async () => {
    for (const host of ['http://localhost:3000/', 'http://metadata.google.internal/', 'http://db.internal/']) {
      const result = await assertPublicUrl(host, publicLookup);
      expect(result?.reason).toBe('blocked-private-address');
    }
  });

  it('rejects a public hostname that resolves into a private range', async () => {
    const lookup = lookupMap({ 'evil.example.com': ['127.0.0.1'] });
    const result = await assertPublicUrl('https://evil.example.com/x', lookup);
    expect(result?.reason).toBe('blocked-private-address');
    expect(result?.detail).toContain('127.0.0.1');
  });

  it('rejects when only one of several records is private', async () => {
    const lookup = lookupMap({ 'mixed.example.com': ['93.184.216.34', '10.1.2.3'] });
    const result = await assertPublicUrl('https://mixed.example.com/x', lookup);
    expect(result?.reason).toBe('blocked-private-address');
  });

  it('allows a public hostname', async () => {
    expect(await assertPublicUrl('https://example.com/recipe', publicLookup)).toBeNull();
  });
});

describe('import/ssrf — redirects', () => {
  it('re-validates after a redirect: public URL that 302s to 127.0.0.1 is rejected', async () => {
    const { impl, calls } = stubFetch({
      'https://public.example.com/r': {
        status: 302,
        headers: { location: 'http://127.0.0.1:8080/admin' },
      },
    });
    const lookup = lookupMap({ 'public.example.com': ['93.184.216.34'] });

    const result = await safeFetch('https://public.example.com/r', { fetchImpl: impl, lookup });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('blocked-private-address');
    expect(result.detail).toContain('via redirect from');
    // The redirect target must never have been requested.
    expect(calls).toEqual(['https://public.example.com/r']);
  });

  it('re-validates a hostname redirect that resolves privately', async () => {
    const { impl, calls } = stubFetch({
      'https://public.example.com/r': { status: 301, headers: { location: 'https://intranet.example.com/' } },
    });
    const lookup = lookupMap({
      'public.example.com': ['93.184.216.34'],
      'intranet.example.com': ['10.0.0.5'],
    });

    const result = await safeFetch('https://public.example.com/r', { fetchImpl: impl, lookup });
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('follows a public redirect and records the chain', async () => {
    const { impl } = stubFetch({
      'https://a.example.com/x': { status: 301, headers: { location: '/y' } },
      'https://a.example.com/y': { body: '<html><title>Landed</title></html>' },
    });
    const result = await safeFetch('https://a.example.com/x', { fetchImpl: impl, lookup: publicLookup });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.redirects).toEqual(['https://a.example.com/x', 'https://a.example.com/y']);
  });

  it('gives up after too many redirects', async () => {
    const { impl } = stubFetch({
      'https://loop.example.com/': { status: 302, headers: { location: 'https://loop.example.com/' } },
    });
    const result = await safeFetch('https://loop.example.com/', {
      fetchImpl: impl,
      lookup: publicLookup,
      maxRedirects: 3,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('too-many-redirects');
  });
});

describe('import/ssrf — size and time caps', () => {
  it('aborts a 50 MB page without buffering it', async () => {
    const { stream, chunksProduced } = endlessBody(1024 * 1024, 50);
    const { impl } = stubFetch({ 'https://big.example.com/': { body: stream } });

    const result = await safeFetch('https://big.example.com/', { fetchImpl: impl, lookup: publicLookup });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('response-too-large');
    // Enforced during streaming: we stopped a few MB in, not after 50.
    expect(chunksProduced()).toBeLessThanOrEqual(MAX_RESPONSE_BYTES / (1024 * 1024) + 2);
  });

  it('rejects on a Content-Length over the cap before reading a byte', async () => {
    const { impl } = stubFetch({
      'https://big.example.com/': { body: 'x', headers: { 'content-length': String(50 * 1024 * 1024) } },
    });
    const result = await safeFetch('https://big.example.com/', { fetchImpl: impl, lookup: publicLookup });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('response-too-large');
  });

  it('fails cleanly inside the timeout when the server hangs', async () => {
    const result = await safeFetch('https://slow.example.com/', {
      fetchImpl: hangingFetch,
      lookup: publicLookup,
      timeoutMs: 25,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('timeout');
  });
});

describe('import/ssrf — response handling', () => {
  it('reports a bot-challenge 403 as blocked-by-site, not as page content', async () => {
    const { impl } = stubFetch({
      'https://cloudflared.example.com/recipe': {
        status: 403,
        body: '<html><title>Attention Required! | Cloudflare</title></html>',
      },
    });
    const result = await safeFetch('https://cloudflared.example.com/recipe', {
      fetchImpl: impl,
      lookup: publicLookup,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    // Distinct from every extraction failure — we never saw the page.
    expect(result.reason).toBe('blocked-by-site');
    expect(result.detail).toContain('cloudflared.example.com');
  });

  it('rejects a non-HTML content type', async () => {
    const { impl } = stubFetch({
      'https://example.com/x.pdf': { headers: { 'content-type': 'application/pdf' }, body: '%PDF' },
    });
    const result = await safeFetch('https://example.com/x.pdf', { fetchImpl: impl, lookup: publicLookup });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('unsupported-content-type');
  });
});

describe('import/ssrf — normalizeUrl', () => {
  it('is stable across the variations a creator actually pastes', () => {
    const canonical = normalizeUrl('https://cookieandkate.com/best-guacamole-recipe');
    expect(normalizeUrl('  https://cookieandkate.com/best-guacamole-recipe/  ')).toBe(canonical);
    expect(normalizeUrl('https://cookieandkate.com/best-guacamole-recipe#jump-to-recipe')).toBe(canonical);
    expect(
      normalizeUrl('https://cookieandkate.com/best-guacamole-recipe?utm_source=pinterest&utm_medium=social'),
    ).toBe(canonical);
  });

  it('sorts query parameters so ordering does not fork the cache key', () => {
    expect(normalizeUrl('https://x.example.com/p?b=2&a=1')).toBe(
      normalizeUrl('https://x.example.com/p?a=1&b=2'),
    );
  });

  it('returns null for anything that is not an http(s) URL', () => {
    for (const input of ['', 'not a url', 'file:///etc/passwd', 'javascript:alert(1)']) {
      expect(normalizeUrl(input)).toBeNull();
    }
  });
});
