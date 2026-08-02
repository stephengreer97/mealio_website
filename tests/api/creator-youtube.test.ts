import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SignJWT } from 'jose';
import { fakeDb } from '../helpers/supabase-mock';
import { jsonRequest } from '../helpers/request';

vi.mock('@/lib/supabase', async () =>
  (await import('../helpers/supabase-mock')).mockSupabaseModule());
const log = vi.fn();
vi.mock('@/lib/logger', () => ({ log: (...args: unknown[]) => log(...args), abbreviateUa: () => undefined }));

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

import { POST as CONNECT, STATE_COOKIE } from '@/app/api/creator/youtube/connect/route';
import { GET as CALLBACK } from '@/app/api/creator/youtube/callback/route';
import { GET, PATCH, DELETE } from '@/app/api/creator/youtube/route';
import { clearRevocationCache, createAccessToken } from '@/lib/tokens';
import { YOUTUBE_WRITE_SCOPE } from '@/lib/youtube';

/**
 * Connecting a channel, and the consent flag that comes with it (MEAL-74).
 *
 * The two properties this file is really about: **who** is connecting comes from
 * a signed cookie rather than from anything Google echoed back, and
 * `youtube_append_opt_in` is written from the creator's own tick — never from a
 * later request, and never left standing when the connection goes away.
 *
 * `tests/helpers/supabase-mock.ts` pops queued results FIFO per table and
 * ignores `.eq()`, so assertions on the update calls below are about the columns
 * and values sent, not about which rows a filter would have matched.
 */

const CHANNEL_ID = 'UCabcdefghijklmnopqrstuv';
const JWT_SECRET = () => new TextEncoder().encode(process.env.JWT_SECRET || '');

/** Queues the `user_profiles` read `verifyAccessToken` makes (memoised for 30s). */
function asUser() {
  clearRevocationCache();
  fakeDb.queue('user_profiles', { data: { tokens_invalidated_at: null } });
}

function grantRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pa1',
    creator_id: 'c1',
    platform: 'youtube',
    external_id: CHANNEL_ID,
    external_name: 'Chef Sarah',
    access_token: 'ya29-token',
    refresh_token: '1//super-secret-refresh',
    scopes: `https://www.googleapis.com/auth/youtube.readonly ${YOUTUBE_WRITE_SCOPE}`,
    expires_at: '2099-01-01T00:00:00.000Z',
    broken_reason: null,
    broken_at: null,
    ...overrides,
  };
}

/** A state cookie as `/connect` would have set it. */
async function stateCookie(payload: Record<string, unknown> = {}) {
  return new SignJWT({ sub: 'u1', creatorId: 'c1', nonce: 'nonce-1', appendOptIn: false, type: 'youtube_connect', ...payload })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('15m')
    .sign(JWT_SECRET());
}

/** Every column value any call carried — for "did a token leak?" checks. */
function everythingWritten(): string {
  return JSON.stringify({ calls: fakeDb.calls, logs: log.mock.calls });
}

let token: string;

beforeEach(async () => {
  fakeDb.reset();
  log.mockReset();
  exchangeYouTubeCode.mockReset();
  fetchOwnChannel.mockReset();
  process.env.GOOGLE_CLIENT_ID = 'client-id.apps.googleusercontent.com';
  process.env.GOOGLE_CLIENT_SECRET = 'client-secret';
  process.env.NEXT_PUBLIC_APP_URL = 'https://mealio.co';
  token = await createAccessToken('u1', 'sarah@chefsarah.test');
});

// ── Starting the round trip ──────────────────────────────────────────────────

describe('POST /api/creator/youtube/connect', () => {
  it('401 without a token, 403 for someone who is not a creator', async () => {
    expect((await CONNECT(jsonRequest('/api/creator/youtube/connect', { body: {} }))).status).toBe(401);

    asUser();
    fakeDb.queue('creators', { data: null });
    const res = await CONNECT(jsonRequest('/api/creator/youtube/connect', { token, body: {} }));
    expect(res.status).toBe(403);
  });

  it('returns a consent URL asking for read and write together', async () => {
    asUser();
    fakeDb.queue('creators', { data: { id: 'c1' } });

    const res = await CONNECT(jsonRequest('/api/creator/youtube/connect', { token, body: { appendOptIn: true } }));
    const body = await res.json();
    const url = new URL(body.url);

    // Asking for write later would re-prompt every creator who already
    // connected, so it is asked for on the first screen or not at all.
    expect(url.searchParams.get('scope')).toContain(YOUTUBE_WRITE_SCOPE);
    expect(url.searchParams.get('state')).toMatch(/^[0-9a-f]{32}$/);
  });

  it('binds the attempt to an httpOnly state cookie carrying the creator, not the query string', async () => {
    asUser();
    fakeDb.queue('creators', { data: { id: 'c1' } });

    const res = await CONNECT(jsonRequest('/api/creator/youtube/connect', { token, body: { appendOptIn: true } }));
    const cookie = res.cookies.get(STATE_COOKIE);

    expect(cookie?.httpOnly).toBe(true);
    // Identity that round-trips through a third party and comes back in a query
    // string is identity anyone can supply — and what is being attached here is
    // write access to a creator's channel.
    const url = new URL((await res.json()).url);
    expect(url.searchParams.get('state')).not.toContain('c1');
    expect(cookie?.value.split('.')).toHaveLength(3);
  });

  it('treats anything other than a literal true as no consent', async () => {
    for (const appendOptIn of [undefined, 'true', 1, null]) {
      fakeDb.reset();
      asUser();
      fakeDb.queue('creators', { data: { id: 'c1' } });
      const res = await CONNECT(jsonRequest('/api/creator/youtube/connect', { token, body: { appendOptIn } }));
      const detail = log.mock.calls.at(-1)?.[0].detail as string;
      expect(detail).toContain('appendOptIn=false');
      expect(res.status).toBe(200);
    }
  });
});

