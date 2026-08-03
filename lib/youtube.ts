/**
 * YouTube: connect a channel, list it, read a video (MEAL-74).
 *
 * Video needs the creator's cooperation, and for partnered creators that is a
 * feature rather than a workaround. Captions are owner-only — `captions.download`
 * requires OAuth from the channel owner, and third-party transcript scrapers are
 * against YouTube's terms, so we do not use one (same decision as MEAL-33).
 *
 * Three things this file is careful about:
 *
 *   1. **Listing a channel costs quota, and is bounded because of it.** The
 *      uploads feed at `youtube.com/feeds/videos.xml?channel_id=…` used to make
 *      listing free, and it is gone: `youtube.com/robots.txt` carries
 *      `Disallow: /feeds/videos.xml` under `User-agent: *`, so the cheap rung is
 *      one YouTube asks us not to take (decided on MEAL-74, 2026-08-02). The
 *      sanctioned replacement is `playlistItems.list` against the channel's
 *      uploads playlist — which needs a grant, and spends units out of a shared
 *      10,000/day budget. See `listUploads` for what that changed.
 *   2. **Description first, captions second.** Creators routinely list
 *      ingredients in the description; it is clean text and it beats ASR on
 *      quantities, which are exactly what a recipe needs. Captions are the
 *      fallback, they cost real quota, and they are only ever fetched for a video
 *      whose description is too thin for the gate to judge.
 *   3. **The channel id comes from the grant.** A creator is never asked to type
 *      one. `resolveChannelId` reads it off their own channel page for the one
 *      case the grant cannot answer — a connection stored without a channel id —
 *      and that page is a creator-supplied URL, so it goes through the guarded
 *      fetcher like any other.
 *
 * The write half is MEAL-78/79: `assertAppendAllowed` is the single consent gate
 * both must go through, and `updateVideoDescription` is the only thing here that
 * writes to a creator's channel at all.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { THIN_CONTENT_CHARS } from '@/lib/import/gate';
import { MAX_TEXT_CHARS } from '@/lib/import/html';
import { providerSignal, readJsonCapped } from '@/lib/provider-fetch';
import { checkRobots } from '@/lib/import/robots';
import { safeFetch, type LookupFn, type SafeFetchOptions } from '@/lib/import/ssrf';
import { loadConnection, type PlatformConnection } from '@/lib/platform-tokens';
import type { SourceDocument } from '@/lib/import/types';

// ── Scopes ───────────────────────────────────────────────────────────────────

/** Reading the channel's own metadata and playlists. */
export const YOUTUBE_READ_SCOPE = 'https://www.googleapis.com/auth/youtube.readonly';

/**
 * The write scope, requested at connect time even though nothing here writes.
 *
 * MEAL-78 and MEAL-79 both append the Mealio link to a video's description, and
 * `captions.download` needs it too. Adding a scope later re-prompts every creator
 * who already connected — a second consent screen for people who thought they
 * were done — and the ones who ignore it break the feature silently. Ask once.
 *
 * Asking for it does **not** authorise using it: `creators.youtube_append_opt_in`
 * decides that, separately and explicitly, and defaults to false.
 */
export const YOUTUBE_WRITE_SCOPE = 'https://www.googleapis.com/auth/youtube.force-ssl';

export const YOUTUBE_SCOPES = [YOUTUBE_READ_SCOPE, YOUTUBE_WRITE_SCOPE];

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const YOUTUBE_API = 'https://www.googleapis.com/youtube/v3';

/** Where Google sends the creator back. Must match a redirect URI on the OAuth client. */
export function youtubeRedirectUri(): string {
  return `${process.env.NEXT_PUBLIC_APP_URL || 'https://mealio.co'}/api/creator/youtube/callback`;
}

/**
 * The consent URL.
 *
 * `access_type=offline` with `prompt=consent` is what makes Google hand back a
 * refresh token. Without the forced prompt a creator who has consented before
 * gets an access token and no refresh token, and the connection dies an hour
 * later with nothing to renew it — which is precisely the silent failure the
 * refresh sweep exists to make visible.
 */
export function youtubeAuthUrl(state: string): string | null {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) return null;

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: youtubeRedirectUri(),
    response_type: 'code',
    scope: YOUTUBE_SCOPES.join(' '),
    state,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
  });
  return `${GOOGLE_AUTH_URL}?${params}`;
}

export interface GoogleGrant {
  accessToken: string;
  refreshToken: string | null;
  scopes: string[];
  expiresAt: string | null;
}

export interface GoogleApiOptions {
  /** Injected so tests never reach Google. */
  fetchImpl?: typeof fetch;
  now?: () => number;
  /**
   * DNS seam for the one call here that goes through the guarded fetcher — the
   * caption download. Injected so a test never resolves a name.
   */
  lookup?: LookupFn;
}

/**
 * Swaps the authorization code for tokens.
 *
 * `googleapis.com` is a fixed host of ours, not something a creator supplied, so
 * this is a plain fetch — the guarded fetcher exists for URLs whose destination
 * an outsider chose, and it cannot carry the credentials these calls need.
 */
