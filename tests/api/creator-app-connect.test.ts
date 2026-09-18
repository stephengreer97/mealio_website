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

const exchangeYouTubeCode = vi.fn();
const fetchOwnChannel = vi.fn();
vi.mock('@/lib/youtube', async () => {
  const actual = await vi.importActual<typeof import('@/lib/youtube')>('@/lib/youtube');
  return {
    ...actual,
    exchangeYouTubeCode: (...args: unknown[]) => exchangeYouTubeCode(...args),
    fetchOwnChannel: (...args: unknown[]) => fetchOwnChannel(...args),
  };
});

import { POST as IG_CONNECT } from '@/app/api/creator/instagram/connect/route';
import { GET as IG_CALLBACK } from '@/app/api/creator/instagram/callback/route';
import { POST as IG_COMPLETE } from '@/app/api/creator/instagram/complete/route';
import { POST as TT_CONNECT } from '@/app/api/creator/tiktok/connect/route';
import { GET as TT_CALLBACK } from '@/app/api/creator/tiktok/callback/route';
import { POST as TT_COMPLETE } from '@/app/api/creator/tiktok/complete/route';
import { POST as YT_CONNECT, STATE_COOKIE as YT_STATE_COOKIE } from '@/app/api/creator/youtube/connect/route';
import { GET as YT_CALLBACK } from '@/app/api/creator/youtube/callback/route';
import { POST as YT_COMPLETE } from '@/app/api/creator/youtube/complete/route';
import { stateCookieName, STATE_TTL_SECONDS } from '@/lib/creator-connect';
import { connectFailureCopy } from '@/lib/connect-copy';
import { clearRevocationCache, createAccessToken } from '@/lib/tokens';
import { INSTAGRAM_BASIC_SCOPE } from '@/lib/instagram';
import { TIKTOK_VIDEO_LIST_SCOPE } from '@/lib/tiktok';
import { YOUTUBE_FORCE_SSL_SCOPE } from '@/lib/youtube';

/**
 * The mobile app's connect round trip.
 *
 * The app cannot use the website's state cookie (it would land in React Native's
 * jar, not the browser doing the consent), so its `state` is a signed JWT, the
 * callback bounces code and state to `mealio://creator/connect` without spending
 * the code, and `/complete` binds the state to the bearer token before it does.
 * That binding is the whole of the CSRF protection on this path, so most of what
 * is below is about it refusing.
 */

type Platform = 'instagram' | 'tiktok' | 'youtube';

const JWT_SECRET = () => new TextEncoder().encode(process.env.JWT_SECRET || '');

const CONNECT = { instagram: IG_CONNECT, tiktok: TT_CONNECT, youtube: YT_CONNECT } as const;
const CALLBACK = { instagram: IG_CALLBACK, tiktok: TT_CALLBACK, youtube: YT_CALLBACK } as const;
const COMPLETE = { instagram: IG_COMPLETE, tiktok: TT_COMPLETE, youtube: YT_COMPLETE } as const;
const COOKIE = { instagram: stateCookieName('instagram'), tiktok: stateCookieName('tiktok'), youtube: YT_STATE_COOKIE };
const PLATFORMS: Platform[] = ['instagram', 'tiktok', 'youtube'];

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
const YT_GRANT = {
  ok: true,
  grant: {
    accessToken: 'ya29-token',
    refreshToken: '1//super-secret-refresh',
    scopes: ['https://www.googleapis.com/auth/youtube.readonly'],
    expiresAt: '2099-01-01T00:00:00.000Z',
  },
};

/** Queues the `user_profiles` read `verifyAccessToken` makes (memoised for 30s). */
function asUser() {
  clearRevocationCache();
  fakeDb.queue('user_profiles', { data: { tokens_invalidated_at: null } });
}

function claims(jwt: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());
}

async function signState(payload: Record<string, unknown>, opts: { expiresIn?: string; secret?: Uint8Array } = {}) {
  return new SignJWT({ sub: 'u1', creatorId: 'c1', nonce: 'n', ...payload })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(opts.expiresIn ?? '15m')
    .sign(opts.secret ?? JWT_SECRET());
}

