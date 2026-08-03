import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { fakeDb } from '../helpers/supabase-mock';

const log = vi.fn();
vi.mock('@/lib/logger', () => ({ log: (...args: unknown[]) => log(...args) }));

import {
  describeConnection,
  refreshConnection,
  refreshExpiringTokens,
  refreshGoogleGrant,
  refreshInstagramGrant,
  refreshTikTokGrant,
  usableAccessToken,
  EXPIRY_SKEW_MS,
  REFRESH_BATCH,
  REFRESH_WINDOW_MS,
  TOKEN_REFRESHERS,
  type PlatformConnection,
  type TokenRefresher,
} from '@/lib/platform-tokens';

/**
 * The shared refresh worker (MEAL-74, reused by MEAL-82 / MEAL-83).
 *
 * The failure it exists for is silent: an expired or revoked grant produces a
 * poller that finds nothing, not an error. So the assertions that matter are
 * about what gets *written* when a refresh fails, and about a refresh token
 * never reaching a log line or a response.
 *
 * These run against `FakeSupabase`'s stored rows rather than queued results, so
 * a filter that is missing or misspelled changes which rows come back and which
 * ones a write touches. The whole point of the two concurrency properties below
 * — "a transient failure writes nothing" and "a stale write does not land" — is
 * unrepresentable against a stub that only records call arguments.
 */

const TABLE = 'creator_platform_accounts';
const supabase = fakeDb as unknown as SupabaseClient;
const NOW = 1_800_000_000_000;
const now = () => NOW;
/** Retries are exercised for real; the backoff itself is not worth waiting for. */
const sleep = async () => undefined;

function connection(overrides: Partial<PlatformConnection> = {}): PlatformConnection {
  return {
    id: 'pa1',
    creatorId: 'c1',
    platform: 'youtube',
    externalId: 'UCabcdefghijklmnopqrstuv',
    externalName: 'Chef Sarah',
    accessToken: 'ya29-token',
    refreshToken: '1//super-secret-refresh',
    scopes: ['https://www.googleapis.com/auth/youtube.readonly'],
    expiresAt: new Date(NOW + 3_600_000).toISOString(),
    brokenReason: null,
    brokenAt: null,
    updatedAt: new Date(NOW - 3_600_000).toISOString(),
    ...overrides,
  };
}

/** The row shape `creator_platform_accounts` hands back. */
function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pa1',
    creator_id: 'c1',
    platform: 'youtube',
    external_id: 'UCabcdefghijklmnopqrstuv',
    external_name: 'Chef Sarah',
    access_token: 'stale-token',
    refresh_token: '1//super-secret-refresh',
    scopes: 'https://www.googleapis.com/auth/youtube.readonly',
    expires_at: new Date(NOW + 1000).toISOString(),
    broken_reason: null,
    broken_at: null,
    updated_at: new Date(NOW - 3_600_000).toISOString(),
    ...overrides,
  };
}

/** Every argument every call was made with, flattened — for "did this leak?" checks. */
function everythingWritten(): string {
  return JSON.stringify({ calls: fakeDb.calls, logs: log.mock.calls });
}

const working: TokenRefresher = async () => ({
  ok: true,
  grant: { accessToken: 'fresh-token', expiresAt: new Date(NOW + 3_600_000).toISOString() },
});

/** The creator revoked us in their Google account. The only terminal failure. */
const revoked: TokenRefresher = async () => ({
  ok: false,
  reason: 'Google refused to refresh this grant: Token has been expired or revoked.',
  terminal: true,
});

/** Google's token endpoint is having a bad thirty seconds. */
const outage: TokenRefresher = async () => ({
  ok: false,
  reason: 'Google did not answer the refresh request: socket hang up',
});

beforeEach(() => {
  fakeDb.reset();
  log.mockReset();
  process.env.GOOGLE_CLIENT_ID = 'client-id.apps.googleusercontent.com';
  process.env.GOOGLE_CLIENT_SECRET = 'client-secret';
  process.env.TIKTOK_CLIENT_KEY = 'tiktok-client-key';
  process.env.TIKTOK_CLIENT_SECRET = 'tiktok-client-secret';
});

/** A fetch that answers once with `body` at `status`, recording what it was sent. */
function answering(body: unknown, status = 200) {
  const impl = vi.fn(async () =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
  ) as unknown as typeof fetch;
  return impl;
}

