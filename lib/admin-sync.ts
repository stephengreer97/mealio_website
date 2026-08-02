/**
 * Operator-driven sync (MEAL-90).
 *
 * Two modes, one engine: paste a single link, or tick items off a creator's
 * catalog. Both build a `creator_sync_runs` row holding the selection and let a
 * worker chew through it; running the two through the same code is what makes
 * "the gate still ran, and here is what it said" true of a one-link sync as much
 * as a 200-item one.
 *
 * Three things this file is careful about, all of them the same worry — that a
 * batch acting on a creator's behalf gets quietly wrong:
 *
 *   1. **Rendering the catalog is free.** Titles, dates and links come from feed
 *      metadata; nothing here fetches a post or calls a model to draw a list.
 *      Opening a 200-post blog costs the feed request and the already-imported
 *      lookup, and nothing else.
 *   2. **The gate still runs.** An operator selecting an item is not a bypass. A
 *      selected post that is not a recipe is dropped with its reason recorded,
 *      so "I selected 12 and got 9" is explainable on screen.
 *   3. **One failure does not sink the batch.** Every item has its own outcome
 *      in `creator_source_items`; a failure stays retryable on its own.
 *
 * **Nothing here publishes** (MEAL-91). A run produces `creator_import_drafts`
 * rows waiting on an operator, and `lib/import-drafts.ts` owns what happens
 * next. MEAL-90 justified publishing directly on the grounds that "a human
 * operator has read the extraction in the admin UI before triggering it" — but
 * the operator reads a *title in an RSS feed*, and between the model's
 * extraction and a live recipe under a creator's name no human saw the
 * ingredients. The email that made that arrangement honest now fires from
 * Approve, where there is something true to announce.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { createImportDraft, reviewDraft, type ImportDraft } from '@/lib/import-drafts';
import { log } from '@/lib/logger';
import {
  isConnectedPlatform,
  SOURCE_COLUMNS,
  SOURCE_LABELS,
  type ConnectedPlatform,
  type PlatformSource,
} from '@/lib/creator-sources';
import { loadConnection, usableAccessToken } from '@/lib/platform-tokens';
import { discoverFeed, readFeed, type FeedDiscoveryResult } from '@/lib/import/feed-discovery';
import { runImport, type RunImportOptions } from '@/lib/import/pipeline';
import { robotsPerOrigin } from '@/lib/import/robots';
import type { SafeFetchOptions } from '@/lib/import/ssrf';
import {
  channelIdForCreator,
  readUploadsFeed,
  uploadsFeedUrl,
  youtubeAccessToken,
  youtubeSourceDocument,
  UPLOADS_FEED_MAX,
  type YouTubeVideo,
} from '@/lib/youtube';
import {
  fetchInstagramMedia,
  instagramMediaTitle,
  instagramSourceDocument,
  INSTAGRAM_MEDIA_MAX,
} from '@/lib/instagram';
import {
  fetchTikTokVideos,
  tiktokSourceDocument,
  tiktokVideoTitle,
  TIKTOK_VIDEO_MAX,
} from '@/lib/tiktok';
import { formatTelemetry } from '@/lib/import/telemetry';
import type { FeedKind } from '@/lib/import/feed';
import type { ImportResult, SourceDocument } from '@/lib/import/types';

// ── Shapes ───────────────────────────────────────────────────────────────────

/**
 * Per-item outcome inside a run.
 *
 * `drafted` — not `imported` — is what a successful item reaches now: the recipe
 * is extracted and waiting in the review queue, and calling it "published" on
 * screen would restate the exact untruth MEAL-91 exists to remove.
 *
 * `rejected` and `failed` mean different things to an operator and must not be
 * merged: rejected is the gate saying this is not a recipe (a correct answer,
 * retrying changes nothing), failed is us not managing to read it (a timeout, a
 * 503, a classifier outage — worth another go).
 */
export type SyncItemStatus = 'pending' | 'drafted' | 'rejected' | 'failed' | 'skipped';

export interface SyncItem {
  /** Feed guid / video id / the URL itself. Half of the `creator_source_items` key. */
  itemId: string;
  url: string;
  title: string | null;
  publishedAt: string | null;
  status: SyncItemStatus;
  /** The gate's sentence, the fetch failure, or why it was skipped. */
  detail: string | null;
  /** The queued draft. Where the run hands over to the review queue. */
  draftId: string | null;
  /** The extracted recipe's name, so the run reads as recipes rather than URLs. */
  mealName: string | null;
  /** How many fields the review card will flag. The reason to look at this one first. */
  needALook: number | null;
  costUsd: number;
}

export type SyncRunStatus = 'queued' | 'running' | 'done';
export type SyncRunMode = 'link' | 'catalog';

