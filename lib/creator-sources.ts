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

/**
 * The three sources reached through an OAuth grant rather than a public feed —
 * the values `creator_platform_accounts.platform` allows.
 *
 * A website needs no account: we fetch it the way any reader would. The other
 * three hand nothing over until their owner says so, which is why the grant
 * table exists at all (MEAL-74 / 82 / 83).
 */
export const CONNECTED_PLATFORMS = ['youtube', 'instagram', 'tiktok'] as const;
export type ConnectedPlatform = (typeof CONNECTED_PLATFORMS)[number];

export function isConnectedPlatform(value: unknown): value is ConnectedPlatform {
  return typeof value === 'string' && (CONNECTED_PLATFORMS as readonly string[]).includes(value);
}

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
  // A missing field is a field nobody typed into; anything else that is not a
  // string is a client bug, and folding it to blank made that bug *destructive* —
  // `{website: null}` for a field the form never touched deleted the creator's
  // link and answered 200. An empty string is the way to clear one, and it is
  // the only way, because it is the only value that says so unambiguously.
  if (raw !== undefined && typeof raw !== 'string') {
    return { ok: false, error: `That is not a link. Send the link as text, or an empty string to remove it. Example: ${EXAMPLES[source]}` };
  }
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

// ── The polling invariants, judged on the resulting row ──────────────────────

/**
 * The columns `checkPollingInvariants` reads. Both `creators` and the object a
 * PATCH would leave behind satisfy it.
 */
export type PollingRow = Record<string, unknown>;

export type PollingVerdict =
  /** Coherent. `importOptIn` is the value that has to be written, which is not
   *  always the one that came in — see the `none` case below. */
  | { ok: true; importOptIn: boolean }
  | { ok: false; error: string };

/**
 * Judges the row a write would leave behind, not the fields it sent.
 *
 * Every rule here is about a *combination* of columns, so validating only the
 * ones a request happened to mention validates nothing: the admin radio button
 * sends `primarySource` alone, the feed-confirm button sends `feedUrl` alone,
 * and a creator editing their own links (MEAL-94) sends neither — yet any of
 * the three can walk an already-opted-in creator into a state these lines exist
 * to refuse. Pointed at a source they have no link for, or polling a website
 * whose feed was just cleared.
 *
 * Shared by the admin source picker and the creator's own link editor because a
 * rule enforced on one path and not the other is the rule not existing — the
 * same reason `describeHostMismatch` is shared. The wording is the operator's;
 * a creator-facing caller checks its own case first, with its own sentence, and
 * keeps this as the backstop that cannot be talked past.
 *
 * `explicitOptIn` is true only when the request *asked* to turn import on, which
 * separates "leave the switch alone" from "turn it on" — a distinction the row
 * itself cannot carry.
 *
 * `grants` is the platforms this creator has an OAuth grant for, and it exists
 * because the link rule below was written when YouTube could be listed from its
 * public uploads feed. It cannot be any more: `youtube.com/robots.txt` disallows
 * that feed and the sanctioned replacement is authenticated (MEAL-79), and
 * Instagram and TikTok never showed us anything without a grant at all. So for
 * those three the thing that gets polled is the grant — `channelIdForCreator`
 * takes the channel id off it and refuses to derive one from a link — and
 * demanding a link as well refuses exactly the creator who connected properly.
 * Left empty the old rule stands, which is the right default for a caller that
 * has not looked.
 */
