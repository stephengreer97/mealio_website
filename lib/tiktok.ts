/**
 * TikTok: connect an account and read its descriptions (MEAL-83).
 *
 * **Login Kit + Display API, `video.list` and nothing else.** The registered app
 * (developer portal, 2026-08-02) is web-only, with no Webhooks product: the one
 * webhook that looks relevant, `video.publish.completed`, fires only for videos
 * uploaded through our own Video Kit, and our creators post from inside the
 * TikTok app — so it could never fire for us, and requesting a product the
 * review demo cannot exercise is a documented rejection reason. No native
 * platforms are registered either, and the connect flow is **web only** — see
 * `app/api/creator/tiktok/connect/route.ts` for why the mobile app cannot
 * complete it as things stand.
 *
 * Two facts shape everything below.
 *
 * **The description is the whole story, and there is no way around it.**
 * `/v2/video/list/` returns `embed_link` and `share_url` — TikTok's player and
 * the post's page. It never returns a video file, and it has no transcript
 * field. So unlike Instagram, where we could at least download the file and
 * transcribe it ourselves one day (MEAL-85), a TikTok import is structurally
 * limited to the text the creator typed. There is no engineering route to the
 * spoken recipe through a sanctioned API, and scrapers are not a path (MEAL-77).
 * If a creator's descriptions say "full recipe on my blog", the honest answer is
 * that TikTok is a *link* source and not a *recipe* source.
 *
 * **The refresh token lasts a year, which makes it the harder case.** Nothing in
 * a development cycle will ever run long enough to exercise a 365-day expiry, so
 * it has to be right by construction rather than by observation. Two properties
 * carry that: the access token lives ~24 hours, so the daily sweep touches every
 * TikTok grant every day whatever the poll cadence; and each refresh **rotates**
 * the refresh token, so the new one must be stored or the next refresh fails.
 * See `refreshTikTokGrant` in `lib/platform-tokens.ts`.
 */

import type { SourceDocument } from '@/lib/import/types';
import { providerSignal, readJsonCapped } from '@/lib/provider-fetch';

// ── Scopes ───────────────────────────────────────────────────────────────────

/**
 * Listing the creator's own videos. The only scope on the app.
 *
 * `user.info.basic` is *not* requested, even though it would give us a display
 * name to put on the portal card instead of an opaque open id. A nicer label is
 * not a use TikTok's review would accept for a permission, and asking for one
 * the demo does not exercise is how a submission comes back rejected.
 */
export const TIKTOK_VIDEO_LIST_SCOPE = 'video.list';

export const TIKTOK_SCOPES = [TIKTOK_VIDEO_LIST_SCOPE];

const TIKTOK_AUTH_URL = 'https://www.tiktok.com/v2/auth/authorize/';
const TIKTOK_TOKEN_URL = 'https://open.tiktokapis.com/v2/oauth/token/';
const TIKTOK_VIDEO_LIST_URL = 'https://open.tiktokapis.com/v2/video/list/';

/**
 * Where TikTok sends the creator back.
 *
 * TikTok accepts **no wildcards and no localhost** for a web redirect URI, so
 * this is the production URL and there is no preview-deployment or local-dev
 * variant of it. Anyone planning to exercise the OAuth round trip has to do it
 * on production or a fixed staging domain — which is worth knowing before
 * planning a preview-based test, not after.
 */
export function tiktokRedirectUri(): string {
  return `${process.env.NEXT_PUBLIC_APP_URL || 'https://mealio.co'}/api/creator/tiktok/callback`;
}

/**
 * Can this deployment start a TikTok connection at all?
 *
 * Both halves, because they fail at different moments and only one of them is
 * visible before a creator presses anything: without the key `tiktokAuthUrl`
 * returns null and the connect route refuses, and without the secret the round
 * trip gets all the way to TikTok's consent screen and dies at the exchange —
 * which reads to the creator as TikTok rejecting them.
 *
 * Read at call time rather than at module load: `process.env` is populated per
 * invocation on Vercel, and a constant captured at import would be false forever
 * on any instance that started before the variable was set.
 */
export function tiktokConfigured(): boolean {
  return Boolean(process.env.TIKTOK_CLIENT_KEY && process.env.TIKTOK_CLIENT_SECRET);
}