export async function exchangeYouTubeCode(
  code: string,
  options: GoogleApiOptions = {},
): Promise<{ ok: true; grant: GoogleGrant } | { ok: false; detail: string }> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return { ok: false, detail: 'Google OAuth is not configured on this deployment.' };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;

  let response: Response;
  try {
    response = await fetchImpl(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: youtubeRedirectUri(),
        grant_type: 'authorization_code',
      }),
    });
  } catch (err) {
    return { ok: false, detail: `Google did not answer: ${err instanceof Error ? err.message : String(err)}` };
  }

  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok || typeof payload?.access_token !== 'string') {
    return { ok: false, detail: `Google refused the authorization code (HTTP ${response.status}).` };
  }

  const expiresIn = typeof payload.expires_in === 'number' ? payload.expires_in : null;
  const scopes = typeof payload.scope === 'string' ? payload.scope.split(/\s+/).filter(Boolean) : [];

  return {
    ok: true,
    grant: {
      accessToken: payload.access_token,
      refreshToken: typeof payload.refresh_token === 'string' ? payload.refresh_token : null,
      scopes,
      expiresAt: expiresIn === null ? null : new Date(now() + expiresIn * 1000).toISOString(),
    },
  };
}

export interface YouTubeChannel {
  id: string;
  title: string | null;
}

/**
 * The channel behind a grant.
 *
 * `mine=true` is the whole point: the id comes from the token, so a creator can
 * neither mistype it nor claim someone else's channel. A grant that owns no
 * channel is a Google account with no YouTube presence, which is a real thing to
 * tell them rather than an error to log.
 */