function sentTo(impl: typeof fetch): { url: string; init: RequestInit } {
  const [url, init] = (impl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
  return { url: String(url), init: (init ?? {}) as RequestInit };
}

// ── The projection ───────────────────────────────────────────────────────────

describe('platform-tokens — tokens do not leave the module', () => {
  it('describeConnection carries no access or refresh token', () => {
    const summary = describeConnection(connection());
    expect(JSON.stringify(summary)).not.toContain('super-secret-refresh');
    expect(JSON.stringify(summary)).not.toContain('ya29-token');
    expect(summary.externalName).toBe('Chef Sarah');
  });
});

// ── The sweep ────────────────────────────────────────────────────────────────

describe('platform-tokens — the refresh sweep', () => {
  it('takes grants near expiry and leaves the healthy and the already-broken alone', async () => {
    fakeDb.seed(TABLE, [
      row({ id: 'due' }),
      row({ id: 'not-due', expires_at: new Date(NOW + REFRESH_WINDOW_MS + 60_000).toISOString() }),
      // Already broken: it needs the creator to reconnect, and retrying it daily
      // forever buries the ones that just broke under the ones that broke in March.
      row({ id: 'already-broken', broken_reason: 'revoked', broken_at: new Date(NOW).toISOString() }),
    ]);

    const result = await refreshExpiringTokens({ supabase, now, sleep, refreshers: { youtube: working } });

    expect(result).toMatchObject({ checked: 1, refreshed: 1 });
    expect(fakeDb.row(TABLE, 'due')?.access_token).toBe('fresh-token');
    expect(fakeDb.row(TABLE, 'not-due')?.access_token).toBe('stale-token');
    expect(fakeDb.row(TABLE, 'already-broken')?.access_token).toBe('stale-token');
  });

  it('sweeps a grant whose expiry is missing rather than treating it as healthy', async () => {
    // `exchangeYouTubeCode` stores null whenever Google omits `expires_in`. A row
    // excluded from the sweep for having no expiry is one nothing ever questions
    // — the silent poller-finds-nothing failure this module exists to eliminate.
    fakeDb.seed(TABLE, [row({ id: 'no-expiry', expires_at: null })]);

    const result = await refreshExpiringTokens({ supabase, now, sleep, refreshers: { youtube: working } });

    expect(result).toMatchObject({ checked: 1, refreshed: 1 });
    expect(fakeDb.row(TABLE, 'no-expiry')?.access_token).toBe('fresh-token');
  });

  it('stores the new token and clears the broken flag', async () => {
    fakeDb.seed(TABLE, [row()]);

    const result = await refreshExpiringTokens({ supabase, now, sleep, refreshers: { youtube: working } });

    expect(result).toMatchObject({ checked: 1, refreshed: 1, broken: 0, deferred: 0 });
    expect(fakeDb.row(TABLE, 'pa1')).toMatchObject({
      access_token: 'fresh-token',
      broken_reason: null,
      broken_at: null,
    });
  });

  it('records why a grant broke instead of leaving the poller to find nothing', async () => {
    fakeDb.seed(TABLE, [row()]);

    const result = await refreshExpiringTokens({ supabase, now, sleep, refreshers: { youtube: revoked } });

    expect(result).toMatchObject({ refreshed: 0, broken: 1 });
    const written = fakeDb.row(TABLE, 'pa1')!;
    expect(written.broken_reason).toMatch(/expired or revoked/i);
    expect(written.broken_at).toBe(new Date(NOW).toISOString());
    // A token we know is dead is worse than none: a caller that finds one will
    // use it and get an opaque 401 instead of the reason recorded here.
    expect(written.access_token).toBeNull();
  });

  it('a Google outage retries and defers — it does not disconnect every creator', async () => {
    fakeDb.seed(TABLE, [row({ id: 'pa1' }), row({ id: 'pa2' })]);
    const flaky = vi.fn(outage);

    const result = await refreshExpiringTokens({ supabase, now, sleep, refreshers: { youtube: flaky } });

    // Thirty seconds of 503s from Google's token endpoint used to mark every
    // connected creator broken with their access token nulled, and the sweep
    // excludes broken rows, so nothing ever revisited them. Every one of those
    // creators had to reconnect by hand for an outage that fixed itself.
    expect(result).toMatchObject({ checked: 2, refreshed: 0, broken: 0, deferred: 2 });
    for (const id of ['pa1', 'pa2']) {
      expect(fakeDb.row(TABLE, id)).toMatchObject({ access_token: 'stale-token', broken_reason: null, broken_at: null });
    }
    // Retried before being given up on, so a blip inside one run is ridden out.
    expect(flaky).toHaveBeenCalledTimes(6);
  });

  it('a refresher that throws is deferred, not treated as a revoked grant', async () => {
    fakeDb.seed(TABLE, [row()]);
    const throwing: TokenRefresher = async () => {
      throw new Error('socket hang up');
    };

    const result = await refreshExpiringTokens({ supabase, now, sleep, refreshers: { youtube: throwing } });

    // A thrown fetch is a fact about the network or about our code. It says
    // nothing about whether the creator still consents.
    expect(result).toMatchObject({ deferred: 1, broken: 0 });
    expect(fakeDb.row(TABLE, 'pa1')?.broken_reason).toBeNull();
  });

  it('one dead grant does not stop the sweep reaching the rest', async () => {
    fakeDb.seed(TABLE, [row({ id: 'pa1' }), row({ id: 'pa2' })]);
    const oneRevoked: TokenRefresher = async (conn, options) =>
      conn.id === 'pa1' ? revoked(conn, options) : working(conn, options);

    const result = await refreshExpiringTokens({ supabase, now, sleep, refreshers: { youtube: oneRevoked } });

    expect(result).toMatchObject({ checked: 2, refreshed: 1, broken: 1 });
    expect(fakeDb.row(TABLE, 'pa2')?.access_token).toBe('fresh-token');
  });

  it('does not mark a platform broken just because we have not built its refresher', async () => {
    fakeDb.seed(TABLE, [row({ platform: 'instagram' })]);

    const result = await refreshExpiringTokens({ supabase, now, sleep, refreshers: { youtube: working } });

    // MEAL-82 is not built. That is a fact about us, not about the creator's
    // grant, and it must not put a working connection on a reconnect list.
    expect(result).toMatchObject({ checked: 0, broken: 0 });
    expect(fakeDb.row(TABLE, 'pa1')?.access_token).toBe('stale-token');
  });

  it('gives every platform its own share of the batch instead of ordering by expiry', async () => {
    // Google's access tokens live an hour, so every connected YouTube row sorts
    // ahead of an Instagram grant a day out. One batch ordered by expiry is
    // therefore entirely YouTube past ~100 connected creators, and Instagram and
    // TikTok — whose refresh tokens actually die if this sweep misses them — are
    // never reached at all.
    const crowd = Array.from({ length: REFRESH_BATCH + 1 }, (_, index) =>
      row({ id: `yt-${index}`, expires_at: new Date(NOW + 1000 + index).toISOString() }),
    );
    fakeDb.seed(TABLE, [
      ...crowd,
      row({ id: 'ig-1', platform: 'instagram', expires_at: new Date(NOW + 86_400_000).toISOString() }),
    ]);

    const result = await refreshExpiringTokens({
      supabase,
      now,
      sleep,
      refreshers: { youtube: working, instagram: working },
    });

    expect(fakeDb.row(TABLE, 'ig-1')?.access_token).toBe('fresh-token');
    // And the total is still bounded by one batch, so a platform added later
    // does not lengthen the cron.
    expect(result.checked).toBeLessThanOrEqual(REFRESH_BATCH);
  });

  it('reaches an Instagram grant a week out, and leaves the same YouTube row alone', async () => {
    // The window means different things per platform. YouTube and TikTok hold a
    // refresh token that outlives the access token, so a missed renewal costs
    // nothing — tomorrow's pass succeeds with the same refresh token. Instagram
    // has no refresh token: the long-lived access token IS the credential and
    // renews only while still valid, so the window is not slack, it is the
    // number of daily attempts before an unrecoverable disconnection. At two
    // days, a two-day Instagram outage loses the creator permanently.
    const weekOut = new Date(NOW + 7 * 86_400_000).toISOString();
    fakeDb.seed(TABLE, [
      row({ id: 'ig-week', platform: 'instagram', expires_at: weekOut }),
      row({ id: 'yt-week', platform: 'youtube', expires_at: weekOut }),
    ]);

    await refreshExpiringTokens({
      supabase, now, sleep,
      refreshers: { youtube: working, instagram: working },
    });

    expect(fakeDb.row(TABLE, 'ig-week')?.access_token).toBe('fresh-token');
    // Untouched: nothing is lost by catching it nearer the time.
    expect(fakeDb.row(TABLE, 'yt-week')?.access_token).not.toBe('fresh-token');
  });

  it('never writes a refresh token into a log line', async () => {
    fakeDb.seed(TABLE, [row()]);
    await refreshExpiringTokens({ supabase, now, sleep, refreshers: { youtube: revoked } });
    expect(everythingWritten()).not.toContain('super-secret-refresh');
  });
});

// ── Racing a reconnect ───────────────────────────────────────────────────────

describe('platform-tokens — a sweep must not overwrite a reconnect', () => {
  /**
   * The sweep reads one batch and then makes up to a batch's worth of sequential
   * outbound calls, so a row can be minutes stale by the time it is written back.
   * `saveConnection` upserts on `(creator_id, platform)`, so a creator who
   * revokes and reconnects keeps the same row id — and a blind `.eq('id', …)`
   * lands on their brand-new working grant.
   */
  const reconnectsMidFlight = (outcome: TokenRefresher): TokenRefresher => async (conn, options) => {
    fakeDb.patch(TABLE, conn.id, {
      access_token: 'brand-new-token',
      refresh_token: '1//brand-new-refresh',
      broken_reason: null,
      broken_at: null,
      updated_at: new Date(NOW - 1000).toISOString(),
    });
    return outcome(conn, options);
  };

  it('does not break the new grant on an invalid_grant about the old one', async () => {
    fakeDb.seed(TABLE, [row()]);

    const result = await refreshExpiringTokens({
      supabase,
      now,
      sleep,
      refreshers: { youtube: reconnectsMidFlight(revoked) },
    });

    // The creator watched the card break seconds after they fixed it, and
    // reconnecting hit the same race.
    expect(fakeDb.row(TABLE, 'pa1')).toMatchObject({ access_token: 'brand-new-token', broken_reason: null });
    expect(result.broken).toBe(0);
  });

  it('does not write a token refreshed from the old grant over the new one', async () => {
    fakeDb.seed(TABLE, [row()]);

    const result = await refreshExpiringTokens({
      supabase,
      now,
      sleep,
      refreshers: { youtube: reconnectsMidFlight(working) },
    });

    expect(fakeDb.row(TABLE, 'pa1')?.access_token).toBe('brand-new-token');
    expect(result.refreshed).toBe(0);
  });

  it('still writes when nothing else touched the row', async () => {
    fakeDb.seed(TABLE, [row()]);
    const result = await refreshConnection({ supabase, now, sleep, refreshers: { youtube: working } }, {
      ...connection(),
      updatedAt: row().updated_at as string,
    });
    expect(result.status).toBe('refreshed');
    expect(fakeDb.row(TABLE, 'pa1')?.access_token).toBe('fresh-token');
  });
});

// ── Refresh on demand ────────────────────────────────────────────────────────

describe('platform-tokens — the token a caller actually uses', () => {
  beforeEach(() => fakeDb.seed(TABLE, [row()]));

  it('uses the stored token while it has life left', async () => {
    const refresher = vi.fn(working);
    const token = await usableAccessToken(
      { supabase, now, sleep, refreshers: { youtube: refresher } },
      connection(),
    );
    expect(token).toBe('ya29-token');
    expect(refresher).not.toHaveBeenCalled();
  });

  it('refreshes one about to lapse rather than racing the expiry', async () => {
    const token = await usableAccessToken(
      { supabase, now, sleep, refreshers: { youtube: working } },
      connection({ expiresAt: new Date(NOW + EXPIRY_SKEW_MS - 1).toISOString(), updatedAt: row().updated_at as string }),
    );
    expect(token).toBe('fresh-token');
  });

  it('returns null for a broken connection instead of an expired token', async () => {
    const refresher = vi.fn(working);
    const token = await usableAccessToken(
      { supabase, now, sleep, refreshers: { youtube: refresher } },
      connection({ brokenReason: 'revoked' }),
    );
    expect(token).toBeNull();
    expect(refresher).not.toHaveBeenCalled();
  });

  it('returns null rather than an expired token for a platform with no refresher', async () => {
    // The registry's "skip, don't break" rule is right for the sweep and wrong
    // here. MEAL-82 and MEAL-83 land in exactly this branch on their first day:
    // a connection is stored, nothing can renew it, and the caller was handed
    // the dead token anyway to get an opaque 401 from the platform.
    const token = await usableAccessToken(
      { supabase, now, sleep, refreshers: {} },
      connection({ platform: 'instagram', accessToken: 'IG.DEAD', expiresAt: new Date(NOW - 86_400_000).toISOString() }),
    );
    expect(token).toBeNull();
  });

  it('does not treat an unreadable expiry as proof the token still works', async () => {
    const refresher = vi.fn(working);

    for (const expiresAt of [null, 'whenever']) {
      fakeDb.seed(TABLE, [row()]);
      const token = await usableAccessToken(
        { supabase, now, sleep, refreshers: { youtube: refresher } },
        connection({ expiresAt, accessToken: 'ya29-maybe-dead', updatedAt: row().updated_at as string }),
      );
      // A null or garbage `expires_at` parses to NaN, and reading that as "no
      // expiry" made a dead grant look healthy forever.
      expect(token).toBe('fresh-token');
    }
    expect(refresher).toHaveBeenCalledTimes(2);
  });
});

// ── Google's own refresher ───────────────────────────────────────────────────

describe('platform-tokens — refreshGoogleGrant', () => {
  it('sends the stored refresh token and returns an absolute expiry', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ access_token: 'fresh-token', expires_in: 3599 }), {
        headers: { 'content-type': 'application/json' },
      }),
    ) as unknown as typeof fetch;

    const outcome = await refreshGoogleGrant(connection(), { fetchImpl, now });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.grant.expiresAt).toBe(new Date(NOW + 3_599_000).toISOString());
    const body = String((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(body).toContain('grant_type=refresh_token');
  });

  it('reports a revoked grant with Google’s own words, and calls it terminal', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;

    const outcome = await refreshGoogleGrant(connection(), { fetchImpl, now });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toMatch(/expired or revoked/i);
    expect(outcome.reason).not.toContain('super-secret-refresh');
    expect(outcome.terminal).toBe(true);
  });

  it('calls every other failure transient, whatever it looks like', async () => {
    const answers: Array<[string, () => Promise<Response>]> = [
      ['503', async () => new Response('<html>backend unavailable</html>', { status: 503 })],
      ['500 with a code', async () =>
        new Response(JSON.stringify({ error: 'internal_failure' }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        })],
      ['429', async () => new Response('{}', { status: 429, headers: { 'content-type': 'application/json' } })],
    ];

    for (const [label, fetchImpl] of answers) {
      const outcome = await refreshGoogleGrant(connection(), { fetchImpl: fetchImpl as typeof fetch, now });
      expect(outcome.ok, label).toBe(false);
      if (outcome.ok) return;
      // Only `invalid_grant` says anything about the grant. Everything else is
      // the network between us and Google, and is retried.
      expect(outcome.terminal, label).toBeFalsy();
    }
  });

  it('treats a socket error as transient and a missing client secret as not the creator’s problem', async () => {
    const exploding = (async () => {
      throw new Error('ECONNRESET');
    }) as typeof fetch;
    const thrown = await refreshGoogleGrant(connection(), { fetchImpl: exploding, now });
    expect(thrown.ok).toBe(false);
    if (thrown.ok) return;
    expect(thrown.terminal).toBeFalsy();

    delete process.env.GOOGLE_CLIENT_SECRET;
    const unconfigured = await refreshGoogleGrant(connection(), { now });
    expect(unconfigured.ok).toBe(false);
    if (unconfigured.ok) return;
    // A missing env var breaks every creator on the deployment at once and is
    // fixed by setting the variable, not by anyone reconnecting.
    expect(unconfigured.terminal).toBeFalsy();
  });

  it('refuses without a stored refresh token rather than silently doing nothing', async () => {
    const outcome = await refreshGoogleGrant(connection({ refreshToken: null }), { now });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toMatch(/reconnect/i);
    // Nothing to retry with: no amount of waiting produces a refresh token.
    expect(outcome.terminal).toBe(true);
  });
});

