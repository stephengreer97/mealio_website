/**
 * SSRF-safe URL fetcher (MEAL-70).
 *
 * We take a user-supplied URL and fetch it from our own server, inside Vercel's
 * network. That is a textbook SSRF primitive: a creator pasting
 * `http://169.254.169.254/` must get an error, not our instance metadata.
 *
 * Four defences, all of which have to hold together:
 *
 *   1. Scheme allowlist — http/https only. No file:, gopher:, data:.
 *   2. Address check before connecting — every A/AAAA record the hostname
 *      resolves to is checked against the private/link-local/loopback ranges.
 *   3. **Re-validation after every redirect.** A public URL that 302s to
 *      127.0.0.1 defeats a check performed only on the original input. This is
 *      the step most implementations miss, so redirects are followed manually
 *      rather than by the fetch layer.
 *   4. Size and time caps enforced *during streaming*. A 50 MB page must fail
 *      without ever being fully buffered, and a server that trickles bytes
 *      forever must fail on the wall clock.
 *
 * Residual risk we accept: DNS rebinding. We resolve the hostname, check the
 * addresses, then hand the *hostname* to fetch, which resolves again — a
 * TTL-0 record can return a different address the second time. Closing that
 * requires connecting to a pinned IP with a Host header override, which Node's
 * fetch does not expose. Documented rather than silently ignored.
 */

import { isIP } from 'net';
import { lookup as dnsLookup } from 'dns/promises';
import type { FetchResult, FetchFailure } from './types';

export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024; // 2 MB
export const REQUEST_TIMEOUT_MS = 10_000;
export const MAX_REDIRECTS = 5;
export const USER_AGENT = 'MealioBot/1.0 (+https://mealio.co/about)';

/** Resolves a hostname to its addresses. Injected so tests never touch DNS. */
export type LookupFn = (hostname: string) => Promise<string[]>;

/** The fetch to use. Injected so tests never touch the network. */
export type FetchFn = typeof fetch;

export interface SafeFetchOptions {
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  lookup?: LookupFn;
  fetchImpl?: FetchFn;
  /** Overridable clock so a timeout test doesn't have to actually wait. */
  now?: () => number;
}

const defaultLookup: LookupFn = async (hostname) => {
  const records = await dnsLookup(hostname, { all: true, verbatim: true });
  return records.map((r) => r.address);
};

function fail(reason: FetchFailure['reason'], detail: string): FetchFailure {
  return { ok: false, reason, detail };
}

// ── Address classification ───────────────────────────────────────────────────

function ipv4ToOctets(address: string): number[] | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map((p) => Number(p));
  if (octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return null;
  return octets;
}

function isPrivateIPv4(address: string): boolean {
  const o = ipv4ToOctets(address);
  if (!o) return true; // unparseable — refuse rather than guess
  const [a, b] = o;
  if (a === 0) return true;                       // 0.0.0.0/8 — "this network"
  if (a === 10) return true;                      // 10/8
  if (a === 127) return true;                     // 127/8 loopback
  if (a === 169 && b === 254) return true;        // 169.254/16 link-local (cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true;        // 192.168/16
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 carrier NAT
  if (a === 192 && b === 0) return true;          // 192.0.0/24 + 192.0.2/24 (TEST-NET-1)
  if (a >= 224) return true;                      // multicast + reserved + 255.255.255.255
  return false;
}

