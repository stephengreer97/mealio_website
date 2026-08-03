import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { fakeDb } from '../helpers/supabase-mock';
import { endlessBody, publicLookup, stubFetch } from '../helpers/import-stubs';

vi.mock('@/lib/logger', () => ({ log: vi.fn() }));

import { MAX_TEXT_CHARS } from '@/lib/import/html';

import {
  assertAppendAllowed,
  channelIdFromUrl,
  videoIdFromUrl,
  exchangeYouTubeCode,
  fetchOwnChannel,
  parseUploadsFeed,
  readUploadsFeed,
  resolveChannelId,
  srtToText,
  uploadsFeedUrl,
  MAX_CAPTION_BYTES,
  youtubeAuthUrl,
  youtubeSourceDocument,
  YOUTUBE_WRITE_SCOPE,
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

function feedXml(overrides: { id?: string; description?: string; title?: string } = {}): string {
  const id = overrides.id ?? 'vid0000000A';
  return (
    `<feed xmlns:yt="y" xmlns:media="m">` +
    `<entry><id>yt:video:${id}</id><yt:videoId>${id}</yt:videoId>` +
    `<title>${overrides.title ?? 'Best Guacamole'}</title>` +
    `<link rel="alternate" href="https://www.youtube.com/watch?v=${id}"/>` +
    `<published>2026-07-29T09:00:00+00:00</published>` +
    `<media:group><media:thumbnail url="https://i.ytimg.com/vi/${id}/hqdefault.jpg" width="480"/>` +
    `<media:description>${overrides.description ?? DESCRIPTION}</media:description></media:group>` +
    `</entry></feed>`
  );
}

function video(overrides: Partial<YouTubeVideo> = {}): YouTubeVideo {
  return {
    videoId: 'vid0000000A',
    url: 'https://www.youtube.com/watch?v=vid0000000A',
    title: 'Best Guacamole',
    description: DESCRIPTION,
    publishedAt: '2026-07-29T09:00:00.000Z',
    thumbnailUrl: null,
    ...overrides,
  };
}

beforeEach(() => {
  fakeDb.reset();
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
  it('reads a /channel/ link without any request at all', async () => {
    expect(channelIdFromUrl(`https://youtube.com/channel/${CHANNEL_ID}`)).toBe(CHANNEL_ID);
    expect(channelIdFromUrl('https://youtube.com/@sarah')).toBeNull();
    // Shape-checked, so a path segment that is not a channel id never becomes one.
    expect(channelIdFromUrl('https://youtube.com/channel/../../etc')).toBeNull();
  });

  it('reads the video id out of every shape of a video link', () => {
    // `item_id` for YouTube is the bare id everywhere a sync writes one, so a
    // caller holding a URL has to arrive at the same string — a record under a
    // URL and a record under an id are two records for one video.
    for (const link of [
      'https://youtube.com/watch?v=dQw4w9WgXcQ',
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s',
      'https://youtu.be/dQw4w9WgXcQ',
      'https://youtube.com/shorts/dQw4w9WgXcQ',
      'https://youtube.com/embed/dQw4w9WgXcQ',
      'https://m.youtube.com/live/dQw4w9WgXcQ',
    ]) {
      expect(videoIdFromUrl(link), link).toBe('dQw4w9WgXcQ');
    }
  });

  it('names no video for a link that names no video', () => {
    expect(videoIdFromUrl('https://youtube.com/@sarah')).toBeNull();
    expect(videoIdFromUrl('https://youtube.com/playlist?list=PL123')).toBeNull();
    // Not YouTube at all, and not a URL at all.
    expect(videoIdFromUrl('https://chefsarah.test/watch?v=dQw4w9WgXcQ')).toBeNull();
    expect(videoIdFromUrl('chefsarah')).toBeNull();
  });

  it('reads it off the channel page for an @handle', async () => {
    const { impl, calls } = stubFetch({
      'https://youtube.com/@sarah': {
        body: `<html><link rel="canonical" href="https://www.youtube.com/channel/${CHANNEL_ID}"></html>`,
      },
    });

    const result = await resolveChannelId('https://youtube.com/@sarah', { fetchImpl: impl, lookup: publicLookup });

    expect(result).toEqual({ ok: true, channelId: CHANNEL_ID });
    // A page nobody invited us to read, so robots.txt is consulted first — the
    // same treatment every other page fetch in this codebase gets.
    expect(calls).toEqual(['https://youtube.com/robots.txt', 'https://youtube.com/@sarah']);
  });

  it('refuses rather than guessing when the page names no channel', async () => {
    const { impl } = stubFetch({ 'https://youtube.com/@sarah': { body: '<html>nothing here</html>' } });
    const result = await resolveChannelId('https://youtube.com/@sarah', { fetchImpl: impl, lookup: publicLookup });
    expect(result.ok).toBe(false);
  });

  it('reads a channel id only off youtube.com, and fetches nothing else', async () => {
    const { impl, calls } = stubFetch({
      'https://sarahcooks.example/links': { body: `<html>{"channelId":"${CHANNEL_ID}"}</html>` },
    });

    const result = await resolveChannelId('https://sarahcooks.example/links', { fetchImpl: impl, lookup: publicLookup });

    // `creators.youtube_url` is a link a creator typed. Without a host check,
    // one pointing at a page they control can name somebody else's channel and
    // the catalog lists that person's videos under their name.
    expect(result.ok).toBe(false);
    expect(calls).toEqual([]);
  });
});

// ── The uploads feed ─────────────────────────────────────────────────────────

describe('youtube — the uploads feed is the free list', () => {
  it('keeps the description’s line breaks, which is where the ingredients are', () => {
    const [parsed] = parseUploadsFeed(feedXml());

    // `feed.ts` collapses all whitespace, which would turn an ingredient list
    // into "2 ripe avocados 1 lime, juiced" — one line, no list.
    expect(parsed.description).toBe(DESCRIPTION);
    expect(parsed.description.split('\n')).toContain('2 ripe avocados');
  });

  it('takes the bare video id, not the yt:video: form', () => {
    const [parsed] = parseUploadsFeed(feedXml());
    expect(parsed.videoId).toBe('vid0000000A');
    expect(parsed.url).toBe('https://www.youtube.com/watch?v=vid0000000A');
    expect(parsed.title).toBe('Best Guacamole');
    expect(parsed.publishedAt).toBe('2026-07-29T09:00:00.000Z');
    expect(parsed.thumbnailUrl).toBe('https://i.ytimg.com/vi/vid0000000A/hqdefault.jpg');
  });

  it('decodes entities in the description, so &amp; is not read as markup', () => {
    const [parsed] = parseUploadsFeed(feedXml({ description: '2 avocados &amp; 1 lime' }));
    expect(parsed.description).toBe('2 avocados & 1 lime');
  });

  it('survives a truncated document instead of parsing garbage', () => {
    expect(parseUploadsFeed('<feed><entry><yt:videoId>vid0000000A')).toEqual([]);
    expect(parseUploadsFeed('')).toEqual([]);
  });

  it('fetches one URL and accepts the text/xml the feed is served as', async () => {
    const { impl, calls } = stubFetch({
      [uploadsFeedUrl(CHANNEL_ID)]: { body: feedXml(), headers: { 'content-type': 'text/xml; charset=UTF-8' } },
    });

    const result = await readUploadsFeed(CHANNEL_ID, { fetchImpl: impl, lookup: publicLookup });

    expect(result.ok).toBe(true);
    expect(calls).toEqual([uploadsFeedUrl(CHANNEL_ID)]);
  });

  it('refuses a channel id that is not one, before any request', async () => {
    const { impl, calls } = stubFetch({});
    const result = await readUploadsFeed('../../etc/passwd', { fetchImpl: impl, lookup: publicLookup });
    expect(result.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it('keeps its own content-type allowlist whatever a caller passes', async () => {
    const { impl } = stubFetch({
      [uploadsFeedUrl(CHANNEL_ID)]: { body: '<html>not a feed</html>', headers: { 'content-type': 'text/html' } },
    });

    const result = await readUploadsFeed(CHANNEL_ID, {
      fetchImpl: impl,
      lookup: publicLookup,
      accept: /text\/html/i,
      expected: 'whatever the caller felt like',
    });

    // `...fetchOptions` used to be spread *after* `accept`, so a caller-supplied
    // option silently switched off the XML check this call is written around —
    // and a page of HTML was handed to the feed parser as if it were a feed.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toMatch(/Expected a YouTube uploads feed/i);
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

  it('allows it only when consent, connection, scope and channel id all hold', async () => {
    fakeDb.queue('creators', { data: { id: 'c1', youtube_append_opt_in: true } });
    fakeDb.queue('creator_platform_accounts', { data: GRANT });

    const result = await assertAppendAllowed(supabase, 'c1');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.channelId).toBe(CHANNEL_ID);
  });
});