export async function fetchOwnChannel(
  accessToken: string,
  options: GoogleApiOptions = {},
): Promise<{ ok: true; channel: YouTubeChannel } | { ok: false; detail: string }> {
  const fetchImpl = options.fetchImpl ?? fetch;

  let response: Response;
  try {
    response = await fetchImpl(`${YOUTUBE_API}/channels?part=snippet&mine=true`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
  } catch (err) {
    return { ok: false, detail: `YouTube did not answer: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (!response.ok) {
    return { ok: false, detail: `YouTube refused the channel lookup (HTTP ${response.status}).` };
  }

  const payload = (await response.json().catch(() => null)) as Record<string, any> | null;
  const item = Array.isArray(payload?.items) ? payload.items[0] : null;
  if (!item || typeof item.id !== 'string') {
    return {
      ok: false,
      detail: 'That Google account has no YouTube channel. Sign in with the account that owns the channel.',
    };
  }

  return { ok: true, channel: { id: item.id, title: item.snippet?.title ?? null } };
}

// ── Channel ids ──────────────────────────────────────────────────────────────

/** Google's channel ids are a fixed shape, and everything downstream trusts this. */
const CHANNEL_ID_RE = /^UC[A-Za-z0-9_-]{22}$/;

export function isChannelId(value: unknown): value is string {
  return typeof value === 'string' && CHANNEL_ID_RE.test(value);
}

/** The only hosts a channel id may be read off. Subdomains included: `m.`, `www.`. */
const YOUTUBE_HOSTS = /^(.+\.)?(youtube\.com|youtu\.be)$/i;

export function isYouTubeHost(link: string): boolean {
  try {
    return YOUTUBE_HOSTS.test(new URL(link).hostname);
  } catch {
    return false;
  }
}

/** A `/channel/UC…` link answers without a request. Every other shape does not. */
export function channelIdFromUrl(link: string): string | null {
  try {
    const path = new URL(link).pathname.split('/').filter(Boolean);
    const index = path.indexOf('channel');
    const candidate = index >= 0 ? path[index + 1] : undefined;
    return isChannelId(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

/**
 * The channel id for a creator-supplied YouTube link.
 *
 * `/@handle`, `/c/name` and `/user/name` carry no id, so the channel page is
 * read and the id taken off its canonical link. That page is a URL a creator
 * chose, which is why it goes through `safeFetch` — the same treatment any other
 * creator-supplied link gets.
 *
 * The fallback, and only the fallback. A connected channel's id comes off the
 * grant, because a page can say anything and a token cannot — this runs for the
 * one case the grant cannot answer, a connection stored without a channel id on
 * it. It is no longer a way to list a channel nobody has connected: that needed
 * the uploads feed, and `youtube.com/robots.txt` disallows it (MEAL-79).
 */
export async function resolveChannelId(
  link: string,
  fetchOptions?: SafeFetchOptions,
): Promise<{ ok: true; channelId: string } | { ok: false; detail: string }> {
  const direct = channelIdFromUrl(link);
  if (direct) return { ok: true, channelId: direct };

  // The id is taken from whatever the page says, so the page has to be one
  // YouTube served. Without this, a creator whose `youtube_url` points at a
  // site they control can emit `"channelId":"UC…"` for somebody else's channel
  // and have the catalog list that person's videos under their own name.
  if (!isYouTubeHost(link)) {
    return {
      ok: false,
      detail: `${link} is not a youtube.com link, so no channel id can be read from it.`,
    };
  }

  // This is a crawl of a page nobody invited us to read, so it is subject to
  // robots.txt like every other page fetch in this codebase. YouTube allows
  // channel pages; a future Disallow should stop us rather than be discovered
  // by someone else.
  const allowed = await checkRobots(link, fetchOptions);
  if (!allowed.allowed) return { ok: false, detail: allowed.detail };

  const fetched = await safeFetch(link, fetchOptions);
  if (!fetched.ok) {
    return { ok: false, detail: `Could not read ${link}: ${fetched.detail}` };
  }

  // Both shapes YouTube serves: the canonical link on a rendered page, and the
  // `channelId` field in the embedded config. Bounded patterns — the body is 2 MB
  // of someone else's markup.
  const canonical = /<link[^>]{0,200}?rel=["']canonical["'][^>]{0,200}?href=["'][^"']{0,200}?\/channel\/(UC[A-Za-z0-9_-]{22})/i.exec(fetched.html);
  const embedded = /"(?:channelId|externalId)":"(UC[A-Za-z0-9_-]{22})"/.exec(fetched.html);
  const channelId = canonical?.[1] ?? embedded?.[1] ?? null;

  if (!channelId) {
    return {
      ok: false,
      detail:
        `${link} did not name a channel id, so there is nothing to list. Use the channel's ` +
        '`/channel/UC…` link, or connect the channel so the id comes from the grant.',
    };
  }
  return { ok: true, channelId };
}

// ── Quota ────────────────────────────────────────────────────────────────────

/**
 * What each Data API call costs, in units, against a project default of
 * **10,000 units per day** shared by every creator we read or write for.
 *
 * Listing used to be free — one unauthenticated request to the uploads feed,
 * whatever the channel size. It is not free any more (see the file header), so
 * the numbers are named here rather than left implicit: every path that spends
 * them reports what it spent, and the operator screen shows it. A ceiling nobody
 * can see is a ceiling somebody exhausts on a Tuesday afternoon.
 *
 * `videos.update` is the outlier at 50 — writing to a creator's description is
 * two hundred times the price of reading a page of their catalogue, which is its
 * own argument for never issuing one we do not need.
 */
export const YOUTUBE_QUOTA = {
  channelsList: 1,
  playlistItemsList: 1,
  videosList: 1,
  videosUpdate: 50,
} as const;

// ── The uploads playlist ─────────────────────────────────────────────────────

export interface YouTubeVideo {
  videoId: string;
  url: string;
  title: string | null;
  /** The full description, newlines intact. Empty when the listing carried none. */
  description: string;
  publishedAt: string | null;
  thumbnailUrl: string | null;
  /**
   * Whose channel the video is on.
   *
   * Carried because the back catalogue reads selected videos **by id**, and an
   * id is a number in a request body. Without this, a hand-edited selection
   * naming somebody else's video would be read, extracted and published under
   * this creator's name — the outcome MEAL-77 exists to prevent. Null only when
   * a listing did not say, which is never a match.
   */
  channelId: string | null;
}

/**
 * Items per `playlistItems.list` page, and the API's own maximum.
 *
 * One page is one unit — two with the playlist lookup in front of it — so this
 * is the granularity of the spend as much as of the screen: a window of 50 costs
 * 2, and a 300-video channel costs 7 to walk end to end.
 */
export const UPLOADS_PAGE_SIZE = 50;

/** Well past YouTube's own 5,000-character description limit. */
const MAX_DESCRIPTION_CHARS = 20_000;
const MAX_TITLE_CHARS = 300;

/** YouTube's own ceiling on a description. Longer bodies are rejected outright. */
export const YOUTUBE_DESCRIPTION_MAX = 5_000;

/** The shape of a video id everything downstream trusts. */
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{6,20}$/;

/**
 * A page cursor as YouTube issues them, and the only shape we will send back.
 *
 * The token arrives from the client — the operator pressed "load more" and the
 * browser echoed what the last response carried. That is safe in a way worth
 * writing down: the *playlist* is resolved server-side from the grant, so a
 * forged cursor can only move the window within this creator's own uploads, or
 * be rejected by YouTube. It is shape-checked anyway, because an unbounded
 * string from a request body has no business being interpolated into a URL.
 */
const PAGE_TOKEN_RE = /^[A-Za-z0-9_\-=.]{1,256}$/;

export function isUploadsPageToken(value: unknown): value is string {
  return typeof value === 'string' && PAGE_TOKEN_RE.test(value);
}

function toIso(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

/** The largest thumbnail YouTube offered, in the order it offers them. */
function bestThumbnail(thumbnails: Record<string, any> | undefined | null): string | null {
  for (const size of ['maxres', 'standard', 'high', 'medium', 'default']) {
    const url = thumbnails?.[size]?.url;
    if (typeof url === 'string' && url) return url;
  }
  return null;
}

function toVideo(videoId: string, snippet: Record<string, any>, publishedAt: unknown): YouTubeVideo {
  const title = typeof snippet.title === 'string' ? snippet.title : '';
  const description = typeof snippet.description === 'string' ? snippet.description : '';
  return {
    videoId,
    // Built from the id rather than taken from the payload: the URL is what we
    // later fetch, record and show, and one derived from a validated id cannot
    // point anywhere but at the video it claims to be.
    url: `https://www.youtube.com/watch?v=${videoId}`,
    title: title.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE_CHARS) || null,
    // Newlines survive. A description is where the ingredient list lives, one
    // per line, and "1 cup flour 2 eggs 200g butter" is not a list any more.
    description: description.slice(0, MAX_DESCRIPTION_CHARS),
    publishedAt: toIso(publishedAt) ?? toIso(snippet.publishedAt),
    thumbnailUrl: bestThumbnail(snippet.thumbnails),
    // `videoOwnerChannelId` is the video's own channel; `channelId` on a
    // playlistItem is the playlist owner's. They agree on an uploads playlist
    // and would not on a curated one, so the specific field wins.
    channelId:
      typeof snippet.videoOwnerChannelId === 'string'
        ? snippet.videoOwnerChannelId
        : typeof snippet.channelId === 'string'
          ? snippet.channelId
          : null,
  };
}

/**
 * One authenticated Data API GET, as JSON, with a timeout and a byte cap.
 *
 * `googleapis.com` is a fixed host of ours rather than something a creator
 * supplied, so this does not go through the guarded fetcher — that exists for
 * destinations an outsider chose and cannot carry the credentials these calls
 * need. The two things it *did* provide are kept: a wall-clock deadline and a
 * bounded body, both of which matter here because these run inside a function
 * timeout (see `lib/provider-fetch.ts`).
 */
async function youtubeGet(
  path: string,
  params: Record<string, string>,
  accessToken: string,
  options: GoogleApiOptions,
): Promise<{ ok: true; payload: Record<string, any> } | { ok: false; detail: string }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const query = new URLSearchParams(params);

  let response: Response;
  try {
    response = await fetchImpl(`${YOUTUBE_API}/${path}?${query}`, {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: providerSignal(),
    });
  } catch (err) {
    return { ok: false, detail: `YouTube did not answer: ${err instanceof Error ? err.message : String(err)}` };
  }

  const payload = await readJsonCapped(response);
  if (!response.ok || !payload) {
    // Google's own sentence is the useful half: a revoked grant, a disabled API
    // and an exhausted quota all arrive as an HTTP error and an operator does
    // something different about each.
    const reason = typeof payload?.error?.message === 'string' ? ` ${payload.error.message}` : '';
    return { ok: false, detail: `YouTube refused the request (HTTP ${response.status}).${reason}` };
  }
  return { ok: true, payload };
}