/** The consent URL, or null when this deployment has no TikTok app configured. */
export function tiktokAuthUrl(state: string): string | null {
  const clientKey = process.env.TIKTOK_CLIENT_KEY;
  if (!clientKey) return null;

  const params = new URLSearchParams({
    // TikTok names this `client_key`, not `client_id`. Getting it wrong produces
    // an authorization page that renders and then fails, which reads as a bug in
    // our redirect rather than in the parameter name.
    client_key: clientKey,
    scope: TIKTOK_SCOPES.join(','),
    response_type: 'code',
    redirect_uri: tiktokRedirectUri(),
    state,
  });
  return `${TIKTOK_AUTH_URL}?${params}`;
}

export interface TikTokApiOptions {
  /** Injected so tests never reach TikTok. */
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface TikTokGrant {
  accessToken: string;
  /** Rotated on every refresh. Losing it costs the creator a re-consent. */
  refreshToken: string | null;
  /** The account's stable id under our app. There is no username without `user.info.basic`. */
  openId: string | null;
  scopes: string[];
  expiresAt: string | null;
}

/** TikTok's scopes come back comma-separated. */
function parseScopes(value: unknown): string[] {
  return typeof value === 'string' ? value.split(/[,\s]+/).filter(Boolean) : [];
}

/**
 * Turns a token-endpoint response into a grant.
 *
 * Shared by the code exchange and the refresh because TikTok answers both from
 * the same endpoint with the same body, and reading it in two places is how the
 * two drift.
 */
function toGrant(payload: Record<string, any>, now: () => number): TikTokGrant | null {
  if (typeof payload.access_token !== 'string') return null;
  const expiresIn = typeof payload.expires_in === 'number' ? payload.expires_in : null;
  return {
    accessToken: payload.access_token,
    refreshToken: typeof payload.refresh_token === 'string' ? payload.refresh_token : null,
    openId: typeof payload.open_id === 'string' ? payload.open_id : null,
    scopes: parseScopes(payload.scope),
    expiresAt: expiresIn === null ? null : new Date(now() + expiresIn * 1000).toISOString(),
  };
}

/**
 * TikTok's failure sentence, without the token that was sent to get it.
 *
 * The token endpoint answers failures with `{ error, error_description }`; the
 * data endpoints answer HTTP 200 with `{ error: { code, message } }`. Both are
 * handled, because a caller that only checks `response.ok` reads a video-list
 * failure as an empty account.
 */
export function tiktokErrorDetail(payload: Record<string, any> | null, status: number): string {
  const description = payload?.error_description ?? payload?.error?.message ?? payload?.error;
  const text = typeof description === 'string' && description ? description : `HTTP ${status}`;
  return text;
}

/**
 * Swaps the authorization code for tokens.
 *
 * `open_id` comes back in this response, which is the only place we get it —
 * without `user.info.basic` there is no profile endpoint to ask. It is the
 * account's identity for every later call, and it comes from the grant rather
 * than from anything a creator typed.
 */
export async function exchangeTikTokCode(
  code: string,
  options: TikTokApiOptions = {},
): Promise<{ ok: true; grant: TikTokGrant } | { ok: false; detail: string }> {
  const clientKey = process.env.TIKTOK_CLIENT_KEY;
  const clientSecret = process.env.TIKTOK_CLIENT_SECRET;
  if (!clientKey || !clientSecret) {
    return { ok: false, detail: 'TikTok connection is not configured on this deployment.' };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;

  let response: Response;
  try {
    response = await fetchImpl(TIKTOK_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        // TikTok documents this on the token endpoint; without it an
        // intermediate cache can serve a stale grant to a second creator.
        'Cache-Control': 'no-cache',
      },
      body: new URLSearchParams({
        client_key: clientKey,
        client_secret: clientSecret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: tiktokRedirectUri(),
      }),
      signal: providerSignal(),
    });
  } catch (err) {
    return { ok: false, detail: `TikTok did not answer: ${err instanceof Error ? err.message : String(err)}` };
  }

  const payload = await readJsonCapped(response);
  const grant = payload ? toGrant(payload, now) : null;
  if (!response.ok || !grant) {
    return { ok: false, detail: `TikTok refused the authorization code: ${tiktokErrorDetail(payload, response.status)}` };
  }

  return { ok: true, grant };
}

// ── Videos ───────────────────────────────────────────────────────────────────

export interface TikTokVideo {
  id: string;
  /** Often empty for a video posted in-app; the description is the real text. */
  title: string;
  /** What the creator typed under the video. The only recipe text this API gives. */
  description: string;
  /** The post's page. What gets recorded as the item's `url`. */
  shareUrl: string;
  /** TikTok's player. Never a file — see the module comment. */
  embedLink: string | null;
  coverImageUrl: string | null;
  publishedAt: string | null;
  durationSeconds: number | null;
}

