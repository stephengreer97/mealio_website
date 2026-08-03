import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { fakeDb } from '../helpers/supabase-mock';
import { publicLookup, stubFetch } from '../helpers/import-stubs';
import { importedGuacamole } from '../helpers/import-ui-fixtures';
import type { ImportResult, ImportSuccess } from '@/lib/import/types';
import type { RunImportOptions } from '@/lib/import/pipeline';

vi.mock('@/lib/logger', () => ({ log: vi.fn() }));

// A run must not be able to reach either of these any more: nothing it produces
// is live, so there is nothing to announce and no cache to invalidate. The mocks
// exist so the tests can assert they were never called.
const sendCreatorSyncPublishedEmail = vi.fn();
vi.mock('@/lib/email', () => ({
  sendCreatorSyncPublishedEmail: (...args: unknown[]) => sendCreatorSyncPublishedEmail(...args),
}));

const publishCreatorMeal = vi.fn();
vi.mock('@/lib/creator-meals', () => ({
  publishCreatorMeal: (...args: unknown[]) => publishCreatorMeal(...args),
}));

import {
  advanceRun,
  buildCatalog,
  createSourceDocumentResolver,
  processSyncItem,
  resumeStalledSyncRuns,
  retrySyncItem,
  summariseRun,
  SWEEP_BUDGET_MS,
  type SyncDeps,
  type SyncItem,
  type SyncRun,
} from '@/lib/admin-sync';
import { __resetUploadsPlaylistCache } from '@/lib/youtube';

/**
 * The engine behind both sync modes.
 *
 * Four properties carry the two tickets and are tested as such: drawing the
 * checklist costs one feed read and nothing else, the gate still decides what
 * gets extracted, one bad item does not take the batch with it, and — MEAL-91 —
 * **a run never publishes**. The last one is tested by asserting the publisher
 * and the notifier were not reached, not merely that the item says `drafted`.
 */

const CREATOR = {
  id: 'c1',
  user_id: 'u1',
  display_name: 'Chef Sarah',
  website_url: 'https://chefsarah.test/',
  youtube_url: null,
  instagram_url: null,
  tiktok_url: null,
  feed_url: 'https://chefsarah.test/feed',
  user_profiles: { email: 'sarah@chefsarah.test' },
};

const supabase = fakeDb as unknown as SupabaseClient;

// ── YouTube fixtures (MEAL-74) ───────────────────────────────────────────────

const CHANNEL_ID = 'UCabcdefghijklmnopqrstuv';

function jsonRoute(body: unknown) {
  return { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } };
}
const PLAYLIST_ID = 'UUabcdefghijklmnopqrstuv';
const YT_API = 'https://www.googleapis.com/youtube/v3';

/**
 * Long enough that the gate would judge it rather than call it thin, so nothing
 * here reaches for captions. That ordering is the quota control MEAL-74 built —
 * a video is rejected on its description before a caption is ever downloaded —
 * and a fixture that trips it would hide the listing calls under caption ones.
 */
const VIDEO_DESCRIPTION =
  `Ingredients:\n2 avocados\n1 lime\n\n${'Mash them together and season well, then serve. '.repeat(6)}`;

/** The grant row `creator_platform_accounts` hands back for a connected channel. */
function connectionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pa1',
    creator_id: 'c1',
    platform: 'youtube',
    external_id: CHANNEL_ID,
    external_name: 'Chef Sarah',
    access_token: 'ya29-token',
    refresh_token: '1//refresh',
    scopes: 'https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/youtube.force-ssl',
    // Well past `now()` in these tests, so nothing tries to refresh.
    expires_at: '2099-01-01T00:00:00.000Z',
    broken_reason: null,
    broken_at: null,
    ...overrides,
  };
}

/**
 * The exact URLs the Data API calls hit. `stubFetch` matches the whole string,
 * so these double as an assertion that each request is built the way YouTube
 * documents it — the only check available with no credentials to try it against.
 */
const CHANNELS_URL = `${YT_API}/channels?${new URLSearchParams({ part: 'contentDetails', id: CHANNEL_ID })}`;

const uploadsUrl = (params: Record<string, string> = {}) =>
  `${YT_API}/playlistItems?${new URLSearchParams({
    part: 'snippet,contentDetails,status',
    playlistId: PLAYLIST_ID,
    maxResults: '50',
    ...params,
  })}`;

const videosUrl = (ids: string[]) => `${YT_API}/videos?${new URLSearchParams({ part: 'snippet', id: ids.join(',') })}`;

/** `channels.list`, answering with this channel's uploads playlist. */
function channelsRoute() {
  return jsonRoute({ items: [{ contentDetails: { relatedPlaylists: { uploads: PLAYLIST_ID } } }] });
}

/** One `playlistItems.list` page, with an entry per id. */
function uploadsPage(ids: string[], extra: Record<string, unknown> = {}) {
  return jsonRoute({
    items: ids.map((id) => ({
      contentDetails: { videoId: id, videoPublishedAt: '2026-07-29T09:00:00Z' },
      status: { privacyStatus: 'public' },
      snippet: {
        title: `Best Guacamole ${id}`,
        description: VIDEO_DESCRIPTION,
        videoOwnerChannelId: CHANNEL_ID,
        thumbnails: { high: { url: `https://i.ytimg.com/vi/${id}/hqdefault.jpg` } },
      },
    })),
    ...extra,
  });
}

/** `videos.list` for a selection, on `channelId` — which defaults to the creator's own. */
function videosPage(ids: string[], channelId = CHANNEL_ID) {
  return jsonRoute({
    items: ids.map((id) => ({
      id,
      snippet: { title: `Best Guacamole ${id}`, description: VIDEO_DESCRIPTION, channelId },
    })),
  });
}

// ── Instagram and TikTok fixtures (MEAL-82 / MEAL-83) ────────────────────────

/**
 * The exact URLs each listing hits. `stubFetch` matches on the whole string, so
 * these double as an assertion that the request is built the way the API
 * documents — which is the only check available until app review clears.
 */
const IG_MEDIA_URL =
  'https://graph.instagram.com/me/media?fields=id%2Ccaption%2Cmedia_type%2Cmedia_url%2Cpermalink%2Ctimestamp' +
  '&limit=50&access_token=IGQ-long';
const TT_LIST_URL =
  'https://open.tiktokapis.com/v2/video/list/?fields=id%2Ctitle%2Cvideo_description%2Cduration%2C' +
  'cover_image_url%2Cembed_link%2Cshare_url%2Ccreate_time';

const SOCIAL_CAPTION = 'Guacamole\nIngredients:\n2 avocados\n1 lime\n\nMash them together.';

/** One `/me/media` page, with no `next` so the loop stops after it. */
function instagramMedia(ids: string[], caption = SOCIAL_CAPTION) {
  return jsonRoute({
    data: ids.map((id) => ({
      id,
      caption,
      media_type: 'VIDEO',
      media_url: `https://scontent.cdninstagram.com/${id}.mp4`,
      permalink: `https://www.instagram.com/reel/${id}/`,
      timestamp: '2026-07-29T09:00:00+0000',
    })),
  });
}

