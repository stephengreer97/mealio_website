/**
 * Everything a connection does after its round trip has been verified: exchange
 * the code, check what came back, store it, log it.
 *
 * There are two ways into this and exactly one way through it. The website's
 * `GET /api/creator/<platform>/callback` verifies a state cookie and a nonce; the
 * mobile app's `POST /api/creator/<platform>/complete` verifies a signed state
 * bound to the bearer token (see `lib/creator-connect.ts`). Once either has
 * established *which creator* is connecting, the rest is this file, so the two
 * clients cannot drift into accepting different grants.
 *
 * None of these take a request or return a response. They return a reason code
 * (`ConnectFailure`), and each caller renders it its own way: a redirect with
 * `?reason=` for the website, JSON with the sentence for the app.
 *
 * Nothing here checks identity. Calling one of these without having verified the
 * state first attaches somebody's account to whichever creator was passed in.
 */

import { createServerSupabaseClient } from '@/lib/supabase';
import { log } from '@/lib/logger';
import { loadConnection, saveConnection } from '@/lib/platform-tokens';
import { exchangeInstagramCode, fetchInstagramAccount, INSTAGRAM_BASIC_SCOPE } from '@/lib/instagram';
import { exchangeTikTokCode, TIKTOK_VIDEO_LIST_SCOPE } from '@/lib/tiktok';
import { exchangeYouTubeCode, fetchOwnChannel, grantCanReadCaptions, YOUTUBE_FORCE_SSL_SCOPE } from '@/lib/youtube';
import type { ConnectFailure } from '@/lib/creator-connect';

/** YouTube's extra branches: the two ways the separate append opt-in can fail to save. */
export type YouTubeConsentFailure = 'consent-write' | 'consent-withdraw';

export type FinishResult<Reason extends string = ConnectFailure> = { ok: true } | { ok: false; reason: Reason };

export interface VerifiedConnect {
  /** From the verified state, never from the query string. */
  userId: string;
  creatorId: string;
  /** As the provider sent it. Instagram's trailing `#_` is stripped by the exchange. */
  code: string;
}

// ── Instagram ────────────────────────────────────────────────────────────────

/**
 * Two failures get their own code rather than a generic one, because in both
 * cases the creator can act on the answer: a **personal** account (Instagram
 * grants those no API access at all), and a grant that came back without the
 * basic scope, which happens when someone unticks it on Meta's own screen and
 * would otherwise present as a connection that reads nothing forever.
 */
export async function finishInstagramConnect({ userId, creatorId, code }: VerifiedConnect): Promise<FinishResult> {
  const exchanged = await exchangeInstagramCode(code);
  if (!exchanged.ok) {
    log({ event: 'CREATOR:SOURCE_CONNECT', status: 'error', userId, detail: 'platform=instagram', reason: exchanged.detail });
    // Instagram's own sentence stays in the log line above; the client owns what
    // the creator reads. See `ConnectFailure`.
    return { ok: false, reason: 'exchange' };
  }

  if (!exchanged.grant.scopes.includes(INSTAGRAM_BASIC_SCOPE)) {
    log({ event: 'CREATOR:SOURCE_CONNECT', status: 'failed', userId, detail: 'platform=instagram', reason: `basic scope not granted (${exchanged.grant.responseShape})` });
    return { ok: false, reason: 'scope' };
  }

  const account = await fetchInstagramAccount(exchanged.grant.accessToken);
  if (!account.ok) {
    log({ event: 'CREATOR:SOURCE_CONNECT', status: 'error', userId, detail: 'platform=instagram', reason: account.detail });
    return { ok: false, reason: 'account' };
  }

  const supabase = createServerSupabaseClient();

  try {
    await saveConnection(supabase, {
      creatorId,
      platform: 'instagram',
      // From the grant, never typed by a creator and never taken off the link on
      // their application.
      externalId: account.account.id,
      externalName: account.account.username,
      accessToken: exchanged.grant.accessToken,
      // Instagram has no refresh token: the long-lived access token renews
      // itself while it is alive. `refreshInstagramGrant` is what keeps it that
      // way, and `expires_at` is what puts this row in the sweep's sights.
      refreshToken: null,
      scopes: exchanged.grant.scopes,
      expiresAt: exchanged.grant.expiresAt,
    });
  } catch (err) {
    log({ event: 'CREATOR:SOURCE_CONNECT', status: 'error', userId, detail: 'platform=instagram', error: err });
    return { ok: false, reason: 'store' };
  }

  log({
    event: 'CREATOR:SOURCE_CONNECT',
    status: 'success',
    userId,
    // No tokens, ever. The account id and type are the useful half, and the
    // expiry is the number anyone debugging this in two months will want.
    detail:
      `platform=instagram creator=${creatorId} account=${account.account.id} ` +
      `type=${account.account.accountType ?? 'unknown'} expires=${exchanged.grant.expiresAt ?? 'never'}`,
  });

  return { ok: true };
}

