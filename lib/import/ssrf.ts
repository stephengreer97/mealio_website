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
 *   5. **The address check happens at connect time**, not only before it. A
 *      pre-flight check that resolves the hostname and then hands the
 *      *hostname* to fetch resolves twice, and a TTL-0 record can answer
 *      differently the second time — the check passes on a public address and
 *      the socket opens on a private one. See `guardedAgent`.
 */

import { isIP } from 'net';
import { lookup as dnsLookup } from 'dns/promises';
import { Agent, fetch as undiciFetch } from 'undici';
import type { FetchResult, FetchFailure, FetchSuccess } from './types';

/**
 * `FetchSuccess` plus the raw bytes.
 *
 * Declared here rather than widened in `types.ts`: the raw body is a detail of
 * the fetch layer (the image path needs it), while `types.ts` is the contract
 * the UI is built against and stays as it is.
 */
export interface SafeFetchSuccess extends FetchSuccess {
  bytes: Buffer;
}

export type SafeFetchResult = SafeFetchSuccess | FetchFailure;

export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024; // 2 MB
export const REQUEST_TIMEOUT_MS = 10_000;
export const MAX_REDIRECTS = 5;

/** What the page fetch will accept. */
export const HTML_CONTENT_TYPES = /text\/html|application\/xhtml|text\/plain|application\/json/i;

/** What the image fetch will accept. SVG is excluded: it is a script carrier. */
export const IMAGE_CONTENT_TYPES = /^image\/(jpeg|jpg|png|webp|gif|avif)\b/i;

/** Images are bigger than pages, but not unbounded. */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const USER_AGENT = 'MealioBot/1.0 (+https://mealio.co/about)';

/** Resolves a hostname to its addresses. Injected so tests never touch DNS. */
export type LookupFn = (hostname: string) => Promise<string[]>;

/** The fetch to use. Injected so tests never touch the network. */
export type FetchFn = typeof fetch;

