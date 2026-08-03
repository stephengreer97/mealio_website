/**
 * Instagram: connect an account and read its captions (MEAL-82).
 *
 * This is the **Instagram API with Instagram Login** — `graph.instagram.com`,
 * the creator consents with their Instagram account, and no linked Facebook Page
 * is involved. The Facebook Login path would drag a Page, a Business Manager and
 * a second consent screen into a flow whose whole job is "let us read your
 * captions".
 *
 * Four things this file is careful about:
 *
 *   1. **One scope, and only one.** `instagram_business_basic` is what reading
 *      captions needs. Messaging, publishing and insights are not requested,
 *      because asking for a permission the review demo never exercises is a
 *      documented Meta rejection reason — and a scope we hold but do not use is
 *      access a creator gave us for nothing.
 *   2. **The caption is the whole source.** `GET /me/media` returns
 *      `media_url` — a real, downloadable video file for a Reel — but there is
 *      no transcript or caption-text field anywhere on the API, and transcribing
 *      it ourselves is a separate capability with a real per-video cost
 *      (MEAL-85). So an import sees what the creator typed. For a creator who
 *      writes the recipe out that is plenty; for one who says "recipe in the
 *      video" it is nearly nothing, and the honest outcome is to report that
 *      rather than to tune a prompt into sounding certain.
 *   3. **Professional accounts only.** A personal Instagram account has no API
 *      access at all — not a thinner version of it, none. That is a real filter
 *      on who can use this feature, so when it is the reason a connect failed we
 *      say so in the sentence the creator reads rather than returning a generic
 *      failure they cannot act on.
 *   4. **There is no refresh token.** The long-lived token *is* the thing you
 *      refresh, and only while it is still alive. See `refreshInstagramGrant` in
 *      `lib/platform-tokens.ts` — that is where the 60-day clock is handled, and
 *      the reason it has to be handled at all.
 *
 * There is no append-consent flag here, unlike `lib/youtube.ts`. Instagram
 * exposes no way to edit the caption of media posted from the app, so there is
 * no write permission to ask for and none to enforce.
 */

import type { SourceDocument } from '@/lib/import/types';
import { providerSignal, readJsonCapped } from '@/lib/provider-fetch';
import { instagramError } from '@/lib/platform-tokens';

// ── Scopes ───────────────────────────────────────────────────────────────────

/**
 * Read the account's own profile and media. The only scope we ask for.
 *
 * Meta's review asks what each permission is used for and rejects ones the demo
 * does not exercise, so the list is exactly what the feature reads.
 */
export const INSTAGRAM_BASIC_SCOPE = 'instagram_business_basic';

export const INSTAGRAM_SCOPES = [INSTAGRAM_BASIC_SCOPE];

const INSTAGRAM_AUTH_URL = 'https://www.instagram.com/oauth/authorize';
const INSTAGRAM_TOKEN_URL = 'https://api.instagram.com/oauth/access_token';
const INSTAGRAM_GRAPH = 'https://graph.instagram.com';

/** Where Instagram sends the creator back. Must match the app's registered URI exactly. */
export function instagramRedirectUri(): string {
  return `${process.env.NEXT_PUBLIC_APP_URL || 'https://mealio.co'}/api/creator/instagram/callback`;
}

/** The consent URL, or null when this deployment has no Instagram app configured. */
export function instagramAuthUrl(state: string): string | null {
  const clientId = process.env.INSTAGRAM_APP_ID;
  if (!clientId) return null;

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: instagramRedirectUri(),
    response_type: 'code',
    scope: INSTAGRAM_SCOPES.join(','),
    state,
  });
  return `${INSTAGRAM_AUTH_URL}?${params}`;
}