/** One `/v2/video/list/` page, with `has_more` false. */
function tiktokVideos(ids: string[], description = SOCIAL_CAPTION) {
  return jsonRoute({
    data: {
      videos: ids.map((id) => ({
        id,
        title: 'Guacamole',
        video_description: description,
        share_url: `https://www.tiktok.com/@chefsarah/video/${id}`,
        embed_link: `https://www.tiktok.com/embed/v2/${id}`,
        create_time: 1_785_060_000,
      })),
      has_more: false,
    },
    error: { code: 'ok' },
  });
}

function item(overrides: Partial<SyncItem> = {}): SyncItem {
  return {
    itemId: 'guid-1',
    url: 'https://chefsarah.test/guacamole',
    title: 'Guacamole',
    publishedAt: '2026-07-29T09:00:00.000Z',
    status: 'pending',
    detail: null,
    draftId: null,
    mealName: null,
    needALook: null,
    photoUrl: null,
    ingredientCount: null,
    costUsd: 0,
    ...overrides,
  };
}

function run(items: SyncItem[], overrides: Partial<SyncRun> = {}): SyncRun {
  return {
    id: 'r1',
    creatorId: 'c1',
    source: 'website',
    mode: 'catalog',
    status: 'queued',
    items,
    createdAt: null,
    finishedAt: null,
    ...overrides,
  };
}

/** The row shape `creator_sync_runs` hands back. */
function runRow(items: SyncItem[], overrides: Record<string, unknown> = {}) {
  return {
    id: 'r1',
    creator_id: 'c1',
    source: 'website',
    mode: 'catalog',
    status: 'queued',
    items,
    started_at: null,
    created_at: '2026-08-02T10:00:00.000Z',
    ...overrides,
  };
}

/**
 * Stores the run, its creator and the per-item record table.
 *
 * A stored row rather than a queued result, because everything a run does is a
 * read-modify-write under a lease: which rows a predicate matches and how many
 * a conditional update affected *are* the behaviour, and a canned result cannot
 * express either.
 */
function storeRun(row: Record<string, unknown>) {
  fakeDb.seed('creator_sync_runs', [{ lease_until: null, updated_at: null, ...row }]);
  fakeDb.seed('creators', [CREATOR]);
  fakeDb.seed('creator_source_items', []);
}

const rejection = (stage: ImportResult extends never ? never : 'fetch' | 'gate' | 'extract', detail: string): ImportResult => ({
  status: 'rejected',
  url: 'https://chefsarah.test/guacamole',
  stage,
  reason: stage === 'gate' ? 'gate-no' : 'timeout',
  detail,
  meta: { cached: false },
});

function deps(overrides: Partial<SyncDeps> = {}): SyncDeps {
  return {
    supabase,
    queue: vi.fn(async () => 'draft-1') as unknown as SyncDeps['queue'],
    now: () => 1_800_000_000_000,
    ...overrides,
  };
}

beforeEach(() => {
  fakeDb.reset();
  // The uploads playlist id is memoised per channel for the life of the process,
  // so a listing test that did not clear it would silently skip the
  // `channels.list` a previous one paid for.
  __resetUploadsPlaylistCache();
  sendCreatorSyncPublishedEmail.mockReset();
  publishCreatorMeal.mockReset();
});

// ── Catalog ──────────────────────────────────────────────────────────────────

