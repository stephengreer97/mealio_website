/**
 * Where a creator publishes, and which one of those places we poll (MEAL-81).
 *
 * All four links are collected; exactly **one** is polled, and which one is an
 * operator decision made during application review. Storing all four means
 * switching a creator later is a field edit rather than re-onboarding them.
 *
 * Shared by the application form (client), the apply route, the approval that
 * copies the links onto the `creators` row, and the admin source picker — so
 * there is one source of truth for the column names, the labels and what counts
 * as a plausible link. Same reason `handles.ts` exists.
 */

/** The four places a creator can publish. `creators` has a column per entry. */
export const PLATFORM_SOURCES = ['website', 'youtube', 'instagram', 'tiktok'] as const;
export type PlatformSource = (typeof PLATFORM_SOURCES)[number];

/**
 * `creators.primary_source`. `none` is the default and the off switch: nothing
 * is polled for a creator whose source is `none`, whatever the opt-in says.
 */
export type PrimarySource = PlatformSource | 'none';

export const PRIMARY_SOURCES: readonly PrimarySource[] = [...PLATFORM_SOURCES, 'none'];

/** Column names on both `creators` and `creator_applications`. */
export const SOURCE_COLUMNS: Record<PlatformSource, string> = {
  website: 'website_url',
  youtube: 'youtube_url',
  instagram: 'instagram_url',
  tiktok: 'tiktok_url',
};

export const SOURCE_LABELS: Record<PlatformSource, string> = {
  website: 'Website',
  youtube: 'YouTube',
  instagram: 'Instagram',
  tiktok: 'TikTok',
};

export function isPlatformSource(value: unknown): value is PlatformSource {
  return typeof value === 'string' && (PLATFORM_SOURCES as readonly string[]).includes(value);
}

export function isPrimarySource(value: unknown): value is PrimarySource {
  return typeof value === 'string' && (PRIMARY_SOURCES as readonly string[]).includes(value);
}

// ── Link validation ──────────────────────────────────────────────────────────

/**
 * Hosts that identify each platform. Deliberately a *host* check and nothing
 * more: we are confirming the creator pasted the right box's link, not parsing
 * their handle out of it. Path shapes change (`/user/`, `/c/`, `/@name`) and a
 * validator that knows them all rejects real creators the day one changes.
 */
const PLATFORM_HOSTS: Record<PlatformSource, RegExp | null> = {
  website: null, // anything, minus the three below
  youtube: /^(www\.|m\.|music\.)?youtube\.com$|^youtu\.be$/i,
  instagram: /^(www\.)?instagram\.com$/i,
  tiktok: /^(www\.|vm\.|vt\.)?tiktok\.com$/i,
};

const EXAMPLES: Record<PlatformSource, string> = {
  website: 'yourblog.com',
  youtube: 'youtube.com/@yourchannel',
  instagram: 'instagram.com/yourname',
  tiktok: 'tiktok.com/@yourname',
};

export type LinkResult =
  /** `url` is the normalised link, or null when the (optional) field was blank. */
  | { ok: true; url: string | null }
  | { ok: false; error: string };

/**
 * Longest link we will normalise or store.
 *
 * Nothing legitimate comes close — browsers and CDNs give up long before this.
 * A link is stored once and then read back forever: into server-side fetches,
 * into log lines, into the admin UI. A 200 KB "URL" normalises perfectly well
 * today, and every one of those places is somewhere it does not belong.
 */
const MAX_LINK_CHARS = 2048;

/**
 * Normalises one platform link.
 *
 * Lenient on purpose. A creator typing `chefsarah.com` or leaving a trailing
 * slash is giving us a perfectly good link, and rejecting it loses an applicant
 * over punctuation. What we do insist on: an http(s) URL with a real-looking
 * hostname, and — where it costs nothing — that the host belongs to the platform
 * whose box it was typed into, because a YouTube URL in the Instagram field is a
 * mistake that would otherwise only surface as a viability check with no items.
 */