export interface SafeFetchOptions {
  /** Content types this fetch will accept. Defaults to HTML and friends. */
  accept?: RegExp;
  /** How to describe `accept` in an error a creator reads. */
  expected?: string;
  /**
   * Require the server to declare a matching Content-Type.
   *
   * Off for pages, where a missing header is common and harmless — we parse
   * the bytes as HTML either way. On for images, where the header is the only
   * thing standing between "SVG is excluded" and storing a script-bearing SVG
   * that we then re-serve from our own origin.
   */
  requireContentType?: boolean;
  /**
   * Extra request headers, for the one caller that fetches an API of ours
   * rather than a page a stranger chose (MEAL-74's caption download).
   *
   * **Dropped the moment a redirect leaves the origin they were sent to.** An
   * `authorization` header followed across hosts hands a creator's OAuth token
   * to whoever the redirect names, and redirects here are attacker-influenced
   * by construction. Google's media downloads redirect to a pre-signed URL that
   * needs no credential, so nothing legitimate wants them carried over.
   */
  headers?: Record<string, string>;
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

/**
 * Closes the DNS-rebinding window.
 *
 * The pre-flight `assertPublicUrl` check resolves the hostname and inspects the
 * addresses, but it then hands the *hostname* to fetch, which resolves again.
 * An attacker serving a TTL-0 record answers the first query with a public
 * address and the second with `127.0.0.1`, and the connection opens somewhere
 * our check never saw. Against an adaptive attacker the pre-flight check alone
 * is advisory.
 *
 * This moves the check to the moment that matters. undici passes `connect`
 * options through to the socket layer, so a custom `lookup` runs *as the
 * connection is being established* — we resolve once, validate every address
 * that resolution returned, and hand back that same resolved set for undici to
 * connect to. There is no second lookup to poison.
 *
 * The pre-flight check stays: it fails fast, gives the creator a precise error,
 * and covers redirect targets before we spend a connection on them.
 */
export type GuardedLookup = (
  hostname: string,
  options: { all?: boolean } | undefined,
  callback: (...args: never[]) => void,
) => void;

/** The connect-time address guard, exported so it can be tested on its own. */
export function createGuardedLookup(lookup: LookupFn): GuardedLookup {
  return (hostname, options, callback) => {
    const done = callback as unknown as (
      err: NodeJS.ErrnoException | null,
      ...rest: unknown[]
    ) => void;

    const deny = (message: string) => {
      const error = new Error(message) as NodeJS.ErrnoException;
      error.code = 'EACCES';
      done(error, []);
    };

    lookup(hostname)
      .then((addresses) => {
        if (addresses.length === 0) {
          deny(`"${hostname}" resolved to no addresses`);
          return;
        }
        const blocked = addresses.find((address) => isPrivateAddress(address));
        if (blocked) {
          deny(
            `Refusing to connect: "${hostname}" resolves to ${blocked}, which is in a ` +
              'private or reserved range',
          );
          return;
        }
        const resolved = addresses.map((address) => ({
          address,
          family: isIP(address) as 4 | 6,
        }));
        // Signature depends on `all`; undici passes `{ all: true }`.
        if (options?.all) done(null, resolved);
        else done(null, resolved[0].address, resolved[0].family);
      })
      .catch((err) => deny(`Could not resolve "${hostname}": ${String(err)}`));
  };
}

function buildGuardedAgent(lookup: LookupFn): Agent {
  return new Agent({ connect: { lookup: createGuardedLookup(lookup) as never } });
}

/**
 * One agent per resolver, so connections are pooled normally. Only ever built
 * for the real fetch path — when a test injects `fetchImpl`, no agent exists.
 */
const agentsByLookup = new WeakMap<LookupFn, Agent>();

function guardedFetch(lookup: LookupFn): FetchFn {
  let agent = agentsByLookup.get(lookup);
  if (!agent) {
    agent = buildGuardedAgent(lookup);
    agentsByLookup.set(lookup, agent);
  }
  const dispatcher = agent;
  return ((input: RequestInfo | URL, init?: RequestInit) =>
    undiciFetch(input as never, {
      ...(init as Record<string, unknown>),
      dispatcher,
    } as never)) as unknown as FetchFn;
}

function fail(reason: FetchFailure['reason'], detail: string): FetchFailure {
  return { ok: false, reason, detail };
}

/**
 * A timeout failure that arrives after `ms`, for racing a step that cannot be
 * cancelled from the outside.
 *
 * `AbortSignal` covers the fetch; nothing covers `dns.lookup`, which takes no
 * signal. The loser of the race keeps running to completion — there is no way to
 * stop it — but it resolves into a promise nobody is holding, so it costs one
 * pending resolution rather than the request.
 */
function expiresIn(ms: number, detail: string): { expired: Promise<FetchFailure>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout>;
  const expired = new Promise<FetchFailure>((resolve) => {
    timer = setTimeout(() => resolve(fail('timeout', detail)), Math.max(0, ms));
  });
  return { expired, cancel: () => clearTimeout(timer) };
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
 * The same URL's *identity*, for deciding whether we have seen it before.
 *
 * `normalizeUrl` has to stay a URL we can actually fetch, so it leaves the
 * scheme and the `www.` alone — an apex that does not resolve, or a host that
 * only serves http, is a hard failure and neither is ours to guess about. But
 * `http://blog.test/x`, `https://blog.test/x` and `https://www.blog.test/x` are
 * one post, and used as `item_id` they are three: three drafts in the review
 * queue, three published meals under the creator's name, from an operator
 * pasting the same link on two different days. Which is the ordinary case, not
 * the adversarial one.
 *
 * So identity folds both and fetching does not. Used for the import cache key
 * and for the `(creator_id, source, item_id)` record a pasted link lands under.
 */
export function urlIdentity(input: string): string | null {
  const normalized = normalizeUrl(input);
  if (!normalized) return null;
  const url = new URL(normalized);
  url.protocol = 'https:';
  url.hostname = url.hostname.replace(/^www\./, '');
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

async function readCapped(
  response: Response,
  maxBytes: number,
  isExpired: () => boolean,
): Promise<Buffer | FetchFailure> {
  const declared = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) {
    return fail(
      'response-too-large',
      `Content-Length ${declared} exceeds the ${maxBytes} byte cap`,
    );
  }

  const body = response.body;
  if (!body) {
    const buffer = Buffer.from(await response.arrayBuffer());
    return buffer.byteLength > maxBytes
      ? fail('response-too-large', `Body exceeds the ${maxBytes} byte cap`)
      : buffer;
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      // The deadline has to be re-checked on every chunk, not just before the
      // read starts. A server that drips one byte every 20ms never trips the
      // size cap and never stalls a single read — it just keeps the request
      // alive indefinitely. Both limits are needed: bytes *and* wall clock.
      if (isExpired()) {
        await reader.cancel().catch(() => {});
        return fail('timeout', 'Timed out while reading the response body');
      }
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
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError';
    return aborted
      ? fail('timeout', 'Timed out while reading the response body')
      : fail('network-error', `Failed while reading the response body: ${String(err)}`);
  } finally {
    reader.releaseLock?.();
  }

  return Buffer.concat(chunks.map((c) => Buffer.from(c)));
}

/**
 * Releases a response we are not going to read.
 *
 * Undici keeps the socket checked out of the pool until the body is consumed or
 * cancelled, so every early return — redirect, bot challenge, wrong content
 * type — has to let go of it explicitly or the connection leaks.
 */
async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    /* already errored or consumed — nothing to release */
  }
}

// ── The fetcher ──────────────────────────────────────────────────────────────

/**
 * Fetches a user-supplied URL with SSRF, size and time protection.
 * Redirects are followed manually so every hop is re-validated.
 */