// ── TikTok ───────────────────────────────────────────────────────────────────

/**
 * The account's `open_id` arrives in the token response, and that is the only
 * place we can get it: without `user.info.basic` there is no profile endpoint,
 * and we are deliberately not requesting that scope for the sake of a prettier
 * label. So the connection stores an id and no display name.
 */
export async function finishTikTokConnect({ userId, creatorId, code }: VerifiedConnect): Promise<FinishResult> {
  const exchanged = await exchangeTikTokCode(code);
  if (!exchanged.ok) {
    log({ event: 'CREATOR:SOURCE_CONNECT', status: 'error', userId, detail: 'platform=tiktok', reason: exchanged.detail });
    // TikTok's own sentence stays in the log line above. See `ConnectFailure`.
    return { ok: false, reason: 'exchange' };
  }

  // A grant without `video.list` cannot list anything, which would present as a
  // connected account that never yields a post, the silent failure this whole
  // area is written around. Refuse it while there is still someone to tell.
  if (!exchanged.grant.scopes.includes(TIKTOK_VIDEO_LIST_SCOPE)) {
    log({ event: 'CREATOR:SOURCE_CONNECT', status: 'failed', userId, detail: 'platform=tiktok', reason: 'video.list not granted' });
    return { ok: false, reason: 'scope' };
  }

  if (!exchanged.grant.openId) {
    return { ok: false, reason: 'account' };
  }

  const supabase = createServerSupabaseClient();

  try {
    await saveConnection(supabase, {
      creatorId,
      platform: 'tiktok',
      externalId: exchanged.grant.openId,
      // No display name: `user.info.basic` is not on the app, on purpose.
      externalName: null,
      accessToken: exchanged.grant.accessToken,
      // Rotated on every refresh from here on. The stored one is only ever the
      // most recent, because the previous one dies the moment it is used.
      refreshToken: exchanged.grant.refreshToken,
      scopes: exchanged.grant.scopes,
      // The *access* token's expiry, about a day out. That is what puts this row
      // in the daily sweep permanently, which is what keeps the year-long
      // refresh token rotating long before its own expiry.
      expiresAt: exchanged.grant.expiresAt,
    });
  } catch (err) {
    log({ event: 'CREATOR:SOURCE_CONNECT', status: 'error', userId, detail: 'platform=tiktok', error: err });
    return { ok: false, reason: 'store' };
  }

  log({
    event: 'CREATOR:SOURCE_CONNECT',
    status: 'success',
    userId,
    // No tokens, ever. `open_id` is app-scoped and is the useful half.
    detail: `platform=tiktok creator=${creatorId} account=${exchanged.grant.openId} expires=${exchanged.grant.expiresAt ?? 'never'}`,
  });

  return { ok: true };
}

// ── YouTube ──────────────────────────────────────────────────────────────────

/**
 * The channel id is read from the grant (`channels.list?mine=true`), never typed
 * by a creator and never taken from the link on their application.
 *
 * `appendOptIn` is **tri-state** (MEAL-138): `true`, `false`, or `undefined` for
 * a round trip that never asked the question (a captions request). It comes from
 * the verified state, never from the query string. The `decision` computed below
 * is the whole of what a connection does to `youtube_append_opt_in`.
 */