/**
 * The channel's uploads playlist id.
 *
 * Read from `contentDetails.relatedPlaylists.uploads` rather than derived by
 * rewriting `UC…` to `UU…`. The rewrite is true of every channel anyone has
 * looked at and saves a unit, and it is still an assumption about somebody
 * else's id scheme standing in for a field they publish. One unit is the price
 * of not making it.
 */
async function uploadsPlaylistId(
  accessToken: string,
  channelId: string,
  options: GoogleApiOptions,
): Promise<{ ok: true; playlistId: string } | { ok: false; detail: string }> {
  const result = await youtubeGet('channels', { part: 'contentDetails', id: channelId }, accessToken, options);
  if (!result.ok) return result;

  const item = Array.isArray(result.payload.items) ? result.payload.items[0] : null;
  const playlistId = item?.contentDetails?.relatedPlaylists?.uploads;
  if (typeof playlistId !== 'string' || !playlistId) {
    return {
      ok: false,
      detail:
        `YouTube returned no uploads playlist for channel ${channelId}. That is what a channel with no ` +
        'uploads looks like, and it is also what a grant for a different account looks like — ask the ' +
        'creator to reconnect if they do have videos.',
    };
  }
  return { ok: true, playlistId };
}

export interface UploadsOptions extends GoogleApiOptions {
  /** Cursor from a previous window. Absent means start at the most recent upload. */
  pageToken?: string | null;
  /** Videos this call may return. Defaults to one page. */
  limit?: number;
}

export type UploadsResult =
  | {
      ok: true;
      channelId: string;
      videos: YouTubeVideo[];
      /** Cursor for the next window, or null at the end of the catalogue. */
      nextPageToken: string | null;
      /** Units this call spent. Reported because the budget is shared and finite. */
      quotaUnits: number;
    }
  | { ok: false; detail: string };

/**
 * One bounded window of a channel's back catalogue, newest first (MEAL-79).
 *
 * This replaces `readUploadsFeed`, and the two differences are the whole point
 * of the ticket:
 *
 *   - **It pages.** The feed returned roughly the 15 most recent uploads and had
 *     no next page, which is right for a poller asking "anything new?" and wrong
 *     for a back catalogue: a creator with 300 recipe videos showed 15.
 *   - **It needs a grant.** `playlistItems.list` is an authenticated call, so a
 *     channel cannot be listed — or measured — before its owner has connected.
 *     Callers must report that as *not measurable*, never as an empty catalogue;
 *     "this creator publishes nothing" is the one thing an empty list must not be
 *     allowed to mean.
 *
 * **One call lists one page.** There is no loop here, deliberately: a loop is how
 * a screen being opened turns into a crawl of somebody's entire YouTube history,
 * and nobody agreed to spend six units of a shared daily budget because a tab was
 * opened. The operator asks for the next window by pressing a button, and
 * `nextPageToken` is how they can. The cost of that choice is honest and small —
 * a page thinned by private videos comes back short rather than being topped up
 * from the next one.
 *
 * Private and deleted entries are dropped rather than listed. They sit in every
 * uploads playlist as placeholders with no readable title, and an operator
 * ticking one would spend a run on a video nothing can read.
 */
