import { NextRequest, NextResponse } from 'next/server';
import { jwtVerify } from 'jose';
import { log } from '@/lib/logger';
import { STATE_COOKIE } from '../connect/route';
import type { ConnectFailure } from '@/lib/creator-connect';
import { finishYouTubeConnect } from '@/lib/creator-connect-finish';

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
 * the flag is not written on either side. The `decision` computed in
 * `finishYouTubeConnect` is the whole of what this route does to
 * `youtube_append_opt_in`.
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

  // Everything from here is shared with the mobile app's `/complete`, so the two
  // paths cannot drift into accepting different grants.
  const finished = await finishYouTubeConnect({ userId, creatorId, code, appendOptIn });
  return finished.ok ? back('connected') : back('failed', finished.reason);
}