export interface SyncRun {
  id: string;
  creatorId: string;
  source: PlatformSource;
  mode: SyncRunMode;
  status: SyncRunStatus;
  items: SyncItem[];
  createdAt: string | null;
  finishedAt: string | null;
}

/** Counts the sync screen shows, so "selected 12, queued 9" adds up on screen. */
export interface SyncRunTotals {
  selected: number;
  pending: number;
  drafted: number;
  rejected: number;
  failed: number;
  skipped: number;
  costUsd: number;
  /** Across every drafted item. What the queue is about to ask a human to read. */
  needALook: number;
}

export function summariseRun(run: SyncRun): SyncRunTotals {
  const count = (status: SyncItemStatus) => run.items.filter((item) => item.status === status).length;
  return {
    selected: run.items.length,
    pending: count('pending'),
    drafted: count('drafted'),
    rejected: count('rejected'),
    failed: count('failed'),
    skipped: count('skipped'),
    costUsd: run.items.reduce((total, item) => total + (item.costUsd || 0), 0),
    needALook: run.items.reduce((total, item) => total + (item.needALook ?? 0), 0),
  };
}

/** Row shape → the type everything else here speaks. */
export function toSyncRun(row: Record<string, any>): SyncRun {
  return {
    id: row.id,
    creatorId: row.creator_id,
    source: row.source,
    mode: row.mode,
    status: row.status,
    items: Array.isArray(row.items) ? (row.items as SyncItem[]) : [],
    createdAt: row.created_at ?? null,
    finishedAt: row.finished_at ?? null,
  };
}

export interface SyncCreator {
  id: string;
  user_id: string;
  display_name: string;
  website_url?: string | null;
  youtube_url?: string | null;
  instagram_url?: string | null;
  tiktok_url?: string | null;
  feed_url?: string | null;
}

/** Everything the creator engine needs, injectable so tests need no network. */
export interface SyncDeps {
  supabase: SupabaseClient;
  fetchOptions?: SafeFetchOptions;
  /** The import pipeline seam. Tests substitute a stub; production runs the real thing. */
  importer?: (url: string, options: RunImportOptions) => Promise<ImportResult>;
  /** Where an extraction lands. There is no publisher seam here any more — a run cannot publish. */
  queue?: typeof createImportDraft;
  /**
   * Builds the source document for a source that is not a web page.
   *
   * `advanceRun` fills this in with a resolver memoised per run, so a 40-video
   * selection reads the channel's uploads feed once rather than forty times.
   */
  sourceDocument?: SourceDocumentResolver;
  now?: () => number;
}

/** Null means "this source is a page — fetch it the normal way". */
export type SourceDocumentResolver = (
  creator: SyncCreator,
  source: PlatformSource,
  item: SyncItem,
) => Promise<SourceDocument | null>;

/**
 * Source documents for a run against a connected platform
 * (MEAL-74 / MEAL-82 / MEAL-83).
 *
 * None of the three is a page. `watch?v=…` serves a JavaScript shell, an
 * Instagram permalink and a TikTok share URL serve a login-walled app — fetching
 * any of them would have the gate truthfully report there is no recipe there,
 * and an operator would read that as a verdict on the post rather than on our
 * reach. So the document is assembled from the same listing the catalog was
 * drawn from.
 *
 * Each platform's listing and token refresh happen **once per run**, whatever
 * the selection size: a 40-item selection is one API read, not forty.
 */
