import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { fakeDb } from '../helpers/supabase-mock';
import { endlessBody, publicLookup, stubFetch } from '../helpers/import-stubs';

vi.mock('@/lib/logger', () => ({ log: vi.fn() }));

import { MAX_TEXT_CHARS } from '@/lib/import/html';

import {
  __resetUploadsPlaylistCache,
  assertAppendAllowed,
  channelIdForCreator,
  exchangeYouTubeCode,
  fetchOwnChannel,
  fetchVideoSnippet,
  fetchVideos,
  isUploadsPageToken,
  listUploads,
  srtToText,
  updateVideoDescription,
  withMealioLink,
  MAX_CAPTION_BYTES,
  MEALIO_LINK_INTRO,
  YOUTUBE_DESCRIPTION_MAX,
  YOUTUBE_QUOTA,
  youtubeAuthUrl,
  youtubeSourceDocument,
  YOUTUBE_WRITE_SCOPE,
  type VideoSnippet,
  type YouTubeVideo,
} from '@/lib/youtube';

/**
 * Reading a creator's channel (MEAL-74).
 *
 * The properties worth defending: listing costs one unauthenticated request,
 * the description survives with its line breaks intact (it is where the
 * ingredient list lives), captions are the fallback and never the first move,
 * and the channel id comes from the grant rather than from anything typed.
 */

const CHANNEL_ID = 'UCabcdefghijklmnopqrstuv';
const supabase = fakeDb as unknown as SupabaseClient;

const DESCRIPTION = 'Ingredients:\n2 ripe avocados\n1 lime, juiced\n\nMash them together.';

const API = 'https://www.googleapis.com/youtube/v3';

/** A JSON route for `stubFetch`, which defaults to serving HTML. */
function jsonRoute(body: unknown) {
  return { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } };
}

function video(overrides: Partial<YouTubeVideo> = {}): YouTubeVideo {
  return {
    videoId: 'vid0000000A',
    url: 'https://www.youtube.com/watch?v=vid0000000A',
    title: 'Best Guacamole',
    description: DESCRIPTION,
    publishedAt: '2026-07-29T09:00:00.000Z',
    thumbnailUrl: null,
    channelId: CHANNEL_ID,
    ...overrides,
  };
}

beforeEach(() => {
  fakeDb.reset();
  // The uploads playlist id is memoised per channel for the life of the process.
  // Leaving it set between tests hides the `channels.list` a later one skipped,
  // and a test asserting its own request count would then pass for that reason.
  __resetUploadsPlaylistCache();
  process.env.GOOGLE_CLIENT_ID = 'client-id.apps.googleusercontent.com';
  process.env.GOOGLE_CLIENT_SECRET = 'client-secret';
  process.env.NEXT_PUBLIC_APP_URL = 'https://mealio.co';
});

// ── Consent URL ──────────────────────────────────────────────────────────────

describe('youtube — the consent screen asks once', () => {
  it('requests the write scope alongside the read scope', () => {
    const url = new URL(youtubeAuthUrl('nonce-1')!);
    const scopes = (url.searchParams.get('scope') ?? '').split(' ');

    // Adding the write scope later re-prompts every creator who already
    // connected, and the ones who ignore that prompt break the feature silently.
    expect(scopes).toContain('https://www.googleapis.com/auth/youtube.readonly');
    expect(scopes).toContain(YOUTUBE_WRITE_SCOPE);
  });

  it('asks Google for a refresh token, which needs both offline access and a forced prompt', () => {
    const url = new URL(youtubeAuthUrl('nonce-1')!);
    // Without `prompt=consent` a creator who has consented before gets an access
    // token and no refresh token, and the connection dies an hour later with
    // nothing to renew it.
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('redirect_uri')).toBe('https://mealio.co/api/creator/youtube/callback');
    expect(url.searchParams.get('state')).toBe('nonce-1');
  });
});

// ── The grant ────────────────────────────────────────────────────────────────

describe('youtube — the channel id comes from the grant', () => {
  it('reads the connected channel with mine=true, never from an id we were given', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ items: [{ id: CHANNEL_ID, snippet: { title: 'Chef Sarah' } }] }), {
        headers: { 'content-type': 'application/json' },
      }),
    ) as unknown as typeof fetch;

    const result = await fetchOwnChannel('ya29-token', { fetchImpl });

    expect(result).toEqual({ ok: true, channel: { id: CHANNEL_ID, title: 'Chef Sarah' } });
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(url)).toContain('mine=true');
    expect((init as RequestInit).headers).toMatchObject({ authorization: 'Bearer ya29-token' });
  });

  it('says plainly when the Google account owns no channel', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ items: [] }), { headers: { 'content-type': 'application/json' } })) as typeof fetch;

    const result = await fetchOwnChannel('ya29-token', { fetchImpl });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toMatch(/no YouTube channel/i);
  });

  it('turns the code into a grant with an absolute expiry', async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({ access_token: 'ya29-token', refresh_token: '1//refresh', expires_in: 3600, scope: 'a b' }),
        { headers: { 'content-type': 'application/json' } },
      )) as typeof fetch;

    const result = await exchangeYouTubeCode('code-1', { fetchImpl, now: () => 1_800_000_000_000 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.grant.refreshToken).toBe('1//refresh');
    expect(result.grant.scopes).toEqual(['a', 'b']);
    expect(result.grant.expiresAt).toBe(new Date(1_800_000_000_000 + 3_600_000).toISOString());
  });
});