/** An app state exactly as `/connect` issues it, by actually calling `/connect`. */
async function appStateFor(platform: Platform, body: Record<string, unknown> = {}): Promise<string> {
  asUser();
  fakeDb.queue('creators', { data: { id: 'c1' } });
  const res = await CONNECT[platform](jsonRequest(`/api/creator/${platform}/connect`, { token, body: { client: 'app', ...body } }));
  return new URL((await res.json()).url).searchParams.get('state')!;
}

function callback(platform: Platform, params: Record<string, string>, cookie?: string) {
  return CALLBACK[platform](
    jsonRequest(`/api/creator/${platform}/callback?${new URLSearchParams(params)}`, {
      method: 'GET',
      ...(cookie ? { cookies: { [COOKIE[platform]]: cookie } } : {}),
    }),
  );
}

function complete(platform: Platform, body: unknown, bearer: string | null = token) {
  return COMPLETE[platform](
    jsonRequest(`/api/creator/${platform}/complete`, { ...(bearer ? { token: bearer } : {}), body }),
  );
}

/** The table-mode rows `/complete` reads and writes. */
function seedCreator(id = 'c1', userId = 'u1') {
  fakeDb.seed('creators', [{ id, user_id: userId, youtube_append_opt_in: false }]);
  fakeDb.seed('creator_platform_accounts', []);
}

function exchangeMock(platform: Platform) {
  return { instagram: exchangeInstagramCode, tiktok: exchangeTikTokCode, youtube: exchangeYouTubeCode }[platform];
}

function mockHappyProvider() {
  exchangeInstagramCode.mockResolvedValue(IG_GRANT);
  fetchInstagramAccount.mockResolvedValue({ ok: true, account: { id: '178', username: 'chefsarah', accountType: 'BUSINESS' } });
  exchangeTikTokCode.mockResolvedValue(TT_GRANT);
  exchangeYouTubeCode.mockResolvedValue(YT_GRANT);
  fetchOwnChannel.mockResolvedValue({ ok: true, channel: { id: 'UCabc', title: 'Chef Sarah' } });
}

let token: string;

beforeEach(async () => {
  fakeDb.reset();
  log.mockReset();
  exchangeInstagramCode.mockReset();
  fetchInstagramAccount.mockReset();
  exchangeTikTokCode.mockReset();
  exchangeYouTubeCode.mockReset();
  fetchOwnChannel.mockReset();
  process.env.INSTAGRAM_APP_ID = 'ig-app-id';
  process.env.INSTAGRAM_APP_SECRET = 'ig-app-secret';
  process.env.TIKTOK_CLIENT_KEY = 'tiktok-client-key';
  process.env.TIKTOK_CLIENT_SECRET = 'tiktok-client-secret';
  process.env.GOOGLE_CLIENT_ID = 'client-id.apps.googleusercontent.com';
  process.env.GOOGLE_CLIENT_SECRET = 'client-secret';
  process.env.NEXT_PUBLIC_APP_URL = 'https://mealio.co';
  token = await createAccessToken('u1', 'sarah@chefsarah.test');
});

// ── Start ────────────────────────────────────────────────────────────────────