export async function finishYouTubeConnect({
  userId,
  creatorId,
  code,
  appendOptIn,
}: VerifiedConnect & { appendOptIn: boolean | undefined }): Promise<FinishResult<ConnectFailure | YouTubeConsentFailure>> {
  const exchanged = await exchangeYouTubeCode(code);
  if (!exchanged.ok) {
    log({ event: 'CREATOR:SOURCE_CONNECT', status: 'error', userId, detail: 'platform=youtube', reason: exchanged.detail });
    // Google's own sentence stays in the log line above. See `ConnectFailure`.
    return { ok: false, reason: 'exchange' };
  }

  const channel = await fetchOwnChannel(exchanged.grant.accessToken);
  if (!channel.ok) {
    log({ event: 'CREATOR:SOURCE_CONNECT', status: 'error', userId, detail: 'platform=youtube', reason: channel.detail });
    return { ok: false, reason: 'account' };
  }

  const supabase = createServerSupabaseClient();

  /** Writes the consent flag and says whether it landed. Never assumed. */
  const writeAppendOptIn = async (value: boolean): Promise<boolean> => {
    const { error } = await supabase
      .from('creators')
      .update({ youtube_append_opt_in: value })
      .eq('id', creatorId);
    if (error) {
      log({ event: 'CREATOR:SOURCE_CONNECT', status: 'error', userId, detail: 'platform=youtube consent', error });
    }
    return !error;
  };

  /**
   * What this round trip does to `youtube_append_opt_in`, and the whole of it.
   *
   * `force-ssl` is the scope behind *both* capabilities, so the grant coming back
   * is what makes a write physically possible. Three inputs decide:
   *
   *   - `appendOptIn` — the creator's answer, or absent if unasked (MEAL-138).
   *   - `forceSsl`    — whether the grant they just made can write at all.
   *   - `priorForceSsl` — whether the grant it replaces could.
   *
   * **`true` is written only when the creator answered `true` on this trip and
   * the grant carries the scope.** A `true` on a grant that cannot write is not a
   * permission, it is a tick the card renders beside a channel Google refused,
   * and it was reachable: tick "also let Mealio add the link" on the connect
   * form, untick `force-ssl` on Google's granular screen, and that is the row you
   * get. So the answer is not carried on faith and the flag is cleared instead.
   *
   * **An unasked question leaves the flag alone, unless the grant it stood
   * beside could not write.** That is the same row, one trip later: a captions
   * request grants `force-ssl` and would arm an append nobody asked for, on the
   * strength of a tick made about a permission Google never gave. Nothing is lost
   * by clearing it, because nothing could be written under it; the box goes back
   * to unticked and one click re-grants it, deliberately, through the PATCH.
   */
  const forceSsl = grantCanReadCaptions(exchanged.grant.scopes);
  // A read we could not make counts as a grant that could not write: the
  // fail-safe direction is to clear a flag we cannot justify, not to keep it.
  let priorForceSsl = false;
  try {
    priorForceSsl = grantCanReadCaptions((await loadConnection(supabase, creatorId, 'youtube'))?.scopes);
  } catch (err) {
    log({ event: 'CREATOR:SOURCE_CONNECT', status: 'error', userId, detail: 'platform=youtube prior grant', error: err });
  }
  const decision: 'granted' | 'withdrawn' | 'unchanged' =
    appendOptIn === true && forceSsl
      ? 'granted'
      : appendOptIn === false || !forceSsl || !priorForceSsl
        ? 'withdrawn'
        : 'unchanged';

  // Consent is withdrawn *before* the grant is stored and granted only after.
  //
  // Both halves matter. Withdrawal has to happen first because the alternative
  // leaves a window in which a fresh write-scoped token sits beside a `true`
  // the creator has just unticked, and `assertAppendAllowed` would say yes in
  // it. It also has to happen unconditionally: writing the connection first and
  // returning early when that write fails abandoned the withdrawal entirely,
  // leaving us permitted to edit descriptions on the strength of a tick the
  // creator had just removed, while the screen said the attempt had failed.
  if (decision === 'withdrawn' && !(await writeAppendOptIn(false))) {
    return { ok: false, reason: 'consent-withdraw' };
  }

  try {
    await saveConnection(supabase, {
      creatorId,
      platform: 'youtube',
      externalId: channel.channel.id,
      externalName: channel.channel.title,
      accessToken: exchanged.grant.accessToken,
      refreshToken: exchanged.grant.refreshToken,
      scopes: exchanged.grant.scopes,
      expiresAt: exchanged.grant.expiresAt,
    });
  } catch (err) {
    log({ event: 'CREATOR:SOURCE_CONNECT', status: 'error', userId, detail: 'platform=youtube', error: err });
    return { ok: false, reason: 'store' };
  }

  // Granting comes last, and its result is checked like any other. Reporting
  // `connected` on a failed consent write logged an audit line asserting a
  // permission change that never happened.
  if (decision === 'granted' && !(await writeAppendOptIn(true))) {
    return { ok: false, reason: 'consent-write' };
  }

  log({
    event: 'CREATOR:SOURCE_CONNECT',
    status: 'success',
    userId,
    // No tokens, ever. The channel id is public and is the useful half.
    detail:
      `platform=youtube creator=${creatorId} channel=${channel.channel.id} ` +
      // What happened to the flag, not what was asked for. "unchanged" is a real
      // outcome (a captions trip does not answer the append question) and an
      // audit line that printed the answer instead would say `false` about a
      // creator whose consent still stands.
      `appendOptIn=${decision} ` +
      // `forceSsl` rather than `write`: the one scope buys description editing
      // *and* caption reading, and calling it "write" in the log is the same
      // mislabelling that let MEAL-138 happen in the first place. False here
      // means this creator's thin-description videos cannot be imported.
      `forceSsl=${exchanged.grant.scopes.includes(YOUTUBE_FORCE_SSL_SCOPE)}`,
  });

  return { ok: true };
}