export interface InstagramApiOptions {
  /** Injected so tests never reach Meta. */
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface InstagramGrant {
  /** A long-lived token, ~60 days. There is no refresh token to go with it. */
  accessToken: string;
  scopes: string[];
  expiresAt: string | null;
}

/**
 * Instagram hands the authorization code back with a `#_` fragment glued to it.
 *
 * A browser strips the fragment before the request reaches us, but the app's own
 * redirect and several client libraries do not, and a code with two stray
 * characters on the end fails the exchange with an error that reads exactly like
 * a wrong client secret. Cheap to remove, expensive to diagnose.
 */
function cleanAuthCode(code: string): string {
  return code.replace(/#_$/, '');
}

/**
 * Reads the token out of both response shapes Instagram serves.
 *
 * Business Login returns `{ data: [ { access_token, user_id, permissions } ] }`;
 * the older flat `{ access_token, user_id }` is still what several documented
 * examples show. Accepting either costs four lines and removes a whole class of
 * "works in the docs, not in production".
 */
function shortLivedToken(payload: Record<string, any> | null): { accessToken: string; permissions: string } | null {
  const entry = Array.isArray(payload?.data) ? payload.data[0] : payload;
  if (!entry || typeof entry.access_token !== 'string') return null;
  return {
    accessToken: entry.access_token,
    permissions: typeof entry.permissions === 'string' ? entry.permissions : '',
  };
}

/** Instagram's permissions come back comma-separated; every other provider uses spaces. */
function parsePermissions(value: string): string[] {
  return value.split(/[,\s]+/).filter(Boolean);
}

/**
 * Swaps the authorization code for a **long-lived** token, in two calls.
 *
 * The code exchange yields a token that lives one hour, which is useless for a
 * poller that runs daily. The second call trades it for the ~60-day token, and
 * doing that here rather than "later" is deliberate: there is no second chance —
 * once the short-lived token lapses the creator has to consent again.
 *
 * `api.instagram.com` and `graph.instagram.com` are fixed hosts of ours, not
 * URLs a creator supplied, so these are plain fetches. The guarded fetcher
 * exists for destinations an outsider chose and cannot carry credentials anyway.
 */
export async function exchangeInstagramCode(
  code: string,
  options: InstagramApiOptions = {},
): Promise<{ ok: true; grant: InstagramGrant } | { ok: false; detail: string }> {
  const clientId = process.env.INSTAGRAM_APP_ID;
  const clientSecret = process.env.INSTAGRAM_APP_SECRET;
  if (!clientId || !clientSecret) {
    return { ok: false, detail: 'Instagram connection is not configured on this deployment.' };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;

  let response: Response;
  try {
    response = await fetchImpl(INSTAGRAM_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'authorization_code',
        redirect_uri: instagramRedirectUri(),
        code: cleanAuthCode(code),
      }),
      signal: providerSignal(),
    });
  } catch (err) {
    return { ok: false, detail: `Instagram did not answer: ${err instanceof Error ? err.message : String(err)}` };
  }

  const payload = await readJsonCapped(response);
  const short = shortLivedToken(payload);
  if (!response.ok || !short) {
    return { ok: false, detail: `Instagram refused the authorization code (HTTP ${response.status}).` };
  }

  // ── Short-lived → long-lived ──────────────────────────────────────────────
  const exchange = new URLSearchParams({
    grant_type: 'ig_exchange_token',
    client_secret: clientSecret,
    access_token: short.accessToken,
  });

  let longLived: Response;
  try {
    longLived = await fetchImpl(`${INSTAGRAM_GRAPH}/access_token?${exchange}`, { signal: providerSignal() });
  } catch (err) {
    return { ok: false, detail: `Instagram did not answer: ${err instanceof Error ? err.message : String(err)}` };
  }

  const longPayload = await readJsonCapped(longLived);
  if (!longLived.ok || typeof longPayload?.access_token !== 'string') {
    return {
      ok: false,
      detail:
        'Instagram would not issue a long-lived token for that account. The one-hour token it did issue is ' +
        'no use to a daily poller, so nothing was stored — try connecting again.',
    };
  }

  const expiresIn = typeof longPayload.expires_in === 'number' ? longPayload.expires_in : null;

  // The permissions Instagram actually granted, verbatim, and **no fallback**.
  //
  // There used to be one: an empty list became `INSTAGRAM_SCOPES`, on the
  // reasoning that an empty `scopes` column reads as "granted nothing". It reads
  // that way because that is what `permissions: ''` means — it is Meta's way of
  // saying the creator ticked nothing — and the callback gates on this very
  // value. Substituting the list we *asked* for made the gate check our own
  // request against itself, so the "connect again and leave the permission
  // ticked" branch could not be reached, and the row was written claiming a
  // scope nobody had verified. TikTok takes its scopes straight off the token
  // response with no fallback; so does this now.
  const granted = parsePermissions(short.permissions);

  return {
    ok: true,
    grant: {
      accessToken: longPayload.access_token,
      scopes: granted,
      expiresAt: expiresIn === null ? null : new Date(now() + expiresIn * 1000).toISOString(),
    },
  };
}

// ── The account behind a grant ───────────────────────────────────────────────

export type InstagramAccountType = 'BUSINESS' | 'MEDIA_CREATOR' | 'PERSONAL' | null;

export interface InstagramAccount {
  /** The Instagram-scoped user id. From the grant, never typed by a creator. */
  id: string;
  username: string | null;
  /** Null when the field was not returned, which is not the same as "personal". */
  accountType: InstagramAccountType;
}

/**
 * The account a grant belongs to.
 *
 * The id comes from `/me`, so a creator can neither mistype it nor claim someone
 * else's account — the same rule the YouTube channel id follows.
 *
 * A **personal** account is rejected here with the real reason. Instagram gives
 * personal accounts no API access whatsoever, so the alternative is storing a
 * connection that will return nothing forever while the portal shows a green
 * "Connected" badge — the precise failure this whole area of the codebase is
 * built to avoid. A missing `account_type` is treated as fine: it is not always
 * returned, and refusing on a field's absence would reject working accounts.
 */