export function checkPollingInvariants(
  row: PollingRow,
  explicitOptIn = false,
  grants: readonly string[] = [],
): PollingVerdict {
  const primarySource = isPrimarySource(row.primary_source) ? row.primary_source : 'none';
  let importOptIn = row.import_opt_in === true;

  // Clearing the source turns polling off with it. Leaving an opt-in set against
  // 'none' would be a switch that means nothing today and the wrong thing the
  // day someone picks a source. A request that explicitly asks for opt-in with
  // no source is a contradiction rather than an off switch, and is refused below.
  if (primarySource === 'none' && importOptIn && !explicitOptIn) {
    importOptIn = false;
  }

  if (importOptIn) {
    // Nothing is polled until a source is chosen AND opt-in is true. Refusing
    // the incoherent combination here means the poller never has to wonder what
    // an opted-in creator with no source means.
    if (primarySource === 'none') {
      return { ok: false, error: 'Choose a source of truth before turning import on — nothing is polled without one.' };
    }
    if (!row[SOURCE_COLUMNS[primarySource]] && !grants.includes(primarySource)) {
      return {
        ok: false,
        error: isConnectedPlatform(primarySource)
          ? `This creator has neither a ${SOURCE_LABELS[primarySource]} link nor a connected ` +
            `${SOURCE_LABELS[primarySource]} account, so there is nothing to poll.`
          : `This creator has no ${SOURCE_LABELS[primarySource]} link, so there is nothing to poll.`,
      };
    }
    // For a website the feed URL *is* the thing polled, and it must be one a
    // human confirmed — that confirmation step is the whole defence against a
    // silently wrong discovery.
    if (primarySource === 'website') {
      if (!row.feed_url) {
        return { ok: false, error: 'Confirm the discovered feed URL before turning import on.' };
      }
      // The pairing, not just the feed. The admin route checks a feed URL
      // against the website as it is *stored*, which only holds the two together
      // while the website link never moves — and since MEAL-94 it does move, on
      // a request no operator sees. Judged here, on the row, the rule survives
      // whichever of the two columns changed and whichever route changed it.
      const mismatch = describeHostMismatch(String(row[SOURCE_COLUMNS.website] ?? ''), String(row.feed_url));
      if (mismatch) return { ok: false, error: mismatch };
    }
  }

  return { ok: true, importOptIn };
}

// ── What an operator needs to see on the Sources tab ─────────────────────────

export interface SourceHealthNotice {
  /** Which rule spoke, so the UI can style it without matching prose. */
  kind: 'paused' | 'feed-host';
  /** Badge text, beside the connection badges. */
  label: string;
  /** The sentence an operator reads. */
  detail: string;
  /** When it happened, ISO, or null when the rule has no moment attached. */
  at: string | null;
}

/**
 * Everything wrong with a creator's polling setup that an operator can only
 * otherwise learn by accident.
 *
 * Both entries answer a question asked long after the event. A paused import
 * currently exists as an email and a log line, so "why is this creator not being
 * polled?" three months later has no answer at all once the email is deleted —
 * hence `import_paused_reason` / `import_paused_at` and hence this. A broken
 * feed/website pairing is worse than silent: it is discoverable only by trying
 * to turn import back on and reading the 400, which is the wrong moment to find
 * out and the wrong place to explain it.
 *
 * A function rather than JSX so the rule is testable on its own and so the page
 * stays a renderer of decisions it did not make — the same split as
 * `summariseCreatorViability`.
 */