describe('buildCatalog — drawing the list is free', () => {
  function feedWith(count: number): string {
    const items = Array.from({ length: count }, (_, i) =>
      `<item><title>Recipe ${i}</title><link>https://chefsarah.test/post-${i}</link>` +
      `<guid>guid-${i}</guid><pubDate>Tue, 29 Jul 2026 09:00:00 +0000</pubDate></item>`,
    ).join('');
    return `<rss><channel>${items}</channel></rss>`;
  }

  it('lists a 200-post blog without fetching a single post', async () => {
    const { impl, calls } = stubFetch({
      'https://chefsarah.test/robots.txt': { body: 'User-agent: *\nAllow: /' },
      'https://chefsarah.test/feed': { body: feedWith(200), headers: { 'content-type': 'application/rss+xml' } },
    });

    const result = await buildCatalog(
      { supabase, fetchOptions: { fetchImpl: impl, lookup: publicLookup } },
      CREATOR,
      'website',
    );

    expect(result.ok && result.entries).toHaveLength(200);
    // robots.txt and the feed. Nothing else — no post is opened to draw a row,
    // which is what makes this screen safe to open on an archive.
    expect(calls).toEqual(['https://chefsarah.test/robots.txt', 'https://chefsarah.test/feed']);
    expect(calls.some((url) => url.includes('/post-'))).toBe(false);
  });

  it('marks what is already imported, from the record and not from a fetch', async () => {
    const { impl } = stubFetch({
      'https://chefsarah.test/robots.txt': { body: '' },
      'https://chefsarah.test/feed': { body: feedWith(3) },
    });
    fakeDb.queue('creator_source_items', {
      data: [
        // Keyed by the entry URL, normalised — see `websiteItemId`. The feed's
        // own guid is not the identity, because it is only as stable as the rung
        // of the discovery ladder that happened to answer.
        { item_id: 'chefsarah.test/post-1', status: 'imported', detail: null, updated_at: '2026-07-01T00:00:00.000Z' },
        { item_id: 'chefsarah.test/post-2', status: 'rejected', detail: 'Not a recipe: a roundup post', updated_at: null },
      ],
    });

    const result = await buildCatalog(
      { supabase, fetchOptions: { fetchImpl: impl, lookup: publicLookup } },
      CREATOR,
      'website',
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries[0].record).toBeNull();
    expect(result.entries[1].record).toMatchObject({ status: 'imported' });
    expect(result.entries[2].record).toMatchObject({ status: 'rejected' });
  });

  it('finds a record past the first page, where the server stops answering', async () => {
    // PostgREST returns at most 1000 rows and says nothing about having stopped.
    // Unpaged, a creator with a longer history gets a partial record map — and a
    // missing record does not read as "unknown" anywhere: it reads as NEW, so
    // the poller re-imports a post that is already in.
    const { impl } = stubFetch({
      'https://chefsarah.test/robots.txt': { body: '' },
      'https://chefsarah.test/feed': { body: feedWith(3) },
    });
    // `post-1` sorts after every filler id, so it lands on the second page.
    fakeDb.seed('creator_source_items', [
      ...Array.from({ length: 1_200 }, (_, i) => ({
        creator_id: 'c1',
        source: 'website',
        item_id: `chefsarah.test/archive-${String(i).padStart(5, '0')}`,
        status: 'seen',
      })),
      { creator_id: 'c1', source: 'website', item_id: 'chefsarah.test/post-1', status: 'imported' },
    ]);

    const result = await buildCatalog(
      { supabase, fetchOptions: { fetchImpl: impl, lookup: publicLookup } },
      CREATOR,
      'website',
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries[1].record).toMatchObject({ status: 'imported' });
  });

  it('says a platform is not connected rather than showing an empty list', async () => {
    // An empty list would read as "this creator publishes nothing", which is the
    // one thing it must not mean. No grant is queued, so there is none.
    const result = await buildCatalog({ supabase }, CREATOR, 'instagram');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('not-connected');
    expect(result.detail).toMatch(/has not connected their Instagram account/i);
  });

  it('lists one page of a connected channel, fetching no video (MEAL-74 / MEAL-79)', async () => {
    const { impl, calls } = stubFetch({
      [CHANNELS_URL]: channelsRoute(),
      [uploadsUrl()]: uploadsPage(['vid0000000A', 'vid0000000B']),
    });
    fakeDb.seed('creator_platform_accounts', [connectionRow()]);

    const result = await buildCatalog(
      { supabase, fetchOptions: { fetchImpl: impl, lookup: publicLookup } },
      { ...CREATOR, youtube_url: 'https://youtube.com/@sarah' },
      'youtube',
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The bare video id, because MEAL-79 keys "this meal came from that video"
    // on it and every YouTube API call takes the same form.
    expect(result.entries.map((entry) => entry.itemId)).toEqual(['vid0000000A', 'vid0000000B']);
    expect(result.entries[0].url).toBe('https://www.youtube.com/watch?v=vid0000000A');
    // Two requests for a window of the channel. No video opened, no model
    // called — and the spend is reported, because the budget is shared.
    expect(calls).toEqual([CHANNELS_URL, uploadsUrl()]);
    expect(result.quotaUnits).toBe(2);
    // No feed URL to offer a button that writes `creators.feed_url`.
    expect(result.feed).toBeNull();
  });

  it('offers a cursor for the next window rather than walking the whole channel', async () => {
    const { impl, calls } = stubFetch({
      [CHANNELS_URL]: channelsRoute(),
      [uploadsUrl()]: uploadsPage(['vid0000000A'], { nextPageToken: 'CDIQAA' }),
      [uploadsUrl({ maxResults: '50', pageToken: 'CDIQAA' })]: uploadsPage(['vid0000000B']),
    });
    fakeDb.seed('creator_platform_accounts', [connectionRow()]);

    const first = await buildCatalog(
      { supabase, fetchOptions: { fetchImpl: impl, lookup: publicLookup } },
      CREATOR,
      'youtube',
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    // 300 videos is 6 pages of somebody else's quota. Opening a screen buys one
    // page; the operator asks for the next.
    expect(first.nextPageToken).toBe('CDIQAA');
    expect(first.truncated).toBe(true);
    expect(calls).toHaveLength(2);

    const second = await buildCatalog(
      { supabase, fetchOptions: { fetchImpl: impl, lookup: publicLookup } },
      CREATOR,
      'youtube',
      { pageToken: 'CDIQAA' },
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.entries.map((entry) => entry.itemId)).toEqual(['vid0000000B']);
    expect(second.nextPageToken).toBeNull();
    // Three requests for two pages, not four: the uploads playlist id is a
    // property of the channel and does not change, and it was being re-bought on
    // every "Load 50 more" — which is what made a 300-video walk 12 units
    // against the 7 claimed for it.
    expect(calls).toEqual([CHANNELS_URL, uploadsUrl(), uploadsUrl({ maxResults: '50', pageToken: 'CDIQAA' })]);
    expect(second.quotaUnits).toBe(1);
  });

  it('takes the channel id from the grant rather than the creator-supplied link', async () => {
    const { impl, calls } = stubFetch({
      [CHANNELS_URL]: channelsRoute(),
      [uploadsUrl()]: uploadsPage(['vid0000000A']),
    });
    fakeDb.seed('creator_platform_accounts', [connectionRow()]);

    await buildCatalog(
      { supabase, fetchOptions: { fetchImpl: impl, lookup: publicLookup } },
      // A link pointing at somebody else's channel entirely. The grant wins, so
      // the page behind this URL is never even read.
      { ...CREATOR, youtube_url: 'https://youtube.com/channel/UCzzzzzzzzzzzzzzzzzzzzzz' },
      'youtube',
    );

    expect(calls).toEqual([CHANNELS_URL, uploadsUrl()]);
  });

  it('refuses to list at all when the grant carries no channel id (MEAL-77 / MEAL-79)', async () => {
    const { impl, calls } = stubFetch({
      [CHANNELS_URL]: channelsRoute(),
      [uploadsUrl()]: uploadsPage(['vid0000000A']),
    });
    // A live, unbroken grant on a row stored before the channel id was recorded
    // — the legacy case the fallback existed for — and a `youtube_url` naming
    // somebody else's channel outright.
    fakeDb.seed('creator_platform_accounts', [connectionRow({ external_id: null })]);

    const result = await buildCatalog(
      { supabase, fetchOptions: { fetchImpl: impl, lookup: publicLookup } },
      { ...CREATOR, youtube_url: 'https://youtube.com/channel/UCzzzzzzzzzzzzzzzzzzzzzz' },
      'youtube',
    );

    // The fallback listed `UCzzz…`'s uploads, and the run's ownership filter
    // then compared each of the stranger's videos against the stranger's own id
    // and passed every one — a stranger's recipes drafted under this creator's
    // name. A check anchored to a creator-supplied link can only ever catch a
    // wrong video id, never a wrong channel.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toMatch(/no channel id/i);
    expect(result.detail).toMatch(/reconnect/i);
    // And nothing is read, so not one unit is spent on the stranger's channel.
    expect(calls).toEqual([]);
  });

  it('offers the next page rather than calling a channel empty when page one is all private', async () => {
    const { impl } = stubFetch({
      [CHANNELS_URL]: channelsRoute(),
      // What `playlistItems.list` returns for 50 private uploads: placeholders
      // `listUploads` drops, and a cursor pointing at the 250 public ones behind
      // them.
      [uploadsUrl()]: uploadsPage([], { nextPageToken: 'CDIQAA' }),
    });
    fakeDb.seed('creator_platform_accounts', [connectionRow()]);

    const result = await buildCatalog(
      { supabase, fetchOptions: { fetchImpl: impl, lookup: publicLookup } },
      CREATOR,
      'youtube',
    );

    // Reported as "this account has nothing posted", this was both the one thing
    // an empty list must never be allowed to mean and a permanent dead end —
    // `emptyAccountCatalog` carries no cursor, so nothing could ask for page two.
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries).toEqual([]);
    expect(result.nextPageToken).toBe('CDIQAA');
    expect(result.truncated).toBe(true);
  });

  it('reports what a failed listing already spent', async () => {
    const { impl } = stubFetch({
      [CHANNELS_URL]: channelsRoute(),
      [uploadsUrl()]: { status: 403, ...jsonRoute({ error: { message: 'quota exceeded' } }) },
    });
    fakeDb.seed('creator_platform_accounts', [connectionRow()]);

    const result = await buildCatalog(
      { supabase, fetchOptions: { fetchImpl: impl, lookup: publicLookup } },
      CREATOR,
      'youtube',
    );

    // The `channels.list` in front of it succeeded and was charged. A screen that
    // only totals successes shows less than Google did.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.quotaUnits).toBe(2);
  });

  it('says YouTube is not connected rather than listing it from a link (MEAL-79)', async () => {
    const { impl, calls } = stubFetch({});

    // A creator with a perfectly good YouTube link and no grant. The uploads
    // feed used to list them for free; `youtube.com/robots.txt` disallows it,
    // and `playlistItems.list` is authenticated — so this is now the same
    // answer Instagram gives, and it must not be an empty catalog.
    const result = await buildCatalog(
      { supabase, fetchOptions: { fetchImpl: impl, lookup: publicLookup } },
      { ...CREATOR, youtube_url: 'https://youtube.com/@sarah' },
      'youtube',
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('not-connected');
    expect(result.detail).toMatch(/has not connected their YouTube account/i);
    // Nothing was fetched, including the channel page: there is no point
    // resolving an id we have no token to use.
    expect(calls).toEqual([]);
  });

  it('reports a connected channel with nothing on it as an answer, not a failure', async () => {
    const { impl } = stubFetch({ [CHANNELS_URL]: channelsRoute(), [uploadsUrl()]: uploadsPage([]) });
    fakeDb.seed('creator_platform_accounts', [connectionRow()]);

    const result = await buildCatalog(
      { supabase, fetchOptions: { fetchImpl: impl, lookup: publicLookup } },
      CREATOR,
      'youtube',
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('empty');
  });

  it('lists a connected Instagram account from /me/media, downloading no video (MEAL-82)', async () => {
    const { impl, calls } = stubFetch({ [IG_MEDIA_URL]: instagramMedia(['m1', 'm2']) });
    fakeDb.seed('creator_platform_accounts', [connectionRow({ platform: 'instagram', access_token: 'IGQ-long' })]);

    const result = await buildCatalog(
      { supabase, fetchOptions: { fetchImpl: impl, lookup: publicLookup } },
      CREATOR,
      'instagram',
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The media id, not the permalink's shortcode: they are different values and
    // the id is the one every API call and every later record lookup is keyed on.
    expect(result.entries.map((entry) => entry.itemId)).toEqual(['m1', 'm2']);
    expect(result.entries[0].url).toBe('https://www.instagram.com/reel/m1/');
    expect(result.entries[0].title).toBe('Guacamole');
    // One request for the whole account. Nothing downloaded, no model called.
    expect(calls).toEqual([IG_MEDIA_URL]);
    // No feed URL to offer: there is nothing here an operator could confirm and
    // store, and offering one to a button that writes `feed_url` invites an error.
    expect(result.feed).toBeNull();
  });

  it('lists a connected TikTok account from /v2/video/list/ (MEAL-83)', async () => {
    const { impl, calls } = stubFetch({ [TT_LIST_URL]: tiktokVideos(['v1', 'v2']) });
    fakeDb.seed('creator_platform_accounts', [connectionRow({ platform: 'tiktok', access_token: 'act.tiktok' })]);

    const result = await buildCatalog(
      { supabase, fetchOptions: { fetchImpl: impl, lookup: publicLookup } },
      CREATOR,
      'tiktok',
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries.map((entry) => entry.itemId)).toEqual(['v1', 'v2']);
    // `share_url` is the page a human can open; `embed_link` is a player and is
    // no use in a record somebody reads later.
    expect(result.entries[0].url).toBe('https://www.tiktok.com/@chefsarah/video/v1');
    expect(calls).toEqual([TT_LIST_URL]);
  });

  it('names a broken grant rather than showing an empty account', async () => {
    fakeDb.seed('creator_platform_accounts', [
      connectionRow({ platform: 'instagram', broken_reason: 'Instagram refused to refresh this grant' }),
    ]);

    const result = await buildCatalog({ supabase }, CREATOR, 'instagram');

    // A dead grant and an account that posted nothing look identical from the
    // outside. This is the difference being stated out loud.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('not-connected');
    expect(result.detail).toMatch(/stopped working/i);
  });

  it('calls an account with nothing posted empty, not unreachable', async () => {
    // `fetchInstagramMedia` used to report zero items as `ok: false` with a
    // detail saying it was "an answer, not a failure" — and this is where that
    // became one, labelled `unreachable`, which is what an operator reads as
    // "go and look at the grant or the network". The two facts are opposites.
    const { impl } = stubFetch({ [IG_MEDIA_URL]: jsonRoute({ data: [] }) });
    fakeDb.seed('creator_platform_accounts', [connectionRow({ platform: 'instagram', access_token: 'IGQ-long' })]);

    const result = await buildCatalog(
      { supabase, fetchOptions: { fetchImpl: impl, lookup: publicLookup } },
      CREATOR,
      'instagram',
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('empty');
    expect(result.reason).not.toBe('unreachable');
    expect(result.detail).toMatch(/nothing posted/i);
  });

  it('still calls a refused listing unreachable', async () => {
    // The other side of the same distinction: a token Meta has stopped
    // accepting is not an empty account, and must not read as one.
    const { impl } = stubFetch({
      [IG_MEDIA_URL]: jsonRoute({ error: { message: 'Error validating access token: Session has expired', code: 190 } }),
    });
    fakeDb.seed('creator_platform_accounts', [connectionRow({ platform: 'instagram', access_token: 'IGQ-long' })]);

    const result = await buildCatalog(
      { supabase, fetchOptions: { fetchImpl: impl, lookup: publicLookup } },
      CREATOR,
      'instagram',
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('unreachable');
    expect(result.detail).toMatch(/Session has expired/);
  });
});

// ── One item ─────────────────────────────────────────────────────────────────

describe('processSyncItem — the gate is not bypassed by selecting something', () => {
  let success: ImportSuccess;
  beforeEach(async () => { success = await importedGuacamole(); });

  it('queues a recipe for review instead of publishing it', async () => {
    const queue = vi.fn(async () => 'draft-9');
    const result = await processSyncItem(
      deps({ importer: async () => success, queue: queue as unknown as SyncDeps['queue'] }),
      run([item()]),
      CREATOR,
      item(),
    );

    expect(result).toMatchObject({ status: 'drafted', draftId: 'draft-9', mealName: 'Best Guacamole' });
    expect(result.costUsd).toBeGreaterThan(0);
    // The point of the ticket: nothing reached Discover, and nobody was told a
    // recipe went live. Asserting the status alone would pass on a version that
    // published as well as queued.
    expect(publishCreatorMeal).not.toHaveBeenCalled();
    expect(sendCreatorSyncPublishedEmail).not.toHaveBeenCalled();
  });

  it('imports a video from its description, never from its watch page (MEAL-74)', async () => {
    const { impl, calls } = stubFetch({ [videosUrl(['vid0000000A'])]: videosPage(['vid0000000A']) });
    fakeDb.seed('creator_platform_accounts', [connectionRow()]);
    const importer = vi.fn(async (_url: string, _options: RunImportOptions) => success);

    await processSyncItem(
      deps({ importer, fetchOptions: { fetchImpl: impl, lookup: publicLookup } }),
      run([], { source: 'youtube' }),
      { ...CREATOR, youtube_url: 'https://youtube.com/@sarah' },
      item({ itemId: 'vid0000000A', url: 'https://www.youtube.com/watch?v=vid0000000A' }),
    );

    // `watch?v=…` is a JavaScript shell. Fetching it would have the gate report,
    // truthfully, that there is no recipe on it — and an operator would read
    // that as a verdict on the video rather than on our reach.
    const options = importer.mock.calls[0][1];
    expect(options.document?.platform).toBe('youtube');
    expect(options.document?.text).toContain('2 avocados');
    // Read by id. No re-listing of the channel, so a video selected from page 4
    // of a back catalogue is as readable as one from page 1.
    expect(calls).toEqual([videosUrl(['vid0000000A'])]);
  });

  it('reads a whole selection in one call, whichever page of the catalogue it came from', async () => {
    const ids = ['vid0000000A', 'vid0000000B', 'vid0000000C'];
    const { impl, calls } = stubFetch({ [videosUrl(ids)]: videosPage(ids) });
    fakeDb.seed('creator_platform_accounts', [connectionRow()]);
    const importer = vi.fn(async () => success);

    const resolve = createSourceDocumentResolver(
      deps({ importer, fetchOptions: { fetchImpl: impl, lookup: publicLookup } }),
      ids,
    );
    for (const id of ids) {
      const document = await resolve(CREATOR, 'youtube', item({ itemId: id, url: `https://www.youtube.com/watch?v=${id}` }));
      expect(document?.text).toContain('2 avocados');
    }

    // Three videos, one unit. The listing is memoised per run for the same
    // reason it always was — a 40-item selection must not be 40 API reads.
    expect(calls).toEqual([videosUrl(ids)]);
  });

  it('refuses a video that is not on the connected channel, whatever the request said', async () => {
    const { impl } = stubFetch({
      // YouTube happily returns any public video by id. This one belongs to
      // somebody else entirely.
      [videosUrl(['vid0000000Z'])]: videosPage(['vid0000000Z'], 'UCzzzzzzzzzzzzzzzzzzzzzz'),
    });
    fakeDb.seed('creator_platform_accounts', [connectionRow()]);
    const importer = vi.fn(async () => success);

    const result = await processSyncItem(
      deps({ importer, fetchOptions: { fetchImpl: impl, lookup: publicLookup } }),
      run([], { source: 'youtube' }),
      { ...CREATOR, youtube_url: 'https://youtube.com/@sarah' },
      item({ itemId: 'vid0000000Z', url: 'https://www.youtube.com/watch?v=vid0000000Z' }),
    );

    // Reading a selection by id is what makes a paged back catalogue work, and
    // it is also what would let a hand-edited request publish a stranger's
    // recipe under this creator's name. The channel check is the difference.
    expect(result.status).toBe('failed');
    expect(importer).not.toHaveBeenCalled();
  });

  it('fails a video the connected channel cannot return rather than falling back to the page', async () => {
    const { impl } = stubFetch({ [videosUrl(['vid0000000Z'])]: jsonRoute({ items: [] }) });
    fakeDb.seed('creator_platform_accounts', [connectionRow()]);
    const importer = vi.fn(async () => success);

    const result = await processSyncItem(
      deps({ importer, fetchOptions: { fetchImpl: impl, lookup: publicLookup } }),
      run([], { source: 'youtube' }),
      { ...CREATOR, youtube_url: 'https://youtube.com/@sarah' },
      item({ itemId: 'vid0000000Z', url: 'https://www.youtube.com/watch?v=vid0000000Z' }),
    );

    expect(result.status).toBe('failed');
    expect(result.detail).toMatch(/could not be read from the connected channel/i);
    expect(importer).not.toHaveBeenCalled();
  });

  it('imports an Instagram post from its caption, never from the permalink (MEAL-82)', async () => {
    const { impl, calls } = stubFetch({ [IG_MEDIA_URL]: instagramMedia(['m1']) });
    fakeDb.seed('creator_platform_accounts', [connectionRow({ platform: 'instagram', access_token: 'IGQ-long' })]);
    const importer = vi.fn(async (_url: string, _options: RunImportOptions) => success);

    await processSyncItem(
      deps({ importer, fetchOptions: { fetchImpl: impl, lookup: publicLookup } }),
      run([], { source: 'instagram' }),
      CREATOR,
      item({ itemId: 'm1', url: 'https://www.instagram.com/reel/m1/' }),
    );

    // An Instagram permalink serves a login-walled app. The gate would correctly
    // say there is no recipe on it, and the operator would read that as a
    // verdict on the post rather than on our reach.
    const options = importer.mock.calls[0][1];
    expect(options.document?.platform).toBe('instagram');
    expect(options.document?.text).toContain('2 avocados');
    expect(calls).toEqual([IG_MEDIA_URL]);
  });

  it('imports a TikTok video from its description (MEAL-83)', async () => {
    const { impl, calls } = stubFetch({ [TT_LIST_URL]: tiktokVideos(['v1']) });
    fakeDb.seed('creator_platform_accounts', [connectionRow({ platform: 'tiktok', access_token: 'act.tiktok' })]);
    const importer = vi.fn(async (_url: string, _options: RunImportOptions) => success);

    await processSyncItem(
      deps({ importer, fetchOptions: { fetchImpl: impl, lookup: publicLookup } }),
      run([], { source: 'tiktok' }),
      CREATOR,
      item({ itemId: 'v1', url: 'https://www.tiktok.com/@chefsarah/video/v1' }),
    );

    const options = importer.mock.calls[0][1];
    expect(options.document?.platform).toBe('tiktok');
    expect(options.document?.text).toContain('2 avocados');
    expect(calls).toEqual([TT_LIST_URL]);
  });

  it('reads a connected account once per run, not once per item', async () => {
    const { impl, calls } = stubFetch({ [IG_MEDIA_URL]: instagramMedia(['m1', 'm2']) });
    fakeDb.seed('creator_platform_accounts', [connectionRow({ platform: 'instagram', access_token: 'IGQ-long' })]);
    const importer = vi.fn(async () => success);
    // One resolver, shared — which is what `advanceRun` builds per invocation.
    const shared = deps({ importer, fetchOptions: { fetchImpl: impl, lookup: publicLookup } });
    const chunkDeps = { ...shared, sourceDocument: createSourceDocumentResolver(shared) };

    for (const id of ['m1', 'm2']) {
      await processSyncItem(chunkDeps, run([], { source: 'instagram' }), CREATOR, item({ itemId: id, url: `https://www.instagram.com/reel/${id}/` }));
    }

    // A 40-item selection is one API read, not forty.
    expect(calls).toEqual([IG_MEDIA_URL]);
    expect(importer).toHaveBeenCalledTimes(2);
  });

  it('fails an item the connected account no longer lists rather than fetching its page', async () => {
    const { impl } = stubFetch({ [TT_LIST_URL]: tiktokVideos(['v1']) });
    fakeDb.seed('creator_platform_accounts', [connectionRow({ platform: 'tiktok', access_token: 'act.tiktok' })]);
    const importer = vi.fn(async () => success);

    const result = await processSyncItem(
      deps({ importer, fetchOptions: { fetchImpl: impl, lookup: publicLookup } }),
      run([], { source: 'tiktok' }),
      CREATOR,
      item({ itemId: 'v9', url: 'https://www.tiktok.com/@chefsarah/video/v9' }),
    );

    // `failed`, not `rejected`: this is us not managing to read it, which is
    // retryable, rather than the gate ruling on the post, which is not.
    expect(result.status).toBe('failed');
    expect(result.detail).toMatch(/no longer in the account/i);
    expect(importer).not.toHaveBeenCalled();
  });

  it('stores the field-level confidence rather than discarding it', async () => {
    // `processSyncItem` computed `result.confidence` and never passed it on, so
    // the MEAL-72 assessment protected nothing on this path. That is the bug.
    const queue = vi.fn(async (_supabase: unknown, input: unknown) => { void input; return 'draft-9'; });
    await processSyncItem(
      deps({ importer: async () => success, queue: queue as unknown as SyncDeps['queue'] }),
      run([item()]),
      CREATOR,
      item(),
    );

    const queued = queue.mock.calls[0][1] as { confidence: unknown; reviewBy: string; draft: { name: string } };
    expect(queued.confidence).toEqual(success.confidence);
    expect(queued.reviewBy).toBe('admin');
    expect(queued.draft.name).toBe('Best Guacamole');
  });

  it('files the draft in the queue its caller names, not always the operator\'s', async () => {
    // The seam the poller needs. Hardcoded `admin`, the poller's drafts sit in
    // the operator's queue while the creator is emailed "Review and publish" —
    // a request to act on something they cannot open (MEAL-76 / MEAL-89).
    const queue = vi.fn(async (_supabase: unknown, input: unknown) => { void input; return 'draft-9'; });
    await processSyncItem(
      deps({ importer: async () => success, queue: queue as unknown as SyncDeps['queue'], reviewBy: 'creator' }),
      run([item()]),
      CREATOR,
      item(),
    );

    expect((queue.mock.calls[0][1] as { reviewBy: string }).reviewBy).toBe('creator');
  });

  it('counts the flagged fields so the run says how much reading is waiting', async () => {
    const result = await processSyncItem(
      deps({ importer: async () => success }),
      run([item()]),
      CREATOR,
      item(),
    );
    // The guacamole fixture lands fields on every level on purpose, including a
    // deliberate hallucination, so this is a real count and not a constant.
    expect(result.needALook).toBeGreaterThan(0);
  });

  it('records the item as imported the moment the draft exists, so a decline sticks', async () => {
    // `creator_source_items` is what the next sync and the poller read. Writing
    // it only on publish would mean a declined recipe comes back next cycle.
    await processSyncItem(
      deps({ importer: async () => success, queue: (async () => 'draft-9') as unknown as SyncDeps['queue'] }),
      run([item()]),
      CREATOR,
      item(),
    );
    const record = fakeDb.calls.find((c) => c.table === 'creator_source_items' && c.method === 'upsert');
    expect(record?.args[0]).toMatchObject({
      creator_id: 'c1', source: 'website', item_id: 'guid-1', status: 'imported', draft_id: 'draft-9',
    });
  });

  it('drops a selected post the gate says is not a recipe — and says so', async () => {
    const queue = vi.fn();
    const result = await processSyncItem(
      deps({
        importer: async () => rejection('gate', 'Not a recipe: this is a kitchen-tour post.'),
        queue: queue as unknown as SyncDeps['queue'],
      }),
      run([item()]),
      CREATOR,
      item(),
    );

    expect(result.status).toBe('rejected');
    expect(result.detail).toMatch(/not a recipe/i);
    expect(queue).not.toHaveBeenCalled();
  });

  it('calls a fetch failure failed, not rejected, so it stays retryable', async () => {
    // The gate is an answer about the post; a timeout is an answer about our
    // afternoon. Only the first is permanent.
    const result = await processSyncItem(
      deps({ importer: async () => rejection('fetch', 'The site took too long to answer.') }),
      run([item()]),
      CREATOR,
      item(),
    );
    expect(result.status).toBe('failed');
  });

  it('skips an item already imported rather than queuing it twice', async () => {
    fakeDb.queue('creator_source_items', { data: { status: 'imported' } });
    const importer = vi.fn();
    const result = await processSyncItem(
      deps({ importer: importer as unknown as SyncDeps['importer'] }),
      run([item()]),
      CREATOR,
      item(),
    );

    expect(result.status).toBe('skipped');
    expect(importer).not.toHaveBeenCalled();
  });

  it('survives an importer that throws', async () => {
    const result = await processSyncItem(
      deps({ importer: async () => { throw new Error('boom'); } }),
      run([item()]),
      CREATOR,
      item(),
    );
    expect(result.status).toBe('failed');
    expect(result.detail).toMatch(/boom/);
  });

  it('keeps the cost when extraction succeeded but queuing did not', async () => {
    const result = await processSyncItem(
      deps({
        importer: async () => success,
        queue: (async () => { throw new Error('duplicate key'); }) as unknown as SyncDeps['queue'],
      }),
      run([item()]),
      CREATOR,
      item(),
    );
    expect(result.status).toBe('failed');
    expect(result.costUsd).toBeGreaterThan(0);
  });
});

// ── A run ────────────────────────────────────────────────────────────────────

describe('advanceRun', () => {
  let success: ImportSuccess;
  beforeEach(async () => { success = await importedGuacamole(); });

  it('queues what passes, explains what did not, and finishes', async () => {
    const items = [
      item({ itemId: 'a', url: 'https://chefsarah.test/a' }),
      item({ itemId: 'b', url: 'https://chefsarah.test/b' }),
      item({ itemId: 'c', url: 'https://chefsarah.test/c' }),
    ];
    storeRun(runRow(items));

    const importer = vi.fn(async (url: string) =>
      url.endsWith('/a') ? success
        : url.endsWith('/b') ? rejection('gate', 'Not a recipe: a travel diary.')
        : rejection('fetch', 'The site refused us.'),
    );

    const result = await advanceRun(deps({ importer: importer as unknown as SyncDeps['importer'] }), 'r1');

    expect(result?.status).toBe('done');
    // "I selected 3 and got 1" has to add up on screen.
    expect(summariseRun(result!)).toMatchObject({ selected: 3, drafted: 1, rejected: 1, failed: 1, pending: 0 });
  });

  it('publishes nothing and tells nobody, however many items succeed', async () => {
    // MEAL-90 published here and emailed the creator from the run. Both are gone:
    // a finished run has put nothing on Discover, so an email announcing live
    // recipes would be false. The announcement moved to Approve.
    const items = [
      item({ itemId: 'a', url: 'https://chefsarah.test/a' }),
      item({ itemId: 'b', url: 'https://chefsarah.test/b' }),
    ];
    storeRun(runRow(items));

    const result = await advanceRun(deps({ importer: async () => success }), 'r1');

    expect(summariseRun(result!)).toMatchObject({ selected: 2, drafted: 2 });
    expect(publishCreatorMeal).not.toHaveBeenCalled();
    expect(sendCreatorSyncPublishedEmail).not.toHaveBeenCalled();
    // And no preset_meals row was written by any other route either.
    expect(fakeDb.calls.some((c) => c.table === 'preset_meals')).toBe(false);
  });

  it('reports how many fields the queue will ask a human to check', async () => {
    storeRun(runRow([item()]));
    const result = await advanceRun(deps({ importer: async () => success }), 'r1');
    expect(summariseRun(result!).needALook).toBeGreaterThan(0);
  });

  it('stops at its time budget and leaves the rest queued', async () => {
    const items = Array.from({ length: 6 }, (_, i) => item({ itemId: `i${i}`, url: `https://chefsarah.test/${i}` }));
    storeRun(runRow(items));

    // A clock that jumps 30s per read: the budget is spent after the first wave.
    let clock = 1_800_000_000_000;
    const result = await advanceRun(
      deps({ importer: async () => success, now: () => (clock += 30_000) }),
      'r1',
    );

    expect(result?.status).toBe('queued');
    const totals = summariseRun(result!);
    expect(totals.pending).toBeGreaterThan(0);
    expect(totals.drafted).toBeLessThan(6);
  });

  it('records a resolver failure on the item instead of wedging the run', async () => {
    // The bug this exists for: the resolver call sat outside the try, so a
    // platform API throwing escaped `processSyncItem`, rejected the wave's
    // `Promise.all`, escaped `advanceRun` and 500'd the route BEFORE the
    // release — leaving the run `running` behind a lease nobody held, every
    // item still `pending`, and no detail anywhere saying why. Three real runs
    // wedged exactly that way and the screen could only say "already being
    // worked on somewhere else".
    storeRun(runRow([item({ itemId: 'vid0000000B', url: 'https://www.youtube.com/watch?v=vid0000000B' })], { source: 'youtube' }));
    fakeDb.seed('creator_platform_accounts', [connectionRow()]);

    const run = await advanceRun(
      deps({
        importer: async () => success,
        sourceDocument: async () => { throw new Error('videos.list said 403'); },
      }),
      'r1',
    );

    expect(run).not.toBeNull();
    const failed = run!.items[0];
    expect(failed.status).toBe('failed');
    // The operator gets the actual reason, not a shrug.
    expect(failed.detail).toContain('videos.list said 403');
    // And the run is finished rather than parked behind a lease.
    expect(run!.status).toBe('done');
  });

  it('re-reads only what a resumed run still has to do', async () => {
    const items = [
      item({ itemId: 'vid0000000A', url: 'https://www.youtube.com/watch?v=vid0000000A', status: 'drafted' }),
      item({ itemId: 'vid0000000B', url: 'https://www.youtube.com/watch?v=vid0000000B' }),
    ];
    storeRun(runRow(items, { source: 'youtube' }));
    fakeDb.seed('creator_platform_accounts', [connectionRow()]);
    const { impl, calls } = stubFetch({ [videosUrl(['vid0000000B'])]: videosPage(['vid0000000B']) });

    await advanceRun(
      deps({ importer: async () => success, fetchOptions: { fetchImpl: impl, lookup: publicLookup } }),
      'r1',
    );

    // The resolver is memoised per invocation and cannot outlive the process, so
    // a run that resumes pays again for whatever it is handed. Handing it the
    // terminal items too meant a 200-video run spread over five invocations
    // bought all 200 five times — 20 `videos.list` units rather than 14.
    expect(calls).toEqual([videosUrl(['vid0000000B'])]);
  });

  it('returns null for a run that does not exist', async () => {
    expect(await advanceRun(deps(), 'nope')).toBeNull();
  });
});

describe('retrySyncItem', () => {
  it('puts a failed item back in the queue', async () => {
    storeRun(runRow([item({ status: 'failed', detail: 'timeout' })], { status: 'done', finished_at: '2026-08-02T11:00:00.000Z' }));

    const result = await retrySyncItem(deps(), 'r1', 'guid-1');

    expect(result.ok && result.run.items[0].status).toBe('pending');
    expect(result.ok && result.run.status).toBe('queued');
    // Persisted, not merely returned: the old assertion read the object the
    // function built and would have passed on a write that never landed.
    const stored = fakeDb.row('creator_sync_runs', 'r1')!;
    expect((stored.items as SyncItem[])[0]).toMatchObject({ status: 'pending', detail: null });
    expect(stored).toMatchObject({ status: 'queued', finished_at: null, lease_until: null });
  });

  it('refuses to retry a gate rejection — that answer will not change', async () => {
    storeRun(runRow([item({ status: 'rejected' })]));
    const result = await retrySyncItem(deps(), 'r1', 'guid-1');
    expect(result.ok).toBe(false);
  });

  it('refuses to retry something already drafted', async () => {
    storeRun(runRow([item({ status: 'drafted', draftId: 'd1' })]));
    const result = await retrySyncItem(deps(), 'r1', 'guid-1');
    expect(result.ok).toBe(false);
  });
});

// ── Two writers on one run ───────────────────────────────────────────────────

/**
 * The run row is shared mutable state: a worker holds a lease on it while an
 * operator presses Retry, the cron sweeps it, and a second tab polls it. These
 * run against a stored row rather than a queued result, because what is being
 * asserted is what ended up *persisted* after two writers interleaved — which a
 * FIFO stub cannot express at all.
 */
describe('advanceRun and retrySyncItem — concurrent writers', () => {
  let success: ImportSuccess;
  beforeEach(async () => { success = await importedGuacamole(); });

  it('never reports a retry it then discards', async () => {
    // Item `a` is being imported; the operator presses Retry on the failed `b`.
    // The retry used to succeed, tell the operator `b` was requeued, and then be
    // overwritten by the worker writing back the array it read *before* the
    // retry: `b` failed again, every item terminal, run marked done — and
    // `resumeStalledSyncRuns` filters `status <> 'done'`, so nothing ever picks
    // `b` up again. Refusing while a worker holds the lease is an acceptable
    // answer here; saying yes and meaning no is not.
    storeRun(runRow([
      item({ itemId: 'a', url: 'https://chefsarah.test/a' }),
      item({ itemId: 'b', url: 'https://chefsarah.test/b', status: 'failed', detail: 'timeout' }),
    ]));

    let retried: Awaited<ReturnType<typeof retrySyncItem>> | undefined;
    const importer = vi.fn(async () => {
      // Mid-wave, through the real PATCH path the retry button takes.
      if (importer.mock.calls.length === 1) retried = await retrySyncItem(deps(), 'r1', 'b');
      return success;
    });

    await advanceRun(deps({ importer: importer as unknown as SyncDeps['importer'] }), 'r1');

    const stored = fakeDb.row('creator_sync_runs', 'r1')!;
    const b = (stored.items as SyncItem[]).find((entry) => entry.itemId === 'b')!;
    expect(retried).toBeDefined();
    const outcome = retried!;
    if (outcome.ok) {
      expect(b.status).toBe('pending');
      expect(stored.status).not.toBe('done');
    } else {
      // Refused, and the operator is told why rather than shown a requeued row.
      expect(outcome.error).toMatch(/being worked on/i);
      expect(b.status).toBe('failed');
    }
  });

  it('does not overwrite a drafted item with a stale pending copy', async () => {
    // The reverse interleaving, both sides real. A retry written from a copy
    // read before the wave finished resets `a` to pending, which re-runs it,
    // finds `creator_source_items` already `imported`, and returns `skipped`
    // with `draftId: null` — the run has lost its link to a draft sitting in
    // the review queue with nothing pointing at it.
    storeRun(runRow([
      item({ itemId: 'a', url: 'https://chefsarah.test/a' }),
      item({ itemId: 'b', url: 'https://chefsarah.test/b', status: 'failed', detail: 'timeout' }),
    ]));

    const [, retried] = await Promise.all([
      advanceRun(deps({ importer: async () => success }), 'r1'),
      retrySyncItem(deps(), 'r1', 'b'),
    ]);

    const stored = fakeDb.row('creator_sync_runs', 'r1')!;
    const items = stored.items as SyncItem[];
    // Whoever wrote last, the imported item keeps its draft.
    expect(items.find((entry) => entry.itemId === 'a')).toMatchObject({ status: 'drafted', draftId: 'draft-1' });
    // And a retry the operator was told succeeded is still queued.
    if (retried.ok) {
      expect(items.find((entry) => entry.itemId === 'b')?.status).toBe('pending');
      expect(stored.status).not.toBe('done');
    }
  });

  it('does not release a lease another worker now holds', async () => {
    // A wave can outrun `LEASE_MS`, and the moment it does the run is claimable
    // by the cron or a second tab. The worker that overran must not then write
    // its own items over the new holder's progress, and must not clear a lease
    // that is no longer its own — that lets a third driver in on a run two
    // workers are already inside.
    storeRun(runRow([item({ itemId: 'a', url: 'https://chefsarah.test/a' })]));
    const held = '2099-01-01T00:00:00.000Z';

    const importer = vi.fn(async () => {
      // Our lease expired and somebody else claimed the run mid-wave.
      fakeDb.patch('creator_sync_runs', 'r1', { lease_until: held, status: 'running' });
      return success;
    });

    await advanceRun(deps({ importer: importer as unknown as SyncDeps['importer'] }), 'r1');

    expect(fakeDb.row('creator_sync_runs', 'r1')).toMatchObject({ lease_until: held });
  });

  it('claims with a predicate that a live lease actually refuses', async () => {
    // The lease test this file used to have queued `{ data: [] }` and asserted
    // the branch. It would have passed with the expiry term dropped, the
    // predicate misspelled, or `.select()` missing. This one runs the filter
    // against a row that really is leased.
    storeRun(runRow([item()], { lease_until: '2099-01-01T00:00:00.000Z', status: 'running' }));
    const importer = vi.fn();

    const result = await advanceRun(deps({ importer: importer as unknown as SyncDeps['importer'] }), 'r1');

    expect(importer).not.toHaveBeenCalled();
    expect(result?.status).toBe('running');
    expect(fakeDb.row('creator_sync_runs', 'r1')).toMatchObject({ lease_until: '2099-01-01T00:00:00.000Z' });
  });

  it('claims a run whose holder is gone, and holds it while it works', async () => {
    // The other half of the same predicate: an expired lease must not wedge the
    // run forever, which is why it is a lease and not a boolean.
    storeRun(runRow([item()], { lease_until: '2020-01-01T00:00:00.000Z', status: 'running' }));

    const result = await advanceRun(deps({ importer: async () => success }), 'r1');

    expect(summariseRun(result!)).toMatchObject({ drafted: 1 });
    // Finished and let go, so the next worker can have it.
    expect(fakeDb.row('creator_sync_runs', 'r1')).toMatchObject({ status: 'done', lease_until: null });
  });
});

// ── The cron's sweep ─────────────────────────────────────────────────────────

/**
 * The backstop for a run whose operator closed the tab. It runs inside a
 * function with two email passes ahead of it, so what it must not do is start
 * work it cannot finish — a chunk begun and then killed leaves a live lease on
 * a run nobody else can touch until it expires.
 */
describe('resumeStalledSyncRuns', () => {
  /** A run with nothing left to do: claiming it is all the work there is. */
  function finishedRun(id: string, updatedAt: string, createdAt: string) {
    return {
      id, creator_id: 'c1', source: 'website', mode: 'catalog', status: 'queued',
      items: [item({ status: 'drafted', draftId: 'd1' })],
      started_at: null, created_at: createdAt, updated_at: updatedAt, lease_until: null,
    };
  }

  it('takes the least recently advanced runs, not the same five old ones every day', async () => {
    // `created_at` ascending meant five old stuck runs were picked every fire
    // and every newer run starved behind them permanently. Ordering by
    // `updated_at` sends a run to the back of the line the moment it is
    // advanced, so the sweep is a round robin.
    fakeDb.seed('creators', [CREATOR]);
    fakeDb.seed('creator_source_items', []);
    fakeDb.seed('creator_sync_runs', [
      // Oldest by creation, but advanced most recently — must not be picked.
      finishedRun('old-but-busy', '2026-08-02T10:00:00.000Z', '2026-01-01T00:00:00.000Z'),
      finishedRun('untouched', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z'),
    ]);

    const swept = await resumeStalledSyncRuns(deps({ importer: vi.fn() as unknown as SyncDeps['importer'] }), 1);

    expect(swept).toBe(1);
    expect(fakeDb.row('creator_sync_runs', 'untouched')).toMatchObject({ status: 'done' });
    expect(fakeDb.row('creator_sync_runs', 'old-but-busy')).toMatchObject({ status: 'queued' });
  });

  it('stops at its budget rather than starting a chunk it cannot finish', async () => {
    // The killed-mid-chunk failure is not "slow", it is a run left holding a
    // lease nobody else can take until it expires.
    fakeDb.seed('creators', [CREATOR]);
    fakeDb.seed('creator_source_items', []);
    fakeDb.seed('creator_sync_runs', [
      { ...finishedRun('a', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z'), items: [item()] },
      { ...finishedRun('b', '2026-07-02T00:00:00.000Z', '2026-07-02T00:00:00.000Z'), items: [item()] },
    ]);

    // The first run's one import spends the whole sweep budget.
    let clock = 1_800_000_000_000;
    const swept = await resumeStalledSyncRuns(
      deps({
        importer: async () => { clock += SWEEP_BUDGET_MS; return await importedGuacamole(); },
        now: () => clock,
      }),
      5,
    );

    expect(swept).toBe(1);
    expect(fakeDb.row('creator_sync_runs', 'a')).toMatchObject({ status: 'done' });
    // Untouched and unleased, so the next fire — or an operator pressing Resume
    // — can pick it up immediately.
    expect(fakeDb.row('creator_sync_runs', 'b')).toMatchObject({ status: 'queued', lease_until: null });
  });

  it('skips a run another worker is inside', async () => {
    fakeDb.seed('creators', [CREATOR]);
    fakeDb.seed('creator_sync_runs', [
      { ...finishedRun('leased', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z'), lease_until: '2099-01-01T00:00:00.000Z' },
    ]);

    expect(await resumeStalledSyncRuns(deps(), 5)).toBe(0);
  });
});