export async function fetchInstagramAccount(
  accessToken: string,
  options: InstagramApiOptions = {},
): Promise<{ ok: true; account: InstagramAccount } | { ok: false; detail: string }> {
  const fetchImpl = options.fetchImpl ?? fetch;

  const query = new URLSearchParams({ fields: 'user_id,username,account_type', access_token: accessToken });

  let response: Response;
  try {
    response = await fetchImpl(`${INSTAGRAM_GRAPH}/me?${query}`, { signal: providerSignal() });
  } catch (err) {
    return { ok: false, detail: `Instagram did not answer: ${err instanceof Error ? err.message : String(err)}` };
  }

  const payload = await readJsonCapped(response);
  if (!response.ok) {
    return { ok: false, detail: `Instagram refused the account lookup (HTTP ${response.status}).` };
  }

  // `user_id` is what the Instagram Login API returns; `id` is what the older
  // documentation shows. Either is the id every later call is keyed on.
  const id = payload?.user_id ?? payload?.id;
  if (id === undefined || id === null || String(id).length === 0) {
    return { ok: false, detail: 'Instagram returned no account for that grant. Try connecting again.' };
  }

  const accountType = typeof payload?.account_type === 'string' ? (payload.account_type as InstagramAccountType) : null;
  if (accountType === 'PERSONAL') {
    return {
      ok: false,
      detail:
        'That is a personal Instagram account, and Instagram gives personal accounts no API access at all — ' +
        'so there is nothing we could read from it. Switch the account to Professional (Business or Creator) ' +
        'in the Instagram app, then connect again.',
    };
  }

  return {
    ok: true,
    account: {
      id: String(id),
      username: typeof payload?.username === 'string' ? payload.username : null,
      accountType,
    },
  };
}

// ── Media ────────────────────────────────────────────────────────────────────

export type InstagramMediaType = 'IMAGE' | 'VIDEO' | 'CAROUSEL_ALBUM' | string;

export interface InstagramMedia {
  id: string;
  /** What the creator typed. The only recipe text this API will ever give us. */
  caption: string;
  mediaType: InstagramMediaType;
  /**
   * A time-limited CDN link to the file itself. Nothing reads it today — it is
   * the seam transcription (MEAL-85) would plug into, and it is deliberately
   * never stored, because a URL that expires is worse in a database than absent.
   */
  mediaUrl: string | null;
  /** The public post URL. What gets recorded as the item's `url`. */
  permalink: string;
  publishedAt: string | null;
}

/**
 * How much of an account one listing reads.
 *
 * Two pages of 50. Enough that an operator opening a catalog sees a real back
 * catalog rather than last week, bounded so that drawing a screen is a couple of
 * requests rather than a crawl of someone's entire Instagram history.
 */
export const INSTAGRAM_MEDIA_MAX = 100;
const INSTAGRAM_PAGE_SIZE = 50;

/**
 * Page ceiling, bounded independently of the item budget.
 *
 * A page can come back shorter than the size asked for, so "items wanted
 * divided by page size" is a floor on the pages needed and not a bound on them.
 * A `next` link that always points somewhere is a loop, and this runs inside a
 * function timeout — so the loop gets its own limit.
 */
const INSTAGRAM_MAX_PAGES = 4;

/** Well past Instagram's own 2,200-character caption limit. */
const MAX_CAPTION_CHARS = 10_000;

/** The first line of a caption, which is what a human recognises a post by. */
const MAX_TITLE_CHARS = 300;

export type InstagramMediaResult =
  | { ok: true; media: InstagramMedia[]; truncated: boolean }
  | { ok: false; detail: string };

function toMedia(row: Record<string, any>): InstagramMedia | null {
  if (typeof row?.id !== 'string' || typeof row?.permalink !== 'string') return null;
  const timestamp = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : NaN;
  return {
    id: row.id,
    caption: typeof row.caption === 'string' ? row.caption.slice(0, MAX_CAPTION_CHARS) : '',
    mediaType: typeof row.media_type === 'string' ? row.media_type : 'IMAGE',
    mediaUrl: typeof row.media_url === 'string' ? row.media_url : null,
    permalink: row.permalink,
    publishedAt: Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null,
  };
}

/**
 * The account's recent media, newest first.
 *
 * Paged by cursor rather than by offset because Instagram's own paging is
 * cursor-based and an offset walk over a feed that is being posted to skips and
 * duplicates items. The page loop is bounded by the item budget *and* by a page
 * ceiling: a `next` link that always points somewhere is a loop, and this runs
 * inside a request with a function timeout.
 */
