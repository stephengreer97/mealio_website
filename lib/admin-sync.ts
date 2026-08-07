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
 *   1. **Rendering the catalog spends nothing on extraction.** Titles, dates and
 *      links come from listing metadata; nothing here fetches a post or calls a
 *      model to draw a list. Opening a 200-post blog costs the feed request and
 *      the already-imported lookup, and nothing else. YouTube is the one source
 *      with a bill attached — `playlistItems.list` spends Data API units, so it
 *      lists **one page per press** rather than the whole channel (MEAL-79).
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
import { createImportDraft, reviewDraft, type DraftReviewBy, type ImportDraft } from '@/lib/import-drafts';
import { log } from '@/lib/logger';
import {
  isConnectedPlatform,
  isOnSameSite,
  platformSourceForUrl,
  SOURCE_COLUMNS,
  SOURCE_LABELS,
  type ConnectedPlatform,
  type PlatformSource,
} from '@/lib/creator-sources';
import { normalizeUrl, urlIdentity } from '@/lib/import/ssrf';
import { loadConnection, usableAccessToken } from '@/lib/platform-tokens';
import { discoverFeed, readFeed, type FeedDiscoveryResult } from '@/lib/import/feed-discovery';
import { runImport, type RunImportOptions } from '@/lib/import/pipeline';
import { robotsPerOrigin } from '@/lib/import/robots';
import type { SafeFetchOptions } from '@/lib/import/ssrf';
import {
  channelIdForCreator,
  fetchVideos,
  listUploads,
  youtubeSourceDocument,
  UPLOADS_PAGE_SIZE,
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
  TIKTOK_PAGE_SIZE,
  TIKTOK_VIDEO_MAX,
} from '@/lib/tiktok';
import { formatTelemetry } from '@/lib/import/telemetry';
import type { FeedKind } from '@/lib/import/feed';
import type { ConditionalValidators } from '@/lib/import/ssrf';
import type { GateMode, ImportResult, SourceDocument } from '@/lib/import/types';

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
  /**
   * The two facts that make an email about this draft a decision rather than a
   * notification (MEAL-76): the picture, and how much recipe there is. Carried
   * on the item so the notifier does not have to re-read and re-derive a draft
   * the pipeline has just finished holding.
   *
   * Null on items recorded before MEAL-75, and on every non-drafted outcome.
   */
  photoUrl: string | null;
  ingredientCount: number | null;
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
  /**
   * How an `unsure` gate verdict resolves. Defaults to `manual`, which is the
   * truth for an operator-driven run: they picked the item and are watching.
   *
   * The poller sets `poller`, and the difference is the whole reason the mode
   * exists — nobody asked for that import, so a maybe has to be a no. A false
   * positive there is not a wasted click, it is a draft and an email about a
   * post the creator never offered us (MEAL-75).
   */
  gateMode?: GateMode;
  /**
   * Whose queue a draft lands in. Defaults to `admin`, which is the truth for an
   * operator-driven run: they started it and they are the ones reading it.
   *
   * The poller sets `creator`, and that is not cosmetic — the email it sends
   * says "Review and publish" and points at the creator portal (MEAL-76), so a
   * draft left in the operator's queue is a creator asked to act on something
   * they cannot see. A seam rather than a constant because these are two
   * different products of the same engine, and the engine must not have to
   * guess which one it is running for.
   */
  reviewBy?: DraftReviewBy;
  /** The import pipeline seam. Tests substitute a stub; production runs the real thing. */
  importer?: (url: string, options: RunImportOptions) => Promise<ImportResult>;
  /** Where an extraction lands. There is no publisher seam here any more — a run cannot publish. */
  queue?: typeof createImportDraft;
  /**
   * Builds the source document for a source that is not a web page.
   *
   * `advanceRun` fills this in with a resolver memoised per run, so a 40-video
   * selection reads the platform once rather than forty times.
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
 *
 * `videoIds` is the whole YouTube selection, handed down so the run can read it
 * in one `videos.list` call (1 quota unit per 50 ids) instead of one per item.
 * Empty is a valid answer — the single-item path has only the item in front of
 * it — and the resolver falls back to that id alone.
 */
