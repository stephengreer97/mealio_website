/**
 * Creator platform grants and the worker that keeps them alive (MEAL-74).
 *
 * `creator_platform_accounts` holds one OAuth grant per creator per platform.
 * Everything about reading or writing a creator's channel goes through a row in
 * that table, so this module is deliberately platform-agnostic: YouTube is the
 * first tenant, and MEAL-82 (Instagram) and MEAL-83 (TikTok) are meant to add a
 * refresher and nothing else.
 *
 * **Why the sweep exists even though Google's refresh token never expires.**
 * The three lifetimes are wildly different — Instagram ~60 days and only
 * refreshable while the token is still alive, TikTok up to 365 days, Google
 * until revoked — and all three fail the same way: an expired or revoked grant
 * produces a poller that finds nothing, not an error. Nobody notices, because
 * "this creator posted nothing this week" and "we lost access in March" look
 * identical from the outside. So a failure here writes `broken_reason` /
 * `broken_at`, which is a row an operator can list, rather than going quiet.
 *
 * **Refresh tokens never leave this module.** `PlatformConnection` carries one
 * because refreshing needs it; `describeConnection` is what any route, log line
 * or API response is allowed to see.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { log } from '@/lib/logger';
import { CONNECTED_PLATFORMS, type ConnectedPlatform } from '@/lib/creator-sources';

/** The table this module owns. */
const TABLE = 'creator_platform_accounts';

export interface PlatformConnection {
  id: string;
  creatorId: string;
  platform: ConnectedPlatform;
  /** The platform's own id: YouTube channel id, IG user id, TikTok open id. */
  externalId: string | null;
  externalName: string | null;
  accessToken: string | null;
  /**
   * Never logged, never serialised to a client. Present on this type only
   * because `refreshGrant` needs it — use `describeConnection` everywhere else.
   */
  refreshToken: string | null;
  scopes: string[];
  /** When `accessToken` stops working. What the sweep below queries on. */
  expiresAt: string | null;
  brokenReason: string | null;
  brokenAt: string | null;
}

/** The safe projection: what a route may return and a log line may carry. */
export interface ConnectionSummary {
  platform: ConnectedPlatform;
  externalId: string | null;
  externalName: string | null;
  scopes: string[];
  expiresAt: string | null;
  /** Non-null means the connection needs the creator to reconnect. */
  brokenReason: string | null;
  brokenAt: string | null;
}

export function describeConnection(connection: PlatformConnection): ConnectionSummary {
  return {
    platform: connection.platform,
    externalId: connection.externalId,
    externalName: connection.externalName,
    scopes: connection.scopes,
    expiresAt: connection.expiresAt,
    brokenReason: connection.brokenReason,
    brokenAt: connection.brokenAt,
  };
}

/** Scopes are stored space-separated, the way every OAuth provider sends them. */
function parseScopes(value: unknown): string[] {
  return typeof value === 'string' ? value.split(/\s+/).filter(Boolean) : [];
}

function toConnection(row: Record<string, any>): PlatformConnection {
  return {
    id: row.id,
    creatorId: row.creator_id,
    platform: row.platform,
    externalId: row.external_id ?? null,
    externalName: row.external_name ?? null,
    accessToken: row.access_token ?? null,
    refreshToken: row.refresh_token ?? null,
    scopes: parseScopes(row.scopes),
    expiresAt: row.expires_at ?? null,
    brokenReason: row.broken_reason ?? null,
    brokenAt: row.broken_at ?? null,
  };
}

/** Every column this module reads. `select *` would drag refresh tokens further than they need to go. */
const CONNECTION_FIELDS =
  'id, creator_id, platform, external_id, external_name, access_token, refresh_token, scopes, expires_at, broken_reason, broken_at';

export async function loadConnection(
  supabase: SupabaseClient,
  creatorId: string,
  platform: ConnectedPlatform,
): Promise<PlatformConnection | null> {
  const { data } = await supabase
    .from(TABLE)
    .select(CONNECTION_FIELDS)
    .eq('creator_id', creatorId)
    .eq('platform', platform)
    .maybeSingle();

  return data ? toConnection(data as Record<string, any>) : null;
}