// ── Instagram's refresher (MEAL-82) ──────────────────────────────────────────

describe('platform-tokens — refreshInstagramGrant', () => {
  const igConnection = (overrides: Partial<PlatformConnection> = {}) =>
    connection({
      platform: 'instagram',
      accessToken: 'IGQ-long-lived',
      // There is no refresh token on Instagram. The access token is the only
      // credential there is, and it renews itself.
      refreshToken: null,
      expiresAt: new Date(NOW + 5 * 24 * 60 * 60 * 1000).toISOString(),
      ...overrides,
    });

  it('trades the still-valid access token for a new one', async () => {
    const fetchImpl = answering({ access_token: 'IGQ-renewed', token_type: 'bearer', expires_in: 5_184_000 });

    const outcome = await refreshInstagramGrant(igConnection(), { fetchImpl, now });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.grant.accessToken).toBe('IGQ-renewed');
    expect(outcome.grant.expiresAt).toBe(new Date(NOW + 5_184_000_000).toISOString());
    // Not an OAuth refresh-token exchange: the current token is what is sent.
    expect(sentTo(fetchImpl).url).toContain('grant_type=ig_refresh_token');
    expect(sentTo(fetchImpl).url).toContain('IGQ-long-lived');
  });

  it('calls Instagram’s own dead-token code terminal, and says so plainly', async () => {
    const fetchImpl = answering(
      {
        error: {
          message: 'Error validating access token: Session has expired',
          type: 'OAuthException',
          code: 190,
          fbtrace_id: 'Axxxxxxxxxx',
        },
      },
      400,
    );

    const outcome = await refreshInstagramGrant(igConnection(), { fetchImpl, now });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    // The refresh only works while the token is alive. Miss the window and there
    // is no path back except the creator consenting again.
    expect(outcome.reason).toMatch(/Session has expired/);
    expect(outcome.reason).toMatch(/reconnect/i);
    expect(outcome.terminal).toBe(true);
  });

  it('does not read a 4xx as a dead grant just because it is a 4xx', async () => {
    // Code 4 is Instagram's *app rate limit* and arrives as a 400. Breaking the
    // connection on it would take a creator's account out of service because we
    // asked Instagram too many questions in an hour — and on Instagram breaking
    // it clears the only credential there is.
    const answers: Array<[string, ReturnType<typeof answering>]> = [
      ['rate limit', answering({ error: { message: 'Application request limit reached', code: 4 } }, 400)],
      ['transient', answering({ error: { message: 'Please retry your request later', code: 2 } }, 500)],
      ['503 with no JSON at all', answering('backend unavailable', 503)],
    ];

    for (const [label, fetchImpl] of answers) {
      const outcome = await refreshInstagramGrant(igConnection(), { fetchImpl, now });
      expect(outcome.ok, label).toBe(false);
      if (outcome.ok) return;
      expect(outcome.terminal, label).toBeFalsy();
    }
  });

  it('treats a socket error as transient — it says nothing about the grant', async () => {
    const fetchImpl = (async () => {
      throw new Error('socket hang up');
    }) as typeof fetch;

    const outcome = await refreshInstagramGrant(igConnection(), { fetchImpl, now });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.terminal).toBeFalsy();
  });

  it('refuses when there is no stored token rather than silently doing nothing', async () => {
    const outcome = await refreshInstagramGrant(igConnection({ accessToken: null }), { now });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toMatch(/reconnect/i);
    // Instagram has no second credential, so there is nothing a later attempt
    // could send. This one really is terminal.
    expect(outcome.terminal).toBe(true);
  });
});