/** TikTok's own per-request ceiling on `/v2/video/list/`. Not ours to raise. */
export const TIKTOK_PAGE_SIZE = 20;

/**
 * How much of an account one listing reads.
 *
 * Five pages at TikTok's maximum page size. Bounded because drawing a catalog
 * has to stay a handful of requests, and because a `has_more` that is always
 * true is a loop this runs inside a function timeout.
 */
export const TIKTOK_VIDEO_MAX = 100;

/**
 * Page ceiling, bounded independently of the item budget — a page can come back
 * shorter than `max_count`, so "items wanted over page size" bounds nothing, and
 * a `has_more` that is always true is a loop.
 */
const TIKTOK_MAX_PAGES = 8;

const MAX_DESCRIPTION_CHARS = 10_000;
const MAX_TITLE_CHARS = 300;

/** Every field we ask for. Requesting more would be data we have no use for. */
const VIDEO_FIELDS = 'id,title,video_description,duration,cover_image_url,embed_link,share_url,create_time';

export type TikTokVideoResult =
  | {
      ok: true;
      videos: TikTokVideo[];
      truncated: boolean;
      /**
       * Where the next window starts, or null when this is the end of the
       * account.
       *
       * TikTok's cursor is the last returned video's creation time in
       * milliseconds. Returned so a caller reading one page at a time can ask
       * for the next — the catalogue does, so that opening the portal costs one
       * request to TikTok rather than five.
       */
      nextCursor: number | null;
    }
  | { ok: false; detail: string };

function toVideo(row: Record<string, any>): TikTokVideo | null {
  // The id arrives as a number in some responses and a string in others, and it
  // becomes `creator_source_items.item_id` — which is text, and must match on
  // the next sync whichever way TikTok sent it this time.
  const id = row?.id;
  if (id === undefined || id === null || String(id).length === 0) return null;
  const shareUrl = typeof row.share_url === 'string' ? row.share_url : '';
  if (!shareUrl) return null;

  const createTime = typeof row.create_time === 'number' ? row.create_time : null;

  return {
    id: String(id),
    title: typeof row.title === 'string' ? row.title.slice(0, MAX_TITLE_CHARS) : '',
    description: typeof row.video_description === 'string' ? row.video_description.slice(0, MAX_DESCRIPTION_CHARS) : '',
    shareUrl,
    embedLink: typeof row.embed_link === 'string' ? row.embed_link : null,
    coverImageUrl: typeof row.cover_image_url === 'string' ? row.cover_image_url : null,
    // `create_time` is Unix epoch **seconds**, not milliseconds. Read as
    // milliseconds it puts every video in January 1970, which sorts a catalog
    // wrongly without ever looking like an error.
    publishedAt: createTime === null ? null : new Date(createTime * 1000).toISOString(),
    durationSeconds: typeof row.duration === 'number' ? row.duration : null,
  };
}

/**
 * The account's recent videos, newest first.
 *
 * `POST`, not `GET`: the Display API takes the paging cursor in a JSON body and
 * the requested fields in the query string, which is unusual enough to be worth
 * stating. The cursor is the last returned video's creation time in
 * milliseconds, and it is echoed back rather than computed here.
 *
 * A failure is reported rather than returning an empty list, because "this
 * account posted nothing" and "our token stopped working" must never look the
 * same to whoever reads the result.
 */
