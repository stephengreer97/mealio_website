import { describe, it, expect } from 'vitest';
import {
  assertPublicUrl,
  createGuardedLookup,
  isPrivateAddress,
  normalizeUrl,
  safeFetch,
  safeFetchImage,
  MAX_RESPONSE_BYTES,
  type LookupFn,
} from '@/lib/import/ssrf';
import {
  drippingBody,
  endlessBody,
  hangingFetch,
  lookupMap,
  publicLookup,
  stubFetch,
} from '../helpers/import-stubs';

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

  it('does not carry caller-supplied credentials across an origin', async () => {
    const sent: Array<Record<string, string>> = [];
    const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      sent.push({ ...(init?.headers as Record<string, string>) });
      const url = String(input);
      return url.endsWith('/track')
        ? new Response(null, { status: 302, headers: { location: 'https://cdn.other.example/signed' } })
        : new Response('1\n00:00:01,000 --> 00:00:02,000\nhello\n', { headers: { 'content-type': 'text/plain' } });
    }) as unknown as typeof fetch;

    await safeFetch('https://api.example.com/track', {
      fetchImpl: impl,
      lookup: publicLookup,
      headers: { authorization: 'Bearer ya29-creator-token' },
      accept: /text\//i,
    });

    // Redirect targets are attacker-influenced by construction, and the header
    // being carried here is a creator's OAuth token for their own channel.
    expect(sent[0].authorization).toBe('Bearer ya29-creator-token');
    expect(sent[1].authorization).toBeUndefined();
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

/**
 * Regressions from the external review. Each of these passed the original test
 * suite while the defect was live, which is the point of writing them down.
 */
