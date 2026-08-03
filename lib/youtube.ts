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
 *   1. **Listing a channel is free.** The uploads feed at
 *      `youtube.com/feeds/videos.xml?channel_id=…` gives ids, titles, dates *and*
 *      full descriptions with no API quota and no auth at all. Drawing a catalog
 *      or measuring viability therefore costs one request, whatever the channel
 *      size — no video fetched, no model called.
 *   2. **Description first, captions second.** Creators routinely list
 *      ingredients in the description; it is clean text and it beats ASR on
 *      quantities, which are exactly what a recipe needs. Captions are the
 *      fallback, they cost real quota, and they are only ever fetched for a video
 *      whose description is too thin for the gate to judge.
 *   3. **The channel id comes from the grant.** A creator is never asked to type
 *      one. When there is no grant yet — the viability check at application
 *      review runs before anyone has connected anything — it is read off their
 *      own channel page instead, and that page is a creator-supplied URL, so it
 *      goes through the guarded fetcher like any other.
 *
 * The write half (appending the Mealio link to a description) is MEAL-78/79.
 * What lives here is the consent flag those must obey and the single function
 * that enforces it — see `assertAppendAllowed`.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { decodeEntities } from '@/lib/import/html-text';
import { THIN_CONTENT_CHARS } from '@/lib/import/gate';
import { MAX_TEXT_CHARS } from '@/lib/import/html';
import { checkRobots } from '@/lib/import/robots';
import { safeFetch, type LookupFn, type SafeFetchOptions } from '@/lib/import/ssrf';
import {
  loadConnection,
  usableAccessToken,
  type PlatformConnection,
  type RefreshDeps,
} from '@/lib/platform-tokens';
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
 * Only used when there is no grant. Once a channel is connected the id comes
 * from the grant and this is never consulted, because a page can say anything
 * and a token cannot.
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

// ── The uploads feed ─────────────────────────────────────────────────────────

export function uploadsFeedUrl(channelId: string): string {
  return `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`;
}

export interface YouTubeVideo {
  videoId: string;
  url: string;
  title: string | null;
  /** The full description, newlines intact. Empty when the feed carried none. */
  description: string;
  publishedAt: string | null;
  thumbnailUrl: string | null;
}

/**
 * The feed lists the 15 most recent uploads. Kept as a named ceiling so the
 * catalog's `truncated` flag has something honest to compare against.
 */
export const UPLOADS_FEED_MAX = 15;

/** Well past YouTube's own 5,000-character description limit. */
const MAX_DESCRIPTION_CHARS = 20_000;
const MAX_TITLE_CHARS = 300;

/**
 * Reads one element's raw content out of a block, by forward search only.
 *
 * Deliberately not `feed.ts`'s parser. That one collapses all whitespace into
 * single spaces, which is right for a blog title and destructive here: a
 * description is where the ingredient list lives, one per line, and
 * "1 cup flour 2 eggs 200g butter" is not a list any more. The scanning
 * discipline is the same as `feed.ts` though — no lazy quantifier spans content,
 * so a truncated document cannot make this quadratic.
 */
function elementText(block: string, name: string, from = 0): { text: string; end: number } | null {
  const lower = block.toLowerCase();
  const open = lower.indexOf(`<${name}`, from);
  if (open === -1) return null;
  const gt = lower.indexOf('>', open);
  if (gt === -1) return null;
  // A self-closing tag has no content; `<media:thumbnail url="…"/>` hits this.
  if (block[gt - 1] === '/') return { text: '', end: gt + 1 };
  const close = lower.indexOf(`</${name}`, gt);
  if (close === -1) return null;
  return { text: block.slice(gt + 1, close), end: close };
}

/** One attribute off a start tag, for the empty elements that carry everything in attributes. */
function attribute(block: string, name: string, attr: string): string | null {
  const lower = block.toLowerCase();
  const open = lower.indexOf(`<${name}`);
  if (open === -1) return null;
  const gt = lower.indexOf('>', open);
  if (gt === -1) return null;
  const match = new RegExp(`\\b${attr}\\s*=\\s*["']([^"']{0,500})["']`, 'i').exec(block.slice(open, gt));
  return match ? decodeEntities(match[1]) : null;
}

function toIso(value: string | null): string | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

/**
 * Parses a YouTube uploads feed.
 *
 * Atom with the `yt:` and `media:` extensions. `<yt:videoId>` is taken rather
 * than the `<id>` (`yt:video:XYZ`) because the bare id is what every API call
 * and every `creator_source_items.item_id` needs — MEAL-79's "the meal came from
 * *this* video" relationship is keyed on it.
 */
