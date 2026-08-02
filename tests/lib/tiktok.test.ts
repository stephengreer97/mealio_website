import { describe, it, expect, beforeEach } from 'vitest';

import {
  exchangeTikTokCode,
  fetchTikTokVideos,
  hasRecipeText,
  tiktokAuthUrl,
  tiktokSourceDocument,
  tiktokVideoTitle,
  TIKTOK_PAGE_SIZE,
  TIKTOK_VIDEO_LIST_SCOPE,
  type TikTokVideo,
} from '@/lib/tiktok';

/**
 * Reading a creator's TikTok account (MEAL-83).
 *
 * Untestable against the real API until Display API approval clears, so these
 * are written against the documented shapes and against the registered app
 * settings recorded on the ticket. What they defend is the set of things a wrong
 * guess breaks silently: `client_key` rather than `client_id`, one scope, an
 * error envelope that arrives with HTTP 200, a rotating refresh token, and
 * `create_time` in seconds rather than milliseconds.
 */

const DESCRIPTION = 'Guacamole\n2 ripe avocados\n1 lime, juiced';

function video(overrides: Partial<TikTokVideo> = {}): TikTokVideo {
  return {
    id: '7245678901234567890',
    title: 'Best Guacamole',
    description: DESCRIPTION,
    shareUrl: 'https://www.tiktok.com/@chefsarah/video/7245678901234567890',
    embedLink: 'https://www.tiktok.com/embed/v2/7245678901234567890',
    coverImageUrl: 'https://p16.tiktokcdn.com/cover.jpeg',
    publishedAt: '2026-07-29T09:00:00.000Z',
    durationSeconds: 42,
    ...overrides,
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Records every call, and answers with whatever the handler returns. */
function recording(handler: (url: string, init?: RequestInit) => Response) {
  const calls: Array<{ url: string; body: unknown }> = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    let body: unknown;
    try {
      body = init?.body ? JSON.parse(String(init.body)) : undefined;
    } catch {
      body = String(init?.body ?? '');
    }
    calls.push({ url, body });
    return handler(url, init);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

/** The video-list row shape, as the Display API documents it. */
function videoRow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    title: 'Best Guacamole',
    video_description: DESCRIPTION,
    duration: 42,
    cover_image_url: 'https://p16.tiktokcdn.com/cover.jpeg',
    embed_link: `https://www.tiktok.com/embed/v2/${id}`,
    share_url: `https://www.tiktok.com/@chefsarah/video/${id}`,
    create_time: 1_785_060_000,
    ...overrides,
  };
}

beforeEach(() => {
  process.env.TIKTOK_CLIENT_KEY = 'tiktok-client-key';
  process.env.TIKTOK_CLIENT_SECRET = 'tiktok-client-secret';
  process.env.NEXT_PUBLIC_APP_URL = 'https://mealio.co';
});

// ── The consent screen ───────────────────────────────────────────────────────

describe('tiktok — the consent screen matches the registered app', () => {
  it('sends client_key, not client_id, and asks only for video.list', () => {
    const url = new URL(tiktokAuthUrl('nonce-1')!);

    // `client_id` renders an authorization page that then fails, which reads as
    // a bug in our redirect rather than in the parameter name.
    expect(url.searchParams.get('client_key')).toBe('tiktok-client-key');
    expect(url.searchParams.get('client_id')).toBeNull();
    // `user.info.basic` would buy a nicer display name and nothing else, which
    // is not a use TikTok's review accepts for a permission.
    expect(url.searchParams.get('scope')).toBe(TIKTOK_VIDEO_LIST_SCOPE);
  });

  it('uses the exact redirect URI registered on the app', () => {
    const url = new URL(tiktokAuthUrl('nonce-1')!);

    // TikTok accepts no wildcards and no localhost, so a preview deployment
    // cannot complete this flow and neither can local dev.
    expect(`${url.origin}${url.pathname}`).toBe('https://www.tiktok.com/v2/auth/authorize/');
    expect(url.searchParams.get('redirect_uri')).toBe('https://mealio.co/api/creator/tiktok/callback');
    expect(url.searchParams.get('state')).toBe('nonce-1');
  });

  it('returns null rather than a broken URL when the app is not configured', () => {
    delete process.env.TIKTOK_CLIENT_KEY;
    expect(tiktokAuthUrl('nonce-1')).toBeNull();
  });
});

// ── The grant ────────────────────────────────────────────────────────────────

describe('tiktok — the code exchange', () => {
  it('returns the open id, the refresh token and an absolute expiry', async () => {
    const { impl } = recording(() =>
      json({
        access_token: 'act.tiktok',
        expires_in: 86_400,
        open_id: 'open-id-1',
        refresh_expires_in: 31_536_000,
        refresh_token: 'rft.super-secret',
        scope: 'video.list',
        token_type: 'Bearer',
      }),
    );

    const result = await exchangeTikTokCode('the-code', { fetchImpl: impl, now: () => 1_800_000_000_000 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // `open_id` arrives here and nowhere else — without `user.info.basic` there
    // is no profile endpoint to ask.
    expect(result.grant.openId).toBe('open-id-1');
    expect(result.grant.refreshToken).toBe('rft.super-secret');
    expect(result.grant.scopes).toEqual(['video.list']);
    expect(result.grant.expiresAt).toBe(new Date(1_800_000_000_000 + 86_400_000).toISOString());
  });

  it('reports TikTok’s own words on a refusal', async () => {
    const { impl } = recording(() =>
      json({ error: 'invalid_grant', error_description: 'Authorization code is invalid or expired.', log_id: 'x' }, 400),
    );

    const result = await exchangeTikTokCode('the-code', { fetchImpl: impl });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toMatch(/invalid or expired/i);
  });
});

// ── Videos ───────────────────────────────────────────────────────────────────

describe('tiktok — listing videos', () => {
  it('posts the cursor in the body and the fields in the query string', async () => {
    const { impl, calls } = recording(() =>
      json({ data: { videos: [videoRow('7245678901234567890')], cursor: 1_785_060_000_000, has_more: false }, error: { code: 'ok' } }),
    );

    const result = await fetchTikTokVideos('act.tiktok', { fetchImpl: impl, limit: 10 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(calls[0].url).toContain('fields=');
    expect(calls[0].url).toContain('video_description');
    expect(calls[0].body).toEqual({ max_count: 10 });
    expect(result.videos[0].description).toContain('2 ripe avocados');
    expect(result.videos[0].shareUrl).toBe('https://www.tiktok.com/@chefsarah/video/7245678901234567890');
  });

  it('reads create_time as seconds, not milliseconds', async () => {
    const { impl } = recording(() => json({ data: { videos: [videoRow('v1')], has_more: false }, error: { code: 'ok' } }));

    const result = await fetchTikTokVideos('act.tiktok', { fetchImpl: impl });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Read as milliseconds this lands in January 1970, which sorts a catalog
    // wrongly without ever looking like an error.
    expect(result.videos[0].publishedAt).toBe(new Date(1_785_060_000 * 1000).toISOString());
  });

  it('treats an error envelope on an HTTP 200 as a failure', async () => {
    const { impl } = recording(() =>
      json({ data: {}, error: { code: 'access_token_invalid', message: 'The access token is invalid or not found.' } }),
    );

    const result = await fetchTikTokVideos('act.tiktok', { fetchImpl: impl });

    // Checking `response.ok` alone reads a revoked token as an account with no
    // videos, which is the one confusion this whole feature is built to avoid.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toMatch(/invalid or not found/i);
  });

  it('pages while has_more is set and stops at the item budget', async () => {
    let page = 0;
    const { impl, calls } = recording(() => {
      page++;
      return json({
        data: {
          videos: [videoRow(`v${page}a`), videoRow(`v${page}b`)],
          cursor: 1_785_060_000_000 - page,
          has_more: true,
        },
        error: { code: 'ok' },
      });
    });

    const result = await fetchTikTokVideos('act.tiktok', { fetchImpl: impl, limit: 4 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.videos).toHaveLength(4);
    expect(result.truncated).toBe(true);
    expect((calls[1].body as Record<string, unknown>).cursor).toBe(1_785_060_000_000 - 1);
  });

  it('never asks for more than TikTok’s own page size', async () => {
    const { impl, calls } = recording(() => json({ data: { videos: [videoRow('v1')], has_more: false }, error: { code: 'ok' } }));

    await fetchTikTokVideos('act.tiktok', { fetchImpl: impl, limit: 100 });

    expect((calls[0].body as Record<string, unknown>).max_count).toBe(TIKTOK_PAGE_SIZE);
  });

  it('stops rather than looping when has_more is set but the cursor is not', async () => {
    const { impl, calls } = recording(() =>
      json({ data: { videos: [videoRow('v1')], has_more: true }, error: { code: 'ok' } }),
    );

    await fetchTikTokVideos('act.tiktok', { fetchImpl: impl, limit: 100 });

    expect(calls).toHaveLength(1);
  });
});

// ── The source document ──────────────────────────────────────────────────────

describe('tiktok — the description is the whole document', () => {
  it('keeps the title and the description together when they differ', () => {
    const document = tiktokSourceDocument(video());

    expect(document.platform).toBe('tiktok');
    // A creator who puts the dish name in the title and the ingredients in the
    // description has written one recipe across two fields.
    expect(document.text).toContain('Best Guacamole');
    expect(document.text).toContain('2 ripe avocados');
    expect(document.url).toBe('https://www.tiktok.com/@chefsarah/video/7245678901234567890');
    // The cover image is TikTok's property, not a photo to help ourselves to.
    expect(document.imageUrl).toBeNull();
  });

  it('does not repeat a title that is just the description again', () => {
    const document = tiktokSourceDocument(video({ title: DESCRIPTION }));
    expect(document.text).toBe(DESCRIPTION);
  });

  it('titles a video by its description when the title is empty', () => {
    expect(tiktokVideoTitle(video({ title: '' }))).toBe('Guacamole');
    expect(tiktokVideoTitle(video({ title: '', description: '' }))).toContain('tiktok.com');
  });

  it('distinguishes an empty video from a short one', () => {
    expect(hasRecipeText(video({ title: '', description: '  ' }))).toBe(false);
    expect(hasRecipeText(video({ title: '', description: 'recipe on my blog' }))).toBe(true);
  });
});