// ── TikTok's refresher (MEAL-83) ─────────────────────────────────────────────

describe('platform-tokens — refreshTikTokGrant', () => {
  const ttConnection = (overrides: Partial<PlatformConnection> = {}) =>
    connection({
      platform: 'tiktok',
      accessToken: 'act.stale',
      refreshToken: 'rft.super-secret',
      expiresAt: new Date(NOW + 3_600_000).toISOString(),
      ...overrides,
    });

  it('returns the rotated refresh token, which must replace the one just spent', async () => {
    const fetchImpl = answering({
      access_token: 'act.fresh',
      expires_in: 86_400,
      refresh_token: 'rft.rotated',
      refresh_expires_in: 31_536_000,
      scope: 'video.list',
    });

    const outcome = await refreshTikTokGrant(ttConnection(), { fetchImpl, now });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // Every refresh invalidates the token it was given. Failing to store the
    // replacement costs the creator a re-consent a year before anything expired.
    expect(outcome.grant.refreshToken).toBe('rft.rotated');
    expect(outcome.grant.accessToken).toBe('act.fresh');
    expect(outcome.grant.expiresAt).toBe(new Date(NOW + 86_400_000).toISOString());
    expect(String(sentTo(fetchImpl).init.body)).toContain('grant_type=refresh_token');
  });

  it('calls a revoked refresh token terminal, without echoing the token that was sent', async () => {
    const fetchImpl = answering({ error: 'invalid_grant', error_description: 'Refresh token is invalid or expired.' }, 400);

    const outcome = await refreshTikTokGrant(ttConnection(), { fetchImpl, now });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toMatch(/invalid or expired/i);
    expect(outcome.reason).not.toContain('rft.super-secret');
    expect(outcome.terminal).toBe(true);
  });

  it('calls every other failure transient, whatever it looks like', async () => {
    const answers: Array<[string, () => Promise<Response>]> = [
      ['503 from the edge', async () => new Response('<html>backend unavailable</html>', { status: 503 })],
      ['internal_error', async () =>
        new Response(JSON.stringify({ error: 'internal_error', error_description: 'try again' }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        })],
      ['rate limit', async () =>
        new Response(JSON.stringify({ error: 'rate_limit_exceeded' }), {
          status: 429,
          headers: { 'content-type': 'application/json' },
        })],
    ];

    for (const [label, fetchImpl] of answers) {
      const outcome = await refreshTikTokGrant(ttConnection(), { fetchImpl: fetchImpl as typeof fetch, now });
      expect(outcome.ok, label).toBe(false);
      if (outcome.ok) return;
      expect(outcome.terminal, label).toBeFalsy();
    }

    const exploding = (async () => {
      throw new Error('ECONNRESET');
    }) as typeof fetch;
    const thrown = await refreshTikTokGrant(ttConnection(), { fetchImpl: exploding, now });
    expect(thrown.ok).toBe(false);
    if (thrown.ok) return;
    expect(thrown.terminal).toBeFalsy();

    delete process.env.TIKTOK_CLIENT_SECRET;
    const unconfigured = await refreshTikTokGrant(ttConnection(), { now });
    expect(unconfigured.ok).toBe(false);
    if (unconfigured.ok) return;
    // A missing env var breaks every TikTok creator on the deployment at once
    // and is fixed by setting the variable, not by anyone reconnecting.
    expect(unconfigured.terminal).toBeFalsy();
  });

  it('refuses without a stored refresh token', async () => {
    const outcome = await refreshTikTokGrant(ttConnection({ refreshToken: null }), { now });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toMatch(/reconnect/i);
    expect(outcome.terminal).toBe(true);
  });
});