export async function fetchTikTokVideos(
  accessToken: string,
  options: TikTokApiOptions & { limit?: number; cursor?: number | null; maxPages?: number } = {},
): Promise<TikTokVideoResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const limit = Math.max(1, Math.min(options.limit ?? TIKTOK_VIDEO_MAX, TIKTOK_VIDEO_MAX));
  // How many round trips this call may make, separate from how many items it
  // wants. A page can come back shorter than `max_count` — TikTok does that
  // routinely — so a caller asking for twenty items would otherwise keep paging
  // until it had twenty, which is exactly the five round trips the catalogue is
  // trying not to make. It asks for one page and takes what is in it.
  const maxPages = Math.max(1, Math.min(options.maxPages ?? TIKTOK_MAX_PAGES, TIKTOK_MAX_PAGES));

  const videos: TikTokVideo[] = [];
  // Where to resume. Absent means the top of the account, which is every caller
  // that wants the whole listing; the catalogue passes the previous window's
  // `nextCursor` to read on from where the creator has already scrolled.
  let cursor: number | undefined =
    typeof options.cursor === 'number' && Number.isFinite(options.cursor) ? options.cursor : undefined;
  let more = false;

  for (let page = 0; page < maxPages; page++) {
    let response: Response;
    try {
      response = await fetchImpl(`${TIKTOK_VIDEO_LIST_URL}?fields=${encodeURIComponent(VIDEO_FIELDS)}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          max_count: Math.min(TIKTOK_PAGE_SIZE, limit - videos.length),
          ...(cursor === undefined ? {} : { cursor }),
        }),
        signal: providerSignal(),
      });
    } catch (err) {
      return { ok: false, detail: `TikTok did not answer: ${err instanceof Error ? err.message : String(err)}` };
    }

    const payload = await readJsonCapped(response);

    // TikTok answers a failed data call with HTTP 200 and `error.code` set to
    // something other than `ok`. Checking `response.ok` alone reads a revoked
    // token as an account with no videos, which is the one confusion this whole
    // feature is built to avoid.
    const errorCode = payload?.error?.code;
    if (!response.ok || (typeof errorCode === 'string' && errorCode !== 'ok')) {
      return { ok: false, detail: `TikTok refused to list this account's videos: ${tiktokErrorDetail(payload, response.status)}` };
    }

    const rows = Array.isArray(payload?.data?.videos) ? (payload.data.videos as Array<Record<string, any>>) : [];
    for (const row of rows) {
      const video = toVideo(row);
      if (video) videos.push(video);
      if (videos.length >= limit) break;
    }

    const nextCursor = payload?.data?.cursor;
    cursor = typeof nextCursor === 'number' ? nextCursor : undefined;
    more = payload?.data?.has_more === true && cursor !== undefined;
    if (videos.length >= limit || !more) break;
  }

  // An empty account is a success with nothing in it. See the same change in
  // `fetchInstagramMedia`: reporting it as a failure is what made every caller
  // label a creator who has posted nothing as `unreachable`.
  //
  // `truncated` and `nextCursor` answer different questions and a one-page
  // caller needs both: truncated says "we stopped early", nextCursor says where
  // to resume. Null when TikTok says there is no more, so a list that has run
  // out stops asking rather than fetching the same empty page forever.
  return { ok: true, videos, truncated: videos.length >= limit && more, nextCursor: more && cursor !== undefined ? cursor : null };
}

// ── The source document ──────────────────────────────────────────────────────

/** A recognisable label for a video, since `title` is routinely empty. */
export function tiktokVideoTitle(video: TikTokVideo): string {
  const firstLine = video.description.split('\n').map((line) => line.trim()).find(Boolean);
  return (video.title.trim() || firstLine || video.shareUrl).slice(0, MAX_TITLE_CHARS);
}

/**
 * A video as the gate and the extractor consume it: `{ title, text }`.
 *
 * The description is the entire document — there is no caption track, no
 * transcript and no file, so there is no second source to fall back on and no
 * fallback that could ever be added. A gate verdict here is a verdict on what
 * the creator wrote, provided they wrote something at all.
 */
export function tiktokSourceDocument(video: TikTokVideo): SourceDocument {
  const description = video.description.trim();
  const title = video.title.trim();
  // Kept together when they differ: a creator who puts the dish name in the
  // title and the ingredients in the description has written one recipe across
  // two fields, and dropping either loses half of it.
  const text = title && title !== description ? [title, description].filter(Boolean).join('\n\n') : description;

  return {
    url: video.shareUrl,
    title: tiktokVideoTitle(video),
    text,
    recipeText: text,
    jsonLd: null,
    structuredSource: null,
    jsonLdRaw: null,
    // The cover image is TikTok's, served from their CDN, and MEAL-77 is about
    // not helping ourselves to a creator's property. The draft gets no photo
    // from here; an operator adds one at review.
    imageUrl: null,
    platform: 'tiktok',
  };
}

/** See `hasRecipeText` in `lib/instagram.ts` — same distinction, same reason. */
export function hasRecipeText(video: TikTokVideo): boolean {
  return `${video.title}${video.description}`.trim().length > 0;
}

/**
 * The sentence shown for a video we could not read.
 *
 * It states the ceiling rather than implying a fix, because there is not one:
 * the Display API is built for embedding, and no amount of engineering gets the
 * spoken content out of it.
 */
export const TIKTOK_NO_DESCRIPTION_DETAIL =
  'Not gated: this video has no title and no description, and the Display API returns no file and no ' +
  'transcript — only an embed link. There is nothing here to read, and no sanctioned way to get it.';
