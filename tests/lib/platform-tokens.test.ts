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
  usableAccessToken,
  EXPIRY_SKEW_MS,
  REFRESH_BATCH,
  REFRESH_WINDOW_MS,
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
});

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
