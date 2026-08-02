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

  const host = url.hostname.toLowerCase();
  // No dot means `localhost` or an intranet name; a bare IP is never a creator's
  // published home. Both are refused at fetch time too — this is the early, and
  // legible, rejection.
  if (!host.includes('.') || /^\d+(\.\d+)*$/.test(host) || host.includes('[')) {
    return { ok: false, error: `"${url.hostname}" is not a public website. Example: ${EXAMPLES[source]}` };
  }

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

  return {
    importable: false,
    summary:
      'Every link this creator gave us was checked and none of them are importable. This creator is not ' +
      'importable — tell them plainly rather than onboarding them into a feature that will do nothing ' +
      'for them.',
    unchecked: [],
  };
}