export interface SaveConnectionInput {
  creatorId: string;
  platform: ConnectedPlatform;
  externalId: string | null;
  externalName: string | null;
  accessToken: string;
  /**
   * Optional because a provider re-consenting an already-connected account
   * often omits it. Omitting it here keeps the stored one rather than nulling
   * it, which would silently turn a working connection into one that can never
   * be refreshed.
   */
  refreshToken?: string | null;
  scopes: string[];
  expiresAt: string | null;
}

/**
 * Stores a fresh grant, replacing whatever was there for that platform.
 *
 * A new grant clears `broken_reason` — the creator has just re-consented, so
 * whatever was wrong is fixed, and leaving the flag set would keep a working
 * connection on an operator's broken list forever.
 */
export async function saveConnection(supabase: SupabaseClient, input: SaveConnectionInput): Promise<void> {
  const row: Record<string, unknown> = {
    creator_id: input.creatorId,
    platform: input.platform,
    external_id: input.externalId,
    external_name: input.externalName,
    access_token: input.accessToken,
    scopes: input.scopes.join(' '),
    expires_at: input.expiresAt,
    broken_reason: null,
    broken_at: null,
    updated_at: new Date().toISOString(),
  };
  if (input.refreshToken) row.refresh_token = input.refreshToken;

  const { error } = await supabase.from(TABLE).upsert(row, { onConflict: 'creator_id,platform' });
  if (error) throw new Error(error.message);
}

/** Removes a grant outright. Disconnecting must not leave a token behind. */
export async function deleteConnection(
  supabase: SupabaseClient,
  creatorId: string,
  platform: ConnectedPlatform,
): Promise<void> {
  await supabase.from(TABLE).delete().eq('creator_id', creatorId).eq('platform', platform);
}

/**
 * Records that a connection stopped working.
 *
 * The access token is cleared with it: a token we know is dead is worse than no
 * token, because a caller that finds one will use it and get an opaque 401 from
 * the platform instead of the reason recorded here.
 */
export async function markConnectionBroken(
  supabase: SupabaseClient,
  connection: PlatformConnection,
  reason: string,
  now: () => number = Date.now,
): Promise<void> {
  await supabase
    .from(TABLE)
    .update({
      access_token: null,
      broken_reason: reason,
      broken_at: new Date(now()).toISOString(),
      updated_at: new Date(now()).toISOString(),
    })
    .eq('id', connection.id);

  log({
    event: 'CRON:TOKEN_REFRESH',
    status: 'error',
    userId: connection.creatorId,
    detail: `platform=${connection.platform} account=${connection.id} broken`,
    reason,
  });
}

// ── Refreshing ───────────────────────────────────────────────────────────────

export interface RefreshedGrant {
  accessToken: string;
  /** ISO, or null for a platform that hands back no expiry. */
  expiresAt: string | null;
  /** Only when the provider rotated it. Absent means keep the stored one. */
  refreshToken?: string | null;
  scopes?: string[];
}

export type RefreshOutcome =
  | { ok: true; grant: RefreshedGrant }
  | {
      ok: false;
      reason: string;
      /**
       * True when the provider never answered at all — a socket error, a
       * timeout, a 5xx. Such a failure says nothing about the grant, and the
       * sweep leaves the connection alone and tries again tomorrow instead of
       * putting a working creator on the reconnect list (see `refreshConnection`
       * for the bound that keeps this from hiding a real expiry).
       *
       * This matters most for Instagram, where marking a connection broken
       * clears the access token — and the access token is the *only* credential
       * there is. One flaky minute would otherwise permanently disconnect a
       * creator whose token had another seven days to run, turning a false alarm
       * into a true one.
       */
      retryable?: boolean;
    };