export function createSourceDocumentResolver(deps: SyncDeps): SourceDocumentResolver {
  let channel: Promise<{ videos: Map<string, YouTubeVideo>; accessToken: string | null }> | null = null;
  /** Instagram and TikTok reduce to a document per item id at listing time. */
  let instagram: Promise<Map<string, SourceDocument>> | null = null;
  let tiktok: Promise<Map<string, SourceDocument>> | null = null;

  return async (creator, source, item) => {
    if (source === 'youtube') {
      channel ??= (async () => {
        const resolved = await channelIdForCreator(deps, creator.id, creator.youtube_url ?? null);
        if (!resolved.ok) return { videos: new Map<string, YouTubeVideo>(), accessToken: null };
        const [feed, accessToken] = await Promise.all([
          readUploadsFeed(resolved.channelId, deps.fetchOptions),
          // Null when they have not connected: description-only import still
          // works, it just cannot fall back to captions.
          youtubeAccessToken({ supabase: deps.supabase }, resolved.connection),
        ]);
        return {
          videos: new Map(feed.ok ? feed.videos.map((video) => [video.videoId, video] as const) : []),
          accessToken,
        };
      })();

      const { videos, accessToken } = await channel;
      const video = videos.get(item.itemId);
      if (!video) return null;
      return youtubeSourceDocument(video, { accessToken });
    }

    if (source === 'instagram') {
      instagram ??= (async () => {
        const { token } = await connectedGrant(deps, creator.id, 'instagram');
        if (!token) return new Map<string, SourceDocument>();
        const listed = await fetchInstagramMedia(token, { limit: INSTAGRAM_MEDIA_MAX, fetchImpl: platformFetch(deps) });
        return new Map(listed.ok ? listed.media.map((media) => [media.id, instagramSourceDocument(media)] as const) : []);
      })();
      return (await instagram).get(item.itemId) ?? null;
    }

    if (source === 'tiktok') {
      tiktok ??= (async () => {
        const { token } = await connectedGrant(deps, creator.id, 'tiktok');
        if (!token) return new Map<string, SourceDocument>();
        const listed = await fetchTikTokVideos(token, { limit: TIKTOK_VIDEO_MAX, fetchImpl: platformFetch(deps) });
        return new Map(listed.ok ? listed.videos.map((video) => [video.id, tiktokSourceDocument(video)] as const) : []);
      })();
      return (await tiktok).get(item.itemId) ?? null;
    }

    return null;
  };
}

/**
 * The fetch these API calls use.
 *
 * `graph.instagram.com` and `open.tiktokapis.com` are fixed hosts of ours, so
 * they do not go through the guarded fetcher — that exists for destinations an
 * outsider chose, and it cannot carry the credentials these calls need. The
 * injection seam is reused so a test still never reaches a provider.
 */
function platformFetch(deps: SyncDeps): typeof fetch | undefined {
  return deps.fetchOptions?.fetchImpl as typeof fetch | undefined;
}

// ── Catalog ──────────────────────────────────────────────────────────────────

/**
 * Ceiling on catalog size, matching the feed parser's own cap. A blog with more
 * posts than this is not a checklist problem, it is a "sync the recent ones and
 * come back" problem.
 */
export const CATALOG_MAX_ENTRIES = 500;

export interface CatalogEntry {
  itemId: string;
  url: string;
  title: string | null;
  publishedAt: string | null;
  /**
   * The `creator_source_items` record, when there is one. Drives the
   * already-imported marker, and the row starts deselected because select-all on
   * a catalog half of which is already in is the obvious expensive mistake.
   */
  record: { status: string; detail: string | null; at: string | null } | null;
}

export type CatalogResult =
  | {
      ok: true;
      source: PlatformSource;
      feed: { url: string; kind: FeedKind; via: string } | null;
      entries: CatalogEntry[];
      /** True when the source published more than we will list. */
      truncated: boolean;
    }
  | { ok: false; reason: string; detail: string };

/**
 * Lists everything a creator's source publishes, from feed metadata alone.
 *
 * A confirmed `feed_url` is re-read rather than re-discovered — an operator
 * already looked at that feed and said yes, and re-deriving it would make the
 * confirmation meaningless (and cost three more requests).
 */
export async function buildCatalog(
  deps: SyncDeps,
  creator: SyncCreator,
  source: PlatformSource,
): Promise<CatalogResult> {
  if (source === 'youtube') return buildYouTubeCatalog(deps, creator);
  if (source === 'instagram') return buildInstagramCatalog(deps, creator);
  if (source === 'tiktok') return buildTikTokCatalog(deps, creator);

  const link = creator[SOURCE_COLUMNS[source] as keyof SyncCreator] as string | null | undefined;
  if (!link) {
    return { ok: false, reason: 'no-link', detail: `This creator has no ${SOURCE_LABELS[source]} link.` };
  }

  try {
    new URL(creator.feed_url || link);
  } catch {
    return { ok: false, reason: 'no-link', detail: `"${link}" is not a URL we can fetch.` };
  }

  // Per origin, not per run. A feed and the item pages inside it can sit on
  // different hosts, and applying one host's robots.txt to another's URLs is how
  // a Disallow we were told about goes unread.
  const robots = robotsPerOrigin(deps.fetchOptions);
  const options = { robots, fetchOptions: deps.fetchOptions, maxEntries: CATALOG_MAX_ENTRIES };
  const discovery: FeedDiscoveryResult = creator.feed_url
    ? await readFeed(creator.feed_url, options)
    : await discoverFeed(link, options);

  if (!discovery.ok) {
    return { ok: false, reason: discovery.reason, detail: discovery.detail };
  }

  const entries = await withImportRecords(
    deps,
    creator,
    source,
    discovery.feed.entries.map((entry) => ({
      itemId: entry.id,
      url: entry.url,
      title: entry.title,
      publishedAt: entry.publishedAt,
    })),
  );

  return {
    ok: true,
    source,
    feed: { url: discovery.feed.url, kind: discovery.feed.kind, via: discovery.feed.via },
    entries,
    truncated: entries.length >= CATALOG_MAX_ENTRIES,
  };
}