export function createSourceDocumentResolver(deps: SyncDeps, videoIds: string[] = []): SourceDocumentResolver {
  let channel: Promise<{
    videos: Map<string, YouTubeVideo>;
    accessToken: string | null;
    /**
     * What the grant actually carries (MEAL-138). Handed to the reader so a
     * `captions.list` that is certain to be refused is never issued — 50 quota
     * units per thin-description video, and a `missing-scope` answer that does
     * not have to be inferred from an error body.
     */
    scopes: readonly string[] | null;
  }> | null = null;
  /** Instagram and TikTok reduce to a document per item id at listing time. */
  let instagram: Promise<Map<string, SourceDocument>> | null = null;
  let tiktok: Promise<Map<string, SourceDocument>> | null = null;

  return async (creator, source, item) => {
    if (source === 'youtube') {
      channel ??= (async () => {
        const empty = { videos: new Map<string, YouTubeVideo>(), accessToken: null, scopes: null };
        // A grant, not a link. `playlistItems.list` and `videos.list` are both
        // authenticated calls now, so an unconnected creator has no read path at
        // all — where the uploads feed used to give description-only import for
        // free (MEAL-74, robots.txt).
        const { connection, token } = await connectedGrant(deps, creator.id, 'youtube');
        if (!token) return empty;
        // The grant's channel id, never one derived from `creator.youtube_url`.
        // The filter below compares against this value, so an id taken from a
        // link a creator supplied would only ever be checked against itself.
        const resolved = channelIdForCreator(connection);
        if (!resolved.ok) return empty;

        // Read by id rather than by re-listing the channel. A selection made
        // from page 4 of a 300-video catalogue used to be unreadable, because
        // the run looked for those ids in the most recent 15 uploads.
        const listed = await fetchVideos(token, [...new Set(videoIds.length ? videoIds : [item.itemId])], {
          fetchImpl: platformFetch(deps),
        });
        if (!listed.ok) return empty;

        return {
          videos: new Map(
            listed.videos
              // The id came from a request body. Without this a hand-edited
              // selection naming somebody else's video would be extracted and
              // published under this creator's name.
              .filter((video) => video.channelId === resolved.channelId)
              .map((video) => [video.videoId, video] as const),
          ),
          accessToken: token,
          scopes: connection?.scopes ?? null,
        };
      })();

      const { videos, accessToken, scopes } = await channel;
      const video = videos.get(item.itemId);
      if (!video) return null;
      return youtubeSourceDocument(video, {
        accessToken,
        scopes,
        fetchImpl: platformFetch(deps),
        lookup: deps.fetchOptions?.lookup,
      });
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

/**
 * How far back through a paged feed the catalogue will walk.
 *
 * A bound rather than a preference: a feed that ignores `?paged=` answers every
 * page with its first one, and without a ceiling the list would offer "more"
 * forever. Fifty pages is five hundred posts on a WordPress default, which is
 * `CATALOG_MAX_ENTRIES` and further back than any creator has asked to go.
 */
export const FEED_MAX_PAGES = 50;

export interface CatalogEntry {
  itemId: string;
  url: string;
  title: string | null;
  publishedAt: string | null;
  /**
   * The `creator_source_items` record, when there is one. Drives the
   * already-imported marker, and the row starts deselected because select-all on
   * a catalog half of which is already in is the obvious expensive mistake.
   *
   * `at` is when we last touched it and `firstSeenAt` when we first met it. Both,
   * because the poller's retry sweep is bounded from the first meeting and leased
   * from the last one, and one timestamp cannot say both (MEAL-75).
   *
   * `rejected` and `declined` are different answers and now different statuses:
   * the gate refused the page without a human ever seeing it, or it produced a
   * draft that a person then declined (MEAL-99). They behave the same — no meal
   * came of either and no sync should try again on its own — but a creator
   * reading their own catalogue is owed the difference, and it used to be
   * inferred from whether `draftId` was set, which made a foreign key carry a
   * meaning nothing in the schema mentioned.
   */
  record: {
    status: string;
    detail: string | null;
    at: string | null;
    firstSeenAt: string | null;
    draftId: string | null;
    /**
     * An import of this post is running right now.
     *
     * Not a status of its own: a claim is stored as `failed` carrying
     * `CLAIM_DETAIL`, so a worker that dies mid-extraction leaves a retryable
     * row rather than a wedged one. That distinction matters to the retry sweep
     * and means nothing to a creator, who needs "we could not read this" and
     * "we are reading it" to look different — the checklist was saying the first
     * about a post it was importing at that moment.
     */
    inFlight: boolean;
  } | null;
}

/**
 * The `creator_source_items` id for an entry from a website feed.
 *
 * **Derived from the entry's URL, never from the feed's own guid**, because the
 * id must not depend on which rung of the discovery ladder answered. A creator
 * with no confirmed `feed_url` walks the whole ladder on every poll, and the
 * rungs disagree: RSS and Atom carry a guid, a sitemap carries only a location.
 * One 503 on `/feed` falls through to `/sitemap.xml`, every already-baselined
 * post is unseen again, and the back catalogue is re-imported — quietly, because
 * a handful of posts sits under the flood cap (MEAL-75).
 *
 * The cost is real and much smaller: a post whose permalink genuinely moves
 * reads as a new post, where a permalink-guid feed would have recognised it.
 * Normalising absorbs the cases that are a move in name only — scheme, `www.`,
 * a trailing slash, a fragment — so what is left is one re-imported post against
 * a whole archive. The query string is kept: `/?p=123` is a permalink on every
 * WordPress site that never switched away from the default.
 */
export function websiteItemId(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.host.toLowerCase().replace(/^www\./, '');
    const path = parsed.pathname.replace(/\/+$/, '');
    return `${host}${path || '/'}${parsed.search}`;
  } catch {
    // Not a URL we could parse is not a URL we fetched either; the raw string is
    // still stable, which is the only property this needs.
    return url;
  }
}

export type CatalogResult =
  | {
      ok: true;
      source: PlatformSource;
      feed: { url: string; kind: FeedKind; via: string } | null;
      entries: CatalogEntry[];
      /** True when the source published more than we will list. */
      truncated: boolean;
      /**
       * Cursor for the next window of a paged catalogue (YouTube, MEAL-79).
       *
       * Present means there is more and an operator can ask for it; absent means
       * this is everything. Distinct from `truncated`, which says the same thing
       * for sources that offer no way to go and get the rest.
       */
      nextPageToken?: string | null;
      /**
       * YouTube Data API units this listing spent, out of a shared 10,000/day.
       *
       * Shown on the operator screen for the reason the cost estimate is: a
       * budget nobody can see is a budget somebody exhausts. Absent on the three
       * sources that spend none.
       */
      quotaUnits?: number;
      /**
       * Polling bookkeeping, filled in only on the website path (MEAL-75).
       *
       * The other three sources are authenticated JSON APIs read with a bearer
       * token: they carry no validator we could replay and advertise no
       * interval, so there is nothing honest to put here for them.
       */
      validators?: ConditionalValidators;
      ttlSeconds?: number | null;
    }
  | {
      ok: false;
      /**
       * `not-modified` is the one value here that is not a problem — the
       * conditional read worked and the feed is unchanged. Everything a caller
       * does with it is different from what it does with a failure, so it does
       * not get folded into one (MEAL-75).
       */
      reason: string;
      detail: string;
      /**
       * Units a *failed* listing still spent (YouTube, MEAL-79).
       *
       * `playlistItems.list` refusing after `channels.list` succeeded has cost a
       * unit, and a screen that only adds up successes reports less than Google
       * charged — which is the wrong direction for a number whose job is to make
       * somebody stop before the budget does.
       */
      quotaUnits?: number;
    };

export interface CatalogOptions {
  /**
   * Replayed as `If-None-Match` / `If-Modified-Since` on the website feed, so a
   * poll of an unchanged feed costs a 304 instead of a body. Unset for the
   * operator-facing catalog: an operator opening the screen wants to see the
   * list, not be told it has not changed since a cron read it.
   */
  conditional?: ConditionalValidators;
  /**
   * The next window of a paged catalogue, from the previous result's
   * `nextPageToken`. YouTube only — nothing else here pages.
   */
  pageToken?: string | null;
}

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
  catalogOptions: CatalogOptions = {},
): Promise<CatalogResult> {
  if (source === 'youtube') return buildYouTubeCatalog(deps, creator, catalogOptions.pageToken ?? null);
  if (source === 'instagram') return buildInstagramCatalog(deps, creator);
  if (source === 'tiktok') return buildTikTokCatalog(deps, creator, catalogOptions.pageToken ?? null);

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
  const options = {
    robots,
    fetchOptions: deps.fetchOptions,
    maxEntries: CATALOG_MAX_ENTRIES,
    conditional: catalogOptions.conditional,
  };
  // Only a confirmed feed can be read conditionally. The discovery ladder walks
  // addresses it has never fetched, so it has no validators to replay — which is
  // also why a creator with no `feed_url` costs the full ladder on every poll,
  // and why confirming one at onboarding is worth the operator's minute.
  // Page two and beyond of a blog's archive.
  //
  // A feed is a window, not an archive: WordPress publishes ten posts and
  // nothing older, so a creator connecting a blog could reach their ten most
  // recent recipes and no further. `?paged=N` is how WordPress — which is most
  // of the food blogs we will ever see — offers the rest, and it is ignored
  // harmlessly by feeds that do not implement it.
  //
  // Only ever a page *number*, never a URL from the request. The address is
  // built here from the stored `feed_url`; taking one from the client would make
  // this endpoint fetch whatever it was handed.
  const page = catalogOptions.pageToken ? Math.max(1, Math.min(Number(catalogOptions.pageToken) || 1, FEED_MAX_PAGES)) : 1;
  const pagedFeedUrl = (base: string): string => {
    if (page === 1) return base;
    const url = new URL(base);
    url.searchParams.set('paged', String(page));
    return url.toString();
  };

  const discovery: FeedDiscoveryResult = creator.feed_url
    ? await readFeed(pagedFeedUrl(creator.feed_url), options)
    : await discoverFeed(link, options);

  if (!discovery.ok) {
    return { ok: false, reason: discovery.reason, detail: discovery.detail };
  }

  const entries = await withImportRecords(
    deps,
    creator,
    source,
    discovery.feed.entries.map((entry) => ({
      // Not `entry.id`. See `websiteItemId` — the guid is only as stable as the
      // rung that happened to answer, and the URL is the one thing all of them
      // agree about.
      itemId: websiteItemId(entry.url),
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
    // Offered while a page still had something in it. An empty page is the end
    // of the archive; a feed that ignores `paged` repeats itself instead, which
    // the list notices when a window adds nothing it did not already have.
    nextPageToken: entries.length > 0 && page < FEED_MAX_PAGES ? String(page + 1) : null,
    validators: discovery.feed.validators,
    ttlSeconds: discovery.feed.ttlSeconds,
  };
}

/**
 * Rows read per request, and the number of requests allowed.
 *
 * PostgREST answers with at most `max-rows` (1000 on Supabase) unless a range
 * says otherwise, **and says nothing about having truncated**. A creator whose
 * `creator_source_items` has grown past that would silently get a partial record
 * map, and a missing record does not read as "unknown" anywhere here — it reads
 * as *new*, which on the poller's side means importing a post we have already
 * imported. So the read is paged explicitly and ordered, since an unordered
 * OFFSET may repeat one row and skip another.
 *
 * The page ceiling is a bound on a screen draw, not a limit on a creator: 20k
 * items is two orders of magnitude past the largest catalog we will list.
 */
const RECORD_PAGE_SIZE = 1000;
const MAX_RECORD_PAGES = 20;

/**
 * Marks each listed item with what already happened to it.
 *
 * One query per page, keyed the way the record is keyed. This and the feed read
 * are the entire cost of drawing the screen — the property that lets an operator
 * open a 200-post blog, or a channel, without spending anything.
 */
async function withImportRecords(
  deps: SyncDeps,
  creator: SyncCreator,
  source: PlatformSource,
  entries: Array<Omit<CatalogEntry, 'record'>>,
): Promise<CatalogEntry[]> {
  const byItemId = new Map<string, NonNullable<CatalogEntry['record']>>();

  for (let page = 0; page < MAX_RECORD_PAGES; page++) {
    const from = page * RECORD_PAGE_SIZE;
    const { data: records } = await deps.supabase
      .from('creator_source_items')
      .select('item_id, status, detail, draft_id, created_at, updated_at')
      .eq('creator_id', creator.id)
      .eq('source', source)
      .order('item_id', { ascending: true })
      .range(from, from + RECORD_PAGE_SIZE - 1);

    const rows = (records ?? []) as Array<Record<string, any>>;
    for (const row of rows) {
      // A claim in flight is stored as `failed` carrying `CLAIM_DETAIL` — see
      // that constant for why it borrows the status rather than adding one. That
      // is right for the retry sweep and wrong for a creator: the checklist read
      // it as a failure and said "Could not read" about a post it was importing
      // at that moment. Resolved here, where the lease is already understood,
      // rather than by shipping the sentinel string to the browser.
      const claimedAt = Date.parse(String(row.updated_at ?? ''));
      const inFlight = String(row.status) === 'failed'
        && row.detail === CLAIM_DETAIL
        && Number.isFinite(claimedAt)
        && Date.now() - claimedAt < CLAIM_LEASE_MS;

      byItemId.set(String(row.item_id), {
        status: String(row.status),
        detail: row.detail ?? null,
        at: row.updated_at ?? null,
        firstSeenAt: row.created_at ?? null,
        draftId: row.draft_id ?? null,
        inFlight,
      });
    }
    if (rows.length < RECORD_PAGE_SIZE) break;
  }

  return entries.map((entry) => ({ ...entry, record: byItemId.get(entry.itemId) ?? null }));
}

/**
 * Lists one window of a creator's YouTube back catalogue (MEAL-74 / MEAL-79).
 *
 * Metadata only: ids, titles, dates and descriptions, from `playlistItems.list`
 * against the channel's uploads playlist. Nothing here fetches a video or calls
 * a model to draw a list — the same rule the other three catalogs follow.
 *
 * Two things changed with MEAL-79 and both are visible from here:
 *
 *   - **It needs a grant**, so an unconnected channel is reported the way an
 *     unconnected Instagram account is. The uploads feed used to make this work
 *     with no connection at all; `youtube.com/robots.txt` disallows that feed,
 *     and the sanctioned replacement is authenticated.
 *   - **It pages, and one press lists one page.** 50 videos for 2 units, or 1
 *     once the uploads playlist id is memoised for this channel. The operator
 *     asks for the next window, so a 300-video channel costs 7 units when
 *     somebody wants all of it and one instance served every press, 12 if none
 *     of them hit a warm memo, and 2 when they opened the screen to look.
 *
 * `item_id` is the bare video id. MEAL-79's "this meal came from *that* video"
 * relationship is keyed on it, so it has to be the id YouTube's own API uses.
 */
async function buildYouTubeCatalog(
  deps: SyncDeps,
  creator: SyncCreator,
  pageToken: string | null,
): Promise<CatalogResult> {
  const { connection, token, brokenReason } = await connectedGrant(deps, creator.id, 'youtube');
  if (!token) return notConnectedCatalog('youtube', brokenReason);

  const resolved = channelIdForCreator(connection);
  if (!resolved.ok) {
    return { ok: false, reason: 'not-connected', detail: resolved.detail };
  }

  const listed = await listUploads(token, resolved.channelId, {
    pageToken,
    limit: UPLOADS_PAGE_SIZE,
    fetchImpl: platformFetch(deps),
  });
  if (!listed.ok) {
    return { ok: false, reason: 'unreachable', detail: listed.detail, quotaUnits: listed.quotaUnits };
  }
  // An empty page is not an empty account when there is a cursor behind it.
  // `listUploads` drops private and deleted placeholders, so a channel whose 50
  // most recent uploads are private lists nothing on page one — and reporting
  // that as "this account has nothing posted" is both the one thing an empty
  // list must never be allowed to mean and a dead end: `emptyAccountCatalog`
  // carries no cursor, so the public back catalogue behind page one can never be
  // asked for. With a cursor this is an ordinary short page.
  if (listed.videos.length === 0 && !pageToken && !listed.nextPageToken) return emptyAccountCatalog('youtube');

  const entries = await withImportRecords(
    deps,
    creator,
    'youtube',
    listed.videos.map((video) => ({
      itemId: video.videoId,
      url: video.url,
      title: video.title,
      publishedAt: video.publishedAt,
    })),
  );

  return {
    ok: true,
    source: 'youtube',
    // No feed URL to offer. There is nothing here an operator could confirm and
    // store, and handing a `youtube.com` address to the button that writes
    // `creators.feed_url` only invites an error.
    feed: null,
    entries,
    // A next cursor means there is older material this screen is not showing.
    // Saying so beats an operator concluding the channel is smaller than it is.
    truncated: Boolean(listed.nextPageToken),
    nextPageToken: listed.nextPageToken,
    quotaUnits: listed.quotaUnits,
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
/**
 * The sentence for an account we reached and which has posted nothing.
 *
 * Its own `reason`, not `unreachable`, because those are opposite facts and an
 * operator does opposite things with them: one is a creator with no back
 * catalogue yet, the other is a grant or a network to go and look at. Reported
 * as a failure rather than an empty success for the reason `notConnectedCatalog`
 * gives — "this creator publishes nothing" is not something an empty list may be
 * allowed to mean silently — but it says which of the two it is.
 */
function emptyAccountCatalog(source: ConnectedPlatform): CatalogResult {
  return {
    ok: false,
    reason: 'empty',
    detail:
      `We reached this creator's ${SOURCE_LABELS[source]} account and it has nothing posted that we can read. ` +
      'That is an answer rather than a failure — there is nothing to import yet.',
  };
}

function notConnectedCatalog(source: ConnectedPlatform, brokenReason: string | null): CatalogResult {
  return {
    ok: false,
    reason: 'not-connected',
    detail: brokenReason
      ? `This creator's ${SOURCE_LABELS[source]} connection has stopped working: ${brokenReason} ` +
        'Ask them to reconnect it from the creator portal.'
      : `This creator has not connected their ${SOURCE_LABELS[source]} account, and ${SOURCE_LABELS[source]} ` +
        'shows us nothing without one. Ask them to connect it from the creator portal. One-link mode is no ' +
        'help here either: these three are read through the grant and never from their public URL, because ' +
        'the public URL serves an app shell with no recipe on it.',
  };
}

/**
 * The grant, plus the reason it is unusable when it is.
 *
 * The connection itself comes back too, because YouTube needs the channel id off
 * it. Loading it twice — once for the token, once for the id — would ask the
 * same question twice and let the two answers disagree.
 */
async function connectedGrant(deps: SyncDeps, creatorId: string, platform: ConnectedPlatform) {
  const connection = await loadConnection(deps.supabase, creatorId, platform);
  if (!connection) return { connection: null, token: null, brokenReason: null };
  return {
    connection,
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
  if (listed.media.length === 0) return emptyAccountCatalog('instagram');

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
/**
 * One window of a TikTok account, not the whole thing.
 *
 * TikTok answers twenty at a time, so reading the full hundred was five
 * round trips before the portal could draw anything — the slowest thing on the
 * creator's page by a distance. The catalogue now reads one page and hands back
 * a cursor, and the list asks for the next as the creator scrolls.
 *
 * Polling is unchanged and still reads the full window: a sweep that stopped at
 * twenty would stop seeing posts from a creator who published more than that
 * between two polls.
 */
async function buildTikTokCatalog(deps: SyncDeps, creator: SyncCreator, cursor: string | null): Promise<CatalogResult> {
  const { token, brokenReason } = await connectedGrant(deps, creator.id, 'tiktok');
  if (!token) return notConnectedCatalog('tiktok', brokenReason);

  const listed = await fetchTikTokVideos(token, {
    limit: TIKTOK_PAGE_SIZE,
    maxPages: 1,
    cursor: cursor === null ? null : Number(cursor),
    fetchImpl: platformFetch(deps),
  });
  if (!listed.ok) {
    return { ok: false, reason: 'unreachable', detail: listed.detail };
  }
  // Only the first window can say the account is empty. A later one coming back
  // empty means the creator scrolled to the end, and telling them they have
  // posted nothing at the bottom of a list of their posts is nonsense.
  if (listed.videos.length === 0 && cursor === null) return emptyAccountCatalog('tiktok');

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

  return {
    ok: true,
    source: 'tiktok',
    feed: null,
    entries,
    truncated: listed.truncated,
    nextPageToken: listed.nextCursor === null ? null : String(listed.nextCursor),
  };
}

// ── Turning a ticked checklist into a run ────────────────────────────────────

/**
 * `normalizeUrl` insists on a scheme, and a checklist row (or an operator
 * pasting `theirblog.com/x`) has given us a perfectly good link. Same leniency
 * as the creator link fields.
 */
export function toSyncUrl(raw: unknown): string | null {
  const input = typeof raw === 'string' ? raw.trim() : '';
  if (!input) return null;
  return normalizeUrl(/^[a-z][a-z0-9+.-]*:/i.test(input) ? input : `https://${input}`);
}

export function newSyncItem(input: {
  itemId: string;
  url: string;
  title?: unknown;
  publishedAt?: unknown;
}): SyncItem {
  return {
    itemId: input.itemId,
    url: input.url,
    title: typeof input.title === 'string' ? input.title.slice(0, 300) : null,
    publishedAt: typeof input.publishedAt === 'string' ? input.publishedAt : null,
    status: 'pending',
    detail: null,
    draftId: null,
    mealName: null,
    needALook: null,
    photoUrl: null,
    ingredientCount: null,
    costUsd: 0,
  };
}

/**
 * Validates a ticked selection into the items a run is made of.
 *
 * Lifted out of the admin route when MEAL-101 gave creators the same checklist.
 * Every rule below is about **whose posts these are**, and a rule enforced on
 * one of two routes that accept a selection is the rule not existing — the
 * creator's own checklist is not more trustworthy than an operator's, because
 * neither of them is what arrives: what arrives is a request body.
 *
 *   - Every URL has to be on the creator's own site. The client got these rows
 *     from their own feed, so a cross-host entry means a hijacked feed or a
 *     hand-edited request, and publishing a stranger's recipe under a creator's
 *     name is what MEAL-77 exists to prevent.
 *   - A YouTube row's URL has to be the watch page for the very video id being
 *     recorded, or `creator_source_items` ends up describing one video with
 *     another's link — which is what MEAL-79 later reads to decide which video a
 *     published meal came from.
 *   - Instagram and TikTok cannot get that treatment (a permalink carries a
 *     shortcode, not the media id), so the host is what is insisted on.
 *
 * The three connected platforms are exempt from the *link* requirement, because
 * the account comes from the OAuth grant: a creator who connected properly can
 * be synced with no `youtube_url` on their row at all. They are not exempt from
 * a check — the rules above are stricter, and the worker reads every item out of
 * the creator's own account listing by id whatever the URL claims.
 *
 * The `feed_url` fallback is website-only. It is the confirmed feed for their
 * *site*, so letting a YouTube selection fall back to it would host-check videos
 * against a blog, refusing every one of them for a reason no error message could
 * sensibly explain.
 */
export function buildSelectionItems(
  creator: SyncCreator,
  source: PlatformSource,
  raw: unknown,
  max: number,
): { ok: true; items: SyncItem[] } | { ok: false; error: string } {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, error: 'Select at least one item.' };
  }
  if (raw.length > max) {
    return { ok: false, error: `That is ${raw.length} items. Sync at most ${max} at a time.` };
  }

  const site =
    (creator[SOURCE_COLUMNS[source] as keyof SyncCreator] as string | null) ||
    (source === 'website' ? creator.feed_url : null);
  if (!site && !isConnectedPlatform(source)) {
    return { ok: false, error: 'This creator has no link for that source.' };
  }

  const items: SyncItem[] = [];
  for (const entry of raw as Array<Record<string, unknown>>) {
    const url = toSyncUrl(entry?.url);
    const itemId = typeof entry?.itemId === 'string' && entry.itemId ? entry.itemId : url && urlIdentity(url);
    if (!url || !itemId) {
      return { ok: false, error: 'Every selected item needs a URL.' };
    }
    if (site && !isOnSameSite(site, url)) {
      return {
        ok: false,
        error: `${url} is not on this creator's own ${SOURCE_LABELS[source]}. Refusing the whole selection.`,
      };
    }
    if (source === 'youtube' && url !== `https://www.youtube.com/watch?v=${itemId}`) {
      return { ok: false, error: `${url} is not the watch page for video ${itemId}. Refusing the whole selection.` };
    }
    if ((source === 'instagram' || source === 'tiktok') && platformSourceForUrl(url) !== source) {
      return { ok: false, error: `${url} is not a ${SOURCE_LABELS[source]} link. Refusing the whole selection.` };
    }
    items.push(newSyncItem({ itemId, url, title: entry?.title, publishedAt: entry?.publishedAt }));
  }

  return { ok: true, items };
}

// ── Running a selection ──────────────────────────────────────────────────────

/**
 * How long a worker may hold a run.
 *
 * Two browser tabs polling the same run must not import the same post twice, and
 * a worker killed mid-chunk must not wedge the run forever — so this is a lease
 * with an expiry rather than a boolean.
 *
 * The number has to be longer than a wave can possibly take, because a lease
 * that expires *while its holder is still importing* is worse than no lease: a
 * second worker claims the run, reads the same still-pending items and imports
 * them again, and one post ends up as two drafts. With the SDK bound at 30s and
 * one retry (`lib/import/anthropic.ts`), the arithmetic per item is a 10s fetch
 * plus a gate call and an extraction of at most ~61s each — 132s worst case,
 * and a wave runs its items in parallel. 90s did not cover that; 180s does.
 */
export const LEASE_MS = 180_000;

/**
 * Wall-clock budget for one worker invocation, under the 60s function limit with
 * room for the write-back and the notification. Whatever is left over is picked
 * up by the next call.
 *
 * The deadline is checked before *starting* a wave, never during one, so it
 * cannot bound the invocation: the arithmetic above allows a single item ~132s
 * worst case, and a wave beginning at 24s can outlive the function whatever this
 * says. Lowered from 40s to widen the gap, which makes the overrun rarer without
 * pretending to prevent it — a run that loses its invocation mid-wave is saved
 * and resumable, which is what the client is built around.
 */
export const CHUNK_BUDGET_MS = 25_000;

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
    'This video could not be read from the connected channel. It has been deleted or made private, the ' +
    "YouTube connection has stopped working, or it is not on this creator's channel at all. Re-open the " +
    'catalog to see which.',
  instagram:
    "This post is no longer in the account's recent media, or the Instagram connection has stopped " +
    'working, so its caption could not be read. Re-open the catalog to see which.',
  tiktok:
    "This video is no longer in the account's recent videos, or the TikTok connection has stopped " +
    'working, so its description could not be read. Re-open the catalog to see which.',
};

/**
 * What `processSyncItem` actually needs to know about the batch it is part of.
 *
 * A `SyncRun` satisfies it, and so does the poller, which has no run row at all
 * — it is a cron pass, not something an operator started and can watch. Narrowed
 * to these two fields rather than given a fake run: `sync_run_id` is how the
 * admin screen finds the items it queued, and pointing it at an id that names no
 * row would be worse than the null that says plainly there was no run.
 */
export interface ItemContext {
  id: string | null;
  source: PlatformSource;
}

/**
 * Runs one item: gate, extract, queue for review, record.
 *
 * Never throws. An item that blows up is a failed item, because the alternative
 * is one bad post taking the other 199 with it.
 */
export async function processSyncItem(
  deps: SyncDeps,
  run: ItemContext,
  creator: SyncCreator,
  item: SyncItem,
): Promise<SyncItem> {
  const supabase = deps.supabase;
  const importer = deps.importer ?? runImport;
  const queue = deps.queue ?? createImportDraft;

  // Already in, from an earlier run or the poller. Skipped rather than
  // re-imported: an operator ticking a row they were warned about should not be
  // able to publish the same recipe twice under a creator's name.
  const { data: found } = await supabase
    .from('creator_source_items')
    .select('status, detail, updated_at')
    .eq('creator_id', creator.id)
    .eq('source', run.source)
    .eq('item_id', item.itemId)
    .maybeSingle();
  const existing = (found ?? null) as ItemRecord | null;

  if (existing?.status === 'imported') {
    return {
      ...item,
      status: 'skipped',
      detail: 'Already imported — skipped so the same recipe is not queued twice.',
    };
  }

  // Claimed BEFORE the extraction, not recorded after it. The UNIQUE key on
  // `(creator_id, source, item_id)` is documented as the idempotency guarantee
  // for a cron that will eventually overlap itself, and it can only be that if
  // the row exists before the money is spent — written afterwards it deduplicates
  // the record while both passes still queue a draft, and
  // `creator_import_drafts` has no unique key to catch the second one.
  if (!(await claimItem(deps, creator, run, item, existing))) {
    return {
      ...item,
      status: 'skipped',
      detail: 'Another import of this post is already in flight, so this one stood down.',
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
    // No hint when one item is being run on its own: the id in front of us is
    // the whole selection as far as this call knows.
    const resolve = deps.sourceDocument ?? createSourceDocumentResolver(deps, [item.itemId]);

    // Wrapped, and this is load-bearing rather than defensive.
    //
    // The resolver reaches a platform API — a token refresh, a `videos.list`,
    // a DNS lookup through the SSRF-safe fetcher — and any of those can throw.
    // Unwrapped, that throw left `processSyncItem`, rejected the `Promise.all`
    // of the wave, escaped `advanceRun`, and 500'd the route **before the
    // release**, so the lease stayed held for its full three minutes and the
    // run sat at `running` with every item still `pending` and no detail on
    // any of them. Three identical wedged runs and not one word about why:
    // the code that records the reason was the code being skipped.
    //
    // A resolver failure is an item failure, which is the same class as an
    // import failure below and belongs in the same place — on the item, where
    // an operator can read it and press Retry.
    let built: SourceDocument | null;
    try {
      built = await resolve(creator, run.source, item);
    } catch (err) {
      return await recordItem(deps, creator, run, {
        ...item,
        status: 'failed',
        detail: `Could not read this post from ${SOURCE_LABELS[run.source]}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      });
    }

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
      // An operator picked this URL and is watching it, which is exactly the
      // condition `manual` describes: an `unsure` verdict is attempted rather
      // than silently skipped. A `no` still stops it — that is the gate doing
      // its job, not a bypass to switch off. The poller overrides this to
      // `poller`, where nobody is watching and a maybe has to be a no.
      mode: deps.gateMode ?? 'manual',
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
      reviewBy: deps.reviewBy ?? 'admin',
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
      photoUrl: result.draft.photoUrl ?? null,
      ingredientCount: result.draft.ingredients?.length ?? 0,
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
 * What a claimed item says while its extraction is in flight.
 *
 * `failed` rather than a status of its own, because the set is fixed by a CHECK
 * constraint and `failed` already means the one thing that is true here: we
 * started reading this and have not come back with an answer. A worker that dies
 * mid-extraction therefore leaves a retryable row rather than a wedged one.
 */
export const CLAIM_DETAIL =
  'An import of this post started and has not reported back yet. If it still says this, ' +
  'whatever was reading it stopped — the retry sweep will pick it up.';

/**
 * How long a claim stands before the item is considered abandoned.
 *
 * Comfortably longer than an extraction — a fetch and two model calls — and far
 * shorter than a poll cycle, so a genuinely interrupted item is retryable within
 * the same cycle rather than the next one. Only ever applied to a row still
 * carrying `CLAIM_DETAIL`: a *finished* failure is retryable immediately, which
 * is what an operator clicking Retry on a failed item is entitled to.
 */
export const CLAIM_LEASE_MS = 10 * 60_000;

/** The columns of an item's record that decide whether we may take it. */
interface ItemRecord {
  status: string;
  detail: string | null;
  updated_at: string | null;
}

/**
 * Takes an item before anything is spent on it.
 *
 * Returns false when somebody else already has it, which the caller reports as
 * `skipped`. Two mechanisms, one for each shape of the race:
 *
 *   - **No row yet** — `insert`, so the UNIQUE key rejects the second pass. This
 *     is the overlap the schema comment has always promised to handle.
 *   - **A row we are retrying** — a compare-and-swap on `updated_at`. Under READ
 *     COMMITTED the second UPDATE re-checks the predicate against the row the
 *     first one committed, so exactly one of them matches.
 *
 * A write that fails for some other reason also stands the item down. That is
 * the right way round: an item nobody recorded is simply new again next pass,
 * whereas an extraction whose outcome cannot be written is money spent twice.
 */
async function claimItem(
  deps: SyncDeps,
  creator: SyncCreator,
  run: ItemContext,
  item: SyncItem,
  existing: ItemRecord | null,
): Promise<boolean> {
  const now = deps.now?.() ?? Date.now();
  const at = new Date(now).toISOString();

  if (!existing) {
    const { error } = await deps.supabase.from('creator_source_items').insert({
      creator_id: creator.id,
      source: run.source,
      item_id: item.itemId,
      url: item.url,
      title: item.title,
      published_at: item.publishedAt,
      status: 'failed',
      detail: CLAIM_DETAIL,
      updated_at: at,
    });
    return !error;
  }

  // Somebody took it moments ago and is still working. The compare-and-swap
  // below cannot see this — they would swap on the value we just read — so the
  // live claim is what says no.
  const heldSince = Date.parse(existing.updated_at ?? '');
  if (existing.detail === CLAIM_DETAIL && Number.isFinite(heldSince) && now - heldSince < CLAIM_LEASE_MS) {
    return false;
  }

  const claim = deps.supabase
    .from('creator_source_items')
    .update({ status: 'failed', detail: CLAIM_DETAIL, updated_at: at })
    .eq('creator_id', creator.id)
    .eq('source', run.source)
    .eq('item_id', item.itemId);
  // `eq(null)` matches nothing in PostgREST, so a row that has never been
  // touched is swapped on `is null` instead.
  const guarded = existing.updated_at === null
    ? claim.is('updated_at', null)
    : claim.eq('updated_at', existing.updated_at);

  const { data } = await guarded.select('item_id');
  return Array.isArray(data) && data.length > 0;
}

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
  run: ItemContext,
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
 * Takes the run's lease, and hands back the row **as it was at that instant**.
 *
 * Every write to `items` goes through a lease, which is what makes the array
 * safe to write whole: the holder is the only writer, so there is no second
 * copy of the array to lose an item to. `or` covers both "nobody holds it" and
 * "whoever held it is gone"; PostgREST re-checks the predicate under the row
 * lock, so exactly one of two simultaneous claimants gets a row back.
 *
 * The returned row matters as much as the boolean. Claiming and then working
 * from a copy read *before* the claim is the same lost update by another route
 * — a retry that landed in between would be overwritten.
 */
/**
 * Do two timestamps name the same instant?
 *
 * Not a string compare, because the two sides format it differently: JS writes
 * `2026-08-04T01:31:49.370Z` and Postgres reads back `2026-08-04T01:31:49.37+00:00`
 * — same moment, trailing zero trimmed, offset spelled out. Comparing the text
 * made every lease check fail, which is a slower way of the same bug the
 * read-back was added to fix.
 */
function sameInstant(a: unknown, b: unknown): boolean {
  if (a == null || b == null) return a == null && b == null;
  const left = new Date(a as string).getTime();
  const right = new Date(b as string).getTime();
  return Number.isFinite(left) && left === right;
}

async function claimRun(
  deps: SyncDeps,
  runId: string,
  extra: Record<string, unknown> = {},
): Promise<{ row: Record<string, any>; lease: string } | null> {
  const now = deps.now ?? Date.now;
  const nowIso = new Date(now()).toISOString();
  const lease = new Date(now() + LEASE_MS).toISOString();

  // The compare-and-swap itself. Deliberately NOT `.select()`ed — see below.
  await deps.supabase
    .from('creator_sync_runs')
    .update({ lease_until: lease, updated_at: nowIso, ...extra })
    .eq('id', runId)
    .or(`lease_until.is.null,lease_until.lt.${nowIso}`);

  // Who won is decided by reading the row back, not by what the UPDATE
  // returned, because **PostgREST applies the filters to the returned
  // representation after the write**. A CAS that filters on the very column it
  // overwrites therefore updates the row and hands back an empty array: the
  // lease is no longer null and no longer in the past, so the row no longer
  // matches the predicate that selected it.
  //
  // That is not hypothetical. It claimed the run, reported failure, and the
  // caller returned early — leaving a brand new run at `running` behind a lease
  // nobody was using, every item still pending, while the screen insisted it
  // was "already being worked on somewhere else". Verified against the real
  // API: rows returned 0, row read back as `running`.
  //
  // The read-back is still a correct CAS. Each worker writes a lease value
  // unique to it, so exactly one can find its own value there afterwards; a
  // loser reads the winner's lease and correctly gives up.
  const { data: after } = await deps.supabase
    .from('creator_sync_runs')
    .select('*')
    .eq('id', runId)
    .maybeSingle();

  const row = after as Record<string, any> | null;
  return row && sameInstant(row.lease_until, lease) ? { row, lease } : null;
}

/**
 * Writes to a run we hold the lease on, or reports that we no longer do.
 *
 * `lease_until` doubles as the ownership token: the value we wrote when we
 * claimed is ours until it expires, and whoever claims next necessarily writes
 * a later one. Carrying it as a predicate is what stops a worker that overran
 * its lease from writing its items over the new holder's progress — and, on the
 * final write, from clearing a lease that is no longer its own and letting a
 * third driver into a run two workers are already inside.
 */
async function writeLeased(
  deps: SyncDeps,
  runId: string,
  lease: string,
  patch: Record<string, unknown>,
): Promise<boolean> {
  await deps.supabase
    .from('creator_sync_runs')
    .update(patch)
    .eq('id', runId)
    .eq('lease_until', lease);

  // Same reason as `claimRun`: this filters on `lease_until` and every patch
  // here rewrites it, so the returned representation is empty even when the
  // write landed. Read back and compare against what we asked for — still a
  // correct ownership check, because only the holder of `lease` could have
  // matched the predicate in the first place.
  const { data: after } = await deps.supabase
    .from('creator_sync_runs')
    .select('lease_until')
    .eq('id', runId)
    .maybeSingle();

  const wrote = (patch as { lease_until?: unknown }).lease_until ?? null;
  return Boolean(after) && sameInstant((after as Record<string, any>).lease_until, wrote);
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

  // If the claim matches nothing, another worker is mid-chunk and we report
  // progress instead of racing it.
  const claim = await claimRun(deps, runId, { status: 'running', started_at: row.started_at ?? nowIso });
  if (!claim) return run;

  // From here on the claimed row is the truth, not the one read a moment ago.
  run = toSyncRun(claim.row);
  let lease = claim.lease;

  const creator = await loadSyncCreator(supabase, run.creatorId);
  if (!creator) {
    await writeLeased(deps, runId, lease, { status: 'done', finished_at: nowIso, lease_until: null, updated_at: nowIso });
    log({ event: 'ADMIN:SYNC_RUN', status: 'error', detail: `run=${runId} creator=${run.creatorId} missing` });
    return { ...run, status: 'done' };
  }

  const deadline = now() + CHUNK_BUDGET_MS;
  let items = [...run.items];

  // Built once per invocation rather than per item, so a 40-video selection is
  // one `videos.list` call and one grant refresh. Only the items still to do go
  // in: the memo cannot outlive the process, so a resumed run re-reads whatever
  // it is handed, and handing it the terminal ones too meant a 200-video run
  // spread over five invocations paid for all 200 five times — 20 units rather
  // than the 14 it actually needs. One invocation that finishes the run still
  // costs 4.
  const chunkDeps: SyncDeps = {
    ...deps,
    sourceDocument:
      deps.sourceDocument ??
      createSourceDocumentResolver(deps, items.filter((entry) => !isTerminal(entry)).map((entry) => entry.itemId)),
  };

  while (items.some((item) => !isTerminal(item)) && now() < deadline) {
    const wave: number[] = [];
    for (let i = 0; i < items.length && wave.length < CHUNK_CONCURRENCY; i++) {
      if (!isTerminal(items[i])) wave.push(i);
    }

    let processed: SyncItem[];
    try {
      processed = await Promise.all(
        wave.map((index) => processSyncItem(chunkDeps, { id: run.id, source: run.source }, creator, items[index])),
      );
    } catch (err) {
      // `processSyncItem` records its own failures, so reaching here means
      // something escaped it. Whatever it was, the lease must not go with it:
      // a throw between claiming and releasing leaves the run at `running`
      // with a lease nobody holds, and the screen tells the operator it is
      // "already being worked on somewhere else" for three minutes — the least
      // useful sentence available, because the worker is gone.
      //
      // So: hand the lease back and let the error out. `queued` is the honest
      // status, the items keep whatever state they had, and Resume works
      // immediately rather than after the lease expires.
      await writeLeased(deps, runId, lease, {
        items,
        status: 'queued',
        lease_until: null,
        updated_at: new Date(now()).toISOString(),
      });
      log({
        event: 'ADMIN:SYNC_RUN',
        status: 'error',
        detail: `run=${runId} threw mid-wave; lease released so Resume works: ${
          err instanceof Error ? err.message : String(err)
        }`,
      });
      throw err;
    }
    wave.forEach((index, position) => {
      items[index] = processed[position];
    });

    // Written after every wave, not at the end: the screen polls this row, and a
    // run that shows nothing for four minutes looks broken. The renewal moves
    // the token on, so the predicate for the next write is the new one.
    const renewed = new Date(now() + LEASE_MS).toISOString();
    const held = await writeLeased(deps, runId, lease, {
      items,
      lease_until: renewed,
      updated_at: new Date(now()).toISOString(),
    });
    if (!held) return lostLease(runId, run, items);
    lease = renewed;
  }

  const finished = items.every(isTerminal);
  run = { ...run, items, status: finished ? 'done' : 'running' };

  // No email here any more. A finished run has published nothing, so there is
  // nothing true to tell a creator yet; the announcement fires from Approve
  // (`notifyApproved`), where the meals are actually live.
  const released = await writeLeased(deps, runId, lease, {
    items,
    status: finished ? 'done' : 'queued',
    finished_at: finished ? new Date(now()).toISOString() : null,
    lease_until: null,
    updated_at: new Date(now()).toISOString(),
  });
  if (!released) return lostLease(runId, run, items);

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

/**
 * What a worker does when it finds it no longer holds the lease.
 *
 * Stop, write nothing further, and say so. The items it did import are not
 * lost — every one of them wrote its own `creator_source_items` record and its
 * draft as it went, so the worker that took over skips them rather than
 * importing them again. What is lost is only this worker's copy of the array,
 * which is exactly the thing that must not be written.
 */
function lostLease(runId: string, run: SyncRun, items: SyncItem[]): SyncRun {
  log({
    event: 'ADMIN:SYNC_RUN',
    status: 'error',
    detail: `run=${runId} lease lost mid-chunk; another worker owns this run. Wrote nothing further.`,
  });
  return { ...run, items, status: 'running' };
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

  // Through the same lease the worker takes, for the same reason. Retry used to
  // read the row, map the array and write the whole thing back with no
  // predicate at all: a retry landing while a worker was mid-wave was written,
  // reported to the operator as requeued, and then silently overwritten by the
  // worker's older copy of the array. Refusing while somebody is working is a
  // worse button; telling an operator an item is requeued when it is not is a
  // worse product.
  const claim = await claimRun(deps, runId);
  if (!claim) {
    return {
      ok: false,
      error: 'This run is being worked on right now. Wait for the chunk to finish, then retry.',
    };
  }

  const run = toSyncRun(claim.row);
  const release = (patch: Record<string, unknown>) => writeLeased(deps, runId, claim.lease, patch);
  const nowIso = new Date(now()).toISOString();

  const target = run.items.find((item) => item.itemId === itemId);
  if (!target || target.status !== 'failed') {
    await release({ lease_until: null, updated_at: nowIso });
    if (!target) return { ok: false, error: 'That item is not part of this run.' };
    return { ok: false, error: `Only failed items can be retried; this one is ${target.status}.` };
  }

  const items = run.items.map((item) =>
    item.itemId === itemId ? { ...item, status: 'pending' as const, detail: null } : item,
  );

  const written = await release({
    items,
    status: 'queued',
    finished_at: null,
    lease_until: null,
    updated_at: nowIso,
  });
  if (!written) {
    return { ok: false, error: 'Another worker took this run while we were reading it. Try again.' };
  }

  return { ok: true, run: { ...run, items, status: 'queued' } };
}

/**
 * Wall-clock budget for the cron's sweep of stalled runs.
 *
 * The cron does two email passes before it gets here and the whole invocation
 * has to fit inside `maxDuration`. Without this the sweep would start work it
 * cannot finish: the function is killed mid-chunk having claimed a lease, and
 * the run it was "recovering" is then unavailable to anyone else until that
 * lease expires.
 */
export const SWEEP_BUDGET_MS = 25_000;

/**
 * Resumes runs nobody is driving.
 *
 * The admin screen calls the worker in a loop, which means closing the tab
 * stops the loop, and this is the backstop for that.
 *
 * **It is a backstop, not a queue, and the difference is worth being plain
 * about.** One cron fire a day advances each stalled run by whatever fits in
 * the budget below — a chunk or two. A 200-item run whose operator walked away
 * therefore takes weeks to finish here, not a day: the honest recovery is an
 * operator reopening the run and pressing Resume, and what this guarantees is
 * only that no run is *forgotten*. Finishing a large abandoned run in one pass
 * needs a real job queue, which this project does not have.
 *
 * Ordered by least-recently-touched rather than oldest-created. `created_at`
 * ascending meant the same five old stuck runs were picked every single day and
 * every newer run starved behind them for good; `updated_at` moves a run to the
 * back of the line the moment it is advanced, so the sweep is a round robin.
 */
export async function resumeStalledSyncRuns(deps: SyncDeps, limit = 5): Promise<number> {
  const now = deps.now ?? Date.now;
  const nowIso = new Date(now()).toISOString();
  const deadline = now() + SWEEP_BUDGET_MS;

  const { data } = await deps.supabase
    .from('creator_sync_runs')
    .select('id')
    .neq('status', 'done')
    .or(`lease_until.is.null,lease_until.lt.${nowIso}`)
    .order('updated_at', { ascending: true })
    .limit(limit);

  const rows = (data ?? []) as Array<{ id: string }>;
  let advanced = 0;
  for (const row of rows) {
    // Checked before starting a run rather than after: a chunk we begin without
    // the time to finish it ends as a killed function holding a live lease.
    if (now() >= deadline) {
      log({
        event: 'ADMIN:SYNC_RUN',
        status: 'pending',
        detail: `sweep stopped at its ${SWEEP_BUDGET_MS}ms budget with ${rows.length - advanced} run(s) left for the next fire`,
      });
      break;
    }
    await advanceRun(deps, row.id);
    advanced += 1;
  }
  return advanced;
}