export interface RefreshOptions {
  /** Injected so tests never reach a provider. */
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export type TokenRefresher = (
  connection: PlatformConnection,
  options: RefreshOptions,
) => Promise<RefreshOutcome>;

/**
 * Google's refresh: swap the stored refresh token for a new access token.
 *
 * `invalid_grant` is the answer when a creator has revoked access in their
 * Google account, and it is permanent — but it is reported the same way as any
 * other failure, because the operator's next move ("ask them to reconnect") is
 * the same either way and guessing at which errors are terminal is how a
 * transient outage disconnects everybody.
 */
export const refreshGoogleGrant: TokenRefresher = async (connection, options) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return { ok: false, reason: 'Google OAuth is not configured on this deployment.' };
  }
  if (!connection.refreshToken) {
    return { ok: false, reason: 'No refresh token is stored, so this grant cannot be renewed. Reconnect the channel.' };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;

  let response: Response;
  try {
    response = await fetchImpl('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: connection.refreshToken,
        grant_type: 'refresh_token',
      }),
    });
  } catch (err) {
    return {
      ok: false,
      reason: `Google did not answer the refresh request: ${err instanceof Error ? err.message : String(err)}`,
      retryable: true,
    };
  }

  const payload = await response.json().catch(() => null as unknown);
  if (!response.ok || !payload || typeof (payload as Record<string, unknown>).access_token !== 'string') {
    // `error_description` is Google's own sentence and is the useful half of
    // this. The request body is never echoed — it carries the refresh token.
    const error = (payload as Record<string, unknown> | null)?.error_description
      ?? (payload as Record<string, unknown> | null)?.error
      ?? `HTTP ${response.status}`;
    return {
      ok: false,
      reason: `Google refused to refresh this grant: ${String(error)}`,
      retryable: response.status >= 500,
    };
  }

  const data = payload as Record<string, unknown>;
  const expiresIn = typeof data.expires_in === 'number' ? data.expires_in : null;
  return {
    ok: true,
    grant: {
      accessToken: data.access_token as string,
      expiresAt: expiresIn === null ? null : new Date(now() + expiresIn * 1000).toISOString(),
      // Google only returns a refresh token on the first consent, so this is
      // normally absent and the stored one is kept.
      refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : null,
      scopes: typeof data.scope === 'string' ? parseScopes(data.scope) : undefined,
    },
  };
};

/**
 * Instagram's refresh: trade a **still-valid** long-lived token for a new one.
 *
 * This is not the usual OAuth refresh-token exchange, and the difference is the
 * whole risk. There is no refresh token; the access token renews itself, and
 * only while it is alive. Miss the ~60-day window by a day and the creator has
 * to consent again — there is no recovery path from our side.
 *
 * Which is why `REFRESH_WINDOW_MS` matters more here than anywhere else: the
 * sweep starts renewing a week out and runs daily, so a token has roughly seven
 * chances before it lapses. Instagram also refuses to refresh a token less than
 * 24 hours old, which never bites in practice because a freshly connected
 * account is sixty days from the window.
 *
 * The token travels in the query string because that is the only form this
 * endpoint documents. Nothing here logs a URL.
 */