describe('import/ssrf — review regressions', () => {
  it('enforces the timeout while the body is streaming, not just before headers', async () => {
    // The original hang test used a fetch that never resolved, so it only ever
    // covered the pre-headers case. A server that returns headers immediately
    // and then drips one byte every 20ms never trips the size cap and never
    // stalls a read — only a wall-clock deadline stops it.
    const { stream, bytesEmitted } = drippingBody(20);
    const { impl } = stubFetch({ 'https://drip.example.com/': { body: stream } });

    const result = await safeFetch('https://drip.example.com/', {
      fetchImpl: impl,
      lookup: publicLookup,
      timeoutMs: 150,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('timeout');
    expect(result.detail).toMatch(/body/i);
    // Measured in bytes, not wall clock. An elapsed-time bound fails on a busy
    // machine for reasons that have nothing to do with safeFetch, and it is not
    // the claim being made anyway: the stream is infinite at one byte per 20 ms,
    // so stopping after a handful of bytes IS "it ended on the deadline" — the
    // 2 MB cap is eleven hours away, and a scheduling stall makes the drip
    // slower, never faster.
    expect(bytesEmitted()).toBeLessThan(1000);
    expect(bytesEmitted()).toBeLessThan(MAX_RESPONSE_BYTES);
  });

  it('releases the body on every early return so sockets go back to the pool', async () => {
    const cancelled: string[] = [];
    const bodyFor = (name: string) =>
      new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Uint8Array(16));
        },
        cancel() {
          cancelled.push(name);
        },
      });

    const impl = (async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.endsWith('/redirect')) {
        return new Response(bodyFor('redirect'), {
          status: 302,
          headers: { location: 'https://a.example.com/final', 'content-type': 'text/html' },
        });
      }
      if (url.endsWith('/blocked')) {
        return new Response(bodyFor('blocked'), { status: 403, headers: { 'content-type': 'text/html' } });
      }
      if (url.endsWith('/pdf')) {
        return new Response(bodyFor('pdf'), { status: 200, headers: { 'content-type': 'application/pdf' } });
      }
      return new Response('<html><title>ok</title></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    }) as unknown as typeof fetch;

    await safeFetch('https://a.example.com/redirect', { fetchImpl: impl, lookup: publicLookup });
    await safeFetch('https://a.example.com/blocked', { fetchImpl: impl, lookup: publicLookup });
    await safeFetch('https://a.example.com/pdf', { fetchImpl: impl, lookup: publicLookup });

    expect(cancelled.sort()).toEqual(['blocked', 'pdf', 'redirect']);
  });

  it('gives up on a nameserver that never answers, inside the deadline', async () => {
    // The pre-flight resolution sat outside the budget entirely: the
    // AbortSignal that bounds the request is created *after* it, and
    // `dns.lookup` takes no signal, so a hostname whose authoritative
    // nameserver never replies held the fetch for the platform resolver's own
    // timeout — and once per hop. The URL is one a creator pasted.
    const silentNameserver: LookupFn = () => new Promise<string[]>(() => {});
    const startedAt = Date.now();

    const result = await safeFetch('https://blackhole.example.com/p', {
      fetchImpl: hangingFetch,
      lookup: silentNameserver,
      timeoutMs: 80,
    });
    const elapsed = Date.now() - startedAt;

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('timeout');
    expect(elapsed).toBeLessThan(2000);
  });

  it('cuts a resolution short rather than letting it overrun the deadline', async () => {
    // The bounded version of the same defect, and the everyday one: the loop
    // did re-check the clock between hops, so it could not run forever — but
    // nothing stopped a resolution already in flight, so each hop could overrun
    // by a whole resolver timeout. A 400ms lookup spent 400ms of an 80ms budget.
    const slowNameserver: LookupFn = () =>
      new Promise<string[]>((resolve) => setTimeout(() => resolve(['93.184.216.34']), 400));
    const startedAt = Date.now();

    const result = await safeFetch('https://slow-dns.example.com/p', {
      fetchImpl: hangingFetch,
      lookup: slowNameserver,
      timeoutMs: 80,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('timeout');
    expect(Date.now() - startedAt).toBeLessThan(300);
  });
});

/**
 * DNS rebinding. The pre-flight check resolves the hostname and then hands the
 * *hostname* to fetch, which resolves again — so a TTL-0 record can answer
 * publicly the first time and privately the second. The guard below runs as the
 * socket is being opened, on the addresses actually being connected to.
 */
describe('import/ssrf — connect-time address guard', () => {
  const resolveOnce = (guard: ReturnType<typeof createGuardedLookup>, hostname: string) =>
    new Promise<{ err: NodeJS.ErrnoException | null; addresses: unknown }>((resolve) => {
      guard(hostname, { all: true }, ((err: NodeJS.ErrnoException | null, addresses: unknown) =>
        resolve({ err, addresses })) as never);
    });

  it('refuses to connect when the resolver returns a private address', async () => {
    const guard = createGuardedLookup(lookupMap({ 'rebind.example.com': ['127.0.0.1'] }));
    const { err } = await resolveOnce(guard, 'rebind.example.com');
    expect(err).toBeTruthy();
    expect(err!.message).toMatch(/private or reserved/);
  });

  it('catches the second answer of a rebinding resolver', async () => {
    // Public on the pre-flight lookup, private when the socket opens.
    let call = 0;
    const flipping: LookupFn = async () => (++call === 1 ? ['93.184.216.34'] : ['169.254.169.254']);

    expect(await assertPublicUrl('https://rebind.example.com/x', flipping)).toBeNull();

    const guard = createGuardedLookup(flipping);
    const { err } = await resolveOnce(guard, 'rebind.example.com');
    expect(err).toBeTruthy();
    expect(err!.message).toContain('169.254.169.254');
  });

  it('passes the resolved addresses through when they are all public', async () => {
    const guard = createGuardedLookup(lookupMap({ 'ok.example.com': ['93.184.216.34'] }));
    const { err, addresses } = await resolveOnce(guard, 'ok.example.com');
    expect(err).toBeNull();
    expect(addresses).toEqual([{ address: '93.184.216.34', family: 4 }]);
  });

  it('refuses when one of several addresses is private', async () => {
    const guard = createGuardedLookup(lookupMap({ 'mixed.example.com': ['93.184.216.34', '10.0.0.7'] }));
    const { err } = await resolveOnce(guard, 'mixed.example.com');
    expect(err).toBeTruthy();
  });
});

describe('import/ssrf — image fetches require a declared type', () => {
  const svgWithScript = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';

  it('rejects an image response with no Content-Type at all', async () => {
    // We re-serve whatever we store from our own origin, so "no declared type"
    // cannot be treated as "probably fine" — it is the only thing separating a
    // JPEG from a script-bearing SVG.
    // A string body makes Response synthesise `text/plain`; an untyped Blob is
    // how you get a genuinely header-less response.
    const impl = (async () =>
      new Response(new Blob([svgWithScript], { type: '' }), { status: 200 })) as unknown as typeof fetch;

    const result = await safeFetchImage('https://cdn.example.com/x', {
      fetchImpl: impl,
      lookup: publicLookup,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('unsupported-content-type');
    expect(result.detail).toMatch(/no Content-Type/i);
  });

  it('rejects a declared SVG', async () => {
    const { impl } = stubFetch({
      'https://cdn.example.com/x.svg': {
        body: svgWithScript,
        headers: { 'content-type': 'image/svg+xml' },
      },
    });
    const result = await safeFetchImage('https://cdn.example.com/x.svg', {
      fetchImpl: impl,
      lookup: publicLookup,
    });
    expect(result.ok).toBe(false);
  });

  it('accepts a declared raster image and returns its bytes', async () => {
    const { impl } = stubFetch({
      'https://cdn.example.com/x.jpg': { body: 'JPEGDATA', headers: { 'content-type': 'image/jpeg' } },
    });
    const result = await safeFetchImage('https://cdn.example.com/x.jpg', {
      fetchImpl: impl,
      lookup: publicLookup,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.bytes.toString()).toBe('JPEGDATA');
  });

  it('still tolerates a page served without a Content-Type', async () => {
    const impl = (async () =>
      new Response('<html><title>ok</title></html>', { status: 200, headers: {} })) as unknown as typeof fetch;
    const result = await safeFetch('https://example.com/p', { fetchImpl: impl, lookup: publicLookup });
    expect(result.ok).toBe(true);
  });
});

describe('import/ssrf — conditional requests (MEAL-75)', () => {
  it('sends both validators and reports a 304 as not-modified', async () => {
    const seen: Array<Record<string, string>> = [];
    const impl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(init?.headers as Record<string, string>);
      return new Response(null, { status: 304 });
    }) as unknown as typeof fetch;

    const result = await safeFetch('https://chefsarah.test/feed', {
      fetchImpl: impl,
      lookup: publicLookup,
      conditional: { etag: '"v1"', lastModified: 'Tue, 14 Jan 2027 08:00:00 GMT' },
    });

    expect(seen[0]['if-none-match']).toBe('"v1"');
    expect(seen[0]['if-modified-since']).toBe('Tue, 14 Jan 2027 08:00:00 GMT');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('not-modified');
  });

  it('does not read a 304 as not-modified when nothing was asked conditionally', async () => {
    // A 304 to an unconditional request is a broken server, and calling it
    // "nothing changed" would have every existing caller silently treat a bug as
    // an unchanged page.
    const impl = (async () => new Response(null, { status: 304 })) as unknown as typeof fetch;

    const result = await safeFetch('https://chefsarah.test/feed', { fetchImpl: impl, lookup: publicLookup });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('http-error');
  });

  it('hands back the validators a 200 declared, so the next request can be conditional', async () => {
    const { impl } = stubFetch({
      'https://chefsarah.test/feed': {
        body: '<rss/>',
        headers: { etag: '"v2"', 'last-modified': 'Wed, 15 Jan 2027 08:00:00 GMT', 'cache-control': 'public, max-age=900' },
      },
    });

    const result = await safeFetch('https://chefsarah.test/feed', { fetchImpl: impl, lookup: publicLookup });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result).toMatchObject({
      etag: '"v2"',
      lastModified: 'Wed, 15 Jan 2027 08:00:00 GMT',
      cacheControl: 'public, max-age=900',
    });
  });

  it('drops the validators when a redirect leaves the origin they describe', async () => {
    // Same rule as `headers`, and for a related reason: a validator is a claim
    // about one server's copy of one resource, and replaying it at a host the
    // redirect chose is at best meaningless.
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      seen.push({ url, headers: init?.headers as Record<string, string> });
      return url.includes('chefsarah')
        ? new Response(null, { status: 302, headers: { location: 'https://cdn.example.com/feed' } })
        : new Response('<rss/>', { status: 200 });
    }) as unknown as typeof fetch;

    await safeFetch('https://chefsarah.test/feed', {
      fetchImpl: impl,
      lookup: publicLookup,
      conditional: { etag: '"v1"' },
    });

    expect(seen[0].headers['if-none-match']).toBe('"v1"');
    expect(seen[1].headers['if-none-match']).toBeUndefined();
  });

  it('does not call a 304 from off-origin not-modified, having asked that host nothing', async () => {
    // The validators are correctly dropped at the redirect — so the CDN answered
    // 304 to a request that carried no condition, which is a broken server, not
    // an unchanged feed. Read as `not-modified` it would be permanent: the
    // poller counts that as a successful poll, refreshes `last_polled_at` and
    // asks again next cycle, so a creator's feed would quietly never be read
    // again while every counter said the source was fine.
    const impl = (async (input: RequestInfo | URL) =>
      String(input).includes('chefsarah')
        ? new Response(null, { status: 302, headers: { location: 'https://cdn.example.com/feed' } })
        : new Response(null, { status: 304 })) as unknown as typeof fetch;

    const result = await safeFetch('https://chefsarah.test/feed', {
      fetchImpl: impl,
      lookup: publicLookup,
      conditional: { etag: '"v1"' },
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('http-error');
  });
});