export function normalizePlatformUrl(source: PlatformSource, raw: unknown): LinkResult {
  const input = typeof raw === 'string' ? raw.trim() : '';
  if (!input) return { ok: true, url: null };
  if (input.length > MAX_LINK_CHARS) {
    return { ok: false, error: `That link is ${input.length} characters long; the limit is ${MAX_LINK_CHARS}. Example: ${EXAMPLES[source]}` };
  }

  // A bare `chefsarah.com` is what most people type, so a missing scheme is
  // filled in rather than rejected. A scheme that *is* present has to be a real
  // one though: prefixing `https://` onto `mailto:sarah@x.com` produces a URL
  // that parses cleanly and points at the wrong place entirely.
  //
  // The negative lookahead keeps `chefsarah.com:8080` out of it — a colon
  // followed by digits is a port, not a scheme.
  const scheme = /^([a-z][a-z0-9+.-]*):(?![0-9])/i.exec(input)?.[1]?.toLowerCase();
  if (scheme && scheme !== 'http' && scheme !== 'https') {
    return { ok: false, error: `Links must start with http:// or https://. Example: ${EXAMPLES[source]}` };
  }
  const withScheme = scheme ? input : `https://${input}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return { ok: false, error: `That does not look like a link. Example: ${EXAMPLES[source]}` };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: `Links must start with http:// or https://. Example: ${EXAMPLES[source]}` };
  }

  // Credentials in a link we later fetch server-side are never useful and are a
  // classic way to disguise the host a human is reading.
  url.username = '';
  url.password = '';
  url.hash = '';

  // The DNS root's trailing dot names the same host but compares as a different
  // string, and this value is later matched against a feed's host — a creator
  // stored as `chefsarah.test.` could never confirm a feed on `chefsarah.test`,
  // in either direction, so they could never be opted in at all.
  const host = url.hostname.toLowerCase().replace(/\.+$/, '');
  // No dot means `localhost` or an intranet name; a bare IP is never a creator's
  // published home. Both are refused at fetch time too — this is the early, and
  // legible, rejection.
  if (!host.includes('.') || /^\d+(\.\d+)*$/.test(host) || host.includes('[')) {
    return { ok: false, error: `"${url.hostname}" is not a public website. Example: ${EXAMPLES[source]}` };
  }
  url.hostname = host;

  const expected = PLATFORM_HOSTS[source];
  if (expected) {
    if (!expected.test(host)) {
      return {
        ok: false,
        error: `That link is not on ${SOURCE_LABELS[source]}. Example: ${EXAMPLES[source]}`,
      };
    }
  } else {
    // The website box specifically: catch a social link pasted into it, since
    // "website" is the only source we can actually poll today and a wrong entry
    // there is the one that wastes an operator's viability check.
    for (const other of PLATFORM_SOURCES) {
      const pattern = PLATFORM_HOSTS[other];
      if (pattern && pattern.test(host)) {
        return {
          ok: false,
          error: `That is a link to ${SOURCE_LABELS[other]} — put it in the ${SOURCE_LABELS[other]} box. The website field is for your own site.`,
        };
      }
    }
  }

  return { ok: true, url: url.toString() };
}

/**
 * Which of the four sources a bare URL belongs to.
 *
 * Used by the one-link admin sync (MEAL-90), where the operator pastes a URL and
 * never picks a platform: the answer has to be derived so the
 * `(creator_id, source, item_id)` record lands under the same source the
 * checklist and the poller would have used for that post. Falls back to
 * `website`, which is what a link on the creator's own domain is.
 */
export function platformSourceForUrl(link: string): PlatformSource {
  let host: string;
  try {
    host = new URL(link).hostname.toLowerCase();
  } catch {
    return 'website';
  }
  for (const source of PLATFORM_SOURCES) {
    const pattern = PLATFORM_HOSTS[source];
    if (pattern && pattern.test(host)) return source;
  }
  return 'website';
}

/** Normalises all four links at once, failing on the first bad one. */
export function normalizePlatformUrls(
  input: Partial<Record<PlatformSource, unknown>>,
): { ok: true; urls: Record<PlatformSource, string | null> } | { ok: false; error: string } {
  const urls = {} as Record<PlatformSource, string | null>;
  for (const source of PLATFORM_SOURCES) {
    const result = normalizePlatformUrl(source, input[source]);
    if (!result.ok) return result;
    urls[source] = result.url;
  }
  return { ok: true, urls };
}

/** Maps normalised links onto the DB columns both tables share. */
export function toSourceColumns(
  urls: Partial<Record<PlatformSource, string | null>>,
): Record<string, string | null> {
  const row: Record<string, string | null> = {};
  for (const source of PLATFORM_SOURCES) {
    row[SOURCE_COLUMNS[source]] = urls[source] ?? null;
  }
  return row;
}

// ── "Is this on the creator's own site?" ─────────────────────────────────────

/** A hostname in the form two links can be compared on, or null if unparseable. */
function comparableHost(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/\.+$/, '') || null;
  } catch {
    return null;
  }
}

