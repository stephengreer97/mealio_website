import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SignJWT } from 'jose';
import { fakeDb } from '../helpers/supabase-mock';
import { jsonRequest } from '../helpers/request';

vi.mock('@/lib/supabase', async () =>
  (await import('../helpers/supabase-mock')).mockSupabaseModule());
const log = vi.fn();
vi.mock('@/lib/logger', () => ({ log: (...args: unknown[]) => log(...args), abbreviateUa: () => undefined }));

const exchangeInstagramCode = vi.fn();
const fetchInstagramAccount = vi.fn();
vi.mock('@/lib/instagram', async () => {
  const actual = await vi.importActual<typeof import('@/lib/instagram')>('@/lib/instagram');
  return {
    ...actual,
    exchangeInstagramCode: (...args: unknown[]) => exchangeInstagramCode(...args),
    fetchInstagramAccount: (...args: unknown[]) => fetchInstagramAccount(...args),
  };
});

const exchangeTikTokCode = vi.fn();
vi.mock('@/lib/tiktok', async () => {
  const actual = await vi.importActual<typeof import('@/lib/tiktok')>('@/lib/tiktok');
  return { ...actual, exchangeTikTokCode: (...args: unknown[]) => exchangeTikTokCode(...args) };
});

import { POST as IG_CONNECT } from '@/app/api/creator/instagram/connect/route';
import { GET as IG_CALLBACK } from '@/app/api/creator/instagram/callback/route';
import { GET as IG_STATUS, DELETE as IG_DISCONNECT } from '@/app/api/creator/instagram/route';
import { POST as TT_CONNECT } from '@/app/api/creator/tiktok/connect/route';
import { GET as TT_CALLBACK } from '@/app/api/creator/tiktok/callback/route';
import { GET as TT_STATUS, DELETE as TT_DISCONNECT } from '@/app/api/creator/tiktok/route';
import { stateCookieName, STATE_TTL_SECONDS } from '@/lib/creator-connect';
import { clearRevocationCache, createAccessToken } from '@/lib/tokens';
import { INSTAGRAM_BASIC_SCOPE } from '@/lib/instagram';
import { TIKTOK_VIDEO_LIST_SCOPE } from '@/lib/tiktok';

/**
 * Connecting an Instagram or TikTok account (MEAL-82 / MEAL-83).
 *
 * Neither flow can be run against a live API until app review clears, so what is
 * tested here is everything that does not need one — and that turns out to be
 * all of the security. **Who** is connecting comes from a signed httpOnly cookie
 * and never from the query string, a mismatched nonce or a forged cookie is
 * refused *before* the code is exchanged, and no token reaches a log line or a
 * response.
 *
 * `tests/helpers/supabase-mock.ts` pops queued results FIFO per table and
 * ignores `.eq()`, so the assertions on writes below are about the columns and
 * values sent, not about which rows a filter would have matched.
 */

const JWT_SECRET = () => new TextEncoder().encode(process.env.JWT_SECRET || '');

/** Queues the `user_profiles` read `verifyAccessToken` makes (memoised for 30s). */
function asUser() {
  clearRevocationCache();
  fakeDb.queue('user_profiles', { data: { tokens_invalidated_at: null } });
}

/** A state cookie as `/connect` would have set it. */
async function stateCookie(platform: 'instagram' | 'tiktok', payload: Record<string, unknown> = {}) {
  return new SignJWT({ sub: 'u1', creatorId: 'c1', nonce: 'nonce-1', type: `${platform}_connect`, ...payload })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('15m')
    .sign(JWT_SECRET());
}

function callbackRequest(platform: 'instagram' | 'tiktok', params: Record<string, string>, cookie?: string) {
  const query = new URLSearchParams(params).toString();
  return jsonRequest(`/api/creator/${platform}/callback?${query}`, {
    method: 'GET',
    ...(cookie ? { cookies: { [stateCookieName(platform)]: cookie } } : {}),
  });
}

/**
 * The claims inside a state cookie.
 *
 * Read rather than substring-matched against the URL: a 32-character hex nonce
 * contains any given two-character id about one run in nine, so "the state does
 * not contain the creator id" is a coin flip dressed up as an assertion.
 */
function claims(cookie: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(cookie.split('.')[1], 'base64url').toString());
}

/** Every column value any call carried — for "did a token leak?" checks. */
function everythingWritten(): string {
  return JSON.stringify({ calls: fakeDb.calls, logs: log.mock.calls });
}