export async function listUploads(
  accessToken: string,
  channelId: string,
  options: UploadsOptions = {},
): Promise<UploadsResult> {
  if (!isChannelId(channelId)) {
    return { ok: false, detail: `"${channelId}" is not a YouTube channel id.` };
  }
  if (options.pageToken != null && !isUploadsPageToken(options.pageToken)) {
    return { ok: false, detail: 'That is not a page cursor YouTube issued.' };
  }

  const limit = Math.max(1, Math.min(options.limit ?? UPLOADS_PAGE_SIZE, UPLOADS_PAGE_SIZE));

  const playlist = await uploadsPlaylistId(accessToken, channelId, options);
  if (!playlist.ok) return playlist;

  const params: Record<string, string> = {
    // `contentDetails` carries the video id and the date it was *published*,
    // which is not the date it was added to the playlist. `status` is how a
    // private placeholder is recognised. Extra parts cost no extra units.
    part: 'snippet,contentDetails,status',
    playlistId: playlist.playlistId,
    maxResults: String(limit),
  };
  if (options.pageToken) params.pageToken = options.pageToken;

  const result = await youtubeGet('playlistItems', params, accessToken, options);
  if (!result.ok) return result;

  const videos: YouTubeVideo[] = [];
  const items: Array<Record<string, any>> = Array.isArray(result.payload.items) ? result.payload.items : [];
  for (const item of items) {
    const videoId = item?.contentDetails?.videoId;
    if (typeof videoId !== 'string' || !VIDEO_ID_RE.test(videoId)) continue;
    if (item?.status?.privacyStatus === 'private') continue;
    videos.push(toVideo(videoId, item.snippet ?? {}, item?.contentDetails?.videoPublishedAt));
  }

  const next = typeof result.payload.nextPageToken === 'string' ? result.payload.nextPageToken : null;

  // An empty window is reported as a success with nothing in it, because that is
  // what it is. Telling "this channel has no uploads" apart from "we could not
  // read it" is the caller's job, and `videos.length` is how.
  return {
    ok: true,
    channelId,
    videos,
    nextPageToken: isUploadsPageToken(next) ? next : null,
    quotaUnits: YOUTUBE_QUOTA.channelsList + YOUTUBE_QUOTA.playlistItemsList,
  };
}

// ── Reading specific videos ──────────────────────────────────────────────────

/** Ids per `videos.list` call, and the API's own maximum. One unit per call. */
export const VIDEOS_LIST_CHUNK = 50;

/** Chunks one `fetchVideos` may issue. 500 ids matches the catalog's own ceiling. */
const VIDEOS_MAX_CHUNKS = 10;

async function videosList(
  accessToken: string,
  videoIds: string[],
  options: GoogleApiOptions,
): Promise<{ ok: true; items: Array<Record<string, any>>; quotaUnits: number } | { ok: false; detail: string }> {
  const ids = videoIds.filter((id) => VIDEO_ID_RE.test(id));
  if (ids.length === 0) return { ok: true, items: [], quotaUnits: 0 };

  const items: Array<Record<string, any>> = [];
  let quotaUnits = 0;

  for (let chunk = 0; chunk < VIDEOS_MAX_CHUNKS && chunk * VIDEOS_LIST_CHUNK < ids.length; chunk++) {
    const slice = ids.slice(chunk * VIDEOS_LIST_CHUNK, (chunk + 1) * VIDEOS_LIST_CHUNK);
    const result = await youtubeGet('videos', { part: 'snippet', id: slice.join(',') }, accessToken, options);
    if (!result.ok) return result;
    quotaUnits += YOUTUBE_QUOTA.videosList;
    if (Array.isArray(result.payload.items)) items.push(...result.payload.items);
  }

  return { ok: true, items, quotaUnits };
}

/**
 * The videos behind a set of ids, whatever page of the catalogue they came from.
 *
 * A sync run reads its selection through this rather than through the listing it
 * was drawn from, and that is a fix rather than a shortcut: a selection made
 * against page 4 of a channel used to be unreadable, because the run re-listed
 * the channel and looked for the ids in the first page. Fifty videos cost one
 * unit here, so it is also cheaper than the listing it replaces.
 *
 * `channelId` on every result is the reason this is safe to key on an id from a
 * request body — see `YouTubeVideo.channelId`. Callers **must** compare it
 * against the connected channel before doing anything with the video.
 */
export async function fetchVideos(
  accessToken: string,
  videoIds: string[],
  options: GoogleApiOptions = {},
): Promise<{ ok: true; videos: YouTubeVideo[]; quotaUnits: number } | { ok: false; detail: string }> {
  const listed = await videosList(accessToken, videoIds, options);
  if (!listed.ok) return listed;

  const videos = listed.items
    .filter((item) => typeof item?.id === 'string' && VIDEO_ID_RE.test(item.id))
    .map((item) => toVideo(item.id as string, item.snippet ?? {}, item?.snippet?.publishedAt));

  return { ok: true, videos, quotaUnits: listed.quotaUnits };
}

// ── Writing a description ────────────────────────────────────────────────────

/**
 * The snippet as it has to be handed back on an update.
 *
 * `videos.update` replaces the whole `snippet` part rather than merging into it,
 * and `title` and `categoryId` are required — so a write that sends only the new
 * description silently blanks a creator's title and fails on the category. The
 * only safe way to change one field is to read the part, change that field, and
 * send the rest back untouched.
 */