// ── Coming back ──────────────────────────────────────────────────────────────

describe('GET /api/creator/youtube/callback', () => {
  function callbackRequest(params: Record<string, string>, cookie?: string) {
    const query = new URLSearchParams(params).toString();
    return jsonRequest(`/api/creator/youtube/callback?${query}`, {
      method: 'GET',
      ...(cookie ? { cookies: { [STATE_COOKIE]: cookie } } : {}),
    });
  }

  it('refuses when the echoed state does not match the cookie', async () => {
    const res = await CALLBACK(callbackRequest({ code: 'c', state: 'someone-elses' }, await stateCookie()));

    expect(res.headers.get('location')).toContain('youtube=failed');
    expect(exchangeYouTubeCode).not.toHaveBeenCalled();
  });

  it('refuses a forged state cookie', async () => {
    const forged = await new SignJWT({ sub: 'u2', creatorId: 'c2', nonce: 'nonce-1', type: 'youtube_connect' })
      .setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime('15m')
      .sign(new TextEncoder().encode('not-the-real-secret'));

    const res = await CALLBACK(callbackRequest({ code: 'c', state: 'nonce-1' }, forged));

    expect(res.headers.get('location')).toContain('youtube=failed');
    expect(exchangeYouTubeCode).not.toHaveBeenCalled();
  });

  it('stores the grant with the channel id read from the grant itself', async () => {
    exchangeYouTubeCode.mockResolvedValue({
      ok: true,
      grant: {
        accessToken: 'ya29-token',
        refreshToken: '1//super-secret-refresh',
        scopes: ['https://www.googleapis.com/auth/youtube.readonly', YOUTUBE_WRITE_SCOPE],
        expiresAt: '2026-08-02T12:00:00.000Z',
      },
    });
    fetchOwnChannel.mockResolvedValue({ ok: true, channel: { id: CHANNEL_ID, title: 'Chef Sarah' } });

    const res = await CALLBACK(callbackRequest({ code: 'c', state: 'nonce-1' }, await stateCookie()));

    expect(res.headers.get('location')).toContain('youtube=connected');
    const upsert = fakeDb.calls.find((call) => call.method === 'upsert')?.args[0] as Record<string, unknown>;
    // Derived from the grant, never typed by a creator and never taken off the
    // link on their application.
    expect(upsert).toMatchObject({ creator_id: 'c1', platform: 'youtube', external_id: CHANNEL_ID });
    // A fresh grant clears whatever was broken about the last one.
    expect(upsert).toMatchObject({ broken_reason: null, broken_at: null });
    // The refresh token is stored, and appears nowhere else.
    expect(upsert.refresh_token).toBe('1//super-secret-refresh');
    expect(JSON.stringify(log.mock.calls)).not.toContain('super-secret-refresh');
  });

  it('writes the append consent from the state cookie, in both directions', async () => {
    exchangeYouTubeCode.mockResolvedValue({
      ok: true,
      grant: { accessToken: 'ya29', refreshToken: '1//r', scopes: [YOUTUBE_WRITE_SCOPE], expiresAt: null },
    });
    fetchOwnChannel.mockResolvedValue({ ok: true, channel: { id: CHANNEL_ID, title: 'Chef Sarah' } });

    await CALLBACK(callbackRequest({ code: 'c', state: 'nonce-1' }, await stateCookie({ appendOptIn: true })));
    let update = fakeDb.calls.filter((c) => c.table === 'creators' && c.method === 'update').at(-1)?.args[0];
    expect(update).toEqual({ youtube_append_opt_in: true });

    fakeDb.reset();
    // Reconnecting without ticking the box has to *withdraw* the consent given
    // last time, not leave it standing.
    await CALLBACK(callbackRequest({ code: 'c', state: 'nonce-1' }, await stateCookie({ appendOptIn: false })));
    update = fakeDb.calls.filter((c) => c.table === 'creators' && c.method === 'update').at(-1)?.args[0];
    expect(update).toEqual({ youtube_append_opt_in: false });
  });

  it('stores nothing when the creator cancels on Google’s screen', async () => {
    const res = await CALLBACK(callbackRequest({ error: 'access_denied', state: 'nonce-1' }, await stateCookie({ appendOptIn: true })));

    expect(res.headers.get('location')).toContain('youtube=cancelled');
    expect(fakeDb.calls.some((call) => call.method === 'upsert' || call.method === 'update')).toBe(false);
  });
});