export const refreshInstagramGrant: TokenRefresher = async (connection, options) => {
  if (!connection.accessToken) {
    return {
      ok: false,
      reason:
        'No Instagram token is stored, and Instagram has no separate refresh token to fall back on. ' +
        'Reconnect the account.',
    };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;

  const query = new URLSearchParams({
    grant_type: 'ig_refresh_token',
    access_token: connection.accessToken,
  });

  let response: Response;
  try {
    response = await fetchImpl(`https://graph.instagram.com/refresh_access_token?${query}`);
  } catch (err) {
    return {
      ok: false,
      reason: `Instagram did not answer the refresh request: ${err instanceof Error ? err.message : String(err)}`,
      retryable: true,
    };
  }

  const payload = (await response.json().catch(() => null)) as Record<string, any> | null;
  if (!response.ok || typeof payload?.access_token !== 'string') {
    const message = typeof payload?.error?.message === 'string' ? payload.error.message : `HTTP ${response.status}`;
    return {
      ok: false,
      reason:
        `Instagram refused to refresh this grant: ${message}. Instagram tokens can only be renewed while ` +
        'they are still valid, so the creator has to reconnect.',
      retryable: response.status >= 500,
    };
  }

  const expiresIn = typeof payload.expires_in === 'number' ? payload.expires_in : null;
  return {
    ok: true,
    grant: {
      accessToken: payload.access_token,
      expiresAt: expiresIn === null ? null : new Date(now() + expiresIn * 1000).toISOString(),
      // No refresh token exists to rotate, and returning null here would be read
      // as "unchanged" — which it is.
      refreshToken: null,
    },
  };
};

/**
 * TikTok's refresh: an ordinary refresh-token exchange that **rotates the
 * refresh token**.
 *
 * The rotation is the part to get right. Every successful refresh invalidates
 * the token that was sent and returns a replacement, so failing to store the new
 * one leaves us holding a dead credential and the creator re-consenting. It is
 * returned here and written by `storeRefresh`.
 *
 * The year-long refresh-token lifetime never gets tested by anything, so it is
 * defended by construction instead: access tokens live about a day, every TikTok
 * row therefore sits permanently inside the sweep's window, and the sweep runs
 * daily — so the refresh token is re-issued long before its own expiry, whatever
 * the polling cadence is.
 */
export const refreshTikTokGrant: TokenRefresher = async (connection, options) => {
  const clientKey = process.env.TIKTOK_CLIENT_KEY;
  const clientSecret = process.env.TIKTOK_CLIENT_SECRET;
  if (!clientKey || !clientSecret) {
    return { ok: false, reason: 'TikTok OAuth is not configured on this deployment.' };
  }
  if (!connection.refreshToken) {
    return { ok: false, reason: 'No refresh token is stored, so this grant cannot be renewed. Reconnect the account.' };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;

  let response: Response;
  try {
    response = await fetchImpl('https://open.tiktokapis.com/v2/oauth/token/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cache-Control': 'no-cache' },
      body: new URLSearchParams({
        client_key: clientKey,
        client_secret: clientSecret,
        grant_type: 'refresh_token',
        refresh_token: connection.refreshToken,
      }),
    });
  } catch (err) {
    return {
      ok: false,
      reason: `TikTok did not answer the refresh request: ${err instanceof Error ? err.message : String(err)}`,
      retryable: true,
    };
  }

  const payload = (await response.json().catch(() => null)) as Record<string, any> | null;
  if (!response.ok || typeof payload?.access_token !== 'string') {
    // TikTok's own words. The request body is never echoed — it carries the
    // refresh token, and this string ends up in `broken_reason` and a log line.
    const message = payload?.error_description ?? payload?.error ?? `HTTP ${response.status}`;
    return {
      ok: false,
      reason: `TikTok refused to refresh this grant: ${String(message)}`,
      retryable: response.status >= 500,
    };
  }

  const expiresIn = typeof payload.expires_in === 'number' ? payload.expires_in : null;
  return {
    ok: true,
    grant: {
      accessToken: payload.access_token,
      expiresAt: expiresIn === null ? null : new Date(now() + expiresIn * 1000).toISOString(),
      // Must be stored. The one we just sent is now dead.
      refreshToken: typeof payload.refresh_token === 'string' ? payload.refresh_token : null,
      scopes: typeof payload.scope === 'string' ? payload.scope.split(/[,\s]+/).filter(Boolean) : undefined,
    },
  };
};

/**
 * Per-platform refreshers (MEAL-74 / MEAL-82 / MEAL-83).
 *
 * A platform with no entry is skipped by the sweep rather than marked broken,
 * because "we have not built this yet" is not a fact about the creator's grant.
 * All three are here now, so nothing is skipped in practice — the branch stays
 * because a fourth platform will land the same way.
 */
export const TOKEN_REFRESHERS: Partial<Record<ConnectedPlatform, TokenRefresher>> = {
  youtube: refreshGoogleGrant,
  instagram: refreshInstagramGrant,
  tiktok: refreshTikTokGrant,
};