/**
 * Hosts where the *path*, not the host, names the publisher.
 *
 * On these, `medium.com/@sarah` and `medium.com/@bob` are two different people
 * behind one hostname, so host equality alone answers the wrong question — it
 * would let a URL under any other user's handle count as this creator's own,
 * which is a stranger's recipe published under their name. Matched only when the
 * creator's own link is on the bare platform host; a creator with a subdomain of
 * one (`sarah.medium.com`) is already told apart by the host rule below.
 *
 * A short list on purpose. It is not a directory of the web, it is the handful
 * of hosts a creator's "website" link is plausibly on while belonging to only
 * part of that host.
 */
const PATH_SCOPED_HOSTS = [
  'medium.com',
  'substack.com',
  'patreon.com',
  'tumblr.com',
  'blogspot.com',
  'sites.google.com',
  'notion.site',
  'beehiiv.com',
  'linktr.ee',
];

/** The first path segment, lowercased, or null for a bare host. */
function firstSegment(url: string): string | null {
  try {
    const segment = new URL(url).pathname.split('/').filter(Boolean)[0];
    return segment ? decodeURIComponent(segment).toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * Is `candidateUrl` on the same site as `siteUrl`?
 *
 * Exact host, a subdomain of it, or the apex of a `www.` site. Deliberately
 * *not* "shares a parent domain": `sarah.wordpress.com` and `wordpress.com`
 * share one, and `sarah.github.io` and `github.io`, so that rule accepts a feed
 * on the hosting platform's own root — every other tenant's posts, imported
 * under this creator's name. Answering "is this a registrable domain" properly
 * needs the public suffix list, which is a couple of hundred kilobytes and a
 * standing update obligation for one comparison in this repository. The only
 * parent-direction match that happens in real life is a creator who pastes
 * `www.chefsarah.test` whose feed sits on the apex, so that is the only one
 * allowed.
 *
 * On a `PATH_SCOPED_HOSTS` host the question is finer than the host, and the
 * first path segment has to match too.
 *
 * Used everywhere a creator-supplied URL decides what our server fetches or what
 * gets attributed to a creator: the stored `feed_url`, the hrefs a homepage
 * advertises, the item URLs inside a feed, and the selection an operator ticks
 * off an admin sync catalog. One function rather than one per caller — a second
 * copy of this rule was how the sync route ended up with the looser version.
 */
export function isOnSameSite(siteUrl: string, candidateUrl: string): boolean {
  const site = comparableHost(siteUrl);
  const candidate = comparableHost(candidateUrl);
  if (!site || !candidate) return false;

  if (PATH_SCOPED_HOSTS.includes(site.replace(/^www\./, ''))) {
    // A bare `medium.com` with no handle identifies nobody, so nothing is on
    // "their" site — refusing is the only safe reading of an empty answer.
    const owner = firstSegment(siteUrl);
    if (!owner) return false;
    return candidate.replace(/^www\./, '') === site.replace(/^www\./, '') && firstSegment(candidateUrl) === owner;
  }

  return candidate === site || candidate.endsWith(`.${site}`) || site === `www.${candidate}`;
}

/**
 * The operator-facing complaint when a URL is not on the creator's own site, or
 * null when it is.
 *
 * Shared by the two admin routes that accept a feed URL, because a rule enforced
 * on one of them and not the other is the rule not existing.
 */
export function describeHostMismatch(websiteUrl: string, feedUrl: string): string | null {
  if (!websiteUrl) return "Set the creator's website link before storing a feed URL.";
  const site = comparableHost(websiteUrl);
  const feed = comparableHost(feedUrl);
  if (!site || !feed) return 'Feed URL: that is not a URL we can fetch.';
  if (isOnSameSite(websiteUrl, feedUrl)) return null;
  return `That feed (${feed}) is not on the creator's own site (${site}). Refusing it: a feed on someone else's host would import their recipes under this creator's name.`;
}

// ── Known-unsupported sources ────────────────────────────────────────────────

export interface UnsupportedSource {
  id: string;
  label: string;
  /** Shown to the operator *instead of* a viability result, so it has to explain itself. */
  detail: string;
}

/**
 * Platforms ruled out by measurement, not judgement.
 *
 * Checked **before** the viability check runs, and listed in the admin UI beside
 * it, so a reviewer neither burns ten classifier calls on a source that cannot
 * be fetched nor has to rediscover why. The whole point of measuring something
 * once is not measuring it again.
 */
export const KNOWN_UNSUPPORTED_SOURCES: UnsupportedSource[] = [
  {
    id: 'medium',
    label: 'Medium',
    detail:
      'Medium blocks server-side fetches outright. MEAL-69 measured 12% of sampled creator URLs ' +
      'returning 403 to our fetcher and every single one was Medium — that is IP-reputation and ' +
      'TLS-fingerprint blocking of datacenter egress, so it fails on request one and no ' +
      'User-Agent, header or cadence change alters it. Route this creator to another of their ' +
      'links, or tell them plainly that their Medium blog cannot be imported.',
  },
];

const UNSUPPORTED_HOSTS: Record<string, RegExp> = {
  medium: /(^|\.)medium\.com$/i,
};

/**
 * Identifies a known-unsupported platform from a link, before anything is
 * fetched. Host-based, so a Medium blog on a custom domain is not caught here —
 * that one surfaces as a `blocked-by-site` fetch failure, which the viability
 * report maps back to this same explanation.
 */
export function knownUnsupportedSource(link: string | null | undefined): UnsupportedSource | null {
  if (!link) return null;
  let host: string;
  try {
    host = new URL(link).hostname.toLowerCase();
  } catch {
    return null;
  }
  for (const entry of KNOWN_UNSUPPORTED_SOURCES) {
    const pattern = UNSUPPORTED_HOSTS[entry.id];
    if (pattern && pattern.test(host)) return entry;
  }
  return null;
}

/** Looks a known-unsupported entry up by id, for failures detected after a fetch. */
export function unsupportedSourceById(id: string): UnsupportedSource | null {
  return KNOWN_UNSUPPORTED_SOURCES.find((entry) => entry.id === id) ?? null;
}

// ── Viability, rolled up across a creator's links ────────────────────────────

/**
 * The per-source result of the viability check (`lib/import/viability.ts`).
 *
 * The type and the roll-up below live here rather than beside the check itself
 * because the admin UI needs both, and the check imports undici — a client
 * bundle must not follow that path.
 */
export type ViabilityOutcome =
  /** Most of what they publish is a recipe. Set the source, enable import. */
  | 'viable'
  /** Some pass, but under half. Works, imports rarely — operator's call. */
  | 'partial'
  /** Items were read and none of them are recipes. Try another link. */
  | 'not-viable'
  /** Ruled out by measurement before anything was fetched (Medium). */
  | 'unsupported'
  /** We could not find out: no feed, site refused us, platform not connected yet. */
  | 'unavailable';

export interface CreatorViabilityVerdict {
  /** Null while links remain unchecked — "we do not know yet" is not "no". */
  importable: boolean | null;
  summary: string;
  /** Links the creator gave us that have not been checked yet. */
  unchecked: PlatformSource[];
}

/**
 * Rolls per-source outcomes up into the answer the ticket actually asks for.
 *
 * "None pass anywhere" is a statement about a creator, not about one source, so
 * it can only be made once every link they gave us has been tried. Saying it
 * early would turn one unlucky platform into a rejection — and saying it never
 * is how a creator gets onboarded into a feature that silently does nothing for
 * them, which is the failure this check exists to catch.
 */
export function summariseCreatorViability(
  links: Partial<Record<PlatformSource, string | null>>,
  outcomes: Partial<Record<PlatformSource, ViabilityOutcome>>,
): CreatorViabilityVerdict {
  const present = PLATFORM_SOURCES.filter((source) => links[source]);

  if (present.length === 0) {
    return { importable: null, summary: 'This creator gave us no links, so there is nothing to poll.', unchecked: [] };
  }

  const workable = present.filter((source) => outcomes[source] === 'viable' || outcomes[source] === 'partial');
  if (workable.length > 0) {
    return {
      importable: true,
      summary: `Importable via ${workable.map((source) => SOURCE_LABELS[source]).join(', ')}.`,
      unchecked: [],
    };
  }

  // A source that could not be checked is not a source that failed: an
  // unconnected platform or a site that was down says nothing about the creator.
  const unchecked = present.filter((source) => !outcomes[source] || outcomes[source] === 'unavailable');
  if (unchecked.length > 0) {
    return {
      importable: null,
      summary:
        `Nothing viable yet. Still to check: ${unchecked.map((source) => SOURCE_LABELS[source]).join(', ')}. ` +
        'A source that could not be checked is not a source that failed.',
      unchecked,
    };
  }

  // "Checked" is not true of a source ruled out before anything was fetched — a
  // Medium-only creator reaches here having had nothing read at all. This is the
  // sentence an operator relays to the creator, so it says what happened.
  const unsupported = present.filter((source) => outcomes[source] === 'unsupported');
  const ruledOut = unsupported.length > 0
    ? ` ${unsupported.map((source) => SOURCE_LABELS[source]).join(', ')} was ruled out without fetching ` +
      'anything — see the known-unsupported list for why.'
    : '';

  return {
    importable: false,
    summary:
      'Every link this creator gave us has been ruled out, and none of them are importable.' +
      `${ruledOut} This creator is not importable — tell them plainly rather than onboarding them ` +
      'into a feature that will do nothing for them.',
    unchecked: [],
  };
}