/**
 * Marks each listed item with what already happened to it.
 *
 * One query for the whole catalog, keyed the way the record is keyed. This and
 * the feed read are the entire cost of drawing the screen — the property that
 * lets an operator open a 200-post blog, or a channel, without spending
 * anything.
 */
async function withImportRecords(
  deps: SyncDeps,
  creator: SyncCreator,
  source: PlatformSource,
  entries: Array<Omit<CatalogEntry, 'record'>>,
): Promise<CatalogEntry[]> {
  const { data: records } = await deps.supabase
    .from('creator_source_items')
    .select('item_id, status, detail, updated_at')
    .eq('creator_id', creator.id)
    .eq('source', source);

  const byItemId = new Map<string, { status: string; detail: string | null; at: string | null }>();
  for (const row of (records ?? []) as Array<Record<string, any>>) {
    byItemId.set(String(row.item_id), {
      status: String(row.status),
      detail: row.detail ?? null,
      at: row.updated_at ?? null,
    });
  }

  return entries.map((entry) => ({ ...entry, record: byItemId.get(entry.itemId) ?? null }));
}

/**
 * Lists a creator's YouTube channel from the uploads feed (MEAL-74).
 *
 * Feed metadata only: ids, titles and dates, one unauthenticated request, no API
 * quota. The same rule the website path follows — nothing here fetches a video
 * or calls a model to draw a list — and the reason a channel can be listed at
 * all before its owner has connected anything.
 *
 * `item_id` is the bare video id. MEAL-79's "this meal came from *that* video"
 * relationship is keyed on it, so it has to be the id YouTube's own API uses.
 */
async function buildYouTubeCatalog(deps: SyncDeps, creator: SyncCreator): Promise<CatalogResult> {
  const resolved = await channelIdForCreator(deps, creator.id, creator.youtube_url ?? null);
  if (!resolved.ok) {
    return { ok: false, reason: 'not-connected', detail: resolved.detail };
  }

  const feed = await readUploadsFeed(resolved.channelId, deps.fetchOptions);
  if (!feed.ok) {
    return { ok: false, reason: 'unreachable', detail: feed.detail };
  }

  const entries = await withImportRecords(
    deps,
    creator,
    'youtube',
    feed.videos.map((video) => ({
      itemId: video.videoId,
      url: video.url,
      title: video.title,
      publishedAt: video.publishedAt,
    })),
  );

  return {
    ok: true,
    source: 'youtube',
    feed: { url: uploadsFeedUrl(resolved.channelId), kind: 'atom', via: 'uploads-feed' },
    entries,
    // The uploads feed only ever carries the most recent uploads, so a full one
    // means there is older material this screen is not showing. Saying so beats
    // an operator concluding the channel is smaller than it is.
    truncated: entries.length >= UPLOADS_FEED_MAX,
  };
}

/**
 * The sentence for a source that can only be reached through a grant we do not
 * have (MEAL-82 / MEAL-83).
 *
 * Instagram and TikTok publish nothing readable without one, so there is no
 * public-feed fallback of the sort the YouTube catalog leans on. Reported as a
 * failure with a next move, never as an empty list — "this creator publishes
 * nothing" is the one thing an empty catalog must not be allowed to mean.
 */
function notConnectedCatalog(source: ConnectedPlatform, brokenReason: string | null): CatalogResult {
  return {
    ok: false,
    reason: 'not-connected',
    detail: brokenReason
      ? `This creator's ${SOURCE_LABELS[source]} connection has stopped working: ${brokenReason} ` +
        'Ask them to reconnect it from the creator portal.'
      : `This creator has not connected their ${SOURCE_LABELS[source]} account, and ${SOURCE_LABELS[source]} ` +
        'shows us nothing without one. Ask them to connect it from the creator portal. Use the one-link ' +
        'mode for individual posts in the meantime.',
  };
}

/** The grant, plus the reason it is unusable when it is. */
async function connectedGrant(deps: SyncDeps, creatorId: string, platform: ConnectedPlatform) {
  const connection = await loadConnection(deps.supabase, creatorId, platform);
  if (!connection) return { token: null, brokenReason: null };
  return {
    token: await usableAccessToken({ supabase: deps.supabase }, connection),
    brokenReason: connection.brokenReason,
  };
}