export interface VideoSnippet {
  videoId: string;
  channelId: string | null;
  title: string;
  description: string;
  categoryId: string | null;
  tags: string[] | null;
  defaultLanguage: string | null;
  defaultAudioLanguage: string | null;
}

export async function fetchVideoSnippet(
  accessToken: string,
  videoId: string,
  options: GoogleApiOptions = {},
): Promise<{ ok: true; snippet: VideoSnippet } | { ok: false; detail: string }> {
  const listed = await videosList(accessToken, [videoId], options);
  if (!listed.ok) return listed;

  const item = listed.items.find((row) => row?.id === videoId);
  if (!item) {
    return {
      ok: false,
      detail:
        `YouTube returned nothing for video ${videoId}. It has been deleted, made private, or it is not ` +
        'readable with this connection.',
    };
  }

  const snippet = (item.snippet ?? {}) as Record<string, any>;
  return {
    ok: true,
    snippet: {
      videoId,
      channelId: typeof snippet.channelId === 'string' ? snippet.channelId : null,
      title: typeof snippet.title === 'string' ? snippet.title : '',
      description: typeof snippet.description === 'string' ? snippet.description : '',
      categoryId: typeof snippet.categoryId === 'string' ? snippet.categoryId : null,
      tags: Array.isArray(snippet.tags) ? snippet.tags.filter((tag: unknown) => typeof tag === 'string') : null,
      defaultLanguage: typeof snippet.defaultLanguage === 'string' ? snippet.defaultLanguage : null,
      defaultAudioLanguage: typeof snippet.defaultAudioLanguage === 'string' ? snippet.defaultAudioLanguage : null,
    },
  };
}

/**
 * The line that goes under a creator's description.
 *
 * Exported so the test and the operator screen quote the same string as the
 * write does, rather than three copies that can drift.
 */
export const MEALIO_LINK_INTRO = 'Save this recipe and send every ingredient straight to your grocery cart:';

export type DescriptionEdit =
  /** The description to write. */
  | { status: 'append'; description: string }
  /** The link is already there. Nothing to write, and nothing wrong. */
  | { status: 'already-present' }
  /** Appending would push the description past YouTube's own limit. */
  | { status: 'too-long'; detail: string };

/**
 * Appends the Mealio link to a description, once.
 *
 * **The description is the record.** There is no column saying we appended
 * before, and there does not need to be one: the write is a read-modify-write
 * against YouTube anyway, so the state that decides whether to write is the same
 * state the last write produced. A bookkeeping row could disagree with the
 * channel; this cannot.
 *
 * Matched on the URL rather than on the wording, because the wording is ours and
 * the creator may have moved it, reformatted it, or written their own sentence
 * around it. What must not happen twice is the *link*.
 *
 * Refuses rather than truncating when the result would exceed YouTube's 5,000
 * character limit. Trimming somebody's description to make room for our link is
 * a second edit nobody asked for, and it destroys content — the failing safe
 * direction is to not write.
 */
export function withMealioLink(description: string, mealUrl: string): DescriptionEdit {
  if (description.includes(mealUrl)) return { status: 'already-present' };

  const block = `${MEALIO_LINK_INTRO}\n${mealUrl}`;
  const next = description.trim() ? `${description.trimEnd()}\n\n${block}` : block;

  if (next.length > YOUTUBE_DESCRIPTION_MAX) {
    return {
      status: 'too-long',
      detail:
        `This description is ${description.length} characters and the link needs ${block.length + 2} more, ` +
        `which is past YouTube's ${YOUTUBE_DESCRIPTION_MAX}-character limit. Nothing was written — trimming ` +
        "a creator's description to make room is a second edit nobody asked for.",
    };
  }
  return { status: 'append', description: next };
}

/**
 * Writes a description back to YouTube. **The only write in this codebase that
 * touches a creator's channel.**
 *
 * Every caller must have gone through `assertAppendAllowed` first: that is where
 * `youtube_append_opt_in`, a live connection, the write scope and a channel id
 * are checked, and it is deliberately the only place any of them are.
 */