export async function safeFetch(
  rawUrl: string,
  options: SafeFetchOptions = {},
): Promise<SafeFetchResult> {
  const {
    maxBytes = MAX_RESPONSE_BYTES,
    timeoutMs = REQUEST_TIMEOUT_MS,
    maxRedirects = MAX_REDIRECTS,
    lookup = defaultLookup,
    now = Date.now,
    accept = HTML_CONTENT_TYPES,
    expected = 'an HTML page',
    requireContentType = false,
  } = options;
  // The default path routes through a dispatcher that re-validates the address
  // at connect time; an injected fetch (tests) bypasses the network entirely.
  const fetchImpl = options.fetchImpl ?? guardedFetch(lookup);

  const deadline = now() + timeoutMs;
  const redirects: string[] = [];
  let current = rawUrl;
  /** The origin `options.headers` were meant for. Unparseable means nowhere. */
  const credentialOrigin = (() => {
    try {
      return new URL(rawUrl).origin;
    } catch {
      return null;
    }
  })();

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const remaining = deadline - now();
    if (remaining <= 0) {
      return fail('timeout', `Timed out after ${timeoutMs}ms`);
    }

    // Re-validated on every hop. This is the whole point of manual redirects.
    //
    // Raced against the deadline, because it was outside it: the `AbortSignal`
    // that bounds the request is created *after* this returns, and the DNS
    // resolution inside it takes no signal at all. A hostname whose
    // authoritative nameserver simply never answers held the fetch for the
    // platform resolver's own timeout — 5 s per nameserver, retried, so 10 s of
    // a 10 s budget spent before a byte moves — and once per hop, so a chain of
    // such hostnames multiplied it by seven. Every one of them is a URL a
    // creator pasted, or a redirect target chosen by the page.
    const dns = expiresIn(remaining, `Timed out after ${timeoutMs}ms`);
    const blocked = await Promise.race([assertPublicUrl(current, lookup), dns.expired]);
    dns.cancel();
    if (blocked) {
      return hop === 0
        ? blocked
        : { ...blocked, detail: `${blocked.detail} (via redirect from ${redirects[0]})` };
    }

    redirects.push(current);

    // The controller has to outlive the fetch call. `await fetchImpl(...)`
    // settles as soon as the *headers* arrive, so clearing the timer in a
    // `finally` around it leaves the body read with no deadline and no signal —
    // a server that drips bytes slowly then runs unbounded. It is cleared once,
    // after the body has been read or abandoned.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);
    const isExpired = () => now() >= deadline;

    try {
      let response: Response;
      try {
        const sameOrigin = credentialOrigin !== null && new URL(current).origin === credentialOrigin;
        response = await fetchImpl(current, {
          method: 'GET',
          redirect: 'manual',
          signal: controller.signal,
          headers: {
            'user-agent': USER_AGENT,
            accept: 'text/html,application/xhtml+xml',
            ...(sameOrigin ? options.headers : undefined),
          },
        });
      } catch (err) {
        const aborted = err instanceof Error && err.name === 'AbortError';
        return aborted
          ? fail('timeout', `Timed out after ${timeoutMs}ms`)
          : fail('network-error', `Request to ${current} failed: ${String(err)}`);
      }

      if (response.status >= 300 && response.status < 400) {
        await discard(response);
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
        await discard(response);
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
      const declared = contentType.trim() !== '';
      if (requireContentType ? !accept.test(contentType) : declared && !accept.test(contentType)) {
        await discard(response);
        return fail(
          'unsupported-content-type',
          declared ? `Expected ${expected}, got "${contentType}"` : `Expected ${expected}, but no Content-Type was declared`,
        );
      }

      const body = await readCapped(response, maxBytes, isExpired);
      if (!Buffer.isBuffer(body)) return body;

      return {
        ok: true,
        url: current,
        status: response.status,
        contentType,
        html: body.toString('utf8'),
        bytes: body,
        redirects,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  return fail('too-many-redirects', `More than ${maxRedirects} redirects starting at ${rawUrl}`);
}

/**
 * Downloads an image through every guard `safeFetch` applies.
 *
 * The image URL comes off an attacker-controlled page, so it is exactly as
 * untrusted as the page URL was and gets the same treatment: scheme allowlist,
 * address validation at connect time, per-hop redirect re-validation, size cap
 * and wall-clock deadline. Content types are restricted to real raster formats
 * — SVG is excluded because it carries script and we re-serve what we store.
 */
export async function safeFetchImage(
  rawUrl: string,
  options: SafeFetchOptions = {},
): Promise<SafeFetchResult> {
  return safeFetch(rawUrl, {
    maxBytes: MAX_IMAGE_BYTES,
    ...options,
    accept: IMAGE_CONTENT_TYPES,
    expected: 'an image',
    // No declared type means no proof it is not an SVG, and we re-serve what we
    // store from our own origin.
    requireContentType: true,
  });
}
