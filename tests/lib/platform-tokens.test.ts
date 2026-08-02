import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { fakeDb } from '../helpers/supabase-mock';

const log = vi.fn();
vi.mock('@/lib/logger', () => ({ log: (...args: unknown[]) => log(...args) }));

import {
  describeConnection,
  refreshExpiringTokens,
  refreshGoogleGrant,
  usableAccessToken,
  EXPIRY_SKEW_MS,
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
 * `tests/helpers/supabase-mock.ts` records calls without modelling filters, so
 * the update assertions below are on the argument shape — that the right columns
 * were written with the right values — rather than on rows actually changing.
 */

const supabase = fakeDb as unknown as SupabaseClient;
const NOW = 1_800_000_000_000;
const now = () => NOW;

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

const failing: TokenRefresher = async () => ({ ok: false, reason: 'Google refused to refresh this grant: invalid_grant' });

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
  it('queries only grants that are near expiry and not already broken', async () => {
    fakeDb.queue('creator_platform_accounts', { data: [] });

    await refreshExpiringTokens({ supabase, now, refreshers: { youtube: working } });

    const calls = fakeDb.calls.filter((call) => call.table === 'creator_platform_accounts');
    // Argument-shape assertions: the mock records filters without applying them.
    expect(calls.find((call) => call.method === 'is')?.args).toEqual(['broken_reason', null]);
    expect(calls.find((call) => call.method === 'lt')?.args).toEqual([
      'expires_at',
      new Date(NOW + REFRESH_WINDOW_MS).toISOString(),
    ]);
    // Already-broken grants need the creator to reconnect. Retrying them daily
    // forever buries the ones that just broke under the ones that broke in March.
    expect(calls.some((call) => call.method === 'in' && call.args[0] === 'platform')).toBe(true);
  });

  it('stores the new token and clears the broken flag', async () => {
    fakeDb.queue('creator_platform_accounts', { data: [row()] });

    const result = await refreshExpiringTokens({ supabase, now, refreshers: { youtube: working } });

    expect(result).toMatchObject({ checked: 1, refreshed: 1, broken: 0 });
    const update = fakeDb.calls.find((call) => call.method === 'update')?.args[0] as Record<string, unknown>;
    expect(update).toMatchObject({ access_token: 'fresh-token', broken_reason: null, broken_at: null });
  });

  it('records why a grant broke instead of leaving the poller to find nothing', async () => {
    fakeDb.queue('creator_platform_accounts', { data: [row()] });

    const result = await refreshExpiringTokens({ supabase, now, refreshers: { youtube: failing } });

    expect(result).toMatchObject({ refreshed: 0, broken: 1 });
    const update = fakeDb.calls.find((call) => call.method === 'update')?.args[0] as Record<string, unknown>;
    expect(update.broken_reason).toMatch(/invalid_grant/);
    expect(update.broken_at).toBe(new Date(NOW).toISOString());
    // A token we know is dead is worse than none: a caller that finds one will
    // use it and get an opaque 401 instead of the reason recorded here.
    expect(update.access_token).toBeNull();
  });

  it('does not mark a platform broken just because we have not built its refresher', async () => {
    fakeDb.queue('creator_platform_accounts', { data: [row({ platform: 'instagram' })] });

    const result = await refreshExpiringTokens({ supabase, now, refreshers: { youtube: working } });

    // MEAL-82 is not built. That is a fact about us, not about the creator's
    // grant, and it must not put a working connection on a reconnect list.
    expect(result).toMatchObject({ checked: 0, skipped: 1, broken: 0 });
    expect(fakeDb.calls.some((call) => call.method === 'update')).toBe(false);
  });

  it('one dead grant does not stop the sweep reaching the rest', async () => {
    fakeDb.queue('creator_platform_accounts', { data: [row({ id: 'pa1' }), row({ id: 'pa2' })] });
    let seen = 0;
    const throwsOnce: TokenRefresher = async () => {
      seen++;
      if (seen === 1) throw new Error('socket hang up');
      return working(connection(), {});
    };

    const result = await refreshExpiringTokens({ supabase, now, refreshers: { youtube: throwsOnce } });

    expect(result).toMatchObject({ checked: 2, refreshed: 1, broken: 1 });
  });

  it('never writes a refresh token into a log line', async () => {
    fakeDb.queue('creator_platform_accounts', { data: [row()] });
    await refreshExpiringTokens({ supabase, now, refreshers: { youtube: failing } });
    expect(everythingWritten()).not.toContain('super-secret-refresh');
  });
});

// ── Refresh on demand ────────────────────────────────────────────────────────

describe('platform-tokens — the token a caller actually uses', () => {
  it('uses the stored token while it has life left', async () => {
    const refresher = vi.fn(working);
    const token = await usableAccessToken(
      { supabase, now, refreshers: { youtube: refresher } },
      connection(),
    );
    expect(token).toBe('ya29-token');
    expect(refresher).not.toHaveBeenCalled();
  });

  it('refreshes one about to lapse rather than racing the expiry', async () => {
    const token = await usableAccessToken(
      { supabase, now, refreshers: { youtube: working } },
      connection({ expiresAt: new Date(NOW + EXPIRY_SKEW_MS - 1).toISOString() }),
    );
    expect(token).toBe('fresh-token');
  });

  it('returns null for a broken connection instead of an expired token', async () => {
    const refresher = vi.fn(working);
    const token = await usableAccessToken(
      { supabase, now, refreshers: { youtube: refresher } },
      connection({ brokenReason: 'revoked' }),
    );
    expect(token).toBeNull();
    expect(refresher).not.toHaveBeenCalled();
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

  it('reports a revoked grant with Google’s own words, and no token', async () => {
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
  });

  it('refuses without a stored refresh token rather than silently doing nothing', async () => {
    const outcome = await refreshGoogleGrant(connection({ refreshToken: null }), { now });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toMatch(/reconnect/i);
  });
});