// ── Status, consent and disconnect ───────────────────────────────────────────

describe('/api/creator/youtube', () => {
  it('reports the connection without returning a token', async () => {
    asUser();
    fakeDb.queue('creators', { data: { id: 'c1', youtube_url: null, youtube_append_opt_in: true } });
    fakeDb.queue('creator_platform_accounts', { data: grantRow() });

    const res = await GET(jsonRequest('/api/creator/youtube', { method: 'GET', token }));
    const body = await res.json();

    expect(body).toMatchObject({
      connected: true,
      channel: { id: CHANNEL_ID, title: 'Chef Sarah' },
      appendOptIn: true,
      canWriteDescriptions: true,
    });
    expect(JSON.stringify(body)).not.toContain('super-secret-refresh');
    expect(JSON.stringify(body)).not.toContain('ya29-token');
  });

  it('surfaces a broken connection to the one person who can fix it', async () => {
    asUser();
    fakeDb.queue('creators', { data: { id: 'c1', youtube_append_opt_in: false } });
    fakeDb.queue('creator_platform_accounts', { data: grantRow({ broken_reason: 'Token has been expired or revoked.' }) });

    const body = await (await GET(jsonRequest('/api/creator/youtube', { method: 'GET', token }))).json();

    // A dead grant looks exactly like a channel that published nothing, which is
    // why it has to be said out loud rather than inferred from silence.
    expect(body.brokenReason).toMatch(/revoked/);
  });

  it('turns the append consent off from any state, including a broken connection', async () => {
    asUser();
    fakeDb.queue('creators', { data: { id: 'c1', youtube_append_opt_in: true } });

    const res = await PATCH(jsonRequest('/api/creator/youtube', { method: 'PATCH', token, body: { appendOptIn: false } }));

    expect(res.status).toBe(200);
    // Revocation that only works while everything else is healthy is not
    // revocation. No connection was queued here at all.
    const update = fakeDb.calls.filter((c) => c.table === 'creators' && c.method === 'update').at(-1)?.args[0];
    expect(update).toEqual({ youtube_append_opt_in: false });
  });

  it('refuses to turn it on without a channel to write to', async () => {
    asUser();
    fakeDb.queue('creators', { data: { id: 'c1', youtube_append_opt_in: false } });
    fakeDb.queue('creator_platform_accounts', { data: null });

    const res = await PATCH(jsonRequest('/api/creator/youtube', { method: 'PATCH', token, body: { appendOptIn: true } }));

    expect(res.status).toBe(400);
    expect(fakeDb.calls.some((c) => c.table === 'creators' && c.method === 'update')).toBe(false);
  });

  it('refuses to turn it on for a grant made without the write scope', async () => {
    asUser();
    fakeDb.queue('creators', { data: { id: 'c1', youtube_append_opt_in: false } });
    fakeDb.queue('creator_platform_accounts', {
      data: grantRow({ scopes: 'https://www.googleapis.com/auth/youtube.readonly' }),
    });

    const res = await PATCH(jsonRequest('/api/creator/youtube', { method: 'PATCH', token, body: { appendOptIn: true } }));

    expect(res.status).toBe(409);
  });

  it('rejects a non-boolean rather than coercing it', async () => {
    asUser();
    const res = await PATCH(jsonRequest('/api/creator/youtube', { method: 'PATCH', token, body: { appendOptIn: 'yes' } }));
    expect(res.status).toBe(400);
  });

  it('disconnecting removes the grant and withdraws the append consent with it', async () => {
    asUser();
    fakeDb.queue('creators', { data: { id: 'c1', youtube_append_opt_in: true } });

    const res = await DELETE(jsonRequest('/api/creator/youtube', { method: 'DELETE', token }));

    expect(res.status).toBe(200);
    expect(fakeDb.calls.some((c) => c.table === 'creator_platform_accounts' && c.method === 'delete')).toBe(true);
    // Consent cannot outlive the connection it was given for: a creator
    // reconnecting months later must not find us already permitted to write.
    const update = fakeDb.calls.filter((c) => c.table === 'creators' && c.method === 'update').at(-1)?.args[0];
    expect(update).toEqual({ youtube_append_opt_in: false });
    expect(everythingWritten()).not.toContain('super-secret-refresh');
  });
});
