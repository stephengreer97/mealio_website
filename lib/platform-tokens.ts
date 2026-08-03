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
import { providerSignal, readJsonCapped } from '@/lib/provider-fetch';

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
  /**
   * The row's version, and the reason every write here is conditional.
   *
   * Read once, written back minutes later — see `updateUnchanged`. Null on a
   * row written before this column had a default.
   */
  updatedAt: string | null;
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
    updatedAt: row.updated_at ?? null,
  };
}

/** Every column this module reads. `select *` would drag refresh tokens further than they need to go. */
const CONNECTION_FIELDS =
  'id, creator_id, platform, external_id, external_name, access_token, refresh_token, scopes, expires_at, broken_reason, broken_at, updated_at';

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
   * be refreshed — **unless the platform rotates**, see `ROTATES_REFRESH_TOKEN`.
   */
  refreshToken?: string | null;
  scopes: string[];
  expiresAt: string | null;
}

/**
 * Does a successful refresh on this platform invalidate the token it was sent?
 *
 * This decides what an *absent* refresh token means on a reconnect, and the two
 * answers are opposites.
 *
 * Google issues a refresh token on the first consent and on no consent after it,
 * so a reconnect that comes back without one is normal and the stored one is
 * still the live one — keeping it is the only correct move. TikTok rotates on
 * every refresh, so the stored one is dead the moment it has been used: keeping
 * it across a reconnect hands the brand-new grant a credential TikTok has
 * already retired, the next sweep sends it, TikTok answers `invalid_grant`, and
 * `terminal: true` breaks a connection the creator made this morning. Instagram
 * has no refresh token at all, so there is nothing to preserve and a leftover
 * value would be a lie about what is stored.
 *
 * Preserve-on-reconnect is the right general rule. It is only right for the
 * platform where the old token is still the current one.
 */
export const ROTATES_REFRESH_TOKEN: Record<ConnectedPlatform, boolean> = {
  youtube: false,
  instagram: true,
  tiktok: true,
};

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
  // Present: always stored. Absent: kept only where the stored one is still the
  // live one — on a rotating platform it is written null, because inheriting a
  // token the provider has already retired is worse than having none.
  if (input.refreshToken) row.refresh_token = input.refreshToken;
  else if (ROTATES_REFRESH_TOKEN[input.platform]) row.refresh_token = null;

  const { error } = await supabase.from(TABLE).upsert(row, { onConflict: 'creator_id,platform' });
  if (error) throw new Error(error.message);
}

/**
 * Removes a grant outright. Disconnecting must not leave a token behind.
 *
 * Throws rather than returning quietly. This is a revocation, and the one thing
 * it must never do is report success while the refresh token is still sitting
 * in the table — the creator has been told the channel is disconnected and will
 * not check again.
 */
export async function deleteConnection(
  supabase: SupabaseClient,
  creatorId: string,
  platform: ConnectedPlatform,
): Promise<void> {
  const { error } = await supabase.from(TABLE).delete().eq('creator_id', creatorId).eq('platform', platform);
  if (error) throw new Error(error.message);
}

/**
 * Applies a write to one grant, but only while it is still the grant we read.
 *
 * The sweep reads a batch and then makes up to a batch's worth of sequential
 * outbound calls, so a row can be minutes stale by the time it is written back
 * — long enough for the creator to have revoked in their Google account and
 * reconnected from the portal. `saveConnection` upserts on
 * `(creator_id, platform)`, so a reconnect keeps the same row id, and a blind
 * `.eq('id', …)` would then null the access token of the brand-new working
 * grant on the strength of an `invalid_grant` about the *old* refresh token.
 *
 * `updated_at` is the version. Every write in this module stamps it, so
 * matching on the value we read is what makes the write conditional. False
 * means the row moved on and nothing was written.
 */
async function updateUnchanged(
  supabase: SupabaseClient,
  connection: PlatformConnection,
  values: Record<string, unknown>,
): Promise<boolean> {
  const write = supabase.from(TABLE).update(values).eq('id', connection.id);
  // PostgREST spells "equals null" differently from "equals a value", and a row
  // written before `updated_at` had a default carries null.
  const guarded =
    connection.updatedAt === null ? write.is('updated_at', null) : write.eq('updated_at', connection.updatedAt);

  const { data, error } = await guarded.select('id');
  if (error) throw new Error(error.message);
  return Array.isArray(data) && data.length > 0;
}

