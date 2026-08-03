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
    });
  } catch (err) {
    return {
      ok: false,
      reason: `Google did not answer the refresh request: ${err instanceof Error ? err.message : String(err)}`,
      terminal: false,
    };
  }

  const payload = await response.json().catch(() => null as unknown);
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
 * Per-platform refreshers. Instagram and TikTok land here (MEAL-82 / MEAL-83);
 * a platform with no entry is skipped by the sweep rather than marked broken,
 * because "we have not built this yet" is not a fact about the creator's grant.
 */
export const TOKEN_REFRESHERS: Partial<Record<ConnectedPlatform, TokenRefresher>> = {
  youtube: refreshGoogleGrant,
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
}

/**
 * How long to wait between attempts at a grant whose failure looked transient.
 *
 * Two extra attempts, under a second and a half in total. Small on purpose: a
 * whole batch failing during an outage multiplies this by the batch size, and
 * the real protection is not the retry but what happens when it runs out — the
 * row is left exactly as it was, so the next sweep and every on-demand caller
 * try again, indefinitely and for free.
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
 * Refreshes one grant, recording either the new token or why it failed.
 *
 * A transient failure is retried with a short backoff and then deferred. Only a
 * terminal one — the provider saying the grant is gone — writes `broken_reason`
 * and clears the token, because that flag takes a creator's channel out of
 * service until they reconnect and the sweep never revisits it.
 */
export async function refreshConnection(
  deps: RefreshDeps,
  connection: PlatformConnection,
): Promise<RefreshResult> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const refresher = (deps.refreshers ?? TOKEN_REFRESHERS)[connection.platform];
  if (!refresher) return { status: 'unsupported', connection };

  const options: RefreshOptions = { fetchImpl: deps.fetchImpl, now };
  let outcome = await attemptRefresh(refresher, connection, options);
  for (let attempt = 0; !outcome.ok && !outcome.terminal && attempt < REFRESH_RETRY_DELAYS_MS.length; attempt++) {
    await sleep(REFRESH_RETRY_DELAYS_MS[attempt]);
    outcome = await attemptRefresh(refresher, connection, options);
  }

  if (!outcome.ok) {
    if (!outcome.terminal) return { status: 'deferred', reason: outcome.reason };
    // Broken only if the flag actually landed. A write that matched nothing
    // means the grant this `invalid_grant` was about has already been replaced.
    const applied = await markConnectionBroken(deps.supabase, connection, outcome.reason, now);
    return applied ? { status: 'broken', reason: outcome.reason } : { status: 'superseded' };
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

/** One pass has to fit in a cron invocation alongside everything else it runs. */
export const REFRESH_BATCH = 100;

export interface RefreshSweepResult {
  checked: number;
  refreshed: number;
  broken: number;
  /** Failed transiently. Untouched, and in the next run's query unchanged. */
  deferred: number;
  skipped: number;
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
 */
export async function refreshExpiringTokens(deps: RefreshDeps): Promise<RefreshSweepResult> {
  const now = deps.now ?? Date.now;
  const refreshers = deps.refreshers ?? TOKEN_REFRESHERS;
  const horizon = new Date(now() + REFRESH_WINDOW_MS).toISOString();
  const result: RefreshSweepResult = { checked: 0, refreshed: 0, broken: 0, deferred: 0, skipped: 0 };

  // Only platforms something can actually refresh. Querying the others spends
  // batch slots on rows we would skip — and skipping is still right: "we have
  // not built this yet" is a fact about us, not about the creator's grant.
  const platforms = CONNECTED_PLATFORMS.filter((platform) => refreshers[platform]);
  if (platforms.length === 0) return result;
  const share = Math.max(1, Math.floor(REFRESH_BATCH / platforms.length));

  for (const platform of platforms) {
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
      .order('expires_at', { ascending: true })
      .limit(share);

    for (const row of (data ?? []) as Array<Record<string, any>>) {
      const connection = toConnection(row);
      result.checked++;
      // One creator's grant must not stop the sweep reaching the rest, and a
      // database error writing one row is not evidence about any other.
      try {
        const refresh = await refreshConnection(deps, connection);
        if (refresh.status === 'refreshed') result.refreshed++;
        else if (refresh.status === 'broken') result.broken++;
        else if (refresh.status === 'deferred') result.deferred++;
        else result.skipped++;
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
    status: result.broken > 0 || result.deferred > 0 ? 'error' : 'success',
    detail:
      `checked=${result.checked} refreshed=${result.refreshed} broken=${result.broken} ` +
      `deferred=${result.deferred} skipped=${result.skipped}`,
  });

  return result;
}