const IG_GRANT = {
  ok: true,
  grant: { accessToken: 'IGQ-long-lived', scopes: [INSTAGRAM_BASIC_SCOPE], expiresAt: '2026-10-01T00:00:00.000Z' },
};
const TT_GRANT = {
  ok: true,
  grant: {
    accessToken: 'act.tiktok',
    refreshToken: 'rft.super-secret',
    openId: 'open-id-1',
    scopes: [TIKTOK_VIDEO_LIST_SCOPE],
    expiresAt: '2026-08-03T18:00:00.000Z',
  },
};

let token: string;

beforeEach(async () => {
  fakeDb.reset();
  log.mockReset();
  exchangeInstagramCode.mockReset();
  fetchInstagramAccount.mockReset();
  exchangeTikTokCode.mockReset();
  process.env.INSTAGRAM_APP_ID = 'ig-app-id';
  process.env.INSTAGRAM_APP_SECRET = 'ig-app-secret';
  process.env.TIKTOK_CLIENT_KEY = 'tiktok-client-key';
  process.env.TIKTOK_CLIENT_SECRET = 'tiktok-client-secret';
  process.env.NEXT_PUBLIC_APP_URL = 'https://mealio.co';
  token = await createAccessToken('u1', 'sarah@chefsarah.test');
});

// ── Starting the round trip ──────────────────────────────────────────────────