// ── Channel ids from links ───────────────────────────────────────────────────

describe('youtube — resolving a channel id from a creator link', () => {




});

// ── The uploads playlist ─────────────────────────────────────────────────────

describe('youtube — listing a back catalogue costs quota, so it is bounded', () => {
  const PLAYLIST_ID = 'UUabcdefghijklmnopqrstuv';

  const channelsUrl = (id = CHANNEL_ID) =>
    `${API}/channels?${new URLSearchParams({ part: 'contentDetails', id })}`;

  const playlistUrl = (params: Record<string, string>) =>
    `${API}/playlistItems?${new URLSearchParams({
      part: 'snippet,contentDetails,status',
      playlistId: PLAYLIST_ID,
      maxResults: '50',
      ...params,
    })}`;

  const channelsRoute = () => jsonRoute({ items: [{ contentDetails: { relatedPlaylists: { uploads: PLAYLIST_ID } } }] });

  function playlistItem(id: string, overrides: Record<string, any> = {}) {
    return {
      contentDetails: { videoId: id, videoPublishedAt: '2026-07-29T09:00:00Z' },
      status: { privacyStatus: 'public' },
      snippet: {
        title: `Best Guacamole ${id}`,
        description: DESCRIPTION,
        publishedAt: '2026-08-01T00:00:00Z',
        channelId: CHANNEL_ID,
        videoOwnerChannelId: CHANNEL_ID,
        thumbnails: { high: { url: `https://i.ytimg.com/vi/${id}/hqdefault.jpg` } },
      },
      ...overrides,
    };
  }

  it('resolves the uploads playlist from the API rather than rewriting UC to UU', async () => {
    const { impl, calls } = stubFetch({
      [channelsUrl()]: channelsRoute(),
      [playlistUrl({})]: jsonRoute({ items: [playlistItem('vid0000000A')] }),
    });

    const result = await listUploads('ya29-token', CHANNEL_ID, { fetchImpl: impl });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // `UC…` → `UU…` is true of every channel anyone has looked at and is still
    // an assumption about somebody else's id scheme standing in for a field
    // they publish. One unit is the price of not making it.
    expect(calls[0]).toBe(channelsUrl());
    expect(calls[1]).toContain(`playlistId=${PLAYLIST_ID}`);
  });

  it('keeps the description’s line breaks, which is where the ingredients are', async () => {
    const { impl } = stubFetch({
      [channelsUrl()]: channelsRoute(),
      [playlistUrl({})]: jsonRoute({ items: [playlistItem('vid0000000A')] }),
    });

    const result = await listUploads('ya29-token', CHANNEL_ID, { fetchImpl: impl });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [video] = result.videos;
    expect(video.description).toBe(DESCRIPTION);
    expect(video.description.split('\n')).toContain('2 ripe avocados');
    // The bare video id, because MEAL-79 keys "this meal came from that video"
    // on it and every YouTube API call takes the same form.
    expect(video.videoId).toBe('vid0000000A');
    expect(video.url).toBe('https://www.youtube.com/watch?v=vid0000000A');
    // `videoPublishedAt`, not the date it was added to the playlist.
    expect(video.publishedAt).toBe('2026-07-29T09:00:00.000Z');
    expect(video.thumbnailUrl).toBe('https://i.ytimg.com/vi/vid0000000A/hqdefault.jpg');
    expect(video.channelId).toBe(CHANNEL_ID);
  });

  it('pages, which the uploads feed could not — the whole reason for the move', async () => {
    const { impl } = stubFetch({
      [channelsUrl()]: channelsRoute(),
      [playlistUrl({ maxResults: '1' })]: jsonRoute({ items: [playlistItem('vid0000000A')], nextPageToken: 'CDIQAA' }),
      [playlistUrl({ maxResults: '1', pageToken: 'CDIQAA' })]: jsonRoute({ items: [playlistItem('vid0000000B')] }),
    });

    const first = await listUploads('ya29-token', CHANNEL_ID, { fetchImpl: impl, limit: 1 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    // A channel with 300 recipe videos showed 15 through the feed and had no
    // next page at all. This is the cursor that fixes that.
    expect(first.nextPageToken).toBe('CDIQAA');

    const second = await listUploads('ya29-token', CHANNEL_ID, {
      fetchImpl: impl,
      limit: 1,
      pageToken: first.nextPageToken,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.videos.map(v => v.videoId)).toEqual(['vid0000000B']);
    expect(second.nextPageToken).toBeNull();
  });

  it('stops at one window rather than walking the whole channel', async () => {
    const many = Array.from({ length: 50 }, (_, i) => playlistItem(`vid000000${String(i).padStart(3, '0')}`));
    const { impl, calls } = stubFetch({
      [channelsUrl()]: channelsRoute(),
      [playlistUrl({})]: jsonRoute({ items: many, nextPageToken: 'CDIQAA' }),
      // Deliberately stubbed. Reaching it at all would mean the lister looped,
      // which is the whole thing MEAL-79 says not to do on a screen open.
      [playlistUrl({ pageToken: 'CDIQAA' })]: jsonRoute({ items: many, nextPageToken: 'CGQQAA' }),
    });

    const result = await listUploads('ya29-token', CHANNEL_ID, { fetchImpl: impl });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 300 videos is 6 pages. A screen being opened must not spend six units of
    // a budget shared with every other creator — the operator asks for the next
    // window, and the cursor is how they can.
    expect(result.videos).toHaveLength(50);
    expect(calls).toHaveLength(2);
    expect(result.quotaUnits).toBe(YOUTUBE_QUOTA.channelsList + YOUTUBE_QUOTA.playlistItemsList);
    expect(result.nextPageToken).toBe('CDIQAA');
  });

  it('drops private and unreadable placeholders rather than listing them', async () => {
    const { impl } = stubFetch({
      [channelsUrl()]: channelsRoute(),
      [playlistUrl({})]: jsonRoute({
        items: [
          playlistItem('vid0000000A'),
          playlistItem('vid0000000B', { status: { privacyStatus: 'private' } }),
          // A deleted entry keeps its row and loses its video id.
          { contentDetails: {}, status: { privacyStatus: 'public' }, snippet: { title: 'Deleted video' } },
        ],
      }),
    });

    const result = await listUploads('ya29-token', CHANNEL_ID, { fetchImpl: impl });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // An operator ticking one of these would spend a run on a video nothing can
    // read, and the failure would look like ours rather than YouTube's.
    expect(result.videos.map(v => v.videoId)).toEqual(['vid0000000A']);
  });

  it('refuses a channel id that is not one, before any request', async () => {
    const { impl, calls } = stubFetch({});
    const result = await listUploads('ya29-token', '../../etc/passwd', { fetchImpl: impl });
    expect(result.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it('refuses a page cursor that is not one YouTube issued, before any request', async () => {
    const { impl, calls } = stubFetch({});
    // The cursor comes back from the client on "load more". It cannot point at
    // another channel — the playlist is resolved server-side — but an unbounded
    // string from a request body still does not get interpolated into a URL.
    expect(isUploadsPageToken('CDIQAA')).toBe(true);
    expect(isUploadsPageToken('a b')).toBe(false);
    expect(isUploadsPageToken('x'.repeat(300))).toBe(false);

    const result = await listUploads('ya29-token', CHANNEL_ID, { fetchImpl: impl, pageToken: 'not a token' });
    expect(result.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it('reports an empty window as a success with nothing in it', async () => {
    const { impl } = stubFetch({
      [channelsUrl()]: channelsRoute(),
      [playlistUrl({})]: jsonRoute({ items: [] }),
    });

    const result = await listUploads('ya29-token', CHANNEL_ID, { fetchImpl: impl });

    // "We could not read it" and "there is nothing there" are opposite facts.
    // Telling them apart is the caller's job, and `videos.length` is how.
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.videos).toEqual([]);
  });

  it('buys the uploads playlist id once per channel, not once per page', async () => {
    const { impl, calls } = stubFetch({
      [channelsUrl()]: channelsRoute(),
      [playlistUrl({})]: jsonRoute({ items: [playlistItem('vid0000000A')], nextPageToken: 'CDIQAA' }),
      [playlistUrl({ pageToken: 'CDIQAA' })]: jsonRoute({ items: [playlistItem('vid0000000B')] }),
    });

    const first = await listUploads('ya29-token', CHANNEL_ID, { fetchImpl: impl });
    const second = await listUploads('ya29-token', CHANNEL_ID, { fetchImpl: impl, pageToken: 'CDIQAA' });

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    // A channel's uploads playlist does not change, so re-reading it is a unit
    // spent to learn something already known — and it was being spent on every
    // "Load 50 more", which made a 300-video walk 12 units against the 7 this
    // file documents.
    expect(calls).toEqual([channelsUrl(), playlistUrl({}), playlistUrl({ pageToken: 'CDIQAA' })]);
    expect(first.quotaUnits).toBe(YOUTUBE_QUOTA.channelsList + YOUTUBE_QUOTA.playlistItemsList);
    expect(second.quotaUnits).toBe(YOUTUBE_QUOTA.playlistItemsList);
  });

  it('reports what a failed listing already spent', async () => {
    const { impl } = stubFetch({
      [channelsUrl()]: channelsRoute(),
      [playlistUrl({})]: { status: 403, body: JSON.stringify({ error: { message: 'quota' } }), headers: { 'content-type': 'application/json' } },
    });

    const result = await listUploads('ya29-token', CHANNEL_ID, { fetchImpl: impl });

    // `channels.list` succeeded and was charged. A refusal reporting zero is how
    // the operator's running total quietly drops below Google's.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.quotaUnits).toBe(YOUTUBE_QUOTA.channelsList + YOUTUBE_QUOTA.playlistItemsList);
  });

  it('spends nothing, and says so, on a channel id or cursor that is not one', async () => {
    const { impl } = stubFetch({});
    const badChannel = await listUploads('ya29-token', '../../etc/passwd', { fetchImpl: impl });
    const badCursor = await listUploads('ya29-token', CHANNEL_ID, { fetchImpl: impl, pageToken: 'not a token' });
    expect(badChannel.ok || badCursor.ok).toBe(false);
    if (badChannel.ok || badCursor.ok) return;
    expect([badChannel.quotaUnits, badCursor.quotaUnits]).toEqual([0, 0]);
  });

  it('carries Google’s own sentence out of a refusal', async () => {
    const { impl } = stubFetch({
      [channelsUrl()]: {
        status: 403,
        body: JSON.stringify({ error: { message: 'The request cannot be completed because you have exceeded your quota.' } }),
        headers: { 'content-type': 'application/json' },
      },
    });

    const result = await listUploads('ya29-token', CHANNEL_ID, { fetchImpl: impl });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // An exhausted quota, a revoked grant and a disabled API all arrive as an
    // HTTP error, and an operator does something different about each.
    expect(result.detail).toMatch(/exceeded your quota/);
  });
});

// ── Reading specific videos ──────────────────────────────────────────────────

describe('youtube — a selection is read by id, and the channel is checked', () => {
  const videosUrl = (ids: string) => `${API}/videos?${new URLSearchParams({ part: 'snippet', id: ids })}`;

  it('reads fifty videos in one call, whichever page they came from', async () => {
    const ids = Array.from({ length: 50 }, (_, i) => `vid000000${String(i).padStart(3, '0')}`);
    const { impl, calls } = stubFetch({
      [videosUrl(ids.join(','))]: jsonRoute({
        items: ids.map(id => ({ id, snippet: { title: `Video ${id}`, description: DESCRIPTION, channelId: CHANNEL_ID } })),
      }),
    });

    const result = await fetchVideos('ya29-token', ids, { fetchImpl: impl });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // A selection made from page 4 of a 300-video channel used to be unreadable,
    // because the run re-listed the channel and looked for those ids in the
    // most recent 15 uploads. One unit for the lot.
    expect(result.videos).toHaveLength(50);
    expect(result.quotaUnits).toBe(YOUTUBE_QUOTA.videosList);
    expect(calls).toHaveLength(1);
  });

  it('reports whose channel each video is on', async () => {
    const { impl } = stubFetch({
      [videosUrl('vid0000000A')]: jsonRoute({
        items: [{ id: 'vid0000000A', snippet: { title: 'x', description: '', channelId: 'UCzzzzzzzzzzzzzzzzzzzzzz' } }],
      }),
    });

    const result = await fetchVideos('ya29-token', ['vid0000000A'], { fetchImpl: impl });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The id arrives in a request body. Without this a hand-edited selection
    // naming somebody else's video would be extracted and published under this
    // creator's name.
    expect(result.videos[0].channelId).toBe('UCzzzzzzzzzzzzzzzzzzzzzz');
  });

  it('spends nothing on an id that is not one', async () => {
    const { impl, calls } = stubFetch({});
    const result = await fetchVideos('ya29-token', ['../../etc/passwd'], { fetchImpl: impl });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.videos).toEqual([]);
    expect(calls).toEqual([]);
  });
});

// ── Writing a description ────────────────────────────────────────────────────

describe('youtube — appending the Mealio link, once', () => {
  const MEAL_URL = 'https://mealio.co/meal/p/meal-1';

  it('adds the link to the end of the description', () => {
    const edit = withMealioLink('Ingredients:\n2 avocados', MEAL_URL);
    expect(edit.status).toBe('append');
    if (edit.status !== 'append') return;
    expect(edit.description).toBe(`Ingredients:\n2 avocados\n\n${MEALIO_LINK_INTRO}\n${MEAL_URL}`);
  });

  it('does nothing the second time, so appending twice adds one link', () => {
    const first = withMealioLink('Ingredients:\n2 avocados', MEAL_URL);
    expect(first.status).toBe('append');
    if (first.status !== 'append') return;

    // The description IS the record. No column says we appended before, and
    // none needs to: the write is a read-modify-write against YouTube anyway,
    // so the state that decides is the state the last write produced.
    expect(withMealioLink(first.description, MEAL_URL).status).toBe('already-present');
  });

  it('recognises the link wherever the creator moved it, matching the URL not our wording', () => {
    const rewritten = `Watch to the end!\n\nGet the shopping list: ${MEAL_URL}\n\nMy knives: example.test`;
    expect(withMealioLink(rewritten, MEAL_URL).status).toBe('already-present');
  });

  it('refuses rather than trimming a description to make room', () => {
    const edit = withMealioLink('x'.repeat(YOUTUBE_DESCRIPTION_MAX - 10), MEAL_URL);
    // Trimming somebody's description to fit our link is a second edit nobody
    // asked for, and it destroys content. The failing-safe direction is not to
    // write at all.
    expect(edit.status).toBe('too-long');
  });

  it('treats YouTube’s 5,000 characters as a length it may reach and not pass', () => {
    // Both sides of the boundary, and only the boundary. The refusal above sits
    // 137 characters clear of it, which exercises the branch and leaves the
    // comparison itself untested — `>` and `>=` are indistinguishable there, and
    // `>=` refuses a description that fits exactly.
    const block = `\n\n${MEALIO_LINK_INTRO}\n${MEAL_URL}`;
    const exactly = withMealioLink('x'.repeat(YOUTUBE_DESCRIPTION_MAX - block.length), MEAL_URL);
    expect(exactly.status).toBe('append');
    if (exactly.status !== 'append') return;
    expect(exactly.description).toHaveLength(YOUTUBE_DESCRIPTION_MAX);

    const oneOver = withMealioLink('x'.repeat(YOUTUBE_DESCRIPTION_MAX - block.length + 1), MEAL_URL);
    expect(oneOver.status).toBe('too-long');
  });

  it('counts the characters the link actually needs, separator and all', () => {
    // `block.length + 2` was assumed. A blank description gets no separator at
    // all, so the sentence quoted a number two higher than the truth.
    const edit = withMealioLink('x'.repeat(YOUTUBE_DESCRIPTION_MAX), MEAL_URL);
    expect(edit.status).toBe('too-long');
    if (edit.status !== 'too-long') return;
    expect(edit.detail).toContain(`needs ${`\n\n${MEALIO_LINK_INTRO}\n${MEAL_URL}`.length} more`);
  });

  it('sends the whole snippet back, because videos.update replaces the part', async () => {
    const bodies: string[] = [];
    const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(`${API}/videos?part=snippet`);
      expect(init?.method).toBe('PUT');
      bodies.push(String(init?.body));
      return new Response('{}', { headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;

    const snippet: VideoSnippet = {
      videoId: 'vid0000000A',
      channelId: CHANNEL_ID,
      title: 'Best Guacamole',
      description: 'Ingredients:\n2 avocados',
      categoryId: '26',
      tags: ['guacamole', 'avocado'],
      defaultLanguage: 'en',
      defaultAudioLanguage: 'en-US',
    };

    const next = `${snippet.description}\n\n${MEALIO_LINK_INTRO}\n${MEAL_URL}`;
    const result = await updateVideoDescription('ya29-token', snippet, next, { fetchImpl: impl });

    expect(result).toEqual({ ok: true, quotaUnits: YOUTUBE_QUOTA.videosUpdate });
    const sent = JSON.parse(bodies[0]);
    // `videos.update` replaces `snippet` rather than merging into it, so a write
    // that sends only the description blanks the creator's title and fails on
    // the missing category. Everything not being changed goes back untouched.
    expect(sent.snippet.title).toBe('Best Guacamole');
    expect(sent.snippet.categoryId).toBe('26');
    expect(sent.snippet.tags).toEqual(['guacamole', 'avocado']);
    expect(sent.snippet.description).toBe(next);
  });

  it('refuses a body that is not the description it read, rather than deleting the difference', async () => {
    const impl = vi.fn() as unknown as typeof fetch;
    const snippet: VideoSnippet = {
      videoId: 'vid0000000A',
      channelId: CHANNEL_ID,
      title: 'Best Guacamole',
      description: 'Ingredients:\n2 avocados\n\nMy knives: example.test',
      categoryId: '26',
      tags: null,
      defaultLanguage: null,
      defaultAudioLanguage: null,
    };

    // An append adds and never removes, and `videos.update` replaces the part —
    // so a body that is not a superset of the snapshot is a deletion off
    // somebody's video. Refused before the request, not after.
    const result = await updateVideoDescription('ya29-token', snippet, `Ingredients:\n2 avocados\n\n${MEAL_URL}`, {
      fetchImpl: impl,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toMatch(/does not begin with the one that was read/i);
    expect(impl).not.toHaveBeenCalled();
  });

  it('refuses to write when YouTube reported no category, rather than filing it under People & Blogs', async () => {
    const impl = vi.fn() as unknown as typeof fetch;
    const snippet: VideoSnippet = {
      videoId: 'vid0000000A',
      channelId: CHANNEL_ID,
      title: 'Best Guacamole',
      description: 'Ingredients:\n2 avocados',
      // What a `videos.list` that omitted `snippet.categoryId` leaves behind.
      categoryId: null,
      tags: null,
      defaultLanguage: null,
      defaultAudioLanguage: null,
    };

    const result = await updateVideoDescription('ya29-token', snippet, `${snippet.description}\n\n${MEAL_URL}`, {
      fetchImpl: impl,
    });

    // A read that came back without a category is not evidence the video has
    // none, and `categoryId` is required on the update — so defaulting it
    // re-files somebody's recipe video as People & Blogs on the strength of a
    // missing field. The same principle as refusing at 5,000 characters.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toMatch(/People & Blogs/);
    expect(impl).not.toHaveBeenCalled();
  });

  it('reports a write YouTube stored differently from the one it was sent', async () => {
    const snippet: VideoSnippet = {
      videoId: 'vid0000000A',
      channelId: CHANNEL_ID,
      title: 'Best Guacamole',
      description: 'Ingredients:\n2 avocados',
      categoryId: '26',
      tags: null,
      defaultLanguage: null,
      defaultAudioLanguage: null,
    };
    const next = `${snippet.description}\n\n${MEAL_URL}`;
    const impl = (async () =>
      new Response(JSON.stringify({ snippet: { description: 'something else entirely' } }), {
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;

    const result = await updateVideoDescription('ya29-token', snippet, next, { fetchImpl: impl });

    // The echoed resource is the only look anything here gets at YouTube's own
    // copy of the field, and a partial write is worth an operator knowing about
    // now rather than never.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toMatch(/not the one that was sent/i);
    expect(result.quotaUnits).toBe(YOUTUBE_QUOTA.videosUpdate);
  });

  it('refuses to write back a description that arrived at YouTube’s own maximum', async () => {
    const atTheLimit = 'x'.repeat(YOUTUBE_DESCRIPTION_MAX);
    const { impl } = stubFetch({
      [`${API}/videos?${new URLSearchParams({ part: 'snippet', id: 'vid0000000A' })}`]: jsonRoute({
        items: [{ id: 'vid0000000A', snippet: { title: 'x', description: atTheLimit, categoryId: '26', channelId: CHANNEL_ID } }],
      }),
    });

    const result = await fetchVideoSnippet('ya29-token', 'vid0000000A', { fetchImpl: impl });

    // The write PUTs this description back as the whole part, so a read that was
    // cut short destroys everything past the cut. Nothing here can prove a read
    // is whole — but a read arriving at exactly the documented ceiling is the one
    // length where a whole one and a truncated one are indistinguishable, and it
    // is refused rather than written.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toMatch(/cut short/i);
  });

  it('reads the snippet a write has to echo back', async () => {
    const { impl } = stubFetch({
      [`${API}/videos?${new URLSearchParams({ part: 'snippet', id: 'vid0000000A' })}`]: jsonRoute({
        items: [
          {
            id: 'vid0000000A',
            snippet: { title: 'Best Guacamole', description: DESCRIPTION, categoryId: '26', channelId: CHANNEL_ID },
          },
        ],
      }),
    });

    const result = await fetchVideoSnippet('ya29-token', 'vid0000000A', { fetchImpl: impl });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snippet.categoryId).toBe('26');
    expect(result.snippet.channelId).toBe(CHANNEL_ID);
    expect(result.snippet.description).toBe(DESCRIPTION);
  });
});

// ── The source document ──────────────────────────────────────────────────────

describe('youtube — description first, captions second', () => {
  it('uses the description alone when it is substantial, fetching no captions', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const long = `${DESCRIPTION}\n${'Serve with tortilla chips and a cold drink. '.repeat(8)}`;

    const document = await youtubeSourceDocument(video({ description: long }), {
      accessToken: 'ya29-token',
      fetchImpl,
    });

    // `captions.download` is the expensive call. Gating on title and description
    // first is what stops a vlog ever paying for one.
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(document.usedCaptions).toBe(false);
    expect(document.text).toContain('2 ripe avocados');
    expect(document.platform).toBe('youtube');
    expect(document.jsonLd).toBeNull();
  });

  it('falls back to captions when the description is too thin to judge', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.includes('/captions?')) {
        return new Response(
          JSON.stringify({
            items: [
              { id: 'asr-1', snippet: { trackKind: 'ASR', language: 'en' } },
              { id: 'real-1', snippet: { trackKind: 'standard', language: 'en' } },
            ],
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('1\n00:00:01,000 --> 00:00:03,000\nAdd two avocados.\n');
    }) as typeof fetch;

    const document = await youtubeSourceDocument(video({ description: 'Full recipe below!' }), {
      accessToken: 'ya29-token',
      fetchImpl,
      lookup: publicLookup,
    });

    expect(document.usedCaptions).toBe(true);
    // Uploaded captions beat auto-generated ones: ASR is materially worse on
    // ingredient names, which is the one thing a recipe cannot get wrong.
    expect(calls[1]).toContain('/captions/real-1');
    // The thin description is kept, not replaced — it often carries the yield or
    // a "full recipe below" line, and both halves are evidence.
    expect(document.text).toContain('Full recipe below!');
    expect(document.text).toContain('Add two avocados.');
  });

  it('does not reach for captions without a grant', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const document = await youtubeSourceDocument(video({ description: 'short' }), { accessToken: null, fetchImpl });

    // Description-only is the free tier of this feature, not a failure.
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(document.text).toBe('short');
  });

  it('keeps the import when the caption download fails', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 403 })) as typeof fetch;
    const document = await youtubeSourceDocument(video({ description: 'short' }), {
      accessToken: 'ya29-token',
      fetchImpl,
      lookup: publicLookup,
    });
    expect(document.usedCaptions).toBe(false);
    expect(document.text).toBe('short');
  });

  /** A caption list naming one uploaded English track, then `body` for the download. */
  function captionFetch(body: string | (() => Response)) {
    return (async (input: RequestInfo | URL) => {
      if (String(input).includes('/captions?')) {
        return new Response(JSON.stringify({ items: [{ id: 'real-1', snippet: { trackKind: 'standard', language: 'en' } }] }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      return typeof body === 'string' ? new Response(body, { headers: { 'content-type': 'text/plain' } }) : body();
    }) as unknown as typeof fetch;
  }

  it('trims a long transcript to the same ceiling the fetched path enforces', async () => {
    const srt = `1\n00:00:01,000 --> 00:00:03,000\n${'Add two ripe avocados and a squeeze of lime. '.repeat(2_000)}\n`;
    expect(srt.length).toBeLessThan(MAX_CAPTION_BYTES);

    const document = await youtubeSourceDocument(video({ description: 'Full recipe below!' }), {
      accessToken: 'ya29-token',
      fetchImpl: captionFetch(srt),
      lookup: publicLookup,
    });

    expect(document.usedCaptions).toBe(true);
    // `document.text` is interpolated into the extraction prompt verbatim.
    // Skipping `toSourceDocument`'s cap because we skipped the fetch put the one
    // path carrying a whole transcript outside the only limit there was.
    expect(document.text.length).toBeLessThanOrEqual(MAX_TEXT_CHARS + 1);
    expect(document.recipeText.length).toBeLessThanOrEqual(MAX_TEXT_CHARS + 1);
  });

  it('refuses a caption track that never ends rather than buffering it', async () => {
    const { stream, chunksProduced } = endlessBody(256 * 1024, 40);

    const document = await youtubeSourceDocument(video({ description: 'Full recipe below!' }), {
      accessToken: 'ya29-token',
      fetchImpl: captionFetch(() => new Response(stream, { headers: { 'content-type': 'text/plain' } })),
      lookup: publicLookup,
    });

    // A measured 4 MB track produced a 4 MB extraction prompt, per video,
    // concurrently across a 40-video sync. Counted while streaming, so the
    // whole body is never held, and the import degrades to the description.
    expect(chunksProduced()).toBeLessThan(10);
    expect(document.usedCaptions).toBe(false);
    expect(document.text).toBe('Full recipe below!');
  });

  it('sends the owner’s token with the download and takes it no further', async () => {
    const seen: Array<{ url: string; authorization: string | undefined }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      seen.push({ url: String(input), authorization: headers.authorization });
      if (String(input).includes('/captions?')) {
        return new Response(JSON.stringify({ items: [{ id: 'real-1', snippet: { trackKind: 'standard', language: 'en' } }] }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('1\n00:00:01,000 --> 00:00:03,000\nAdd two avocados.\n', {
        headers: { 'content-type': 'text/plain' },
      });
    }) as unknown as typeof fetch;

    const document = await youtubeSourceDocument(video({ description: 'Full recipe below!' }), {
      accessToken: 'ya29-token',
      fetchImpl,
      lookup: publicLookup,
    });

    // Captions are owner-only, so the guarded fetcher has to be able to carry
    // the grant — that is the whole reason this ticket exists.
    expect(document.text).toContain('Add two avocados.');
    expect(seen[1].url).toContain('/captions/real-1');
    expect(seen[1].authorization).toBe('Bearer ya29-token');
  });

  it('strips SRT sequence numbers and timecodes', () => {
    const srt = '1\n00:00:01,000 --> 00:00:03,000\nAdd two avocados.\n\n2\n00:00:03,000 --> 00:00:05,000\nThen the lime.\n';
    expect(srtToText(srt)).toBe('Add two avocados.\nThen the lime.');
  });
});

// ── The append consent flag ──────────────────────────────────────────────────

describe('youtube — youtube_append_opt_in is enforced server-side', () => {
  const GRANT = {
    id: 'pa1',
    creator_id: 'c1',
    platform: 'youtube',
    external_id: CHANNEL_ID,
    external_name: 'Chef Sarah',
    access_token: 'ya29-token',
    refresh_token: '1//refresh',
    scopes: `https://www.googleapis.com/auth/youtube.readonly ${YOUTUBE_WRITE_SCOPE}`,
    expires_at: '2099-01-01T00:00:00.000Z',
    broken_reason: null,
    broken_at: null,
  };

  it('refuses when the flag is false, whatever else is in place', async () => {
    fakeDb.queue('creators', { data: { id: 'c1', youtube_append_opt_in: false } });
    fakeDb.queue('creator_platform_accounts', { data: GRANT });

    const result = await assertAppendAllowed(supabase, 'c1');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(403);
    expect(result.error).toMatch(/separate permissions/i);
  });

  it('refuses on anything that is not a literal true', async () => {
    // A null from an older row, or a string from a careless write, is not consent.
    for (const value of [null, undefined, 'true', 1]) {
      fakeDb.reset();
      fakeDb.queue('creators', { data: { id: 'c1', youtube_append_opt_in: value } });
      fakeDb.queue('creator_platform_accounts', { data: GRANT });
      expect((await assertAppendAllowed(supabase, 'c1')).ok).toBe(false);
    }
  });

  it('refuses when the creator has no connected channel', async () => {
    fakeDb.queue('creators', { data: { id: 'c1', youtube_append_opt_in: true } });
    const result = await assertAppendAllowed(supabase, 'c1');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/no connected YouTube channel/i);
  });

  it('refuses a broken connection', async () => {
    fakeDb.queue('creators', { data: { id: 'c1', youtube_append_opt_in: true } });
    fakeDb.queue('creator_platform_accounts', {
      data: { ...GRANT, broken_reason: 'Google refused to refresh this grant', broken_at: '2026-08-01T00:00:00Z' },
    });
    const result = await assertAppendAllowed(supabase, 'c1');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/stopped working/i);
  });

  it('refuses a grant made without the write scope', async () => {
    fakeDb.queue('creators', { data: { id: 'c1', youtube_append_opt_in: true } });
    fakeDb.queue('creator_platform_accounts', {
      data: { ...GRANT, scopes: 'https://www.googleapis.com/auth/youtube.readonly' },
    });
    const result = await assertAppendAllowed(supabase, 'c1');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/reconnect/i);
  });

  it('refuses a connection carrying no channel id, which is the anchor the write hangs from', async () => {
    // `appendMealioLink` compares the video's own `channelId` against this one
    // before writing, so without it there is nothing to compare against and the
    // ownership check has no anchor. Consent, a live grant and the write scope
    // all hold here; the missing id alone has to be enough to stop it.
    for (const externalId of [null, '', 'sarahcooks', 'UCtooshort']) {
      fakeDb.reset();
      fakeDb.queue('creators', { data: { id: 'c1', youtube_append_opt_in: true } });
      fakeDb.queue('creator_platform_accounts', { data: { ...GRANT, external_id: externalId } });

      const result = await assertAppendAllowed(supabase, 'c1');

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.status).toBe(409);
      expect(result.error).toMatch(/no channel id/i);
    }
  });

  it('allows it only when consent, connection, scope and channel id all hold', async () => {
    fakeDb.queue('creators', { data: { id: 'c1', youtube_append_opt_in: true } });
    fakeDb.queue('creator_platform_accounts', { data: GRANT });

    const result = await assertAppendAllowed(supabase, 'c1');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.channelId).toBe(CHANNEL_ID);
  });
});

// ── The channel a creator may be listed under ────────────────────────────────

describe('youtube — the channel to list comes from the grant and nowhere else', () => {
  const connection = (externalId: string | null) => ({
    id: 'pa1',
    creatorId: 'c1',
    platform: 'youtube' as const,
    externalId,
    externalName: 'Chef Sarah',
    accessToken: 'ya29-token',
    refreshToken: '1//refresh',
    scopes: [YOUTUBE_WRITE_SCOPE],
    expiresAt: '2099-01-01T00:00:00.000Z',
    brokenReason: null,
    brokenAt: null,
    updatedAt: null,
  });

  it('takes it off the grant', () => {
    expect(channelIdForCreator(connection(CHANNEL_ID))).toEqual({ ok: true, channelId: CHANNEL_ID });
  });

  it('refuses a grant carrying no channel id rather than deriving one from a link', () => {
    // The read path's ownership filter compares each video against whatever this
    // returns, so a value derived from `creators.youtube_url` would only ever be
    // checked against itself: a legacy row plus a link naming a stranger listed
    // the stranger's uploads and passed every one of their videos. Refused, the
    // same way the write path refuses it.
    for (const externalId of [null, 'sarahcooks', 'UCtooshort']) {
      const result = channelIdForCreator(connection(externalId));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.detail).toMatch(/no channel id/i);
      expect(result.detail).toMatch(/reconnect/i);
    }
  });

  it('refuses when there is no connection at all', () => {
    expect(channelIdForCreator(null).ok).toBe(false);
  });
});