/**
 * Lists a creator's Instagram account from `/me/media` (MEAL-82).
 *
 * Metadata only: ids, captions, permalinks and timestamps, in one or two
 * requests. Nothing here downloads a video or calls a model to draw a list — the
 * same property the website and YouTube catalogs have, and the reason opening a
 * back catalog costs nothing.
 *
 * `item_id` is Instagram's media id, not the permalink's shortcode. They are
 * different values, and the id is the one every API call and every later
 * `creator_source_items` lookup is keyed on.
 */
async function buildInstagramCatalog(deps: SyncDeps, creator: SyncCreator): Promise<CatalogResult> {
  const { token, brokenReason } = await connectedGrant(deps, creator.id, 'instagram');
  if (!token) return notConnectedCatalog('instagram', brokenReason);

  const listed = await fetchInstagramMedia(token, { limit: INSTAGRAM_MEDIA_MAX, fetchImpl: platformFetch(deps) });
  if (!listed.ok) {
    return { ok: false, reason: 'unreachable', detail: listed.detail };
  }

  const entries = await withImportRecords(
    deps,
    creator,
    'instagram',
    listed.media.map((media) => ({
      itemId: media.id,
      url: media.permalink,
      title: instagramMediaTitle(media),
      publishedAt: media.publishedAt,
    })),
  );

  return {
    ok: true,
    source: 'instagram',
    // No feed: there is no URL here an operator could confirm and store, and
    // offering one to a button that writes `creators.feed_url` invites an error.
    feed: null,
    entries,
    truncated: listed.truncated,
  };
}

/**
 * Lists a creator's TikTok account from `/v2/video/list/` (MEAL-83).
 *
 * Same discipline as the others — metadata only, a handful of requests, no video
 * opened and no model called. `item_id` is TikTok's video id and `url` is the
 * `share_url`, because that is the page a human can open; `embed_link` is a
 * player and is no use in a record somebody reads later.
 */
async function buildTikTokCatalog(deps: SyncDeps, creator: SyncCreator): Promise<CatalogResult> {
  const { token, brokenReason } = await connectedGrant(deps, creator.id, 'tiktok');
  if (!token) return notConnectedCatalog('tiktok', brokenReason);

  const listed = await fetchTikTokVideos(token, { limit: TIKTOK_VIDEO_MAX, fetchImpl: platformFetch(deps) });
  if (!listed.ok) {
    return { ok: false, reason: 'unreachable', detail: listed.detail };
  }

  const entries = await withImportRecords(
    deps,
    creator,
    'tiktok',
    listed.videos.map((video) => ({
      itemId: video.id,
      url: video.shareUrl,
      title: tiktokVideoTitle(video),
      publishedAt: video.publishedAt,
    })),
  );

  return { ok: true, source: 'tiktok', feed: null, entries, truncated: listed.truncated };
}

// ── Running a selection ──────────────────────────────────────────────────────

/**
 * How long a worker may hold a run.
 *
 * Two browser tabs polling the same run must not import the same post twice, and
 * a worker killed mid-chunk must not wedge the run forever — so this is a lease
 * with an expiry rather than a boolean.
 */
export const LEASE_MS = 90_000;

/**
 * Wall-clock budget for one worker invocation, under the 60s function limit with
 * room for the write-back and the notification. Whatever is left over is picked
 * up by the next call.
 */
export const CHUNK_BUDGET_MS = 40_000;

/** Items imported at once. Each is a fetch plus two model calls; two is plenty. */
export const CHUNK_CONCURRENCY = 2;

function isTerminal(item: SyncItem): boolean {
  return item.status !== 'pending';
}

/**
 * Why an item on a connected platform could not be read.
 *
 * Per platform, because the three reasons an item drops out of a listing are
 * different and so is the operator's next move. The failure is retryable — it
 * says what to do rather than recording a verdict on the post, which a gate
 * rejection would have been.
 */
const MISSING_ITEM_DETAIL: Record<ConnectedPlatform, string> = {
  youtube:
    "This video is no longer in the channel's recent uploads, so its description could not be read. " +
    'Re-open the catalog and select it again if it is still listed.',
  instagram:
    "This post is no longer in the account's recent media, or the Instagram connection has stopped " +
    'working, so its caption could not be read. Re-open the catalog to see which.',
  tiktok:
    "This video is no longer in the account's recent videos, or the TikTok connection has stopped " +
    'working, so its description could not be read. Re-open the catalog to see which.',
};

/**
 * Runs one item: gate, extract, queue for review, record.
 *
 * Never throws. An item that blows up is a failed item, because the alternative
 * is one bad post taking the other 199 with it.
 */