describe('POST /api/creator/<platform>/connect with {"client":"app"}', () => {
  it.each(PLATFORMS)('%s: puts a signed app state in the consent URL and sets no cookie', async (platform) => {
    asUser();
    fakeDb.queue('creators', { data: { id: 'c1' } });

    const res = await CONNECT[platform](jsonRequest(`/api/creator/${platform}/connect`, { token, body: { client: 'app' } }));
    expect(res.status).toBe(200);
    const url = new URL((await res.json()).url);
    const state = url.searchParams.get('state')!;

    // The cookie would only reach React Native's jar, never the browser doing
    // the consent, so the app flow must not set one.
    expect(res.cookies.get(COOKIE[platform])).toBeUndefined();
    expect(res.headers.get('set-cookie')).toBeNull();
    const c = claims(state);
    expect(c).toMatchObject({ sub: 'u1', creatorId: 'c1', type: `${platform}_connect_app` });
    expect(typeof c.nonce).toBe('string');
    expect(Number(c.exp) - Number(c.iat)).toBe(STATE_TTL_SECONDS);
    // The registered web callback, unchanged: providers accept nothing else.
    expect(url.searchParams.get('redirect_uri')).toBe(`https://mealio.co/api/creator/${platform}/callback`);
  });

  it.each(PLATFORMS)('%s: the website (no client) still gets a nonce and a cookie', async (platform) => {
    asUser();
    fakeDb.queue('creators', { data: { id: 'c1' } });

    const res = await CONNECT[platform](jsonRequest(`/api/creator/${platform}/connect`, { token, body: {} }));
    const url = new URL((await res.json()).url);

    expect(url.searchParams.get('state')).toMatch(/^[0-9a-f]{32}$/);
    const cookie = res.cookies.get(COOKIE[platform]);
    expect(cookie?.httpOnly).toBe(true);
    expect(claims(cookie!.value)).toMatchObject({ type: `${platform}_connect` });
  });

  it('keeps the status codes: 401, 403, 500', async () => {
    expect((await IG_CONNECT(jsonRequest('/api/creator/instagram/connect', { body: { client: 'app' } }))).status).toBe(401);

    asUser();
    fakeDb.queue('creators', { data: null });
    expect((await TT_CONNECT(jsonRequest('/api/creator/tiktok/connect', { token, body: { client: 'app' } }))).status).toBe(403);

    delete process.env.TIKTOK_CLIENT_KEY;
    asUser();
    fakeDb.queue('creators', { data: { id: 'c1' } });
    expect((await TT_CONNECT(jsonRequest('/api/creator/tiktok/connect', { token, body: { client: 'app' } }))).status).toBe(500);
  });

  it('youtube: carries the append answer in the app state the way the cookie does', async () => {
    expect(claims(await appStateFor('youtube', { appendOptIn: true }))).toMatchObject({ appendOptIn: true });
    expect(claims(await appStateFor('youtube'))).toMatchObject({ appendOptIn: false });
    // A captions trip does not answer the question, so the claim is absent.
    expect(claims(await appStateFor('youtube', { captions: true }))).not.toHaveProperty('appendOptIn');
  });
});

// ── Callback ─────────────────────────────────────────────────────────────────

describe('GET /api/creator/<platform>/callback with an app state', () => {
  it.each(PLATFORMS)('%s: bounces code and state into the app and exchanges nothing', async (platform) => {
    const state = await appStateFor(platform);
    const code = platform === 'instagram' ? 'AQD-code#_' : 'code/with+odd=chars';

    const res = await callback(platform, { code, state });

    expect(res.status).toBe(302);
    const location = res.headers.get('location')!;
    expect(location.startsWith('mealio://creator/connect?')).toBe(true);
    const params = new URL(location).searchParams;
    expect(params.get('platform')).toBe(platform);
    // Exactly as received, `#_` included; the exchange strips it.
    expect(params.get('code')).toBe(code);
    expect(params.get('state')).toBe(state);
    expect(exchangeMock(platform)).not.toHaveBeenCalled();
    expect(fakeDb.calls.some((call) => call.method === 'upsert')).toBe(false);
  });

  it.each(PLATFORMS)('%s: a cancel on the provider screen comes back as outcome=cancelled', async (platform) => {
    const state = await appStateFor(platform);
    const res = await callback(platform, { error: 'access_denied', error_reason: 'user_denied', state });

    const params = new URL(res.headers.get('location')!).searchParams;
    expect(res.headers.get('location')!.startsWith('mealio://creator/connect?')).toBe(true);
    expect(params.get('platform')).toBe(platform);
    expect(params.get('outcome')).toBe('cancelled');
    expect(params.get('code')).toBeNull();
    expect(exchangeMock(platform)).not.toHaveBeenCalled();
  });

  it('tiktok: a refusal that is not access_denied is not reported as the creator cancelling', async () => {
    const state = await appStateFor('tiktok');
    const res = await callback('tiktok', { error: 'unauthorized_client', state });

    const params = new URL(res.headers.get('location')!).searchParams;
    expect(params.get('outcome')).toBe('failed');
    expect(params.get('reason')).toBe('unavailable');
  });

  it.each(PLATFORMS)('%s: an expired app state comes back as failed/expired, unexchanged', async (platform) => {
    const state = await signState({ type: `${platform}_connect_app` }, { expiresIn: '-1s' });
    const res = await callback(platform, { code: 'c', state });

    const params = new URL(res.headers.get('location')!).searchParams;
    expect(res.headers.get('location')!.startsWith('mealio://creator/connect?')).toBe(true);
    expect(params.get('outcome')).toBe('failed');
    expect(params.get('reason')).toBe('expired');
    expect(params.get('code')).toBeNull();
    expect(exchangeMock(platform)).not.toHaveBeenCalled();
  });

  it('a state we did not sign is not handed to the app', async () => {
    const forged = await signState({ type: 'instagram_connect_app' }, { secret: new TextEncoder().encode('nope') });
    const res = await callback('instagram', { code: 'c', state: forged });

    const params = new URL(res.headers.get('location')!).searchParams;
    expect(params.get('outcome')).toBe('failed');
    expect(params.get('state')).toBeNull();
  });

  it.each(PLATFORMS)('%s: the web round trip still works end to end, cookie and all', async (platform) => {
    mockHappyProvider();
    seedCreator();
    asUser();
    fakeDb.queue('creators', { data: { id: 'c1' } });
    const started = await CONNECT[platform](jsonRequest(`/api/creator/${platform}/connect`, { token, body: {} }));
    const nonce = new URL((await started.json()).url).searchParams.get('state')!;
    const cookie = started.cookies.get(COOKIE[platform])!.value;

    const res = await callback(platform, { code: 'web-code', state: nonce }, cookie);

    const location = new URL(res.headers.get('location')!);
    expect(location.origin).toBe('https://mealio.co');
    expect(location.searchParams.get(platform)).toBe('connected');
    expect(exchangeMock(platform)).toHaveBeenCalledWith('web-code');
    expect(fakeDb.rows('creator_platform_accounts')).toHaveLength(1);
    expect(res.cookies.get(COOKIE[platform])).toMatchObject({ value: '', maxAge: 0 });
  });
});