/**
 * Records that a connection stopped working.
 *
 * The access token is cleared with it: a token we know is dead is worse than no
 * token, because a caller that finds one will use it and get an opaque 401 from
 * the platform instead of the reason recorded here. Reserved for failures that
 * are facts about the grant — see `RefreshOutcome.terminal`.
 *
 * That clearing is why the terminal rule has to be narrow. On YouTube and TikTok
 * the refresh token survives this write; on Instagram the access token is the
 * only credential there is, so calling this over a socket error would not put a
 * working creator on a reconnect list, it would destroy the grant to say so.
 * Everything that reaches here is a grant the provider has already disowned or
 * one nothing can renew — and `reason` is the operator's whole record of it, so
 * it says what happened and that reconnecting is the fix.
 *
 * Returns false when the write did not land, which is either a database error
 * or a grant that was replaced while we were deciding this one was dead.
 */
export async function markConnectionBroken(
  supabase: SupabaseClient,
  connection: PlatformConnection,
  reason: string,
  now: () => number = Date.now,
): Promise<boolean> {
  const stamp = new Date(now()).toISOString();

  let applied = false;
  let failure: string | null = null;
  try {
    applied = await updateUnchanged(supabase, connection, {
      access_token: null,
      broken_reason: reason,
      broken_at: stamp,
      updated_at: stamp,
    });
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err);
  }

  log({
    event: 'CRON:TOKEN_REFRESH',
    status: 'error',
    userId: connection.creatorId,
    detail:
      `platform=${connection.platform} account=${connection.id} ` +
      (applied
        ? 'broken'
        : failure
          ? `not recorded: ${failure}`
          : 'superseded by a newer grant, left alone'),
    reason,
  });
  return applied;
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
       * True only when this failure is a fact about the *grant*: the provider
       * said in as many words that it is gone, or there is nothing stored to
       * renew it with. Everything else — a socket error, a timeout, a 500, a
       * 503, an HTML error page from a load balancer, a missing client secret —
       * is a fact about the network or about us, and is retried.
       *
       * Optional, and false by default, so a refresher that has not thought
       * about the distinction errs toward retrying rather than toward
       * disconnecting a creator.
       */
      terminal?: boolean;
    };

export interface RefreshOptions {
  /** Injected so tests never reach a provider. */
  fetchImpl?: typeof fetch;
  now?: () => number;
  /**
   * Aborts the provider call. The sweep passes one carrying whatever is left of
   * its own budget, so a row late in a pass cannot outlive the pass.
   */
  signal?: AbortSignal;
}

export type TokenRefresher = (
  connection: PlatformConnection,
  options: RefreshOptions,
) => Promise<RefreshOutcome>;

/**
 * Google's refresh: swap the stored refresh token for a new access token.
 *
 * **`invalid_grant` is the entire taxonomy, deliberately.** It is Google's
 * answer when the creator has revoked access, and it is the only failure that
 * says anything about the grant rather than about the network between us and
 * Google. Everything else is retried. Guessing at which errors are terminal is
 * indeed how a transient outage disconnects everybody — but so is the reverse,
 * and worse: with no distinction at all, thirty seconds of 503s from Google's
 * token endpoint marks every connected creator broken with their access token
 * nulled, and the sweep excludes broken rows, so nothing ever revisits them.
 * One narrow rule, erring toward retrying, is what avoids both.
 */
