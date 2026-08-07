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
import { YOUTUBE_FORCE_SSL_SCOPE } from '@/lib/youtube';

/**
 * Connecting a channel, and the consent flag that comes with it (MEAL-74).
 *
 * The two properties this file is really about: **who** is connecting comes from
 * a signed cookie rather than from anything Google echoed back, and
 * `youtube_append_opt_in` is written from the creator's own tick — never from a
 * later request, and never left standing when the connection goes away.
 *
 * `tests/helpers/supabase-mock.ts` serves queued results FIFO per table and
 * runs real filters against seeded rows. The consent tests below use seeded
 * rows deliberately: what a permission write *sent* is not the property worth
 * defending — what the row says afterwards, on the path where something else
 * failed, is.
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
    scopes: `https://www.googleapis.com/auth/youtube.readonly ${YOUTUBE_FORCE_SSL_SCOPE}`,
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

/**
 * The claims inside a state cookie.
 *
 * Read rather than substring-matched against the URL: a 32-character hex nonce
 * contains the two characters "c1" about one run in nine, so "the state does not
 * contain the creator id" is a coin flip dressed up as an assertion.
 */
function claims(cookie: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(cookie.split('.')[1], 'base64url').toString());
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

    // The tick is what asks for it, and this request carries the tick.
    expect(url.searchParams.get('scope')).toContain(YOUTUBE_FORCE_SSL_SCOPE);
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
    // write access to a creator's channel. So the state parameter is an opaque
    // nonce and nothing else, and the identity is in the signed cookie Google
    // never sees.
    //
    // Asserted as a shape, not as "does not contain 'c1'": a random 32-char hex
    // string contains that pair about 12% of the time, which made this test fail
    // roughly one run in eight for no reason at all.
    const url = new URL((await res.json()).url);
    expect(url.searchParams.get('state')).toMatch(/^[0-9a-f]{32}$/);
    expect(cookie?.value.split('.')).toHaveLength(3);
    expect(claims(cookie!.value)).toMatchObject({ sub: 'u1', creatorId: 'c1' });
  });

  /**
   * MEAL-138. Two capabilities, one Google scope, and — until this — one request.
   *
   * The bug was not that `force-ssl` became incremental; that was right. It was
   * that the *only* thing that ever asked for it was the description-editing
   * tick, so a creator who declined to have their descriptions edited also
   * declined, without being told, to have their captions read. Asking on the
   * caption's own behalf is what uncouples them.
   */
  it('asks for the caption scope on the caption’s own account, with no consent to edit', async () => {
    asUser();
    fakeDb.queue('creators', { data: { id: 'c1' } });

    const res = await CONNECT(
      jsonRequest('/api/creator/youtube/connect', { token, body: { appendOptIn: false, captions: true } }),
    );
    const url = new URL((await res.json()).url);

    expect(url.searchParams.get('scope')).toContain(YOUTUBE_FORCE_SSL_SCOPE);
    // And nothing about this trip claims the creator wants their descriptions
    // edited. The state cookie carries the answer the callback writes, and it
    // must still be no.
    const cookie = res.cookies.get(STATE_COOKIE);
    expect(claims(cookie!.value)).toMatchObject({ appendOptIn: false });
    // Answerable from the log: "why did this creator see that consent screen".
    const detail = log.mock.calls.at(-1)?.[0].detail as string;
    expect(detail).toContain('captions=true');
    expect(detail).toContain('appendOptIn=false');
  });

  it('keeps a plain connect plain', async () => {
    asUser();
    fakeDb.queue('creators', { data: { id: 'c1' } });

    // 8aec421's win, guarded from this ticket's fix: a creator who asked for
    // neither capability must still meet the narrow consent screen.
    const res = await CONNECT(jsonRequest('/api/creator/youtube/connect', { token, body: {} }));
    const url = new URL((await res.json()).url);

    expect(url.searchParams.get('scope')).not.toContain(YOUTUBE_FORCE_SSL_SCOPE);
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
        scopes: ['https://www.googleapis.com/auth/youtube.readonly', YOUTUBE_FORCE_SSL_SCOPE],
        expiresAt: '2026-08-02T12:00:00.000Z',
      },
    });
    fetchOwnChannel.mockResolvedValue({ ok: true, channel: { id: CHANNEL_ID, title: 'Chef Sarah' } });

    const res = await CALLBACK(callbackRequest({ code: 'c', state: 'nonce-1' }, await stateCookie()));

    expect(res.headers.get('location')).toContain('youtube=connected');
    // The tab they left from, same as the other platforms' callbacks.
    expect(res.headers.get('location')).toContain('#settings');
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
      grant: { accessToken: 'ya29', refreshToken: '1//r', scopes: [YOUTUBE_FORCE_SSL_SCOPE], expiresAt: null },
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

  /** A grant Google was happy with, for the callback tests that get that far. */
  function googleSaidYes() {
    exchangeYouTubeCode.mockResolvedValue({
      ok: true,
      grant: { accessToken: 'ya29', refreshToken: '1//r', scopes: [YOUTUBE_FORCE_SSL_SCOPE], expiresAt: null },
    });
    fetchOwnChannel.mockResolvedValue({ ok: true, channel: { id: CHANNEL_ID, title: 'Chef Sarah' } });
  }

  it('withdraws the append consent even when the grant cannot be stored', async () => {
    googleSaidYes();
    fakeDb.seed('creators', [{ id: 'c1', user_id: 'u1', youtube_url: null, youtube_append_opt_in: true }]);
    fakeDb.queue('creator_platform_accounts', { error: { message: 'connection refused' } });

    const res = await CALLBACK(callbackRequest({ code: 'c', state: 'nonce-1' }, await stateCookie({ appendOptIn: false })));

    expect(res.headers.get('location')).toContain('youtube=failed');
    // Reconnecting without ticking the box is a withdrawal. Returning early on
    // a failed grant write abandoned it: the previous `true` stood over the
    // previous, still-working grant, `assertAppendAllowed` kept permitting
    // description edits, and the creator was told the attempt had failed and
    // reasonably concluded nothing had changed.
    expect(fakeDb.row('creators', 'c1')?.youtube_append_opt_in).toBe(false);
  });

  it('withdraws it before the new grant is stored, not after', async () => {
    googleSaidYes();
    fakeDb.seed('creators', [{ id: 'c1', user_id: 'u1', youtube_append_opt_in: true }]);

    await CALLBACK(callbackRequest({ code: 'c', state: 'nonce-1' }, await stateCookie({ appendOptIn: false })));

    const consentAt = fakeDb.calls.findIndex((c) => c.table === 'creators' && c.method === 'update');
    const grantAt = fakeDb.calls.findIndex((c) => c.table === 'creator_platform_accounts' && c.method === 'upsert');
    // Otherwise there is a window in which a fresh write-scoped token sits
    // beside a `true` the creator has just unticked, and a concurrent
    // `assertAppendAllowed` says yes in it.
    expect(consentAt).toBeGreaterThanOrEqual(0);
    expect(consentAt).toBeLessThan(grantAt);
  });

  it('does not report a connection when the consent write failed', async () => {
    googleSaidYes();
    fakeDb.queue('creator_platform_accounts', { error: null });
    fakeDb.queue('creators', { error: { message: 'permission denied' } });

    const res = await CALLBACK(callbackRequest({ code: 'c', state: 'nonce-1' }, await stateCookie({ appendOptIn: true })));

    // The result used to be discarded, so a failed consent write still returned
    // `youtube=connected` and logged `appendOptIn=false` — an audit line
    // asserting a permission change that never happened.
    expect(res.headers.get('location')).toContain('youtube=failed');
    expect(JSON.stringify(log.mock.calls)).not.toContain('appendOptIn=true');
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
      canReadCaptions: true,
    });
    expect(JSON.stringify(body)).not.toContain('super-secret-refresh');
    expect(JSON.stringify(body)).not.toContain('ya29-token');
  });

  /**
   * MEAL-138. The visible-consequence half: a read-only grant means every video
   * with a description under about 250 characters is unimportable, and until this
   * field existed nothing anywhere said so — not the card, not the log, not the
   * row the video was written to.
   */
  it('says when a connection cannot read captions, which is the whole silent failure', async () => {
    asUser();
    fakeDb.queue('creators', { data: { id: 'c1', youtube_url: null, youtube_append_opt_in: false } });
    // The ordinary grant since `force-ssl` became incremental: a creator who
    // connected without ticking description editing.
    fakeDb.queue('creator_platform_accounts', {
      data: grantRow({ scopes: 'https://www.googleapis.com/auth/youtube.readonly' }),
    });

    const body = await (await GET(jsonRequest('/api/creator/youtube', { method: 'GET', token }))).json();

    expect(body).toMatchObject({ connected: true, canReadCaptions: false, canWriteDescriptions: false });
  });

  /**
   * `hasChannel` is what decides whether the append setting is offered at all
   * (MEAL-78). It is not the enforcement — `assertAppendAllowed` is — but a
   * consent prompt about a channel that does not exist is one a creator learns
   * to click past, so it has to be right.
   */
  it('reports no channel for a creator with neither a link nor a grant', async () => {
    asUser();
    fakeDb.queue('creators', { data: { id: 'c1', youtube_url: null, youtube_append_opt_in: false } });
    fakeDb.queue('creator_platform_accounts', { data: null });

    const body = await (await GET(jsonRequest('/api/creator/youtube', { method: 'GET', token }))).json();

    expect(body).toMatchObject({ hasChannel: false, connected: false, appendOptIn: false });
  });

  it('reports a channel on a link alone, so a creator who adds one can connect it', async () => {
    asUser();
    // The MEAL-94 case: joined without YouTube, started a channel later, added
    // the link. Nothing is connected yet and the offer is still honest.
    fakeDb.queue('creators', { data: { id: 'c1', youtube_url: 'https://youtube.com/@chefsarah', youtube_append_opt_in: false } });
    fakeDb.queue('creator_platform_accounts', { data: null });

    const body = await (await GET(jsonRequest('/api/creator/youtube', { method: 'GET', token }))).json();

    expect(body).toMatchObject({ hasChannel: true, connected: false });
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
    // A real broken grant, not an absent one: revocation that only works while
    // everything else is healthy is not revocation, and this is the state a
    // creator is most likely to be in when they want to withdraw.
    fakeDb.seed('creators', [{ id: 'c1', user_id: 'u1', youtube_url: null, youtube_append_opt_in: true }]);
    fakeDb.seed('creator_platform_accounts', [grantRow({ broken_reason: 'Token has been expired or revoked.' })]);

    const res = await PATCH(jsonRequest('/api/creator/youtube', { method: 'PATCH', token, body: { appendOptIn: false } }));

    expect(res.status).toBe(200);
    expect(fakeDb.row('creators', 'c1')?.youtube_append_opt_in).toBe(false);
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

  it('does not report a disconnect that did not happen', async () => {
    asUser();
    fakeDb.queue('creators', { data: { id: 'c1', youtube_append_opt_in: true } });
    fakeDb.queue('creators', { error: null });
    fakeDb.queue('creator_platform_accounts', { error: { message: 'permission denied' } });

    const res = await DELETE(jsonRequest('/api/creator/youtube', { method: 'DELETE', token }));

    // The error was never destructured, never checked and never surfaced: a
    // failed delete left the refresh token stored and the grant live at Google
    // while the creator was told the channel was disconnected. Of everything
    // here this is the one action that must not report success optimistically.
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/still stored/i);
  });

  it('does not remove the grant when the consent could not be withdrawn', async () => {
    asUser();
    fakeDb.queue('creators', { data: { id: 'c1', youtube_append_opt_in: true } });
    fakeDb.queue('creators', { error: { message: 'permission denied' } });

    const res = await DELETE(jsonRequest('/api/creator/youtube', { method: 'DELETE', token }));

    expect(res.status).toBe(500);
    // Consent off with a token still stored blocks every append. A deleted
    // token with consent still standing would not, so the order matters.
    expect(fakeDb.calls.some((c) => c.table === 'creator_platform_accounts' && c.method === 'delete')).toBe(false);
  });
});