/** Writes a successful refresh back, and returns the connection as it now stands. */
async function storeRefresh(
  supabase: SupabaseClient,
  connection: PlatformConnection,
  grant: RefreshedGrant,
  now: () => number,
): Promise<PlatformConnection> {
  const update: Record<string, unknown> = {
    access_token: grant.accessToken,
    expires_at: grant.expiresAt,
    broken_reason: null,
    broken_at: null,
    updated_at: new Date(now()).toISOString(),
  };
  if (grant.refreshToken) update.refresh_token = grant.refreshToken;
  if (grant.scopes) update.scopes = grant.scopes.join(' ');

  await supabase.from(TABLE).update(update).eq('id', connection.id);

  return {
    ...connection,
    accessToken: grant.accessToken,
    refreshToken: grant.refreshToken || connection.refreshToken,
    scopes: grant.scopes ?? connection.scopes,
    expiresAt: grant.expiresAt,
    brokenReason: null,
    brokenAt: null,
  };
}

export interface RefreshDeps extends RefreshOptions {
  supabase: SupabaseClient;
  /** Overridable so a test — or a future platform — can slot a refresher in. */
  refreshers?: Partial<Record<ConnectedPlatform, TokenRefresher>>;
}

/**
 * Is the stored token still good for a while, quite apart from the refresh?
 *
 * The bound on `retryable`: a provider outage may be waited out only while there
 * is something left to wait with. Once the token is at or past its expiry, any
 * failure is terminal whatever caused it — otherwise a provider that answers
 * every request with a 503 forever would leave a dead connection looking healthy
 * and a poller quietly finding nothing, which is the exact failure the sweep
 * exists to prevent.
 */
function stillUsable(connection: PlatformConnection, atMs: number): boolean {
  if (!connection.accessToken) return false;
  const expiresAt = connection.expiresAt ? Date.parse(connection.expiresAt) : NaN;
  return Number.isFinite(expiresAt) && expiresAt - atMs > EXPIRY_SKEW_MS;
}

/**
 * What one refresh attempt did. The sweep counts these; `refreshConnection`
 * flattens them back to "a usable connection, or nothing".
 */
type RefreshAttempt =
  | { outcome: 'refreshed' | 'skipped'; connection: PlatformConnection }
  /** Nothing was written. The grant is untouched and tomorrow's sweep tries again. */
  | { outcome: 'retry'; connection: PlatformConnection }
  | { outcome: 'broken'; connection: null };

async function attemptRefresh(deps: RefreshDeps, connection: PlatformConnection): Promise<RefreshAttempt> {
  const now = deps.now ?? Date.now;
  const refresher = (deps.refreshers ?? TOKEN_REFRESHERS)[connection.platform];
  if (!refresher) return { outcome: 'skipped', connection };

  const outcome = await refresher(connection, { fetchImpl: deps.fetchImpl, now });
  if (!outcome.ok) {
    if (outcome.retryable && stillUsable(connection, now())) {
      // Logged rather than written: the connection is fine, we just could not
      // reach the provider this minute. Recording it as broken would put a
      // working creator on the reconnect list — and for Instagram it would
      // destroy the only token they have.
      log({
        event: 'CRON:TOKEN_REFRESH',
        status: 'pending',
        userId: connection.creatorId,
        detail: `platform=${connection.platform} account=${connection.id} retrying tomorrow`,
        reason: outcome.reason,
      });
      return { outcome: 'retry', connection };
    }
    await markConnectionBroken(deps.supabase, connection, outcome.reason, now);
    return { outcome: 'broken', connection: null };
  }

  return { outcome: 'refreshed', connection: await storeRefresh(deps.supabase, connection, outcome.grant, now) };
}

/**
 * Refreshes one grant, recording either the new token or why it failed.
 *
 * Returns null when the connection is now unusable, which is the answer every
 * caller wants: there is nothing to retry with and the reason is already durable
 * in `broken_reason`.
 */
export async function refreshConnection(
  deps: RefreshDeps,
  connection: PlatformConnection,
): Promise<PlatformConnection | null> {
  return (await attemptRefresh(deps, connection)).connection;
}

/**
 * How close to expiry a token has to be before a *caller* refreshes it.
 *
 * A token that expires during the request that just checked it is the same
 * failure as an expired one, and Google's access tokens live an hour, so a
 * minute of slack costs nothing and removes the race.
 */
export const EXPIRY_SKEW_MS = 60_000;

/**
 * The access token to use right now, refreshing first if it is about to lapse.
 *
 * This is what every read of a creator's channel goes through. A broken
 * connection returns null rather than an expired token — see
 * `markConnectionBroken` for why a dead token is worse than none.
 */