export async function fetchInstagramMedia(
  accessToken: string,
  options: InstagramApiOptions & { limit?: number } = {},
): Promise<InstagramMediaResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const limit = Math.max(1, Math.min(options.limit ?? INSTAGRAM_MEDIA_MAX, INSTAGRAM_MEDIA_MAX));

  const media: InstagramMedia[] = [];
  let after: string | null = null;

  for (let page = 0; page < INSTAGRAM_MAX_PAGES; page++) {
    const query = new URLSearchParams({
      fields: 'id,caption,media_type,media_url,permalink,timestamp',
      limit: String(Math.min(INSTAGRAM_PAGE_SIZE, limit - media.length)),
      access_token: accessToken,
    });
    if (after) query.set('after', after);

    let response: Response;
    try {
      response = await fetchImpl(`${INSTAGRAM_GRAPH}/me/media?${query}`, { signal: providerSignal() });
    } catch (err) {
      return { ok: false, detail: `Instagram did not answer: ${err instanceof Error ? err.message : String(err)}` };
    }

    const payload = await readJsonCapped(response);
    if (!response.ok || !Array.isArray(payload?.data)) {
      // Meta's own sentence is the useful half — an expired token and a revoked
      // app say different things here and an operator acts differently on each.
      // Both envelopes, for the reason `instagramError` gives.
      const { message } = instagramError(payload, response.status);
      return { ok: false, detail: `Instagram refused to list this account's media: ${message}` };
    }

    for (const row of payload.data as Array<Record<string, any>>) {
      const item = toMedia(row);
      if (item) media.push(item);
      if (media.length >= limit) break;
    }

    after = typeof payload?.paging?.cursors?.after === 'string' ? payload.paging.cursors.after : null;
    // No `next` means this was the last page. A cursor with no `next` beside it
    // is the end of the feed, not an invitation to ask again.
    if (media.length >= limit || !after || typeof payload?.paging?.next !== 'string') break;
  }

  // An empty account is reported as a success with nothing in it, because that
  // is what it is. This used to return `ok: false` with a detail saying in as
  // many words that it was "an answer, not a failure" — and every caller then
  // treated it as one: the catalogs labelled it `reason: 'unreachable'` and the
  // viability probes turned it into a probe failure. That is the same conflation
  // `notConnectedCatalog` exists to prevent, applied in reverse. Telling the two
  // apart is the caller's job, and `media.length` is how.
  return { ok: true, media, truncated: media.length >= limit };
}

// ── The source document ──────────────────────────────────────────────────────

/**
 * A title for a post that has none.
 *
 * Instagram media carry no title field, so the first line of the caption is
 * used — which is what a creator scanning a catalog recognises the post by.
 * Falling back to the permalink keeps every row identifiable rather than
 * printing a blank.
 */
export function instagramMediaTitle(media: InstagramMedia): string {
  const firstLine = media.caption.split('\n').map((line) => line.trim()).find(Boolean);
  return (firstLine ?? media.permalink).slice(0, MAX_TITLE_CHARS);
}

/**
 * A post as the gate and the extractor consume it: `{ title, text }`.
 *
 * The caption is the entire document. There are no captions to fall back on, no
 * JSON-LD, and no transcript — so unlike YouTube there is no second source to
 * try when the first is thin, and `hasRecipeText` below is how a caller tells
 * "the creator wrote nothing" apart from "the gate said no".
 */
export function instagramSourceDocument(media: InstagramMedia): SourceDocument {
  const text = media.caption.trim();
  return {
    url: media.permalink,
    title: instagramMediaTitle(media),
    text,
    // No comment rails or related-post furniture on a caption, so MEAL-72
    // verifies evidence against exactly the same text.
    recipeText: text,
    jsonLd: null,
    structuredSource: null,
    jsonLdRaw: null,
    // Deliberately not `media_url`: that link expires within hours, and a photo
    // the draft points at which 404s tomorrow is worse than no photo.
    imageUrl: null,
    platform: 'instagram',
  };
}

/**
 * Is there enough here for the gate's verdict to be about the creator?
 *
 * An empty caption means we read nothing, and calling that "not a recipe" would
 * measure our access rather than their post — the same distinction the YouTube
 * probe makes for a video with neither description nor captions. A *short*
 * caption is still evidence and is gated normally; the gate has its own thin
 * content handling.
 */
export function hasRecipeText(media: InstagramMedia): boolean {
  return media.caption.trim().length > 0;
}

/**
 * The sentence shown for a post we could not read.
 *
 * It names the reason and the ticket, because "nothing came out of this Reel" is
 * a fact about Instagram's API rather than about the creator, and an operator
 * reading a viability report needs to be able to tell those apart.
 */
export const INSTAGRAM_NO_CAPTION_DETAIL =
  'Not gated: this post has no caption, and Instagram exposes no transcript for the video. ' +
  'Reading the spoken recipe would need transcription, which is MEAL-85 and is not built.';
