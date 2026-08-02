import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { fakeDb } from '../helpers/supabase-mock';

const log = vi.fn();
vi.mock('@/lib/logger', () => ({ log: (...args: unknown[]) => log(...args) }));

import {
  describeConnection,
  refreshExpiringTokens,
  refreshGoogleGrant,
  refreshInstagramGrant,
  refreshTikTokGrant,
  usableAccessToken,
  EXPIRY_SKEW_MS,
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
    // All three real platforms have one now, so this uses a registry that is
    // deliberately missing an entry. The property survives the platforms:
    // "we have not built this yet" is a fact about us, not about the creator's
    // grant, and it must not put a working connection on a reconnect list.
    fakeDb.queue('creator_platform_accounts', { data: [row({ platform: 'instagram' })] });

    const result = await refreshExpiringTokens({ supabase, now, refreshers: { youtube: working } });

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

  it('says plainly that a lapsed Instagram token cannot be recovered', async () => {
    const fetchImpl = answering({ error: { message: 'Error validating access token: Session has expired' } }, 400);

    const outcome = await refreshInstagramGrant(igConnection(), { fetchImpl, now });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    // The refresh only works while the token is alive. Miss the window and there
    // is no path back except the creator consenting again.
    expect(outcome.reason).toMatch(/Session has expired/);
    expect(outcome.reason).toMatch(/reconnect/i);
    expect(outcome.retryable).toBeFalsy();
  });

  it('refuses when there is no stored token rather than silently doing nothing', async () => {
    const outcome = await refreshInstagramGrant(igConnection({ accessToken: null }), { now });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toMatch(/reconnect/i);
  });

  it('marks a network failure retryable, because it says nothing about the grant', async () => {
    const fetchImpl = (async () => { throw new Error('socket hang up'); }) as typeof fetch;

    const outcome = await refreshInstagramGrant(igConnection(), { fetchImpl, now });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.retryable).toBe(true);
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

  it('reports TikTok’s words without echoing the token that was sent', async () => {
    const fetchImpl = answering({ error: 'invalid_grant', error_description: 'Refresh token is invalid or expired.' }, 400);

    const outcome = await refreshTikTokGrant(ttConnection(), { fetchImpl, now });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toMatch(/invalid or expired/i);
    expect(outcome.reason).not.toContain('rft.super-secret');
  });

  it('refuses without a stored refresh token', async () => {
    const outcome = await refreshTikTokGrant(ttConnection({ refreshToken: null }), { now });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toMatch(/reconnect/i);
  });
});

// ── The registry, and the bound on retrying ──────────────────────────────────

describe('platform-tokens — every connected platform has a refresher', () => {
  it('registers all three, so no grant is skipped by the sweep', () => {
    // A platform with no entry is skipped rather than broken, which is right —
    // but a *shipped* platform being skipped is a grant nobody renews.
    expect(Object.keys(TOKEN_REFRESHERS).sort()).toEqual(['instagram', 'tiktok', 'youtube']);
  });
});

describe('platform-tokens — a provider outage does not disconnect everybody', () => {
  const unreachable: TokenRefresher = async () => ({ ok: false, reason: 'socket hang up', retryable: true });

  it('leaves a grant untouched when the provider is unreachable and the token has life left', async () => {
    // Five days out: the sweep starts renewing a week early, so there are
    // several more passes before anything actually lapses.
    fakeDb.queue('creator_platform_accounts', {
      data: [row({ platform: 'instagram', expires_at: new Date(NOW + 5 * 24 * 60 * 60 * 1000).toISOString() })],
    });

    const result = await refreshExpiringTokens({ supabase, now, refreshers: { instagram: unreachable } });

    expect(result).toMatchObject({ checked: 1, refreshed: 0, broken: 0, retried: 1 });
    // Nothing is written. For Instagram, marking this broken would clear the
    // access token — the only credential there is — and turn a false alarm into
    // a real disconnection.
    expect(fakeDb.calls.some((call) => call.method === 'update')).toBe(false);
  });

  it('breaks it anyway once the token itself has expired', async () => {
    fakeDb.queue('creator_platform_accounts', {
      data: [row({ platform: 'instagram', expires_at: new Date(NOW - 1000).toISOString() })],
    });

    const result = await refreshExpiringTokens({ supabase, now, refreshers: { instagram: unreachable } });

    // Retrying forever over a dead token is how a broken connection looks
    // healthy while the poller quietly finds nothing.
    expect(result).toMatchObject({ broken: 1, retried: 0 });
    const update = fakeDb.calls.find((call) => call.method === 'update')?.args[0] as Record<string, unknown>;
    expect(update.broken_reason).toMatch(/socket hang up/);
  });
});