export function describeSourceHealth(row: PollingRow): SourceHealthNotice[] {
  const notices: SourceHealthNotice[] = [];

  const reason = typeof row.import_paused_reason === 'string' ? row.import_paused_reason.trim() : '';
  // Only while it is still true. An operator who has turned import back on has
  // answered the question, and a stale reason sitting beside a polling creator
  // is worse than none: it says the opposite of what the row does.
  if (reason && row.import_opt_in !== true) {
    notices.push({
      kind: 'paused',
      label: 'Import paused',
      detail: reason,
      at: typeof row.import_paused_at === 'string' ? row.import_paused_at : null,
    });
  }

  // The pairing the admin route confirmed once and nothing re-checks. Since
  // MEAL-94 a creator can move `website_url` off the host their `feed_url` sits
  // on, and the poller then reads a feed on a host that is no longer theirs —
  // every entry fails the item-level host check, the sync returns nothing, and
  // no message anywhere says why.
  const feedUrl = typeof row.feed_url === 'string' ? row.feed_url : '';
  if (feedUrl) {
    const mismatch = describeHostMismatch(String(row[SOURCE_COLUMNS.website] ?? ''), feedUrl);
    if (mismatch) {
      notices.push({
        kind: 'feed-host',
        label: 'Feed off-site',
        detail:
          `${mismatch} Confirm a feed on the current website before turning import back on — until then this row ` +
          'cannot be polled, and the admin route will refuse the switch.',
        at: null,
      });
    }
  }

  return notices;
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

// ── What a creator may choose for themselves (MEAL-101) ──────────────────────

/**
 * One entry in the creator's source picker.
 *
 * `blockedReason` travels *with* the option rather than being discovered after
 * it is picked. Instagram and TikTok are real places creators publish and both
 * are genuinely unavailable today, so leaving them out would read as "Mealio
 * does not know about Instagram" and offering them live would be a dead end
 * reached after a decision — which is the worst order to put those two things
 * in (MEAL-101). They are listed, unselectable, and say why.
 */
export interface CreatorSourceOption {
  source: PlatformSource;
  /** The dropdown's own text, reason included. One string, because an `<option>` has one. */
  label: string;
  /** Null when a creator may choose it; otherwise why not, in their terms. */
  blockedReason: string | null;
  /**
   * A caveat that belongs *after* the choice, not on it.
   *
   * Deliberately not the same field as `blockedReason` and deliberately not on
   * the option text. An option carrying a warning reads as a soft version of
   * disabled — a creator scanning a dropdown sees two greyed-looking entries and
   * stops — whereas this is about what to expect from pressing Connect, which is
   * only worth reading once Connect is what they are looking at.
   */
  note: string | null;
}

export const CREATOR_SOURCE_OPTIONS: readonly CreatorSourceOption[] = [
  { source: 'website', label: 'Website or blog', blockedReason: null, note: null },
  { source: 'youtube', label: 'YouTube', blockedReason: null, note: null },
  {
    source: 'instagram',
    label: 'Instagram — not available yet',
    blockedReason:
      'Instagram is waiting on Meta’s app review. Until they approve Mealio, Instagram hands us nothing at ' +
      'all from your account, so there would be nothing to sync.',
    note: null,
  },
  {
    source: 'tiktok',
    label: 'TikTok',
    blockedReason: null,
    /**
     * No note before the press. TikTok approved the app on 2026-08-06, so the
     * sandbox tester allow-list no longer applies and there is nothing to warn
     * about up front. A refusal is now a genuine one and is reported by the
     * callback — when it actually happens, to the creator it happened to,
     * rather than as a caveat every creator reads and most will never hit.
     */
    note: null,
  },
];

/**
 * How many of their own back-catalogue posts a creator may import in one run
 * (MEAL-101).
 *
 * Every ticked item is a real extraction — a fetch, a gate call and a model call
 * — so a hundred of them is roughly $1.60 of somebody else's money spent by
 * somebody clicking a checkbox. The creator's screen does not name a price (the
 * admin's does; a creator being shown the unit cost of their own recipes is a
 * strange thing to do to them), but the cap is visible while they tick, because
 * a limit discovered at the moment it refuses you is a limit that reads as a
 * bug.
 *
 * Here rather than in `lib/admin-sync.ts` because the picker is a client
 * component and that module reaches the import pipeline and undici — a client
 * bundle must never follow that path, so it can only ever import types from it.
 */
export const CREATOR_SELECTION_MAX = 100;

/** Why a creator cannot pick this source, or null when they can. */
export function creatorSourceBlockedReason(source: PlatformSource): string | null {
  return CREATOR_SOURCE_OPTIONS.find((option) => option.source === source)?.blockedReason ?? null;
}

/**
 * Has this creator done the thing that makes a source readable?
 *
 * A website is ready once its link is saved **and** a feed on that same site has
 * been found — which is what `POST /api/creator/website` writes after the
 * viability check has actually read posts from it. The other three are ready
 * only with an OAuth grant: they hand over nothing without one, so a link on the
 * row says where a creator publishes and nothing about what we can read.
 *
 * The same-site clause is not belt-and-braces. A creator who moves their blog
 * leaves `feed_url` pointing at the old host, and both columns are still
 * populated — so "both present" would call that ready and start polling a feed
 * that is no longer theirs.
 */
export function isCreatorSourceReady(
  row: PollingRow,
  source: PlatformSource,
  grants: readonly string[] = [],
): boolean {
  if (source === 'website') {
    const website = typeof row[SOURCE_COLUMNS.website] === 'string' ? String(row[SOURCE_COLUMNS.website]) : '';
    const feed = typeof row.feed_url === 'string' ? row.feed_url : '';
    return Boolean(website && feed) && isOnSameSite(website, feed);
  }
  return grants.includes(source);
}

/**
 * The creator's own source choice, judged and turned into columns (MEAL-101).
 *
 * `primary_source` and `import_opt_in` were an operator decision (MEAL-81) and
 * on this path they are the creator's: they pick where they publish and polling
 * starts, with no operator in the loop. **The admin route still writes both** —
 * it stopped being the only way in, it did not go away.
 *
 * Three refusals, each with its own sentence, and then the shared backstop:
 *
 *   1. Not one of the values the CHECK constraint allows. Validated against
 *      `PRIMARY_SOURCES` rather than a list written out here, so the column and
 *      this function cannot drift apart.
 *   2. A source nobody can use yet — Instagram, TikTok. The dropdown disables
 *      them, and a request is not a dropdown.
 *   3. A source they have not connected. Picking YouTube without connecting a
 *      channel would set a row the poller reads and finds nothing behind.
 *
 * `none` is always allowed and is the off switch: a creator may always stop us
 * reading them, whatever state the row is in.
 */
export function chooseCreatorSource(
  row: PollingRow,
  requested: unknown,
  grants: readonly string[] = [],
): { ok: true; update: Record<string, unknown> } | { ok: false; error: string } {
  if (!isPrimarySource(requested)) {
    return {
      ok: false,
      error:
        `"${String(requested)}" is not somewhere Mealio can sync from. Choose your website, YouTube, or ` +
        'turn syncing off.',
    };
  }

  // Off is always available. Nothing about a row can make a creator unable to
  // withdraw, and a switch that only moves one way is not consent.
  if (requested === 'none') {
    return { ok: true, update: { primary_source: 'none', import_opt_in: false } };
  }

  const blocked = creatorSourceBlockedReason(requested);
  if (blocked) return { ok: false, error: blocked };

  if (!isCreatorSourceReady(row, requested, grants)) {
    return {
      ok: false,
      error:
        requested === 'website'
          ? 'Save your website below first. Mealio reads your site and checks it can actually import recipes ' +
            'from it before it will sync from there.'
          : `Connect your ${SOURCE_LABELS[requested]} account first — ${SOURCE_LABELS[requested]} shows Mealio ` +
            'nothing until you do, so there would be nothing to sync.',
    };
  }

  // The backstop, on the row this choice would leave behind, through the same
  // function the admin picker uses. Nothing a creator can reach through the UI
  // should get here — the readiness check above covers the two cases they can
  // produce — so its verdict is reported in one plain sentence rather than the
  // operator wording, which names screens a creator cannot open.
  const verdict = checkPollingInvariants(
    { ...row, primary_source: requested, import_opt_in: true },
    true,
    grants,
  );
  if (!verdict.ok) {
    return {
      ok: false,
      error:
        'Something about your import settings does not add up, so we have not started syncing — we would ' +
        'rather stop than publish the wrong thing under your name. Get in touch and we will sort it out.',
    };
  }

  return {
    ok: true,
    update: {
      primary_source: requested,
      import_opt_in: true,
      // The creator has just answered whatever question the pause was waiting
      // for. Left behind, the Sources tab would report a paused import beside a
      // creator that is being polled, and the next operator would have to work
      // out which of the two to believe.
      import_paused_reason: null,
      import_paused_at: null,
    },
  };
}

/**
 * What went wrong with a creator's website, said to the creator (MEAL-101).
 *
 * Save runs the **full** viability check — find the feed, read real posts, ask
 * whether recipes can actually be extracted — rather than a reachability ping,
 * because "your site answered a request" is not the question anybody has. The
 * price of asking the real question is that it can fail in six different ways,
 * and a creator handed `Website could not be checked: 404 on /feed` has been
 * told nothing they can act on.
 *
 * So each failure gets a sentence naming the thing they would change. No status
 * codes, no `robots.txt` fetch traces, no talk of feeds until feeds are what
 * went wrong.
 *
 * Returns null when the site *is* importable, which includes `partial` — a blog
 * where three posts in ten are recipes works, it just syncs less often, and
 * refusing it would be Mealio deciding a creator publishes the wrong things.
 */
export interface WebsiteCheckOutcome {
  outcome: ViabilityOutcome;
  /** `ViabilityReport.reason` — the machine-readable half. Null when items were gated. */
  reason: string | null;
  /** Items the gate actually judged. */
  checked: number;
  passed: number;
}

export function describeWebsiteImportFailure(site: string, result: WebsiteCheckOutcome): string | null {
  if (result.outcome === 'viable' || result.outcome === 'partial') return null;

  if (result.outcome === 'not-viable') {
    return (
      `We read the ${result.checked} most recent ${result.checked === 1 ? 'post' : 'posts'} on ${site} and none ` +
      'of them looked like a recipe — no ingredients, no method. Mealio can only sync posts with the recipe ' +
      'written out in them. If your recipes live somewhere else on your site, or on another site, point us ' +
      'there instead.'
    );
  }

  // Ruled out before anything was fetched — Medium today. Said as a fact about
  // the platform rather than about them, because it is one, and said without a
  // "try again" they would spend the afternoon on.
  if (result.outcome === 'unsupported' && !result.reason) {
    return (
      `${site} is on a platform that blocks Mealio outright — we cannot read posts from it, and no setting on ` +
      'your side changes that. If your recipes are also on your own site, point us there instead.'
    );
  }

  switch (result.reason) {
    case 'blocked-by-robots':
      return (
        `${site} has a robots.txt file telling automated readers to stay away, and Mealio respects it. Allow ` +
        'Mealio (or automated readers generally) in that file and save this again — until then we will not ' +
        'read your posts.'
      );
    case 'blocked-by-site':
      return (
        `${site} refused to let Mealio read it at all. Some hosts block anything that is not a person with a ` +
        'browser, and there is nothing we can change from our end. If your recipes are also somewhere else — ' +
        'your own domain, a different blog — point us there instead.'
      );
    case 'unreachable':
      return (
        `We could not reach ${site}. Check the address is right and that the site is up, then save it again. ` +
        'If it is behind a login or a “coming soon” page, we cannot read it.'
      );
    case 'no-feed':
      return (
        `We could not find a feed on ${site}. Mealio follows your posts through an RSS or Atom feed — most ` +
        'blogging platforms publish one automatically, often at /feed or /rss. If yours is somewhere unusual, ' +
        'paste the feed address here instead of your homepage.'
      );
    case 'feed-off-site':
      return (
        `The feed we found is not on ${site}, so we cannot be sure it is yours — and importing somebody else's ` +
        'posts under your name is the one thing we will not risk. Paste the feed address on your own site.'
      );
    case 'no-entries':
    case 'not-a-feed':
      return (
        `We found a feed on ${site} but could not read any posts out of it. It may be empty, or in a format we ` +
        'do not understand. If you have published posts recently, send us the address and we will look.'
      );
    case 'unreadable-items':
      return (
        `We found your posts on ${site} but could not open any of them — every one we tried refused us or timed ` +
        'out. Try again in a few minutes; if it keeps happening, get in touch.'
      );
    case 'classifier-unavailable':
      return (
        'We could not finish checking your site just now — the part of Mealio that reads posts was unavailable. ' +
        'This says nothing about your site. Try again in a few minutes.'
      );
    case 'empty':
      return `We reached ${site} and found nothing posted yet. Publish a recipe and save this again.`;
    default:
      return (
        `We could not read ${site}. Check the address is right and save it again — if it keeps failing, get in ` +
        'touch and we will look at it with you.'
      );
  }
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
      'anything — the badge on that source says why.'
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