// ── The registry ─────────────────────────────────────────────────────────────

describe('platform-tokens — every connected platform has a refresher', () => {
  it('registers all three, so no shipped grant is skipped by the sweep', () => {
    // A platform with no entry is skipped rather than broken, which is right —
    // but a *shipped* platform being skipped is a grant nobody renews, and
    // `usableAccessToken` hands its caller null rather than a stale token.
    expect(Object.keys(TOKEN_REFRESHERS).sort()).toEqual(['instagram', 'tiktok', 'youtube']);
  });
});

// ── The same rule, on every platform ─────────────────────────────────────────

/**
 * The polarity, end to end and per platform.
 *
 * Two branches independently invented this contract with opposite defaults. Opt
 * *in* to retrying means an unclassified failure disconnects the creator, and a
 * thirty-second outage at a provider therefore disconnects every creator
 * connected to it — permanently, because the sweep excludes broken rows. Opt
 * *in* to breaking means an unclassified failure costs a day. These run the real
 * refreshers against real provider answers, through the real sweep, so the rule
 * is asserted where it is actually applied rather than on the flag.
 */
describe('platform-tokens — an outage defers, a dead grant breaks', () => {
  const igRow = (overrides: Record<string, unknown> = {}) =>
    row({
      id: 'ig-1',
      platform: 'instagram',
      access_token: 'IGQ-long-lived',
      refresh_token: null,
      // Inside the sweep's window and still a day and a half from lapsing: a
      // token with life left in it, which is the whole point of not breaking it.
      expires_at: new Date(NOW + 36 * 60 * 60 * 1000).toISOString(),
      ...overrides,
    });

  const ttRow = (overrides: Record<string, unknown> = {}) =>
    row({
      id: 'tt-1',
      platform: 'tiktok',
      access_token: 'act.stale',
      refresh_token: 'rft.super-secret',
      expires_at: new Date(NOW + 3_600_000).toISOString(),
      ...overrides,
    });

  const sweep = (platform: 'instagram' | 'tiktok', fetchImpl: typeof fetch) =>
    refreshExpiringTokens({
      supabase,
      now,
      sleep,
      fetchImpl,
      refreshers:
        platform === 'instagram'
          ? { instagram: refreshInstagramGrant }
          : { tiktok: refreshTikTokGrant },
    });

  const exploding = (async () => {
    throw new Error('socket hang up');
  }) as typeof fetch;
  const unavailable = (async () => new Response('<html>502 Bad Gateway</html>', { status: 502 })) as typeof fetch;

  it('leaves an Instagram grant untouched when Instagram is unreachable', async () => {
    for (const [label, fetchImpl] of [['socket', exploding], ['5xx', unavailable]] as const) {
      fakeDb.seed(TABLE, [igRow()]);

      const result = await sweep('instagram', fetchImpl);

      expect(result, label).toMatchObject({ checked: 1, refreshed: 0, broken: 0, deferred: 1 });
      // Nothing written at all. Marking this broken clears `access_token`, and on
      // Instagram that is the only credential there is — a false alarm would not
      // just flag a working grant, it would destroy it. The row keeps
      // `broken_reason` null, so it is still in tomorrow's sweep.
      expect(fakeDb.row(TABLE, 'ig-1'), label).toMatchObject({
        access_token: 'IGQ-long-lived',
        broken_reason: null,
        broken_at: null,
      });
    }
  });

  it('breaks an Instagram grant when Instagram says the token is gone', async () => {
    fakeDb.seed(TABLE, [igRow()]);
    const dead = (async () =>
      new Response(
        JSON.stringify({ error: { message: 'Error validating access token', type: 'OAuthException', code: 190 } }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      )) as typeof fetch;

    const result = await sweep('instagram', dead);

    expect(result).toMatchObject({ broken: 1, deferred: 0 });
    const written = fakeDb.row(TABLE, 'ig-1')!;
    expect(written.broken_reason).toMatch(/no longer valid/i);
    expect(written.broken_reason).toMatch(/reconnect/i);
    expect(written.access_token).toBeNull();
  });

  it('leaves a TikTok grant untouched when TikTok is unreachable', async () => {
    for (const [label, fetchImpl] of [['socket', exploding], ['5xx', unavailable]] as const) {
      fakeDb.seed(TABLE, [ttRow()]);

      const result = await sweep('tiktok', fetchImpl);

      expect(result, label).toMatchObject({ checked: 1, refreshed: 0, broken: 0, deferred: 1 });
      expect(fakeDb.row(TABLE, 'tt-1'), label).toMatchObject({
        access_token: 'act.stale',
        // The refresh token is the one that must survive an outage: it is what
        // every future attempt is made with, and TikTok rotates it away on the
        // first success after the provider comes back.
        refresh_token: 'rft.super-secret',
        broken_reason: null,
      });
    }
  });

  it('breaks a TikTok grant when TikTok says the refresh token is dead', async () => {
    fakeDb.seed(TABLE, [ttRow()]);
    const dead = (async () =>
      new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'Refresh token is invalid or expired.' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;

    const result = await sweep('tiktok', dead);

    expect(result).toMatchObject({ broken: 1, deferred: 0 });
    expect(fakeDb.row(TABLE, 'tt-1')?.broken_reason).toMatch(/invalid or expired/i);
    expect(everythingWritten()).not.toContain('rft.super-secret');
  });

  it('gives up on a grant nothing can renew any more, and says why', async () => {
    // The bound on deferring. Instagram renews a token only while it is still
    // valid, and there is no refresh token behind it, so once the stored token is
    // past its own expiry no later attempt can succeed. Deferring that forever is
    // how a permanently unreachable provider leaves a dead grant with
    // `broken_reason` null, on nobody's list, while the poller finds nothing.
    fakeDb.seed(TABLE, [igRow({ expires_at: new Date(NOW - 1000).toISOString() })]);

    const result = await sweep('instagram', exploding);

    expect(result).toMatchObject({ broken: 1, deferred: 0 });
    const written = fakeDb.row(TABLE, 'ig-1')!;
    // The last error alone would read as "try again tomorrow", which is exactly
    // what will not work. An operator gets the reason and the remedy.
    expect(written.broken_reason).toMatch(/socket hang up/);
    expect(written.broken_reason).toMatch(/no later attempt can succeed/i);
    expect(written.broken_reason).toMatch(/reconnect/i);
  });

  it('keeps deferring a grant that still has a refresh token behind it', async () => {
    // The same shape of failure over an expired *access* token on a platform
    // that has a second credential. Google's access tokens live an hour and the
    // sweep runs daily, so every YouTube row is past its expiry on every pass —
    // bounding on the access token alone would re-break exactly the outage this
    // whole model exists to survive.
    fakeDb.seed(TABLE, [row({ expires_at: new Date(NOW - 86_400_000).toISOString() })]);

    const result = await refreshExpiringTokens({
      supabase,
      now,
      sleep,
      fetchImpl: exploding,
      refreshers: { youtube: refreshGoogleGrant },
    });

    expect(result).toMatchObject({ broken: 0, deferred: 1 });
    expect(fakeDb.row(TABLE, 'pa1')?.broken_reason).toBeNull();
  });
});