export async function usableAccessToken(
  deps: RefreshDeps,
  connection: PlatformConnection,
): Promise<string | null> {
  const now = deps.now ?? Date.now;
  if (connection.brokenReason) return null;

  const expiresAt = connection.expiresAt ? Date.parse(connection.expiresAt) : NaN;
  const stillGood =
    connection.accessToken && (!Number.isFinite(expiresAt) || expiresAt - now() > EXPIRY_SKEW_MS);
  if (stillGood) return connection.accessToken;

  const refreshed = await refreshConnection(deps, connection);
  return refreshed?.accessToken ?? null;
}

// ── The sweep ────────────────────────────────────────────────────────────────

/**
 * How far ahead of expiry the daily sweep renews.
 *
 * Comfortably more than a day, so a cron run that fails still leaves several
 * more before anything lapses. It is deliberately wide enough to catch YouTube's
 * hour-long access tokens on every pass too: those are refreshed on demand
 * anyway, but sweeping them daily is how a *revoked* channel is discovered
 * within a day instead of whenever someone next tries to import from it.
 */
export const REFRESH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** One pass has to fit in a cron invocation alongside everything else it runs. */
export const REFRESH_BATCH = 100;

export interface RefreshSweepResult {
  checked: number;
  refreshed: number;
  broken: number;
  skipped: number;
  /**
   * Grants left alone because the provider was unreachable and the stored token
   * still has life in it. Counted separately from `broken` because it needs no
   * action from anybody — tomorrow's pass tries again.
   */
  retried: number;
}

/**
 * The shared token-refresh worker (MEAL-74, reused by MEAL-82 / MEAL-83).
 *
 * Platform-agnostic over `expires_at`: it does not know what a YouTube grant is,
 * only that a row is approaching its expiry and that some refresher claims that
 * platform. Already-broken rows are left alone — they need the creator to
 * reconnect, and retrying them daily forever would bury the ones that just
 * broke under the ones that broke months ago.
 */
export async function refreshExpiringTokens(deps: RefreshDeps): Promise<RefreshSweepResult> {
  const now = deps.now ?? Date.now;
  const refreshers = deps.refreshers ?? TOKEN_REFRESHERS;
  const horizon = new Date(now() + REFRESH_WINDOW_MS).toISOString();

  const { data } = await deps.supabase
    .from(TABLE)
    .select(CONNECTION_FIELDS)
    .in('platform', [...CONNECTED_PLATFORMS])
    .is('broken_reason', null)
    .not('expires_at', 'is', null)
    .lt('expires_at', horizon)
    .order('expires_at', { ascending: true })
    .limit(REFRESH_BATCH);

  const rows = (data ?? []) as Array<Record<string, any>>;
  const result: RefreshSweepResult = { checked: 0, refreshed: 0, broken: 0, skipped: 0, retried: 0 };

  for (const row of rows) {
    const connection = toConnection(row);
    if (!refreshers[connection.platform]) {
      // No refresher for this platform yet. Not an error, and emphatically not
      // a broken grant — marking it would put a perfectly good connection on
      // an operator's "ask them to reconnect" list for our own missing code.
      result.skipped++;
      continue;
    }
    result.checked++;
    // One creator's dead grant must not stop the sweep reaching the rest.
    try {
      const attempt = await attemptRefresh(deps, connection);
      if (attempt.outcome === 'refreshed') result.refreshed++;
      else if (attempt.outcome === 'retry') result.retried++;
      else if (attempt.outcome === 'broken') result.broken++;
    } catch (err) {
      result.broken++;
      await markConnectionBroken(
        deps.supabase,
        connection,
        `The refresh threw before it could report: ${err instanceof Error ? err.message : String(err)}`,
        now,
      );
    }
  }

  log({
    event: 'CRON:TOKEN_REFRESH',
    status: result.broken > 0 ? 'error' : 'success',
    detail:
      `checked=${result.checked} refreshed=${result.refreshed} broken=${result.broken} ` +
      `retried=${result.retried} skipped=${result.skipped}`,
  });

  return result;
}