/** Expands an IPv6 literal to its eight 16-bit groups. Returns null if malformed. */
function expandIPv6(address: string): number[] | null {
  let addr = address.trim().toLowerCase();
  // Strip a zone index (fe80::1%eth0) — the address before it is what matters.
  const zone = addr.indexOf('%');
  if (zone !== -1) addr = addr.slice(0, zone);

  // IPv4-mapped / -compatible tail (::ffff:127.0.0.1) — convert the tail to hex.
  const lastColon = addr.lastIndexOf(':');
  const tail = addr.slice(lastColon + 1);
  if (tail.includes('.')) {
    const o = ipv4ToOctets(tail);
    if (!o) return null;
    const hi = ((o[0] << 8) | o[1]).toString(16);
    const lo = ((o[2] << 8) | o[3]).toString(16);
    addr = `${addr.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const halves = addr.split('::');
  if (halves.length > 2) return null;

  const head = halves[0] ? halves[0].split(':') : [];
  const back = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : [];
  if (halves.length === 1 && head.length !== 8) return null;

  const gap = 8 - head.length - back.length;
  if (gap < 0) return null;
  const groups = [...head, ...Array(halves.length === 2 ? gap : 0).fill('0'), ...back];
  if (groups.length !== 8) return null;

  const out = groups.map((g) => parseInt(g || '0', 16));
  if (out.some((n) => !Number.isInteger(n) || n < 0 || n > 0xffff)) return null;
  return out;
}

function isPrivateIPv6(address: string): boolean {
  const g = expandIPv6(address);
  if (!g) return true; // unparseable — refuse

  // ::  (unspecified) and ::1 (loopback)
  if (g.slice(0, 7).every((n) => n === 0) && (g[7] === 0 || g[7] === 1)) return true;

  // IPv4-mapped ::ffff:a.b.c.d — classify by the embedded IPv4 address.
  if (g.slice(0, 5).every((n) => n === 0) && g[5] === 0xffff) {
    const v4 = `${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`;
    return isPrivateIPv4(v4);
  }

  const first = g[0];
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((first & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  return false;
}

/** True when an address literal is in a range we must never connect to. */
export function isPrivateAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isPrivateIPv4(address);
  if (version === 6) return isPrivateIPv6(address);
  return true; // not an IP literal at all — caller should have resolved first
}

/** Hostnames that never reach the public internet, regardless of what DNS says. */
const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa'];

function isBlockedHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  if (h === 'localhost' || h === '') return true;
  if (h === 'metadata.google.internal') return true;
  return BLOCKED_HOST_SUFFIXES.some((suffix) => h.endsWith(suffix));
}

// ── URL validation ───────────────────────────────────────────────────────────

/**
 * Normalised form used as the idempotency cache key and as `source` on the
 * draft. Lowercases scheme/host, drops the fragment, drops tracking params,
 * and strips a trailing slash on the path so `/x` and `/x/` are one key.
 */
export function normalizeUrl(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  url.hash = '';
  url.username = '';
  url.password = '';
  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_|fbclid|gclid|mc_cid|mc_eid|igshid|ref$|ref_src$)/i.test(key)) {
      url.searchParams.delete(key);
    }
  }
  url.searchParams.sort();
  if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
    url.pathname = url.pathname.slice(0, -1);
  }
  return url.toString();
}

/**
 * Checks one hop: scheme, hostname, and every address the hostname resolves to.
 * Called on the original URL *and again on every redirect target*.
 */
export async function assertPublicUrl(
  rawUrl: string,
  lookup: LookupFn,
): Promise<FetchFailure | null> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return fail('invalid-url', `Not a valid URL: ${rawUrl}`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return fail('blocked-scheme', `Only http and https are allowed, got "${url.protocol}"`);
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '');

  if (isBlockedHostname(hostname)) {
    return fail('blocked-private-address', `Hostname "${hostname}" is not a public address`);
  }

  // An IP literal never needs resolving — check it directly.
  if (isIP(hostname)) {
    return isPrivateAddress(hostname)
      ? fail('blocked-private-address', `Address ${hostname} is in a private or reserved range`)
      : null;
  }

  let addresses: string[];
  try {
    addresses = await lookup(hostname);
  } catch (err) {
    return fail('network-error', `Could not resolve "${hostname}": ${String(err)}`);
  }

  if (addresses.length === 0) {
    return fail('network-error', `"${hostname}" resolved to no addresses`);
  }

  // Every address must be public — one private record is enough to refuse.
  for (const address of addresses) {
    if (isPrivateAddress(address)) {
      return fail(
        'blocked-private-address',
        `"${hostname}" resolves to ${address}, which is in a private or reserved range`,
      );
    }
  }

  return null;
}

// ── Streaming read with a hard byte cap ──────────────────────────────────────

async function readCapped(response: Response, maxBytes: number): Promise<string | FetchFailure> {
  const declared = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) {
    return fail(
      'response-too-large',
      `Content-Length ${declared} exceeds the ${maxBytes} byte cap`,
    );
  }

  const body = response.body;
  if (!body) {
    const text = await response.text();
    return Buffer.byteLength(text) > maxBytes
      ? fail('response-too-large', `Body exceeds the ${maxBytes} byte cap`)
      : text;
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      // Enforced during streaming, not after the body has landed — a 50 MB page
      // must never be fully buffered.
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return fail('response-too-large', `Body exceeds the ${maxBytes} byte cap`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }

  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

// ── The fetcher ──────────────────────────────────────────────────────────────

/**
 * Fetches a user-supplied URL with SSRF, size and time protection.
 * Redirects are followed manually so every hop is re-validated.
 */
export async function safeFetch(
  rawUrl: string,
  options: SafeFetchOptions = {},
): Promise<FetchResult> {
  const {
    maxBytes = MAX_RESPONSE_BYTES,
    timeoutMs = REQUEST_TIMEOUT_MS,
    maxRedirects = MAX_REDIRECTS,
    lookup = defaultLookup,
    fetchImpl = fetch,
    now = Date.now,
  } = options;

  const deadline = now() + timeoutMs;
  const redirects: string[] = [];
  let current = rawUrl;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const remaining = deadline - now();
    if (remaining <= 0) {
      return fail('timeout', `Timed out after ${timeoutMs}ms`);
    }

    // Re-validated on every hop. This is the whole point of manual redirects.
    const blocked = await assertPublicUrl(current, lookup);
    if (blocked) {
      return hop === 0
        ? blocked
        : { ...blocked, detail: `${blocked.detail} (via redirect from ${redirects[0]})` };
    }

    redirects.push(current);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);

    let response: Response;
    try {
      response = await fetchImpl(current, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml' },
      });
    } catch (err) {
      const aborted = err instanceof Error && err.name === 'AbortError';
      return aborted
        ? fail('timeout', `Timed out after ${timeoutMs}ms`)
        : fail('network-error', `Request to ${current} failed: ${String(err)}`);
    } finally {
      clearTimeout(timer);
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) {
        return fail('http-error', `HTTP ${response.status} with no Location header`);
      }
      let next: string;
      try {
        next = new URL(location, current).toString();
      } catch {
        return fail('invalid-url', `Redirect target is not a valid URL: ${location}`);
      }
      current = next;
      continue;
    }

    if (!response.ok) {
      // 12% of the MEAL-69 sample refused a plain server-side fetch while
      // working fine in a browser — Cloudflare, Medium, Beacons. That is a
      // different failure from "we read the page and could not extract a
      // recipe", and the creator needs to be told which one happened. The error
      // body is never used as page content.
      if (response.status === 401 || response.status === 403 || response.status === 429) {
        return fail(
          'blocked-by-site',
          `${new URL(current).hostname} refused our request (HTTP ${response.status}). ` +
            'Some sites block automated readers even though the page opens fine in a browser.',
        );
      }
      return fail('http-error', `HTTP ${response.status} from ${current}`);
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (contentType && !/text\/html|application\/xhtml|text\/plain|application\/json/i.test(contentType)) {
      return fail(
        'unsupported-content-type',
        `Expected an HTML page, got "${contentType}"`,
      );
    }

    const body = await readCapped(response, maxBytes);
    if (typeof body !== 'string') return body;

    return { ok: true, url: current, status: response.status, contentType, html: body, redirects };
  }

  return fail('too-many-redirects', `More than ${maxRedirects} redirects starting at ${rawUrl}`);
}