export async function processSyncItem(
  deps: SyncDeps,
  run: SyncRun,
  creator: SyncCreator,
  item: SyncItem,
): Promise<SyncItem> {
  const supabase = deps.supabase;
  const importer = deps.importer ?? runImport;
  const queue = deps.queue ?? createImportDraft;

  // Already in, from an earlier run or the poller. Skipped rather than
  // re-imported: an operator ticking a row they were warned about should not be
  // able to publish the same recipe twice under a creator's name.
  const { data: existing } = await supabase
    .from('creator_source_items')
    .select('status')
    .eq('creator_id', creator.id)
    .eq('source', run.source)
    .eq('item_id', item.itemId)
    .maybeSingle();

  if (existing && (existing as Record<string, any>).status === 'imported') {
    return {
      ...item,
      status: 'skipped',
      detail: 'Already imported — skipped so the same recipe is not queued twice.',
    };
  }

  // A post on a connected platform is read from that platform's listing, not
  // from its public URL. A selected item no longer in the listing fails rather
  // than falling back to a page fetch: `watch?v=…` returns a JavaScript shell
  // and an Instagram or TikTok URL returns a login-walled app, the gate would
  // correctly call any of them not-a-recipe, and the operator would read that as
  // a verdict on the post instead of on our reach.
  let document: SourceDocument | undefined;
  if (isConnectedPlatform(run.source)) {
    const resolve = deps.sourceDocument ?? createSourceDocumentResolver(deps);
    const built = await resolve(creator, run.source, item);
    if (!built) {
      return await recordItem(deps, creator, run, {
        ...item,
        status: 'failed',
        detail: MISSING_ITEM_DETAIL[run.source],
      });
    }
    document = built;
  }

  let result: ImportResult;
  try {
    result = await importer(item.url, {
      document,
      // The operator picked this URL and is watching it, which is exactly the
      // condition `manual` describes: an `unsure` verdict is attempted rather
      // than silently skipped. A `no` still stops it — that is the gate doing
      // its job, not a bypass to switch off.
      mode: 'manual',
      // Scopes the storage bucket path when a page's image is copied in, so a
      // synced photo lands under the creator it belongs to.
      userId: creator.user_id,
      fetchOptions: deps.fetchOptions,
      telemetry: (event) =>
        log({
          event: 'CREATOR:MEAL_IMPORT',
          status: event.outcome === 'ok' ? 'success' : 'error',
          userId: creator.id,
          detail: formatTelemetry(event),
        }),
    });
  } catch (err) {
    return await recordItem(deps, creator, run, {
      ...item,
      status: 'failed',
      detail: `The import threw before it could report: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  if (result.status === 'rejected') {
    // The gate is an answer about the post; everything else is an answer about
    // our afternoon. Only the first is permanent.
    const rejectedByGate = result.stage === 'gate';
    return await recordItem(deps, creator, run, {
      ...item,
      status: rejectedByGate ? 'rejected' : 'failed',
      detail: result.detail,
      costUsd: 0,
    });
  }

  const costUsd = (result.meta.usage?.costUsd ?? 0) + (result.meta.gateUsage?.costUsd ?? 0);

  try {
    const draftId = await queue(supabase, {
      creatorId: creator.id,
      sourceUrl: result.url,
      source: run.source,
      itemId: item.itemId,
      syncRunId: run.id,
      draft: result.draft,
      // Stored, not discarded. Passing the draft on without this is the bug
      // MEAL-91 was written about: the field-level assessment was computed on
      // every import and then dropped on the floor, so the greens on this path
      // were claims nobody had ever looked at.
      confidence: result.confidence,
      reviewBy: 'admin',
    });

    // Counted here rather than on the review screen so an operator watching a
    // 40-item run already knows how much reading is waiting for them.
    const { summary } = reviewDraft({
      ...EMPTY_DRAFT_FIELDS,
      id: draftId,
      creatorId: creator.id,
      sourceUrl: result.url,
      draft: result.draft,
      confidence: result.confidence,
    });

    return await recordItem(deps, creator, run, {
      ...item,
      status: 'drafted',
      detail: null,
      draftId,
      mealName: result.draft.name,
      needALook: summary.needALook,
      costUsd,
    });
  } catch (err) {
    // Extraction succeeded and the insert did not. Retryable, and the cost of
    // the extraction is still recorded — it was really spent.
    return await recordItem(deps, creator, run, {
      ...item,
      status: 'failed',
      detail: `Extracted, but queuing it for review failed: ${err instanceof Error ? err.message : String(err)}`,
      costUsd,
    });
  }
}

/** The members of `ImportDraft` `reviewDraft` does not read. Kept out of the call site. */
const EMPTY_DRAFT_FIELDS = {
  creatorName: null,
  source: null,
  itemId: null,
  syncRunId: null,
  status: 'pending_review',
  reviewBy: 'admin',
  editedAt: null,
  decidedAt: null,
  decidedBy: null,
  publishedMealId: null,
  createdAt: null,
} satisfies Omit<ImportDraft, 'id' | 'creatorId' | 'sourceUrl' | 'draft' | 'confidence'>;

/**
 * Writes the durable per-item record.
 *
 * `creator_source_items` is what the poller and the next operator read, so it is
 * updated even when the batch row already knows — and a write failure here is
 * logged, not thrown: losing the bookkeeping is bad, losing the run because the
 * bookkeeping failed is worse.
 */
async function recordItem(
  deps: SyncDeps,
  creator: SyncCreator,
  run: SyncRun,
  // Narrowed to the three outcomes worth recording, so a new item status can
  // never quietly become an invalid record write.
  item: SyncItem & { status: 'drafted' | 'rejected' | 'failed' },
): Promise<SyncItem> {
  // `imported` in the record means "produced a draft or a published meal" — the
  // sense `add-creator-sources.sql` already gives it. Writing it the moment the
  // draft exists rather than when it publishes is what makes a declined recipe
  // stay declined: the next sync or poll sees the record and skips the post.
  const recordStatus = item.status === 'drafted' ? 'imported' : item.status;

  try {
    await deps.supabase.from('creator_source_items').upsert(
      {
        creator_id: creator.id,
        source: run.source,
        item_id: item.itemId,
        url: item.url,
        title: item.title,
        published_at: item.publishedAt,
        status: recordStatus,
        detail: item.detail,
        draft_id: item.draftId,
        updated_at: new Date(deps.now?.() ?? Date.now()).toISOString(),
      },
      { onConflict: 'creator_id,source,item_id' },
    );
  } catch (err) {
    log({ event: 'ADMIN:SYNC_ITEM', status: 'error', userId: creator.id, detail: `run=${run.id} item=${JSON.stringify(item.itemId)}`, error: err });
  }
  return item;
}

/**
 * Moves a run forward by one chunk, then returns where it got to.
 *
 * This is the whole background job. It is deliberately *resumable* rather than
 * long-running: it takes a lease, works until its budget is spent, writes what
 * it did and lets go. The admin screen calls it in a loop while a run is
 * unfinished, and the daily cron sweeps anything an operator walked away from —
 * so a closed tab delays a run rather than abandoning it half-imported.
 */
export async function advanceRun(deps: SyncDeps, runId: string): Promise<SyncRun | null> {
  const supabase = deps.supabase;
  const now = deps.now ?? Date.now;

  const { data: row } = await supabase.from('creator_sync_runs').select('*').eq('id', runId).maybeSingle();
  if (!row) return null;
  let run = toSyncRun(row as Record<string, any>);

  const nowIso = new Date(now()).toISOString();

  // Claim the lease. `or` covers both "nobody holds it" and "whoever held it is
  // gone"; if neither matches, another worker is mid-chunk and we report
  // progress instead of racing it.
  const { data: claimed } = await supabase
    .from('creator_sync_runs')
    .update({
      status: 'running',
      lease_until: new Date(now() + LEASE_MS).toISOString(),
      started_at: row.started_at ?? nowIso,
      updated_at: nowIso,
    })
    .eq('id', runId)
    .or(`lease_until.is.null,lease_until.lt.${nowIso}`)
    .select();

  if (!Array.isArray(claimed) || claimed.length === 0) {
    return run;
  }

  const creator = await loadSyncCreator(supabase, run.creatorId);
  if (!creator) {
    await supabase
      .from('creator_sync_runs')
      .update({ status: 'done', finished_at: nowIso, lease_until: null, updated_at: nowIso })
      .eq('id', runId);
    log({ event: 'ADMIN:SYNC_RUN', status: 'error', detail: `run=${runId} creator=${run.creatorId} missing` });
    return { ...run, status: 'done' };
  }

  const deadline = now() + CHUNK_BUDGET_MS;
  let items = [...run.items];

  // Built once per invocation rather than per item, so a 40-video selection
  // reads the uploads feed once and refreshes the grant once.
  const chunkDeps: SyncDeps = { ...deps, sourceDocument: deps.sourceDocument ?? createSourceDocumentResolver(deps) };

  while (items.some((item) => !isTerminal(item)) && now() < deadline) {
    const wave: number[] = [];
    for (let i = 0; i < items.length && wave.length < CHUNK_CONCURRENCY; i++) {
      if (!isTerminal(items[i])) wave.push(i);
    }

    const processed = await Promise.all(
      wave.map((index) => processSyncItem(chunkDeps, { ...run, items }, creator, items[index])),
    );
    wave.forEach((index, position) => {
      items[index] = processed[position];
    });

    // Written after every wave, not at the end: the screen polls this row, and a
    // run that shows nothing for four minutes looks broken.
    await supabase
      .from('creator_sync_runs')
      .update({
        items,
        lease_until: new Date(now() + LEASE_MS).toISOString(),
        updated_at: new Date(now()).toISOString(),
      })
      .eq('id', runId);
  }

  const finished = items.every(isTerminal);
  run = { ...run, items, status: finished ? 'done' : 'running' };

  // No email here any more. A finished run has published nothing, so there is
  // nothing true to tell a creator yet; the announcement fires from Approve
  // (`notifyApproved`), where the meals are actually live.
  await supabase
    .from('creator_sync_runs')
    .update({
      items,
      status: finished ? 'done' : 'queued',
      finished_at: finished ? new Date(now()).toISOString() : null,
      lease_until: null,
      updated_at: new Date(now()).toISOString(),
    })
    .eq('id', runId);

  const totals = summariseRun({ ...run, items });
  log({
    event: 'ADMIN:SYNC_RUN',
    status: finished ? 'success' : 'pending',
    userId: creator.id,
    detail:
      `run=${runId} source=${run.source} ${finished ? 'done' : 'partial'} ` +
      `selected=${totals.selected} drafted=${totals.drafted} rejected=${totals.rejected} ` +
      `failed=${totals.failed} skipped=${totals.skipped} flagged=${totals.needALook} ` +
      `cost=$${totals.costUsd.toFixed(4)}`,
  });

  return { ...run, items, status: finished ? 'done' : 'queued' };
}

/** Reads the creator fields the engine needs. */
async function loadSyncCreator(supabase: SupabaseClient, creatorId: string): Promise<SyncCreator | null> {
  const { data } = await supabase
    .from('creators')
    .select('id, user_id, display_name, website_url, youtube_url, instagram_url, tiktok_url, feed_url')
    .eq('id', creatorId)
    .maybeSingle();

  if (!data) return null;
  const row = data as Record<string, any>;
  return {
    id: row.id,
    user_id: row.user_id,
    display_name: row.display_name,
    website_url: row.website_url ?? null,
    youtube_url: row.youtube_url ?? null,
    instagram_url: row.instagram_url ?? null,
    tiktok_url: row.tiktok_url ?? null,
    feed_url: row.feed_url ?? null,
  };
}

/**
 * Puts one failed item back in the queue.
 *
 * Only `failed` is retryable. Retrying a gate rejection would just pay for the
 * same "no" again, and retrying something already drafted is how the same recipe
 * ends up in the review queue twice.
 */
export async function retrySyncItem(
  deps: SyncDeps,
  runId: string,
  itemId: string,
): Promise<{ ok: true; run: SyncRun } | { ok: false; error: string }> {
  const now = deps.now ?? Date.now;
  const { data: row } = await deps.supabase.from('creator_sync_runs').select('*').eq('id', runId).maybeSingle();
  if (!row) return { ok: false, error: 'Run not found' };

  const run = toSyncRun(row as Record<string, any>);
  const target = run.items.find((item) => item.itemId === itemId);
  if (!target) return { ok: false, error: 'That item is not part of this run.' };
  if (target.status !== 'failed') {
    return { ok: false, error: `Only failed items can be retried; this one is ${target.status}.` };
  }

  const items = run.items.map((item) =>
    item.itemId === itemId ? { ...item, status: 'pending' as const, detail: null } : item,
  );

  await deps.supabase
    .from('creator_sync_runs')
    .update({ items, status: 'queued', finished_at: null, updated_at: new Date(now()).toISOString() })
    .eq('id', runId);

  return { ok: true, run: { ...run, items, status: 'queued' } };
}

/**
 * Resumes runs nobody is driving.
 *
 * The admin screen calls the worker in a loop, which means closing the tab
 * stops the loop. Without this a 200-item run could sit half-published forever
 * and — worse — the creator would never get the email about the half that did
 * publish. Called from the daily cron, so the recovery is slow but certain.
 */
export async function resumeStalledSyncRuns(deps: SyncDeps, limit = 5): Promise<number> {
  const nowIso = new Date((deps.now ?? Date.now)()).toISOString();
  const { data } = await deps.supabase
    .from('creator_sync_runs')
    .select('id')
    .neq('status', 'done')
    .or(`lease_until.is.null,lease_until.lt.${nowIso}`)
    .order('created_at', { ascending: true })
    .limit(limit);

  const rows = (data ?? []) as Array<{ id: string }>;
  for (const row of rows) {
    await advanceRun(deps, row.id);
  }
  return rows.length;
}