// ── Complete ─────────────────────────────────────────────────────────────────

describe('POST /api/creator/<platform>/complete', () => {
  it.each(PLATFORMS)('%s: exchanges, stores and reports connected', async (platform) => {
    mockHappyProvider();
    const state = await appStateFor(platform);
    seedCreator();
    asUser();

    const res = await complete(platform, { code: 'app-code#_', state });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, outcome: 'connected' });
    expect(exchangeMock(platform)).toHaveBeenCalledWith('app-code#_');
    const rows = fakeDb.rows('creator_platform_accounts');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ creator_id: 'c1', platform });
  });

  it.each(PLATFORMS)('%s: 403 when the state was issued to a different user, and nothing is exchanged', async (platform) => {
    mockHappyProvider();
    // The attacker's state, the victim's bearer: account-linking CSRF.
    const state = await signState({ sub: 'attacker', type: `${platform}_connect_app` });
    seedCreator();
    asUser();

    const res = await complete(platform, { code: 'c', state });

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ ok: false, outcome: 'failed', reason: 'unverified' });
    expect(exchangeMock(platform)).not.toHaveBeenCalled();
    expect(fakeDb.rows('creator_platform_accounts')).toEqual([]);
  });

  it('403 when the state names a creator this user no longer is', async () => {
    mockHappyProvider();
    const state = await signState({ creatorId: 'c-other', type: 'instagram_connect_app' });
    seedCreator();
    asUser();

    expect((await complete('instagram', { code: 'c', state })).status).toBe(403);
    expect(exchangeInstagramCode).not.toHaveBeenCalled();
  });

  it('403 when the user is not a creator at all', async () => {
    mockHappyProvider();
    const state = await signState({ type: 'tiktok_connect_app' });
    fakeDb.seed('creators', []);
    asUser();

    expect((await complete('tiktok', { code: 'c', state })).status).toBe(403);
    expect(exchangeTikTokCode).not.toHaveBeenCalled();
  });

  it.each(PLATFORMS)('%s: refuses the website’s cookie-type state', async (platform) => {
    mockHappyProvider();
    const state = await signState({ type: `${platform}_connect` });
    seedCreator();
    asUser();

    const res = await complete(platform, { code: 'c', state });

    expect(res.status).toBe(403);
    expect(exchangeMock(platform)).not.toHaveBeenCalled();
  });

  it('refuses another platform’s app state', async () => {
    mockHappyProvider();
    const state = await signState({ type: 'instagram_connect_app' });
    seedCreator();
    asUser();

    expect((await complete('tiktok', { code: 'c', state })).status).toBe(403);
    expect(exchangeTikTokCode).not.toHaveBeenCalled();
  });

  it('an expired state is a handled failure the app can show', async () => {
    const state = await signState({ type: 'instagram_connect_app' }, { expiresIn: '-1s' });
    seedCreator();
    asUser();

    const res = await complete('instagram', { code: 'c', state });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: false,
      outcome: 'failed',
      reason: 'expired',
      message: connectFailureCopy('instagram', 'expired'),
    });
    expect(exchangeInstagramCode).not.toHaveBeenCalled();
  });

  it('401 without a bearer token, 400 without code or state', async () => {
    const state = await signState({ type: 'instagram_connect_app' });
    expect((await complete('instagram', { code: 'c', state }, null)).status).toBe(401);

    asUser();
    expect((await complete('instagram', { state })).status).toBe(400);
    asUser();
    expect((await complete('instagram', { code: 'c' })).status).toBe(400);
  });

  it('instagram: a personal account comes back with the reason and the website’s sentence', async () => {
    exchangeInstagramCode.mockResolvedValue(IG_GRANT);
    fetchInstagramAccount.mockResolvedValue({ ok: false, detail: 'personal account' });
    const state = await appStateFor('instagram');
    seedCreator();
    asUser();

    const res = await complete('instagram', { code: 'c', state });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, outcome: 'failed', reason: 'account' });
    expect(body.message).toMatch(/switch it to Professional/);
    expect(body.message).not.toContain('—');
    expect(fakeDb.rows('creator_platform_accounts')).toEqual([]);
  });

  it('instagram: a grant without the basic scope is refused', async () => {
    exchangeInstagramCode.mockResolvedValue({ ...IG_GRANT, grant: { ...IG_GRANT.grant, scopes: [] } });
    const state = await appStateFor('instagram');
    seedCreator();
    asUser();

    expect(await (await complete('instagram', { code: 'c', state })).json()).toMatchObject({ ok: false, reason: 'scope' });
    expect(fakeDb.rows('creator_platform_accounts')).toEqual([]);
  });

  it('replaying a spent code returns the provider’s failure, not a 500', async () => {
    mockHappyProvider();
    exchangeTikTokCode
      .mockResolvedValueOnce(TT_GRANT)
      .mockResolvedValueOnce({ ok: false, detail: 'invalid_grant: authorization code has been used' });
    const state = await appStateFor('tiktok');
    seedCreator();

    asUser();
    expect((await (await complete('tiktok', { code: 'c', state })).json()).ok).toBe(true);
    asUser();
    const replay = await complete('tiktok', { code: 'c', state });

    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ ok: false, outcome: 'failed', reason: 'exchange' });
  });

  it('youtube: the append answer in the state reaches the consent flag', async () => {
    exchangeYouTubeCode.mockResolvedValue({
      ...YT_GRANT,
      grant: { ...YT_GRANT.grant, scopes: ['https://www.googleapis.com/auth/youtube.readonly', YOUTUBE_FORCE_SSL_SCOPE] },
    });
    fetchOwnChannel.mockResolvedValue({ ok: true, channel: { id: 'UCabc', title: 'Chef Sarah' } });
    const state = await appStateFor('youtube', { appendOptIn: true });
    seedCreator();
    asUser();

    expect(await (await complete('youtube', { code: 'c', state })).json()).toEqual({ ok: true, outcome: 'connected' });
    expect(fakeDb.row('creators', 'c1').youtube_append_opt_in).toBe(true);
  });

  it('never logs a token', async () => {
    mockHappyProvider();
    const state = await appStateFor('tiktok');
    seedCreator();
    asUser();
    await complete('tiktok', { code: 'c', state });

    expect(JSON.stringify(log.mock.calls)).not.toContain('rft.super-secret');
    expect(JSON.stringify(log.mock.calls)).not.toContain('act.tiktok');
  });
});
