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
  retrySyncItem,
  summariseRun,
  type SyncDeps,
  type SyncItem,
  type SyncRun,
} from '@/lib/admin-sync';

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
const UPLOADS_FEED = `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}`;

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

/** An uploads feed carrying one entry per id, each with a real ingredient list. */
function uploadsFeed(ids: string[], description = 'Ingredients:\n2 avocados\n1 lime\n\nMash them together.'): string {
  const entries = ids
    .map(
      (id) =>
        `<entry><id>yt:video:${id}</id><yt:videoId>${id}</yt:videoId>` +
        `<title>Best Guacamole ${id}</title>` +
        `<link rel="alternate" href="https://www.youtube.com/watch?v=${id}"/>` +
        `<published>2026-07-29T09:00:00+00:00</published>` +
        `<media:group><media:title>Best Guacamole ${id}</media:title>` +
        `<media:thumbnail url="https://i.ytimg.com/vi/${id}/hqdefault.jpg"/>` +
        `<media:description>${description}</media:description></media:group></entry>`,
    )
    .join('');
  return `<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/">${entries}</feed>`;
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

function jsonRoute(body: unknown) {
  return { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } };
}

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

/** Queues the run read and a successful lease claim. */
function queueRun(row: Record<string, unknown>) {
  fakeDb.queue('creator_sync_runs', { data: row });
  fakeDb.queue('creator_sync_runs', { data: [row] });
  fakeDb.queue('creators', { data: CREATOR });
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

  it('lists a connected channel from the uploads feed, fetching no video (MEAL-74)', async () => {
    const { impl, calls } = stubFetch({
      [UPLOADS_FEED]: { body: uploadsFeed(['vid0000000A', 'vid0000000B']), headers: { 'content-type': 'text/xml' } },
    });
    fakeDb.queue('creator_platform_accounts', { data: connectionRow() });

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
    // One request for the whole channel. No video opened, no model called.
    expect(calls).toEqual([UPLOADS_FEED]);
  });

  it('takes the channel id from the grant rather than the creator-supplied link', async () => {
    const { impl, calls } = stubFetch({
      [UPLOADS_FEED]: { body: uploadsFeed(['vid0000000A']), headers: { 'content-type': 'text/xml' } },
    });
    fakeDb.queue('creator_platform_accounts', { data: connectionRow() });

    await buildCatalog(
      { supabase, fetchOptions: { fetchImpl: impl, lookup: publicLookup } },
      // A link pointing at somebody else's channel entirely. The grant wins, so
      // the page behind this URL is never even read.
      { ...CREATOR, youtube_url: 'https://youtube.com/channel/UCzzzzzzzzzzzzzzzzzzzzzz' },
      'youtube',
    );

    expect(calls).toEqual([UPLOADS_FEED]);
  });

  it('refuses a YouTube catalog for a creator with neither a grant nor a link', async () => {
    const result = await buildCatalog({ supabase }, CREATOR, 'youtube');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toMatch(/connect YouTube/i);
  });

  it('lists a connected Instagram account from /me/media, downloading no video (MEAL-82)', async () => {
    const { impl, calls } = stubFetch({ [IG_MEDIA_URL]: instagramMedia(['m1', 'm2']) });
    fakeDb.queue('creator_platform_accounts', { data: connectionRow({ platform: 'instagram', access_token: 'IGQ-long' }) });

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
    fakeDb.queue('creator_platform_accounts', { data: connectionRow({ platform: 'tiktok', access_token: 'act.tiktok' }) });

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
    fakeDb.queue('creator_platform_accounts', {
      data: connectionRow({ platform: 'instagram', broken_reason: 'Instagram refused to refresh this grant' }),
    });

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
    fakeDb.queue('creator_platform_accounts', { data: connectionRow({ platform: 'instagram', access_token: 'IGQ-long' }) });

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
    fakeDb.queue('creator_platform_accounts', { data: connectionRow({ platform: 'instagram', access_token: 'IGQ-long' }) });

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

  it('imports a video from the channel description, never from its watch page (MEAL-74)', async () => {
    const { impl, calls } = stubFetch({
      [UPLOADS_FEED]: { body: uploadsFeed(['vid0000000A']), headers: { 'content-type': 'text/xml' } },
    });
    fakeDb.queue('creator_platform_accounts', { data: connectionRow() });
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
    expect(calls).toEqual([UPLOADS_FEED]);
  });

  it('fails a video that has dropped out of the uploads feed rather than falling back to the page', async () => {
    const { impl } = stubFetch({
      [UPLOADS_FEED]: { body: uploadsFeed(['vid0000000A']), headers: { 'content-type': 'text/xml' } },
    });
    fakeDb.queue('creator_platform_accounts', { data: connectionRow() });
    const importer = vi.fn(async () => success);

    const result = await processSyncItem(
      deps({ importer, fetchOptions: { fetchImpl: impl, lookup: publicLookup } }),
      run([], { source: 'youtube' }),
      { ...CREATOR, youtube_url: 'https://youtube.com/@sarah' },
      item({ itemId: 'vid0000000Z', url: 'https://www.youtube.com/watch?v=vid0000000Z' }),
    );

    expect(result.status).toBe('failed');
    expect(result.detail).toMatch(/no longer in the channel/i);
    expect(importer).not.toHaveBeenCalled();
  });

  it('imports an Instagram post from its caption, never from the permalink (MEAL-82)', async () => {
    const { impl, calls } = stubFetch({ [IG_MEDIA_URL]: instagramMedia(['m1']) });
    fakeDb.queue('creator_platform_accounts', { data: connectionRow({ platform: 'instagram', access_token: 'IGQ-long' }) });
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
    fakeDb.queue('creator_platform_accounts', { data: connectionRow({ platform: 'tiktok', access_token: 'act.tiktok' }) });
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
    fakeDb.queue('creator_platform_accounts', { data: connectionRow({ platform: 'instagram', access_token: 'IGQ-long' }) });
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
    fakeDb.queue('creator_platform_accounts', { data: connectionRow({ platform: 'tiktok', access_token: 'act.tiktok' }) });
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
    queueRun(runRow(items));

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
    queueRun(runRow(items));

    const result = await advanceRun(deps({ importer: async () => success }), 'r1');

    expect(summariseRun(result!)).toMatchObject({ selected: 2, drafted: 2 });
    expect(publishCreatorMeal).not.toHaveBeenCalled();
    expect(sendCreatorSyncPublishedEmail).not.toHaveBeenCalled();
    // And no preset_meals row was written by any other route either.
    expect(fakeDb.calls.some((c) => c.table === 'preset_meals')).toBe(false);
  });

  it('reports how many fields the queue will ask a human to check', async () => {
    queueRun(runRow([item()]));
    const result = await advanceRun(deps({ importer: async () => success }), 'r1');
    expect(summariseRun(result!).needALook).toBeGreaterThan(0);
  });

  it('refuses to work on a run another worker holds the lease on', async () => {
    fakeDb.queue('creator_sync_runs', { data: runRow([item()], { status: 'running' }) });
    fakeDb.queue('creator_sync_runs', { data: [] }); // the claim matched no row
    const importer = vi.fn();

    await advanceRun(deps({ importer: importer as unknown as SyncDeps['importer'] }), 'r1');

    expect(importer).not.toHaveBeenCalled();
  });

  it('stops at its time budget and leaves the rest queued', async () => {
    const items = Array.from({ length: 6 }, (_, i) => item({ itemId: `i${i}`, url: `https://chefsarah.test/${i}` }));
    queueRun(runRow(items));

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

  it('returns null for a run that does not exist', async () => {
    expect(await advanceRun(deps(), 'nope')).toBeNull();
  });
});

describe('retrySyncItem', () => {
  it('puts a failed item back in the queue', async () => {
    fakeDb.queue('creator_sync_runs', { data: runRow([item({ status: 'failed', detail: 'timeout' })], { status: 'done' }) });
    const result = await retrySyncItem(deps(), 'r1', 'guid-1');
    expect(result.ok && result.run.items[0].status).toBe('pending');
    expect(result.ok && result.run.status).toBe('queued');
  });

  it('refuses to retry a gate rejection — that answer will not change', async () => {
    fakeDb.queue('creator_sync_runs', { data: runRow([item({ status: 'rejected' })]) });
    const result = await retrySyncItem(deps(), 'r1', 'guid-1');
    expect(result.ok).toBe(false);
  });

  it('refuses to retry something already drafted', async () => {
    fakeDb.queue('creator_sync_runs', { data: runRow([item({ status: 'drafted', draftId: 'd1' })]) });
    const result = await retrySyncItem(deps(), 'r1', 'guid-1');
    expect(result.ok).toBe(false);
  });
});
