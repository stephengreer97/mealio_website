import { NextRequest, NextResponse } from 'next/server';
import { jwtVerify } from 'jose';
import { createServerSupabaseClient } from '@/lib/supabase';
import { log } from '@/lib/logger';
import { loadConnection, saveConnection } from '@/lib/platform-tokens';
import { exchangeYouTubeCode, fetchOwnChannel, grantCanReadCaptions, YOUTUBE_FORCE_SSL_SCOPE } from '@/lib/youtube';
import { STATE_COOKIE } from '../connect/route';
import type { ConnectFailure } from '@/lib/creator-connect';

/**
 * GET /api/creator/youtube/callback — where Google sends the creator back.
 *
 * Everything that decides what happens comes from the signed state cookie, not
 * from the query string: which creator this is, and whether they ticked the
 * separate consent to have descriptions edited. Google echoes a nonce, and the
 * only thing the nonce proves is that this response belongs to the request that
 * set the cookie.
 *
 * That consent claim is **tri-state** (MEAL-138): `true`, `false`, or absent for
 * a round trip that never asked the question — a captions request. Absent means
 * the flag is not written on either side. The `decision` computed below is
 * the whole of what this route does to `youtube_append_opt_in`.
 *
 * The channel id is read from the grant (`channels.list?mine=true`), never typed
 * by a creator and never taken from the link on their application.
 */

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://mealio.co';
const JWT_SECRET = () => new TextEncoder().encode(process.env.JWT_SECRET || '');

/**
 * Sends the creator back to the portal with a reason **code**, and drops the
 * state cookie.
 *
 * A code and not the sentence, for the argument in `ConnectFailure`
 * (`lib/creator-connect.ts`): free text in the query string is prose an attacker
 * chooses, rendered inside our own error styling on our own domain.
 * `consent-write` and `consent-withdraw` are this route's extra branches — the
 * two ways the separate append opt-in can fail to save.
 */
function back(outcome: string, reason?: ConnectFailure | 'consent-write' | 'consent-withdraw'): NextResponse {
  const url = new URL(`${APP_URL}/creator`);
  url.searchParams.set('youtube', outcome);
  if (reason) url.searchParams.set('reason', reason);
  // Back to the tab they left from — see `backToPortal` in
  // `lib/creator-connect.ts`, which does the same for the other platforms.
  url.hash = 'settings';
  const response = NextResponse.redirect(url.toString());
  response.cookies.set(STATE_COOKIE, '', { path: '/', maxAge: 0 });
  return response;
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);

  const stateCookie = request.cookies.get(STATE_COOKIE)?.value;
  if (!stateCookie) {
    return back('failed', 'expired');
  }

  let userId: string;
  let creatorId: string;
  let nonce: string;
  /** `undefined` = this trip did not ask about description editing. */
  let appendOptIn: boolean | undefined;
  try {
    const { payload } = await jwtVerify(stateCookie, JWT_SECRET());
    if (payload.type !== 'youtube_connect') throw new Error('wrong token type');
    userId = String(payload.sub);
    creatorId = String(payload.creatorId);
    nonce = String(payload.nonce);
    // Absent stays absent. Everything else is read the strict way it always was:
    // only a literal `true` is consent, so a tampered or odd claim is a no.
    appendOptIn = payload.appendOptIn === undefined ? undefined : payload.appendOptIn === true;
  } catch {
    log({ event: 'CREATOR:SOURCE_CONNECT', status: 'failed', reason: 'invalid state cookie' });
    return back('failed', 'unverified');
  }

  // Two known, accepted properties of this comparison, recorded so they are not
  // rediscovered as findings. It is not constant-time: the value it is checked
  // against lives in an httpOnly cookie the attacker cannot read, so there is
  // no oracle to time. And there is no server-side nonce store, so a *captured*
  // cookie stays usable for its full 15 minutes — the code itself is single-use
  // at Google and this cookie is cleared on every exit, which bounds the replay
  // to an attacker who already has the creator's cookie jar.
  if (searchParams.get('state') !== nonce) {
    log({ event: 'CREATOR:SOURCE_CONNECT', status: 'failed', userId, reason: 'state mismatch (csrf)' });
    return back('failed', 'unverified');
  }

  // A creator who changed their mind on Google's screen. Not an error, and
  // nothing is stored — including the append consent they ticked on ours.
  if (searchParams.get('error')) {
    log({ event: 'CREATOR:SOURCE_CONNECT', status: 'failed', userId, detail: 'platform=youtube', reason: 'cancelled' });
    return back('cancelled');
  }

  const code = searchParams.get('code');
  if (!code) {
    return back('failed', 'no-code');
  }

  const exchanged = await exchangeYouTubeCode(code);
  if (!exchanged.ok) {
    log({ event: 'CREATOR:SOURCE_CONNECT', status: 'error', userId, detail: 'platform=youtube', reason: exchanged.detail });
    // Google's own sentence stays in the log line above. See `ConnectFailure`.
    return back('failed', 'exchange');
  }

  const channel = await fetchOwnChannel(exchanged.grant.accessToken);
  if (!channel.ok) {
    log({ event: 'CREATOR:SOURCE_CONNECT', status: 'error', userId, detail: 'platform=youtube', reason: channel.detail });
    return back('failed', 'account');
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
   * permission, it is a tick the card renders beside a channel Google refused —
   * and it was reachable: tick "also let Mealio add the link" on the connect
   * form, untick `force-ssl` on Google's granular screen, and that is the row you
   * get. So the answer is not carried on faith and the flag is cleared instead.
   *
   * **An unasked question leaves the flag alone — unless the grant it stood
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
    return back('failed', 'consent-withdraw');
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
    return back('failed', 'store');
  }

  // Granting comes last, and its result is checked like any other. Reporting
  // `connected` on a failed consent write logged an audit line asserting a
  // permission change that never happened.
  if (decision === 'granted' && !(await writeAppendOptIn(true))) {
    return back('failed', 'consent-write');
  }

  log({
    event: 'CREATOR:SOURCE_CONNECT',
    status: 'success',
    userId,
    // No tokens, ever. The channel id is public and is the useful half.
    detail:
      `platform=youtube creator=${creatorId} channel=${channel.channel.id} ` +
      // What happened to the flag, not what was asked for. "unchanged" is a real
      // outcome — a captions trip does not answer the append question — and an
      // audit line that printed the answer instead would say `false` about a
      // creator whose consent still stands.
      `appendOptIn=${decision} ` +
      // `forceSsl` rather than `write`: the one scope buys description editing
      // *and* caption reading, and calling it "write" in the log is the same
      // mislabelling that let MEAL-138 happen in the first place. False here
      // means this creator's thin-description videos cannot be imported.
      `forceSsl=${exchanged.grant.scopes.includes(YOUTUBE_FORCE_SSL_SCOPE)}`,
  });

  return back('connected');
}