export async function updateVideoDescription(
  accessToken: string,
  snippet: VideoSnippet,
  description: string,
  options: GoogleApiOptions = {},
): Promise<{ ok: true; quotaUnits: number } | { ok: false; detail: string }> {
  const fetchImpl = options.fetchImpl ?? fetch;

  let response: Response;
  try {
    response = await fetchImpl(`${YOUTUBE_API}/videos?part=snippet`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: snippet.videoId,
        snippet: {
          // Sent back verbatim. `videos.update` replaces the part rather than
          // merging, so anything omitted here is anything cleared on the video.
          title: snippet.title,
          description,
          categoryId: snippet.categoryId ?? '22',
          ...(snippet.tags ? { tags: snippet.tags } : {}),
          ...(snippet.defaultLanguage ? { defaultLanguage: snippet.defaultLanguage } : {}),
          ...(snippet.defaultAudioLanguage ? { defaultAudioLanguage: snippet.defaultAudioLanguage } : {}),
        },
      }),
      signal: providerSignal(),
    });
  } catch (err) {
    return { ok: false, detail: `YouTube did not answer: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (!response.ok) {
    const payload = await readJsonCapped(response);
    const reason = typeof payload?.error?.message === 'string' ? ` ${payload.error.message}` : '';
    return { ok: false, detail: `YouTube refused the description update (HTTP ${response.status}).${reason}` };
  }
  return { ok: true, quotaUnits: YOUTUBE_QUOTA.videosUpdate };
}

// ── The source document ──────────────────────────────────────────────────────

/**
 * A caption track's ceiling before any of it is parsed.
 *
 * Generous against real transcripts — an hour of speech is well under 100 kB of
 * SRT — and the point is only that there *is* one. `MAX_TEXT_CHARS` trims what
 * survives to what a prompt will read; this stops the bytes arriving at all.
 */
export const MAX_CAPTION_BYTES = 512 * 1024;

/** SRT and WebVTT are served as text; some CDNs answer with a generic type. */
const CAPTION_CONTENT_TYPES = /text\/|application\/(octet-stream|x-subrip)/i;

/**
 * Captions for one video, as plain text.
 *
 * Owner-only: `captions.list` and `captions.download` both need the channel
 * owner's grant, which is the reason this ticket exists. An uploaded track is
 * preferred over an auto-generated one — ASR is materially worse on ingredient
 * names, which is the one thing a recipe cannot afford to get wrong.
 *
 * Returns null rather than throwing for every failure: a video with no captions
 * is ordinary, and a caption fetch that fails must degrade to "we have the
 * description" rather than losing the import.
 *
 * The *download* goes through `safeFetch`, unlike the other Google calls in
 * this file. Not for SSRF — the host is fixed — but for the two caps it is the
 * only thing here that has: bytes counted during streaming, so a track that
 * never ends fails without being buffered, and a wall-clock deadline, so a slow
 * one cannot hold a sync run open to the function's ceiling. A measured 4 MB
 * track previously produced a 4 MB extraction prompt, per video, concurrently.
 */
export async function fetchCaptions(
  videoId: string,
  accessToken: string,
  options: GoogleApiOptions = {},
): Promise<string | null> {
  const fetchImpl = options.fetchImpl ?? fetch;

  try {
    const listed = await fetchImpl(`${YOUTUBE_API}/captions?part=snippet&videoId=${encodeURIComponent(videoId)}`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!listed.ok) return null;

    const payload = (await listed.json().catch(() => null)) as Record<string, any> | null;
    const tracks: Array<Record<string, any>> = Array.isArray(payload?.items) ? payload.items : [];
    if (tracks.length === 0) return null;

    const score = (track: Record<string, any>) => {
      const snippet = track.snippet ?? {};
      // Uploaded beats ASR; English beats anything else, since every prompt in
      // the pipeline is English and a Spanish transcript gates as "not a recipe".
      return (snippet.trackKind === 'ASR' ? 0 : 2) + (String(snippet.language ?? '').startsWith('en') ? 1 : 0);
    };
    const best = tracks.slice().sort((a, b) => score(b) - score(a))[0];
    if (typeof best?.id !== 'string') return null;

    const downloaded = await safeFetch(`${YOUTUBE_API}/captions/${encodeURIComponent(best.id)}?tfmt=srt`, {
      fetchImpl: options.fetchImpl,
      lookup: options.lookup,
      // Dropped if Google redirects the download off googleapis.com, which its
      // media endpoints do — the signed URL they redirect to needs no token.
      headers: { authorization: `Bearer ${accessToken}` },
      accept: CAPTION_CONTENT_TYPES,
      expected: 'a caption track',
      maxBytes: MAX_CAPTION_BYTES,
    });
    if (!downloaded.ok) return null;

    return srtToText(downloaded.html);
  } catch {
    return null;
  }
}

/**
 * Strips SRT sequence numbers and timecodes, leaving the spoken text.
 *
 * The cue structure carries nothing a recipe needs, and leaving it in spends
 * most of the gate's 500-word budget on timestamps.
 */
export function srtToText(srt: string): string {
  const lines: string[] = [];
  for (const raw of srt.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^\d+$/.test(line)) continue;
    if (/^\d{2}:\d{2}:\d{2}[,.]\d{3}\s*-->/.test(line)) continue;
    // WebVTT headers, in case a provider answers with vtt despite tfmt=srt.
    if (/^(WEBVTT|NOTE|Kind:|Language:)/i.test(line)) continue;
    lines.push(line.replace(/<[^>]{0,200}>/g, ''));
  }
  return lines.join('\n');
}

export interface VideoDocumentOptions extends GoogleApiOptions {
  /**
   * The channel owner's access token. Absent means description-only, which is
   * the free tier of this feature and works for most cooking channels.
   */
  accessToken?: string | null;
}

/**
 * A video as the gate and the extractor consume it: `{ title, text }`.
 *
 * Title + description + captions is the whole source document for a video —
 * there is no JSON-LD fallback on YouTube, so this is the *only* material
 * MEAL-70's gate gets. Returning it in the pipeline's own shape rather than a
 * YouTube-specific blob is what lets the poller reject a vlog through the same
 * code path it rejects a blog post with.
 *
 * Captions are fetched only when the description is too thin for the gate to
 * judge on. That ordering is the quota control the ticket asks for: a haul video
 * with a one-line description is rejected on title and description, and its
 * captions are never downloaded.
 */
export async function youtubeSourceDocument(
  video: YouTubeVideo,
  options: VideoDocumentOptions = {},
): Promise<SourceDocument & { usedCaptions: boolean }> {
  const description = video.description.trim();
  let text = description;
  let usedCaptions = false;

  if (description.length < THIN_CONTENT_CHARS && options.accessToken) {
    const captions = await fetchCaptions(video.videoId, options.accessToken, options);
    if (captions) {
      // Kept together rather than replaced. A thin description still often holds
      // the link, the yield or a "full recipe below" line, and the transcript is
      // the conversational half — both are evidence.
      text = [description, captions].filter(Boolean).join('\n\n');
      usedCaptions = true;
    }
  }

  // The same ceiling the fetched path enforces. `toSourceDocument` caps `text`
  // at 24k because it is interpolated into the extraction prompt verbatim, and
  // a document handed straight to the pipeline reaches that prompt by exactly
  // the same route — skipping the cap because we skipped the fetch would put
  // the one path that carries a creator's whole transcript outside it.
  if (text.length > MAX_TEXT_CHARS) text = `${text.slice(0, MAX_TEXT_CHARS)}…`;

  return {
    url: video.url,
    title: video.title ?? '',
    text,
    // No comment rails or related-post furniture on a description, so the
    // verification corpus MEAL-72 checks evidence against is the same text.
    recipeText: text,
    jsonLd: null,
    structuredSource: null,
    jsonLdRaw: null,
    imageUrl: video.thumbnailUrl,
    platform: 'youtube',
    usedCaptions,
  };
}

// ── Reading a connected channel ──────────────────────────────────────────────

/**
 * The channel id to list for a creator: the grant's if it carries one, otherwise
 * derived from their link.
 *
 * The grant wins because it is the only source that cannot be wrong — MEAL-74
 * says a creator is never asked to type a channel id, and a link they pasted
 * during an application is one step away from typing one. The link is the
 * fallback for one narrow case: a connection stored before the channel id was
 * recorded on it.
 *
 * Takes the connection rather than loading it. Every caller has already loaded
 * one to get a token — nothing can be listed without a grant any more — and a
 * second read here would be a second answer to a question already asked.
 */
export async function channelIdForCreator(
  connection: PlatformConnection | null,
  youtubeUrl: string | null,
  fetchOptions?: SafeFetchOptions,
): Promise<{ ok: true; channelId: string } | { ok: false; detail: string }> {
  if (connection && isChannelId(connection.externalId)) {
    return { ok: true, channelId: connection.externalId };
  }
  if (!youtubeUrl) {
    return {
      ok: false,
      detail:
        'This creator has no YouTube link and has not connected a channel, so there is nothing to list. ' +
        'Ask them to connect YouTube from the creator portal.',
    };
  }

  const resolved = await resolveChannelId(youtubeUrl, fetchOptions);
  return resolved.ok ? { ok: true, channelId: resolved.channelId } : resolved;
}

// ── The append consent flag ──────────────────────────────────────────────────

/**
 * The one place that decides whether Mealio may edit a creator's video
 * descriptions (MEAL-77 / MEAL-79 / MEAL-78).
 *
 * A creator agreeing to have their videos **read** has not agreed to have their
 * channel **written to**. Those are separate permissions over separate property,
 * so they are separate flags: `import_opt_in` governs reading,
 * `youtube_append_opt_in` governs writing, and the second defaults to false.
 *
 * Enforced here, server-side, rather than by hiding a button. Every append
 * endpoint MEAL-78 and MEAL-79 add must call this and refuse on a failure,
 * whatever the client sent — one flag, one gate, one place to revoke.
 */
export type AppendPermission =
  | { ok: true; connection: PlatformConnection; channelId: string }
  | { ok: false; status: number; error: string };

export async function assertAppendAllowed(
  supabase: SupabaseClient,
  creatorId: string,
): Promise<AppendPermission> {
  const { data } = await supabase
    .from('creators')
    .select('id, youtube_append_opt_in')
    .eq('id', creatorId)
    .maybeSingle();

  const creator = data as Record<string, any> | null;
  if (!creator) {
    return { ok: false, status: 404, error: 'Creator not found.' };
  }
  // Anything other than an explicit true refuses. A missing column on an older
  // row, a null, a string — none of those are consent.
  if (creator.youtube_append_opt_in !== true) {
    return {
      ok: false,
      status: 403,
      error:
        'This creator has not agreed to let Mealio edit their YouTube descriptions. ' +
        'Importing their videos and writing to their channel are separate permissions.',
    };
  }

  const connection = await loadConnection(supabase, creatorId, 'youtube');
  if (!connection || connection.brokenReason) {
    return {
      ok: false,
      status: 409,
      error: connection
        ? 'This creator\'s YouTube connection has stopped working, so nothing can be written to it until they reconnect.'
        : 'This creator has no connected YouTube channel.',
    };
  }
  if (!connection.scopes.includes(YOUTUBE_WRITE_SCOPE)) {
    // A grant made before the write scope was requested, or one where the
    // creator unticked it on Google's own screen.
    return {
      ok: false,
      status: 409,
      error: 'This connection was granted without permission to edit descriptions. Ask the creator to reconnect YouTube.',
    };
  }
  if (!isChannelId(connection.externalId)) {
    return { ok: false, status: 409, error: 'This connection carries no channel id. Ask the creator to reconnect YouTube.' };
  }

  return { ok: true, connection, channelId: connection.externalId };
}