export function parseUploadsFeed(xml: string): YouTubeVideo[] {
  const videos: YouTubeVideo[] = [];
  const lower = xml.toLowerCase();
  let cursor = 0;

  while (videos.length < UPLOADS_FEED_MAX) {
    const open = lower.indexOf('<entry', cursor);
    if (open === -1) break;
    const close = lower.indexOf('</entry', open);
    if (close === -1) break;
    const block = xml.slice(open, close);
    cursor = close + 1;

    const videoId = elementText(block, 'yt:videoid')?.text.trim() ?? '';
    if (!/^[A-Za-z0-9_-]{6,20}$/.test(videoId)) continue;

    const title = elementText(block, 'title')?.text ?? '';
    const description = elementText(block, 'media:description')?.text ?? '';
    const published = elementText(block, 'published')?.text ?? elementText(block, 'updated')?.text ?? null;

    videos.push({
      videoId,
      // Built from the id rather than taken from the feed's `<link>`: the URL is
      // what we later fetch, record and show, and one derived from a validated
      // id cannot point anywhere but at the video it claims to be.
      url: `https://www.youtube.com/watch?v=${videoId}`,
      title: decodeEntities(title).replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE_CHARS) || null,
      description: decodeEntities(description).slice(0, MAX_DESCRIPTION_CHARS),
      publishedAt: toIso(published && published.trim()),
      thumbnailUrl: attribute(block, 'media:thumbnail', 'url'),
    });
  }

  return videos;
}

export type UploadsFeedResult =
  | { ok: true; channelId: string; videos: YouTubeVideo[] }
  | { ok: false; detail: string };

/**
 * The channel's recent uploads. One unauthenticated request, no API quota.
 *
 * This is what keeps drawing a catalog free. The feed is a fixed Google path
 * with a validated channel id in it, but it still goes through `safeFetch`
 * because the id ultimately traces back to something a creator gave us, and a
 * guarded fetch costs nothing to keep uniform.
 *
 * **This is the one page fetch in the codebase that does not call
 * `checkRobots`, and that is not an oversight to tidy up.** `youtube.com/robots.txt`
 * carries `Disallow: /feeds/videos.xml` under `User-agent: *`, so adding the
 * check here does not make this consistent with `resolveChannelId` — it turns
 * the free-listing half of MEAL-74 off. That is a product and legal call rather
 * than a code cleanup: the only compliant substitute is `playlistItems.list`
 * on the Data API, which needs a grant (so it cannot run at application review,
 * before anyone has connected anything) and spends quota per channel. Recorded
 * here so the next person finds the decision rather than the gap.
 */
export async function readUploadsFeed(
  channelId: string,
  fetchOptions?: SafeFetchOptions,
): Promise<UploadsFeedResult> {
  if (!isChannelId(channelId)) {
    return { ok: false, detail: `"${channelId}" is not a YouTube channel id.` };
  }

  const fetched = await safeFetch(uploadsFeedUrl(channelId), {
    ...fetchOptions,
    // After the spread, not before. These two are the contract this call is
    // written against — a caller passing its own `accept` for some unrelated
    // reason must not silently switch off the XML allowlist.
    // The feed is served as `text/xml`, which the default HTML allowlist rejects.
    accept: /xml|text\/plain/i,
    expected: 'a YouTube uploads feed',
  });
  if (!fetched.ok) {
    return { ok: false, detail: `Could not read the uploads feed for ${channelId}: ${fetched.detail}` };
  }

  const videos = parseUploadsFeed(fetched.html);
  if (videos.length === 0) {
    return {
      ok: false,
      detail:
        `The uploads feed for ${channelId} lists no videos. A channel with no public uploads has ` +
        'nothing to import — that is an answer, not a failure.',
    };
  }
  return { ok: true, channelId, videos };
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
 * The channel id to list for a creator: the grant's if there is one, otherwise
 * derived from their link.
 *
 * The grant wins because it is the only source that cannot be wrong — MEAL-74
 * says a creator is never asked to type a channel id, and a link they pasted
 * during an application is one step away from typing one.
 */
export async function channelIdForCreator(
  deps: { supabase: SupabaseClient; fetchOptions?: SafeFetchOptions },
  creatorId: string,
  youtubeUrl: string | null,
): Promise<{ ok: true; channelId: string; connection: PlatformConnection | null } | { ok: false; detail: string }> {
  const connection = await loadConnection(deps.supabase, creatorId, 'youtube');
  if (connection && isChannelId(connection.externalId)) {
    return { ok: true, channelId: connection.externalId, connection };
  }
  if (!youtubeUrl) {
    return {
      ok: false,
      detail:
        'This creator has no YouTube link and has not connected a channel, so there is nothing to list. ' +
        'Ask them to connect YouTube from the creator portal.',
    };
  }

  const resolved = await resolveChannelId(youtubeUrl, deps.fetchOptions);
  return resolved.ok ? { ok: true, channelId: resolved.channelId, connection } : resolved;
}

/**
 * The access token for a creator's channel, or null when there is no usable one.
 *
 * Null is an ordinary answer: description-only reading works without OAuth and
 * is the free tier of this feature. Callers degrade rather than fail.
 */
export async function youtubeAccessToken(
  deps: RefreshDeps,
  connection: PlatformConnection | null,
): Promise<string | null> {
  if (!connection) return null;
  return usableAccessToken(deps, connection);
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