export const refreshGoogleGrant: TokenRefresher = async (connection, options) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    // A missing env var is the most global failure there is — it would break
    // every creator on the deployment in the same pass — and it is fixed by
    // setting the variable, not by anyone reconnecting.
    return { ok: false, reason: 'Google OAuth is not configured on this deployment.', terminal: false };
  }
  if (!connection.refreshToken) {
    // Nothing to retry with. No amount of waiting produces a refresh token.
    return {
      ok: false,
      reason: 'No refresh token is stored, so this grant cannot be renewed. Reconnect the channel.',
      terminal: true,
    };
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
      // An abort lands in the catch below as a transient failure, which is what
      // "Google was too slow today" is. Nothing is written.
      signal: providerSignal(undefined, options.signal),
    });
  } catch (err) {
    return {
      ok: false,
      reason: `Google did not answer the refresh request: ${err instanceof Error ? err.message : String(err)}`,
      terminal: false,
    };
  }

  const payload = await readJsonCapped(response);
  if (!response.ok || !payload || typeof (payload as Record<string, unknown>).access_token !== 'string') {
    // `error_description` is Google's own sentence and is the useful half of
    // this. The request body is never echoed — it carries the refresh token.
    const body = payload as Record<string, unknown> | null;
    const error = body?.error_description ?? body?.error ?? `HTTP ${response.status}`;
    return {
      ok: false,
      reason: `Google refused to refresh this grant: ${String(error)}`,
      // The machine-readable code, not the sentence: `error_description` is
      // prose Google is free to reword. A 503 whose body happens not to be JSON
      // lands here with no code at all, which is exactly right — it retries.
      terminal: body?.error === 'invalid_grant',
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
 * The Graph API codes that mean the Instagram token itself is gone.
 *
 * Instagram's analogue of `invalid_grant`, and the same discipline: the
 * machine-readable code, not the sentence. 190 is "error validating access
 * token" — revoked, invalidated by a password change, or lapsed; 102 is its
 * older session-expired spelling. Everything else Instagram answers 400 with is
 * about the request or about Instagram: code 4 is *the app rate limit*, code 1
 * and code 2 are "unknown error" and "service temporarily unavailable". Reading
 * any 4xx as terminal would take a creator's account out of service because we
 * asked Instagram too many questions in an hour.
 */
const INSTAGRAM_DEAD_TOKEN_CODES = new Set([102, 190]);

/**
 * Reads the code and the sentence out of **both** shapes Meta serves.
 *
 * `graph.facebook.com` answers `{ error: { code, message } }`; the
 * Instagram-Login endpoints document a flat `{ error_type, code, error_message }`
 * and that is the family every call in this feature talks to. Reading only the
 * nested one is not a cosmetic loss: under the flat shape a revoked token comes
 * back with no code we recognise, so it classifies `terminal: false` and defers
 * — forever, on a grant with a null `expires_at` that `provablyUnrenewable`
 * cannot judge — and Meta's own sentence degrades to `HTTP 400`.
 *
 * Which shape actually arrives cannot be settled without a live credential, and
 * that is precisely the argument for accepting both. It is the same move
 * `shortLivedToken` in `lib/instagram.ts` already makes for the token response.
 */
export function instagramError(
  payload: Record<string, any> | null,
  status: number,
): { code: number | null; message: string } {
  const nested = payload?.error;
  const rawCode = typeof nested?.code === 'number' ? nested.code : payload?.code;
  const rawMessage = typeof nested?.message === 'string' ? nested.message : payload?.error_message;
  return {
    code: typeof rawCode === 'number' ? rawCode : null,
    message: typeof rawMessage === 'string' && rawMessage ? rawMessage : `HTTP ${status}`,
  };
}

/**
 * Instagram's refresh: trade a **still-valid** long-lived token for a new one.
 *
 * This is not the usual OAuth refresh-token exchange, and the difference is the
 * whole risk. There is no refresh token; the access token renews itself, and
 * only while it is alive. Miss the ~60-day window by a day and the creator has
 * to consent again — there is no recovery path from our side.
 *
 * Which is why the transient/terminal split matters more here than anywhere
 * else. `markConnectionBroken` clears the access token, and on Instagram that is
 * the only credential there is: breaking a grant over a socket error does not
 * just put a working creator on a reconnect list, it destroys the thing that was
 * still working. So only Instagram saying the token is dead is terminal, and
 * `refreshConnection` bounds the rest — see `provablyUnrenewable`.
 *
 * The token travels in the query string because that is the only form this
 * endpoint documents. Nothing here logs a URL.
 */
export const refreshInstagramGrant: TokenRefresher = async (connection, options) => {
  if (!connection.accessToken) {
    // Terminal, and the only kind of terminal that is about us: Instagram has no
    // separate refresh token, so with nothing stored there is nothing any later
    // attempt could send.
    return {
      ok: false,
      reason:
        'No Instagram token is stored, and Instagram has no separate refresh token to fall back on. ' +
        'Reconnect the account.',
      terminal: true,
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
    response = await fetchImpl(`https://graph.instagram.com/refresh_access_token?${query}`, {
      signal: providerSignal(undefined, options.signal),
    });
  } catch (err) {
    return {
      ok: false,
      reason: `Instagram did not answer the refresh request: ${err instanceof Error ? err.message : String(err)}`,
      terminal: false,
    };
  }

  const payload = await readJsonCapped(response);
  if (!response.ok || typeof payload?.access_token !== 'string') {
    const { code, message } = instagramError(payload, response.status);
    const dead = typeof code === 'number' && INSTAGRAM_DEAD_TOKEN_CODES.has(code);
    return {
      ok: false,
      reason: dead
        ? `Instagram says this token is no longer valid: ${message}. Instagram tokens can only be renewed while ` +
          'they are still valid, so the creator has to reconnect the account.'
        : `Instagram refused to refresh this grant: ${message}`,
      terminal: dead,
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
    // Same as Google's: a missing env var breaks every TikTok creator on the
    // deployment in the same pass, and is fixed by setting the variable rather
    // than by any of them reconnecting.
    return { ok: false, reason: 'TikTok OAuth is not configured on this deployment.', terminal: false };
  }
  if (!connection.refreshToken) {
    // Nothing to retry with. No amount of waiting produces a refresh token.
    return {
      ok: false,
      reason: 'No refresh token is stored, so this grant cannot be renewed. Reconnect the account.',
      terminal: true,
    };
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
      signal: providerSignal(undefined, options.signal),
    });
  } catch (err) {
    return {
      ok: false,
      reason: `TikTok did not answer the refresh request: ${err instanceof Error ? err.message : String(err)}`,
      terminal: false,
    };
  }

  const payload = await readJsonCapped(response);
  if (!response.ok || typeof payload?.access_token !== 'string') {
    // TikTok's own words. The request body is never echoed — it carries the
    // refresh token, and this string ends up in `broken_reason` and a log line.
    const message = payload?.error_description ?? payload?.error ?? `HTTP ${response.status}`;
    return {
      ok: false,
      reason: `TikTok refused to refresh this grant: ${String(message)}`,
      // The code, not the sentence, exactly as for Google. TikTok answers
      // `invalid_grant` when the refresh token has been revoked or has run out
      // its year; `internal_error`, `rate_limit_exceeded`, a 5xx and an HTML
      // error page from the edge all land here with no such code, and retry.
      terminal: payload?.error === 'invalid_grant',
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

/**
 * Writes a successful refresh back, and returns the connection as it now stands.
 *
 * Null means the row was replaced while we were talking to the provider. The
 * token in hand was minted from a refresh token the creator may have just
 * revoked, so writing it over the grant they replaced it with would break a
 * working connection with a stale one.
 */
async function storeRefresh(
  supabase: SupabaseClient,
  connection: PlatformConnection,
  grant: RefreshedGrant,
  now: () => number,
): Promise<PlatformConnection | null> {
  const stamp = new Date(now()).toISOString();
  const update: Record<string, unknown> = {
    access_token: grant.accessToken,
    expires_at: grant.expiresAt,
    broken_reason: null,
    broken_at: null,
    updated_at: stamp,
  };
  if (grant.refreshToken) update.refresh_token = grant.refreshToken;
  if (grant.scopes) update.scopes = grant.scopes.join(' ');

  const applied = await updateUnchanged(supabase, connection, update);
  if (!applied) return null;

  return {
    ...connection,
    accessToken: grant.accessToken,
    refreshToken: grant.refreshToken || connection.refreshToken,
    scopes: grant.scopes ?? connection.scopes,
    expiresAt: grant.expiresAt,
    brokenReason: null,
    brokenAt: null,
    updatedAt: stamp,
  };
}

export interface RefreshDeps extends RefreshOptions {
  supabase: SupabaseClient;
  /** Overridable so a test — or a future platform — can slot a refresher in. */
  refreshers?: Partial<Record<ConnectedPlatform, TokenRefresher>>;
  /** Waits out the backoff. Injected so a test does not spend it. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Whether a transient failure is retried with `REFRESH_RETRY_DELAYS_MS`.
   *
   * On by default, for the caller with a user waiting. The sweep turns it off —
   * see the constant.
   */
  retry?: boolean;
}

/**
 * How long to wait between attempts at a grant whose failure looked transient.
 *
 * Two extra attempts, under a second and a half in total. This is for the
 * **on-demand** caller — `usableAccessToken`, with a request waiting on it —
 * where a second of backoff is the difference between a working page and an
 * error, and where there is exactly one row.
 *
 * The daily sweep deliberately does **not** pay it. See `retry` on
 * `RefreshDeps`: 99 rows failing transiently is 123,750 ms spent purely asleep,
 * for a retry whose entire benefit is a second attempt at a row that is going to
 * be tried again tomorrow anyway. Backoff buys nothing in a batch and costs the
 * budget the platforms further down the loop need.
 */
export const REFRESH_RETRY_DELAYS_MS = [250, 1_000];

/**
 * What one attempt at a grant did.
 *
 * `deferred` is the state this module was missing. It is not `refreshed` and it
 * is emphatically not `broken`: nothing is written, `broken_reason` stays null,
 * and the row stays in the sweep's own query so the next run picks it up.
 */
export type RefreshResult =
  | { status: 'refreshed'; connection: PlatformConnection }
  /** No refresher registered for the platform. A fact about us, not the grant. */
  | { status: 'unsupported'; connection: PlatformConnection }
  /** Failed in a way that might not fail again. Left alone for the next pass. */
  | { status: 'deferred'; reason: string }
  /** The provider says this grant is gone. Recorded, and the token cleared. */
  | { status: 'broken'; reason: string }
  /** A newer grant landed under us. Nothing written; theirs wins. */
  | { status: 'superseded' };

/** Runs a refresher without letting a throw escape as anything but a failure. */
async function attemptRefresh(
  refresher: TokenRefresher,
  connection: PlatformConnection,
  options: RefreshOptions,
): Promise<RefreshOutcome> {
  try {
    return await refresher(connection, options);
  } catch (err) {
    // A refresher that throws has told us about our code or the runtime, not
    // about the creator's grant. Transient by default, like every other failure
    // that is not an explicit `invalid_grant`.
    return {
      ok: false,
      reason: `The refresh threw before it could report: ${err instanceof Error ? err.message : String(err)}`,
      terminal: false,
    };
  }
}

/**
 * The bound on deferring: is there anything left for a later attempt to try?
 *
 * Deferring is free only while some credential survives the wait. A YouTube or
 * TikTok grant keeps a refresh token whose life is not measured by `expires_at`
 * at all, so an unreachable provider costs nothing but time — the moment it
 * answers, the grant renews. Instagram has no such second credential: the access
 * token is the only one there is, it renews only while it is still valid, and
 * once it is past its own expiry no attempt can ever succeed again. Deferring
 * that one forever is how a dead grant sits with `broken_reason` null, out of
 * every operator's list, while the poller quietly finds nothing.
 *
 * Deliberately narrow. It needs proof, not suspicion: a refresh token present
 * means no, and an expiry we cannot parse means no — nulling the one credential
 * a creator has on a guess is the failure this whole model exists to avoid.
 */
function provablyUnrenewable(connection: PlatformConnection, atMs: number): boolean {
  if (connection.refreshToken) return false;
  const expiresAt = connection.expiresAt ? Date.parse(connection.expiresAt) : NaN;
  return Number.isFinite(expiresAt) && expiresAt <= atMs;
}

/**
 * The second bound on deferring, for the grant `provablyUnrenewable` cannot
 * judge: has it now failed for a whole window of daily attempts?
 *
 * `provablyUnrenewable` needs a parseable expiry, and both `exchangeInstagramCode`
 * and `refreshInstagramGrant` write a null one whenever Meta omits `expires_in`.
 * A grant in that state that fails transiently every day is deferred forever:
 * nothing is written, so it is byte-identical to one refreshed this morning, it
 * appears on no operator's broken list, and the creator's card still reads
 * "Connected" while the poller quietly finds nothing. Confirmed at 400
 * consecutive sweeps with `broken_reason` still null — the exact failure the
 * module header claims to eliminate, reached by the one route left open.
 *
 * **`updated_at` is the attempt counter, and no column had to be added for it.**
 * Every write in this module stamps it and a deferral writes nothing, so on a
 * row the sweep is looking at, `updated_at` is the last time anything *worked*.
 *
 * As narrow as its sibling, and for the same reason — four conditions, each
 * carrying its own weight:
 *
 *  - **No refresh token.** A YouTube or TikTok grant holds a credential whose
 *    life `expires_at` does not measure, so a fortnight of Google being down
 *    costs those grants nothing and breaking them would be the "a transient
 *    outage disconnects everybody" failure, just slower. Only the platform with
 *    one credential can be spent by waiting.
 *  - **No readable expiry.** This is the *whole* gap, and confining the rule to
 *    it is what makes the arithmetic sound. A row with a real `expires_at`
 *    ENTERS the window carrying an `updated_at` from whenever it was last
 *    written — a healthy 60-day Instagram grant reaches its 14-day window 46
 *    days after it was stored — so "older than a window" would fire on its very
 *    first transient failure and break a grant that is perfectly alive. A row
 *    with a null expiry has no such moment: `expires_at.is.null` puts it in the
 *    query from the day it is written and every day after, so elapsed time
 *    really is elapsed attempts. And that row is exactly the one
 *    `provablyUnrenewable` has to decline to judge.
 *  - **A parseable `updated_at`.** Null on a row written before the column had a
 *    default, and a guess about a credential a creator has to reconnect by hand
 *    is not something to make on a missing value.
 *  - **A window's worth of it.** For Instagram that is fourteen daily attempts.
 *    Short of a fortnight-long total outage at Meta, a grant that has taken none
 *    of them is not coming back.
 */
function deferredPastItsWindow(connection: PlatformConnection, atMs: number, windowMs: number): boolean {
  if (connection.refreshToken) return false;
  // A readable expiry is `provablyUnrenewable`'s business, and its arithmetic is
  // the correct one for that row. See above for why borrowing this one would
  // break healthy grants the day they enter their window.
  if (Number.isFinite(connection.expiresAt ? Date.parse(connection.expiresAt) : NaN)) return false;
  const updatedAt = connection.updatedAt ? Date.parse(connection.updatedAt) : NaN;
  return Number.isFinite(updatedAt) && atMs - updatedAt >= windowMs;
}

/**
 * Refreshes one grant, recording either the new token or why it failed.
 *
 * A transient failure is retried with a short backoff and then deferred. Only a
 * terminal one — the provider saying the grant is gone — writes `broken_reason`
 * and clears the token, because that flag takes a creator's channel out of
 * service until they reconnect and the sweep never revisits it. The two
 * exceptions are `provablyUnrenewable` and `deferredPastItsWindow`: deferring is
 * only free while a later attempt could still work, and only while there are
 * later attempts left to have.
 */
export async function refreshConnection(
  deps: RefreshDeps,
  connection: PlatformConnection,
): Promise<RefreshResult> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const refresher = (deps.refreshers ?? TOKEN_REFRESHERS)[connection.platform];
  if (!refresher) return { status: 'unsupported', connection };

  const options: RefreshOptions = { fetchImpl: deps.fetchImpl, now, signal: deps.signal };
  const attempts = deps.retry === false ? 0 : REFRESH_RETRY_DELAYS_MS.length;
  let outcome = await attemptRefresh(refresher, connection, options);
  for (let attempt = 0; !outcome.ok && !outcome.terminal && attempt < attempts; attempt++) {
    await sleep(REFRESH_RETRY_DELAYS_MS[attempt]);
    outcome = await attemptRefresh(refresher, connection, options);
  }

  if (!outcome.ok) {
    // A transient failure over a grant nothing can renew any more is still the
    // end of that grant. Record it with what an operator needs to act — the
    // last error alone reads as "try again tomorrow", which is precisely what
    // will not work.
    const at = now();
    const window = refreshWindowFor(connection.platform);
    const spent = !outcome.terminal && provablyUnrenewable(connection, at);
    // The same judgement for the grant whose expiry cannot be read at all.
    const exhausted = !outcome.terminal && !spent && deferredPastItsWindow(connection, at, window);
    if (!outcome.terminal && !spent && !exhausted) return { status: 'deferred', reason: outcome.reason };

    let reason = outcome.reason;
    if (spent) {
      reason +=
        ` The stored ${connection.platform} token expired at ${connection.expiresAt}, and there is ` +
        'no refresh token to renew it with, so no later attempt can succeed. The creator has to reconnect.';
    } else if (exhausted) {
      // The sentence carries the elapsed time because that is the whole
      // difference between this and "try again tomorrow" — which is what the
      // last error on its own reads as, and what has already been tried.
      const days = Math.round((at - Date.parse(connection.updatedAt!)) / 86_400_000);
      reason +=
        ` This ${connection.platform} grant has now failed every daily attempt for ${days} days, which is longer ` +
        'than the window it is renewable in, and it holds no refresh token to fall back on. The creator has to ' +
        'reconnect.';
    }
    // Broken only if the flag actually landed. A write that matched nothing
    // means the grant this `invalid_grant` was about has already been replaced.
    const applied = await markConnectionBroken(deps.supabase, connection, reason, now);
    return applied ? { status: 'broken', reason } : { status: 'superseded' };
  }

  const stored = await storeRefresh(deps.supabase, connection, outcome.grant, now);
  return stored ? { status: 'refreshed', connection: stored } : { status: 'superseded' };
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
  // An expiry we cannot read is not proof of life. A null or unparseable
  // `expires_at` parses to NaN, and treating that as "no expiry" made a dead
  // grant look healthy forever — the silent poller-finds-nothing failure this
  // module exists to eliminate. `exchangeYouTubeCode` stores null whenever
  // Google omits `expires_in`, so this is reachable today.
  const stillGood =
    Boolean(connection.accessToken) && Number.isFinite(expiresAt) && expiresAt - now() > EXPIRY_SKEW_MS;
  if (stillGood) return connection.accessToken;

  // Anything short of a completed refresh is null. In particular `unsupported`:
  // the registry's "skip, don't break" rule is right for the sweep and wrong
  // here — "we have not built this platform's refresher yet" is a fine reason
  // not to flag a row and a terrible reason to hand a caller a token that has
  // already expired. MEAL-82 and MEAL-83 land in that branch on day one.
  const result = await refreshConnection(deps, connection);
  return result.status === 'refreshed' ? result.connection.accessToken : null;
}

// ── The sweep ────────────────────────────────────────────────────────────────

/**
 * How far ahead of expiry the daily sweep renews.
 *
 * Two days: a day of cadence plus a whole missed run of slack, and no more.
 * The window used to be a week, which meant every row on every platform was
 * rewritten on every pass — six days of work done six times, and six days'
 * worth of grants inside the blast radius of any single bad run.
 */
export const REFRESH_WINDOW_MS = 2 * 24 * 60 * 60 * 1000;

/**
 * Instagram gets a wider one, because for Instagram this number is the count of
 * attempts before a permanent loss.
 *
 * YouTube and TikTok hold a separate refresh token that outlives the access
 * token, so a missed renewal costs nothing — tomorrow's pass uses the same
 * refresh token and succeeds. Two days of slack is generous.
 *
 * Instagram has no refresh token. The long-lived access token **is** the
 * credential, and it is renewed by trading a still-valid one for a new one
 * (`ig_refresh_token`). Once it lapses there is nothing left to renew with and
 * the creator has to reconnect by hand. So the window is not slack here, it is
 * the number of daily chances we get: at two days, an Instagram outage lasting
 * two days — or two failed crons — is an unrecoverable disconnection.
 *
 * Fourteen against a ~60-day token: two weeks of daily attempts, still only a
 * quarter of the token's life, and the `updateUnchanged` predicate means a
 * no-op renewal writes nothing.
 */
export const REFRESH_WINDOW_BY_PLATFORM: Partial<Record<ConnectedPlatform, number>> = {
  instagram: 14 * 24 * 60 * 60 * 1000,
};

/** The window this platform is swept on. */
export function refreshWindowFor(platform: ConnectedPlatform): number {
  return REFRESH_WINDOW_BY_PLATFORM[platform] ?? REFRESH_WINDOW_MS;
}

/** One pass has to fit in a cron invocation alongside everything else it runs. */
export const REFRESH_BATCH = 100;

/**
 * The wall clock the whole sweep runs against.
 *
 * A batch size is a bound on *rows*, not on time, and rows are not what runs
 * out. `/api/cron/daily` declares `maxDuration = 300`, runs three other passes
 * first, and hands this one whatever is left; a hundred rows against a provider
 * having a bad afternoon is unbounded against that. Two minutes leaves room for
 * the passes before it and is far more than a healthy sweep needs — a hundred
 * token calls at normal latency is a few seconds.
 *
 * Running out is not a failure. Every row this sweep does not reach is left
 * exactly as it was and is first in tomorrow's query, which is the same place a
 * deferral leaves it.
 */
export const SWEEP_BUDGET_MS = 120_000;

/**
 * The order platforms are swept in, most-perishable first.
 *
 * `CONNECTED_PLATFORMS` is declaration order — `['youtube', 'instagram',
 * 'tiktok']` — and following it puts the one platform that cannot recover from a
 * missed pass **second**. That is exactly backwards. A YouTube or TikTok grant
 * that is not reached today is renewed tomorrow from a refresh token that does
 * not care how long it waited. An Instagram grant is renewable only while its
 * one credential is still alive, so the fourteen-day window is fourteen
 * *chances*, and a correlated failure that drains the budget ahead of it —
 * Google's token endpoint being slow for an afternoon, say — takes those chances
 * away in exactly the same motion, all fourteen times.
 *
 * So the platform that loses something permanent goes first, and the ones that
 * lose nothing wait. Platforms not named here follow, in declaration order.
 */
export const SWEEP_ORDER: readonly ConnectedPlatform[] = ['instagram', 'tiktok', 'youtube'];

export interface RefreshSweepResult {
  checked: number;
  refreshed: number;
  broken: number;
  /** Failed transiently. Untouched, and in the next run's query unchanged. */
  deferred: number;
  skipped: number;
  /**
   * Rows the budget ran out before reaching. Not a failure — they are untouched
   * and first in tomorrow's query — but a number that is regularly non-zero
   * means the budget or the batch is wrong.
   */
  ranOutOfTime: number;
}

/**
 * The shared token-refresh worker (MEAL-74, reused by MEAL-82 / MEAL-83).
 *
 * Platform-agnostic over `expires_at`: it does not know what a YouTube grant is,
 * only that a row is approaching its expiry and that some refresher claims that
 * platform. Already-broken rows are left alone — they need the creator to
 * reconnect, and retrying them daily forever would bury the ones that just
 * broke under the ones that broke months ago.
 *
 * **One batch per platform, not one batch ordered by expiry.** Google's access
 * tokens live an hour, so every connected YouTube row sorts ahead of an
 * Instagram grant six days out — no window narrow enough to exclude an hourly
 * token is wide enough to be useful, so a single ordered batch is entirely
 * YouTube past ~100 connected creators, and Instagram and TikTok are never
 * reached. Those are the platforms whose *refresh* tokens die if this sweep
 * misses them; YouTube's does not. The per-platform share divides the same
 * total, so adding a platform does not lengthen the cron.
 *
 * **The pass is bounded by a clock, not only by a row count.** A batch size
 * bounds how many grants are touched and says nothing about how long touching
 * them takes, and the thing that runs out inside a cron invocation is time. See
 * `SWEEP_BUDGET_MS` for the deadline, `SWEEP_ORDER` for who gets the budget
 * first, and `RefreshDeps.retry` for the per-row backoff this pass does not pay.
 */
export async function refreshExpiringTokens(deps: RefreshDeps): Promise<RefreshSweepResult> {
  const now = deps.now ?? Date.now;
  const refreshers = deps.refreshers ?? TOKEN_REFRESHERS;
  const result: RefreshSweepResult = {
    checked: 0, refreshed: 0, broken: 0, deferred: 0, skipped: 0, ranOutOfTime: 0,
  };

  // Measured against the real clock even when `now` is injected: a test that
  // pins `now` to a constant is describing token expiries, not asking for an
  // infinite budget, and a deadline that never moves is not a deadline.
  const deadline = Date.now() + SWEEP_BUDGET_MS;

  // Only platforms something can actually refresh. Querying the others spends
  // batch slots on rows we would skip — and skipping is still right: "we have
  // not built this yet" is a fact about us, not about the creator's grant.
  const platforms = [...CONNECTED_PLATFORMS]
    .filter((platform) => refreshers[platform])
    .sort((a, b) => sweepRank(a) - sweepRank(b));
  if (platforms.length === 0) return result;
  const share = Math.max(1, Math.floor(REFRESH_BATCH / platforms.length));

  for (const platform of platforms) {
    // Per platform, because the window means different things per platform —
    // slack for a refresh-token platform, retry attempts for Instagram.
    const horizon = new Date(now() + refreshWindowFor(platform)).toISOString();
    const { data } = await deps.supabase
      .from(TABLE)
      .select(CONNECTION_FIELDS)
      .eq('platform', platform)
      .is('broken_reason', null)
      // A row with no expiry is not a healthy row, it is one nothing can judge.
      // Excluding it outright is how a grant with a null `expires_at` — which
      // `exchangeYouTubeCode` writes whenever Google omits `expires_in` — was
      // never swept, never questioned and never discovered to be dead.
      .or(`expires_at.is.null,expires_at.lt.${horizon}`)
      // `nullsFirst` is load-bearing, not a tidying. Postgres sorts NULLs LAST
      // on an ascending order, so a bare `.order('expires_at')` puts the rows
      // the `.or()` above was widened to include at the tail — where `.limit()`
      // drops them first, permanently, on any platform with more in-window rows
      // than its share. That is every YouTube row (hourly tokens) and every
      // TikTok deployment past ~33 creators: the fix undone at the scale it was
      // written for. First is also the honest order — a grant nothing can judge
      // is the most urgent row here, not the least.
      .order('expires_at', { ascending: true, nullsFirst: true })
      .limit(share);

    for (const row of (data ?? []) as Array<Record<string, any>>) {
      const connection = toConnection(row);

      // Checked before the call, not after: the point is to not start work that
      // cannot finish. Rows left here are untouched and first in tomorrow's
      // query, which is where a deferral leaves them too.
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        result.ranOutOfTime++;
        continue;
      }

      result.checked++;
      // One creator's grant must not stop the sweep reaching the rest, and a
      // database error writing one row is not evidence about any other.
      try {
        const refresh = await refreshConnection({
          ...deps,
          // No backoff in a batch — see REFRESH_RETRY_DELAYS_MS.
          retry: false,
          // Whatever is left of the sweep's budget, so one stalled socket cannot
          // spend the time the platforms after this one need.
          signal: providerSignal(remaining, deps.signal),
        }, connection);
        if (refresh.status === 'refreshed') result.refreshed++;
        else if (refresh.status === 'broken') result.broken++;
        else if (refresh.status === 'deferred') {
          result.deferred++;
          // Per row, not just in the run total. A deferral writes nothing, so
          // this line is the only record that this particular grant failed
          // today — and the sequence of them is how an operator tells a grant
          // failing every day apart from one that failed once.
          log({
            event: 'CRON:TOKEN_REFRESH',
            status: 'error',
            userId: connection.creatorId,
            detail:
              `platform=${connection.platform} account=${connection.id} deferred ` +
              `lastWrote=${connection.updatedAt ?? 'unknown'}`,
            reason: refresh.reason,
          });
        } else result.skipped++;
      } catch (err) {
        result.deferred++;
        log({
          event: 'CRON:TOKEN_REFRESH',
          status: 'error',
          userId: connection.creatorId,
          detail: `platform=${connection.platform} account=${connection.id} deferred`,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  log({
    event: 'CRON:TOKEN_REFRESH',
    // A run that deferred anything is a run an operator should see: it means
    // the provider was unreachable, not that everything was already fine.
    status: result.broken > 0 || result.deferred > 0 || result.ranOutOfTime > 0 ? 'error' : 'success',
    detail:
      `checked=${result.checked} refreshed=${result.refreshed} broken=${result.broken} ` +
      `deferred=${result.deferred} skipped=${result.skipped} ranOutOfTime=${result.ranOutOfTime}`,
  });

  return result;
}

/** Position in `SWEEP_ORDER`; anything unlisted sorts after everything listed. */
function sweepRank(platform: ConnectedPlatform): number {
  const index = SWEEP_ORDER.indexOf(platform);
  return index === -1 ? SWEEP_ORDER.length : index;
}