describe('POST /api/creator/{instagram,tiktok}/connect', () => {
  it.each([
    ['instagram', IG_CONNECT] as const,
    ['tiktok', TT_CONNECT] as const,
  ])('%s: 401 without a token, 403 for someone who is not a creator', async (platform, handler) => {
    expect((await handler(jsonRequest(`/api/creator/${platform}/connect`, { body: {} }))).status).toBe(401);

    asUser();
    fakeDb.queue('creators', { data: null });
    const res = await handler(jsonRequest(`/api/creator/${platform}/connect`, { token, body: {} }));
    expect(res.status).toBe(403);
  });

  it.each([
    ['instagram', IG_CONNECT] as const,
    ['tiktok', TT_CONNECT] as const,
  ])('%s: binds the attempt to an httpOnly cookie, and puts only a nonce in the query string', async (platform, handler) => {
    asUser();
    fakeDb.queue('creators', { data: { id: 'c1' } });

    const res = await handler(jsonRequest(`/api/creator/${platform}/connect`, { token, body: {} }));
    const cookie = res.cookies.get(stateCookieName(platform));
    const url = new URL((await res.json()).url);

    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.value.split('.')).toHaveLength(3);
    // Identity that round-trips through a third party and comes back in a query
    // string is identity anyone can supply. So the state is an opaque nonce, and
    // who is connecting lives in the signed cookie the platform never sees.
    expect(url.searchParams.get('state')).toMatch(/^[0-9a-f]{32}$/);
    expect(claims(cookie!.value)).toMatchObject({ sub: 'u1', creatorId: 'c1', type: `${platform}_connect` });
  });

  it.each([
    ['instagram', IG_CONNECT] as const,
    ['tiktok', TT_CONNECT] as const,
  ])('%s: sets every flag the cookie needs, not only httpOnly', async (platform, handler) => {
    // `httpOnly` was the only flag anything asserted, and it is the least
    // interesting of the four. `sameSite: 'lax'` is *required* here rather than
    // merely advisable — the callback is a top-level cross-site GET, and
    // `strict` would drop the cookie on the one request that needs it. `maxAge`
    // matching the JWT's own `exp` is what stops a cookie outliving the claim
    // inside it, and host-only (no `domain`) keeps it off every subdomain.
    // `NODE_ENV` is typed read-only, so it is set the way the runtime actually
    // sees it rather than by assignment.
    vi.stubEnv('NODE_ENV', 'production');
    asUser();
    fakeDb.queue('creators', { data: { id: 'c1' } });

    try {
      const res = await handler(jsonRequest(`/api/creator/${platform}/connect`, { token, body: {} }));
      const cookie = res.cookies.get(stateCookieName(platform));

      expect(cookie).toMatchObject({
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        maxAge: STATE_TTL_SECONDS,
        path: '/',
      });
      expect(cookie?.domain).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('gives each platform its own cookie, so two tabs cannot cross', async () => {
    asUser();
    fakeDb.queue('creators', { data: { id: 'c1' } });
    const ig = await IG_CONNECT(jsonRequest('/api/creator/instagram/connect', { token, body: {} }));

    asUser();
    fakeDb.queue('creators', { data: { id: 'c1' } });
    const tt = await TT_CONNECT(jsonRequest('/api/creator/tiktok/connect', { token, body: {} }));

    expect(ig.cookies.get(stateCookieName('instagram'))).toBeTruthy();
    expect(tt.cookies.get(stateCookieName('tiktok'))).toBeTruthy();
    expect(stateCookieName('instagram')).not.toBe(stateCookieName('tiktok'));
  });

  it('reports an unconfigured deployment rather than sending a creator to a broken URL', async () => {
    delete process.env.TIKTOK_CLIENT_KEY;
    asUser();
    fakeDb.queue('creators', { data: { id: 'c1' } });

    const res = await TT_CONNECT(jsonRequest('/api/creator/tiktok/connect', { token, body: {} }));
    expect(res.status).toBe(500);
  });
});

// ── Coming back ──────────────────────────────────────────────────────────────

describe('GET /api/creator/{instagram,tiktok}/callback — verified before anything is spent', () => {
  it('refuses when the echoed state does not match the cookie', async () => {
    const res = await IG_CALLBACK(callbackRequest('instagram', { code: 'c', state: 'someone-elses' }, await stateCookie('instagram')));

    expect(res.headers.get('location')).toContain('instagram=failed');
    // The code is never exchanged, so a forged callback cannot mint a token.
    expect(exchangeInstagramCode).not.toHaveBeenCalled();
  });

  it('refuses a forged state cookie', async () => {
    const forged = await new SignJWT({ sub: 'u2', creatorId: 'c2', nonce: 'nonce-1', type: 'tiktok_connect' })
      .setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime('15m')
      .sign(new TextEncoder().encode('not-the-real-secret'));

    const res = await TT_CALLBACK(callbackRequest('tiktok', { code: 'c', state: 'nonce-1' }, forged));

    expect(res.headers.get('location')).toContain('tiktok=failed');
    expect(exchangeTikTokCode).not.toHaveBeenCalled();
  });

  it('refuses a cookie issued for a different platform', async () => {
    // Same secret, same nonce, wrong `type` claim: an Instagram attempt must not
    // be redeemable as a TikTok connection.
    const res = await TT_CALLBACK(callbackRequest('tiktok', { code: 'c', state: 'nonce-1' }, await stateCookie('instagram')));

    expect(res.headers.get('location')).toContain('tiktok=failed');
    expect(exchangeTikTokCode).not.toHaveBeenCalled();
  });

  it('refuses when there is no cookie at all', async () => {
    const res = await IG_CALLBACK(callbackRequest('instagram', { code: 'c', state: 'nonce-1' }));

    expect(res.headers.get('location')).toContain('instagram=failed');
    expect(exchangeInstagramCode).not.toHaveBeenCalled();
  });
});

describe('GET /api/creator/instagram/callback', () => {
  it('stores the grant with the account id read from the grant itself', async () => {
    exchangeInstagramCode.mockResolvedValue(IG_GRANT);
    fetchInstagramAccount.mockResolvedValue({
      ok: true,
      account: { id: '178', username: 'chefsarah', accountType: 'BUSINESS' },
    });

    const res = await IG_CALLBACK(callbackRequest('instagram', { code: 'c', state: 'nonce-1' }, await stateCookie('instagram')));

    expect(res.headers.get('location')).toContain('instagram=connected');
    const upsert = fakeDb.calls.find((call) => call.method === 'upsert')?.args[0] as Record<string, unknown>;
    expect(upsert).toMatchObject({
      creator_id: 'c1',
      platform: 'instagram',
      external_id: '178',
      external_name: 'chefsarah',
      // The 60-day clock. This is what puts the row in the refresh sweep's
      // sights, and Instagram tokens can only be renewed while still alive.
      expires_at: '2026-10-01T00:00:00.000Z',
    });
    // A fresh grant clears whatever was broken about the last one.
    expect(upsert).toMatchObject({ broken_reason: null, broken_at: null });
    expect(JSON.stringify(log.mock.calls)).not.toContain('IGQ-long-lived');
    // Dropped on the way out even though nothing went wrong. A state cookie
    // that outlives its round trip is a second chance for somebody else's
    // callback, and success is the exit path easiest to forget.
    expect(res.cookies.get(stateCookieName('instagram'))).toMatchObject({ value: '', maxAge: 0 });
  });

  it('refuses a personal account with Instagram’s real reason, storing nothing', async () => {
    exchangeInstagramCode.mockResolvedValue(IG_GRANT);
    fetchInstagramAccount.mockResolvedValue({
      ok: false,
      detail: 'That is a personal Instagram account, and Instagram gives personal accounts no API access at all.',
    });

    const res = await IG_CALLBACK(callbackRequest('instagram', { code: 'c', state: 'nonce-1' }, await stateCookie('instagram')));

    const location = new URL(res.headers.get('location') ?? '');
    expect(location.searchParams.get('instagram')).toBe('failed');
    // A code, and the card owns the sentence — see `ConnectFailure`. The
    // account branch is distinguished from every other failure so the card can
    // still say the thing the creator can act on: switch to Professional.
    expect(location.searchParams.get('reason')).toBe('account');
    // And Instagram's own words are still recorded, where they are actually
    // useful — a log line nobody can author by handing someone a URL.
    expect(JSON.stringify(log.mock.calls)).toMatch(/personal Instagram account/);
    expect(fakeDb.calls.some((call) => call.method === 'upsert')).toBe(false);
  });

  it('refuses a grant that came back without the basic scope', async () => {
    exchangeInstagramCode.mockResolvedValue({ ...IG_GRANT, grant: { ...IG_GRANT.grant, scopes: [] } });

    const res = await IG_CALLBACK(callbackRequest('instagram', { code: 'c', state: 'nonce-1' }, await stateCookie('instagram')));

    // A connection with no read permission would present as an account that
    // never yields a post — the silent failure this whole area is built around.
    expect(res.headers.get('location')).toContain('instagram=failed');
    expect(fetchInstagramAccount).not.toHaveBeenCalled();
    expect(fakeDb.calls.some((call) => call.method === 'upsert')).toBe(false);
  });

  it('stores nothing when the creator cancels on Instagram’s screen', async () => {
    const res = await IG_CALLBACK(
      callbackRequest('instagram', { error: 'access_denied', error_reason: 'user_denied', state: 'nonce-1' }, await stateCookie('instagram')),
    );

    expect(res.headers.get('location')).toContain('instagram=cancelled');
    expect(exchangeInstagramCode).not.toHaveBeenCalled();
    expect(fakeDb.calls.some((call) => call.method === 'upsert')).toBe(false);
  });
});

describe('GET /api/creator/tiktok/callback', () => {
  it('stores the rotating refresh token and the open id', async () => {
    exchangeTikTokCode.mockResolvedValue(TT_GRANT);

    const res = await TT_CALLBACK(callbackRequest('tiktok', { code: 'c', state: 'nonce-1' }, await stateCookie('tiktok')));

    expect(res.headers.get('location')).toContain('tiktok=connected');
    const upsert = fakeDb.calls.find((call) => call.method === 'upsert')?.args[0] as Record<string, unknown>;
    expect(upsert).toMatchObject({ creator_id: 'c1', platform: 'tiktok', external_id: 'open-id-1' });
    // Every refresh invalidates the token that was sent, so the newest one has
    // to be the stored one or the next refresh disconnects the creator.
    expect(upsert.refresh_token).toBe('rft.super-secret');
    // `user.info.basic` is deliberately not on the app, so there is no name.
    expect(upsert.external_name).toBeNull();
    expect(JSON.stringify(log.mock.calls)).not.toContain('rft.super-secret');
  });

  it('refuses a grant that came back without video.list', async () => {
    exchangeTikTokCode.mockResolvedValue({ ...TT_GRANT, grant: { ...TT_GRANT.grant, scopes: [] } });

    const res = await TT_CALLBACK(callbackRequest('tiktok', { code: 'c', state: 'nonce-1' }, await stateCookie('tiktok')));

    expect(res.headers.get('location')).toContain('tiktok=failed');
    expect(fakeDb.calls.some((call) => call.method === 'upsert')).toBe(false);
  });

  it('refuses a grant with no open id rather than storing a nameless row', async () => {
    exchangeTikTokCode.mockResolvedValue({ ...TT_GRANT, grant: { ...TT_GRANT.grant, openId: null } });

    const res = await TT_CALLBACK(callbackRequest('tiktok', { code: 'c', state: 'nonce-1' }, await stateCookie('tiktok')));

    expect(res.headers.get('location')).toContain('tiktok=failed');
    expect(fakeDb.calls.some((call) => call.method === 'upsert')).toBe(false);
  });
});

// ── Status and disconnect ────────────────────────────────────────────────────

describe('/api/creator/{instagram,tiktok} — status and disconnect', () => {
  function grantRow(platform: string, overrides: Record<string, unknown> = {}) {
    return {
      id: 'pa1',
      creator_id: 'c1',
      platform,
      external_id: '178',
      external_name: 'chefsarah',
      access_token: 'IGQ-long-lived',
      refresh_token: 'rft.super-secret',
      scopes: INSTAGRAM_BASIC_SCOPE,
      expires_at: '2026-10-01T00:00:00.000Z',
      broken_reason: null,
      broken_at: null,
      ...overrides,
    };
  }

  it('reports the connection and its expiry without returning a token', async () => {
    asUser();
    fakeDb.queue('creators', { data: { id: 'c1' } });
    fakeDb.queue('creator_platform_accounts', { data: grantRow('instagram') });

    const body = await (await IG_STATUS(jsonRequest('/api/creator/instagram', { method: 'GET', token }))).json();

    expect(body).toMatchObject({
      connected: true,
      account: { id: '178', name: 'chefsarah' },
      // Real and short. A creator who can see the date can notice if it stops
      // moving, rather than finding out when their imports quietly stop.
      expiresAt: '2026-10-01T00:00:00.000Z',
    });
    expect(JSON.stringify(body)).not.toContain('rft.super-secret');
    expect(JSON.stringify(body)).not.toContain('IGQ-long-lived');
  });

  it('surfaces a broken connection to the one person who can fix it', async () => {
    asUser();
    fakeDb.queue('creators', { data: { id: 'c1' } });
    fakeDb.queue('creator_platform_accounts', {
      data: grantRow('tiktok', { broken_reason: 'TikTok refused to refresh this grant: invalid_grant' }),
    });

    const body = await (await TT_STATUS(jsonRequest('/api/creator/tiktok', { method: 'GET', token }))).json();

    // A dead grant looks exactly like an account that posted nothing, which is
    // why it has to be said out loud rather than inferred from silence.
    expect(body.brokenReason).toMatch(/invalid_grant/);
  });

  it('reports no connection rather than erroring for a creator who never connected', async () => {
    asUser();
    fakeDb.queue('creators', { data: { id: 'c1' } });

    const body = await (await IG_STATUS(jsonRequest('/api/creator/instagram', { method: 'GET', token }))).json();

    expect(body).toMatchObject({ connected: false, account: null, brokenReason: null });
  });

  it.each([
    ['instagram', IG_DISCONNECT] as const,
    ['tiktok', TT_DISCONNECT] as const,
  ])('%s: disconnecting removes the grant and leaves no token behind', async (platform, handler) => {
    asUser();
    fakeDb.queue('creators', { data: { id: 'c1' } });
    // Seeded, and that is the whole assertion. This test used to check that
    // `rft.super-secret` appeared nowhere while no row had ever held it — which
    // would have passed with the behaviour reverted, and passed against a
    // handler that did nothing at all.
    fakeDb.seed('creator_platform_accounts', [
      { id: 'pa1', creator_id: 'c1', platform, refresh_token: 'rft.super-secret', access_token: 'act.live' },
    ]);

    const res = await handler(jsonRequest(`/api/creator/${platform}`, { method: 'DELETE', token }));

    expect(res.status).toBe(200);
    // The row is gone, not merely a delete that was issued.
    expect(fakeDb.rows('creator_platform_accounts')).toEqual([]);
    expect(everythingWritten()).not.toContain('rft.super-secret');
  });

  it('says so when the grant could not actually be removed', async () => {
    asUser();
    fakeDb.queue('creators', { data: { id: 'c1' } });
    fakeDb.queue('creator_platform_accounts', { error: { message: 'permission denied for table' } });

    const res = await IG_DISCONNECT(jsonRequest('/api/creator/instagram', { method: 'DELETE', token }));

    // The one action that must not report success optimistically. A creator told
    // their account is disconnected will not check again, and the grant is still
    // live at Instagram.
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/still connected/i);
  });

  it('refuses status and disconnect for someone who is not a creator', async () => {
    asUser();
    fakeDb.queue('creators', { data: null });
    expect((await IG_STATUS(jsonRequest('/api/creator/instagram', { method: 'GET', token }))).status).toBe(403);

    asUser();
    fakeDb.queue('creators', { data: null });
    expect((await TT_DISCONNECT(jsonRequest('/api/creator/tiktok', { method: 'DELETE', token }))).status).toBe(403);
  });
});
