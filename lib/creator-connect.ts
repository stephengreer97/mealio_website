/**
 * The OAuth round trip a creator makes to connect a publishing account
 * (MEAL-82 / MEAL-83).
 *
 * This is MEAL-74's YouTube connect/callback pair with the platform lifted out.
 * Instagram and TikTok differ only in which consent URL is opened and what comes
 * back, and the part that is identical is the part that must not be got wrong
 * twice — so it lives once, here.
 *
 * **Identity travels in a signed httpOnly cookie, not in `state`.** The `state`
 * parameter is a nonce and proves one thing only: that this response belongs to
 * the request that set the cookie. Who is connecting comes from the cookie,
 * which is signed with `JWT_SECRET` and never leaves this origin. Identity that
 * round-trips through a third party and comes back in a query string is identity
 * anyone can supply, and what is being attached is read access to a creator's
 * account.
 *
 * The nonce is checked and the cookie verified **before** the authorization code
 * is exchanged, so a forged or replayed callback never causes a token to be
 * minted at all.
 *
 * That is the website. The mobile app cannot carry a cookie across to the browser
 * doing the consent, so it has its own round trip further down (see "The mobile
 * app's round trip"): a signed `state`, a callback that bounces to
 * `mealio://creator/connect` without exchanging anything, and a `/complete` that
 * matches the state to the bearer token before the code is spent.
 *
 * YouTube keeps its own copy of this dance. Its state also carries the separate
 * consent to edit descriptions, and rewriting a route that landed hours ago is
 * not what these two tickets are for — but there is one shape here, and a third
 * platform should use this rather than a third copy.
 */

import { NextRequest, NextResponse } from 'next/server';
import { randomBytes } from 'crypto';
import { SignJWT, jwtVerify, errors as joseErrors, type JWTPayload } from 'jose';
import { createServerSupabaseClient } from '@/lib/supabase';
import { requireAuth } from '@/lib/requireAuth';
import { log } from '@/lib/logger';
import { deleteConnection, describeConnection, loadConnection } from '@/lib/platform-tokens';
import { SOURCE_LABELS, type ConnectedPlatform } from '@/lib/creator-sources';
import { connectFailureCopy, GENERIC_CONNECT_FAILURE } from '@/lib/connect-copy';
import type { FinishResult, VerifiedConnect } from '@/lib/creator-connect-finish';

const APP_URL = () => process.env.NEXT_PUBLIC_APP_URL || 'https://mealio.co';
const JWT_SECRET = () => new TextEncoder().encode(process.env.JWT_SECRET || '');

/** Long enough to read a consent screen, short enough that a stale tab is not a key. */
export const STATE_TTL_SECONDS = 900;

/** One cookie per platform, so connecting two accounts in two tabs cannot cross. */
export function stateCookieName(platform: ConnectedPlatform): string {
  return `mealio_${platform}_state`;
}

/**
 * Why a connection attempt ended, as a code rather than as prose.
 *
 * The callback used to redirect with the failure *sentence* in the query string
 * and the portal card rendered it as its red error line. React escapes it, so
 * there was never an XSS — but the sentence was still whatever the URL said, and
 * `mealio.co/creator?instagram=failed&detail=…` renders arbitrary text inside
 * our own error styling on our own domain, which is a phishing page we host.
 *
 * A code fixes it by construction: the card owns the words, so the worst an
 * attacker can do with a hand-written URL is pick which of *our* sentences a
 * creator reads. The provider's own wording is not lost, it just goes where it
 * was always more use — the `CREATOR:SOURCE_CONNECT` log line, which already
 * carries it.
 *
 * `expired` and `unverified` are the two refusals in `readPlatformConnectState`;
 * the rest name the branches of the callbacks.
 */
export type ConnectFailure =
  | 'expired'        // no state cookie: a stale tab, or an attempt that began elsewhere
  | 'unverified'     // a cookie we did not sign, or a nonce that does not match
  | 'no-code'        // the provider sent the creator back without one
  | 'exchange'       // the code would not exchange for a token
  | 'scope'          // the grant came back without permission to read anything
  | 'account'        // the account itself is unusable (a personal IG account, no open id)
  | 'store'          // the grant was fine and we could not write it down
  // The provider turned the account down rather than the creator declining
  // (MEAL-101). Distinct from `cancelled`, which is an outcome rather than a
  // failure: reading every redirect `error` as "you cancelled" blames a creator
  // for something they did not do. While TikTok's app was in sandbox this was
  // usually its tester allow-list; since approval (2026-08-06) it is a real
  // refusal, so the copy no longer names a cause it cannot know.
  | 'unavailable';

/** Where the creator lands afterwards, with something the portal can render. */
export function backToPortal(platform: ConnectedPlatform, outcome: string, reason?: ConnectFailure): NextResponse {
  const url = new URL(`${APP_URL()}/creator`);
  url.searchParams.set(platform, outcome);
  if (reason) url.searchParams.set('reason', reason);
  // Back to the tab they left from. The portal opens on Meals, so without this a
  // creator returning from a consent screen lands somewhere that says nothing
  // about what just happened — and the card carrying the answer, success or
  // failure, is one they have to go and find.
  url.hash = 'settings';
  const response = NextResponse.redirect(url.toString());
  // Dropped whatever happened: a state cookie that outlives its round trip is a
  // second chance for somebody else's callback.
  response.cookies.set(stateCookieName(platform), '', { path: '/', maxAge: 0 });
  return response;
}

/**
 * `POST /api/creator/<platform>/connect`.
 *
 * Returns the consent URL for the client to navigate to rather than redirecting
 * itself: the creator portal authenticates with a bearer token out of
 * localStorage, and an `<a href>` to a redirecting endpoint would arrive without
 * one.
 */
export async function startPlatformConnect(
  request: NextRequest,
  platform: ConnectedPlatform,
  buildAuthUrl: (nonce: string) => string | null,
): Promise<NextResponse> {
  const user = await requireAuth(request);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = createServerSupabaseClient();
  const { data: creator } = await supabase
    .from('creators')
    .select('id')
    .eq('user_id', user.userId)
    .maybeSingle();

  if (!creator) {
    return NextResponse.json({ error: 'Only approved creators can connect an account.' }, { status: 403 });
  }

  const creatorId = (creator as { id: string }).id;

  if (await wantsAppClient(request)) {
    const appState = await signAppConnectState(platform, user.userId, creatorId);
    const appUrl = buildAuthUrl(appState);
    if (!appUrl) {
      return NextResponse.json(
        { error: `${SOURCE_LABELS[platform]} connection is not configured on this deployment.` },
        { status: 500 },
      );
    }
    log({
      event: 'CREATOR:SOURCE_CONNECT',
      status: 'pending',
      userId: user.userId,
      email: user.email,
      detail: `platform=${platform} client=app`,
    });
    // No cookie: it would land in the app's fetch cookie jar, which the browser
    // doing the consent never sees. See `signAppConnectState`.
    return NextResponse.json({ url: appUrl });
  }

  const nonce = randomBytes(16).toString('hex');
  const authUrl = buildAuthUrl(nonce);
  if (!authUrl) {
    return NextResponse.json(
      { error: `${SOURCE_LABELS[platform]} connection is not configured on this deployment.` },
      { status: 500 },
    );
  }

  const state = await new SignJWT({
    sub: user.userId,
    creatorId,
    nonce,
    type: `${platform}_connect`,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${STATE_TTL_SECONDS}s`)
    .sign(JWT_SECRET());

  log({
    event: 'CREATOR:SOURCE_CONNECT',
    status: 'pending',
    userId: user.userId,
    email: user.email,
    detail: `platform=${platform}`,
  });

  const response = NextResponse.json({ url: authUrl });
  response.cookies.set(stateCookieName(platform), state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: STATE_TTL_SECONDS,
    path: '/',
  });
  return response;
}

export interface ConnectState {
  userId: string;
  creatorId: string;
}

/**
 * Verifies a callback before anything is exchanged.
 *
 * Three ways this refuses, and all of them happen before the code is spent: no
 * cookie (an expired attempt, or one that never started here), a cookie we did
 * not sign or that names a different platform, and an echoed `state` that is not
 * the nonce we issued.
 */
export async function readPlatformConnectState(
  request: NextRequest,
  platform: ConnectedPlatform,
  echoedState: string | null,
): Promise<{ ok: true; state: ConnectState } | { ok: false; response: NextResponse }> {
  const cookie = request.cookies.get(stateCookieName(platform))?.value;
  if (!cookie) {
    return {
      ok: false,
      response: backToPortal(platform, 'failed', 'expired'),
    };
  }

  let userId: string;
  let creatorId: string;
  let nonce: string;
  try {
    const { payload } = await jwtVerify(cookie, JWT_SECRET());
    if (payload.type !== `${platform}_connect`) throw new Error('wrong token type');
    userId = String(payload.sub);
    creatorId = String(payload.creatorId);
    nonce = String(payload.nonce);
  } catch {
    log({ event: 'CREATOR:SOURCE_CONNECT', status: 'failed', detail: `platform=${platform}`, reason: 'invalid state cookie' });
    return {
      ok: false,
      response: backToPortal(platform, 'failed', 'unverified'),
    };
  }

  if (echoedState !== nonce) {
    log({ event: 'CREATOR:SOURCE_CONNECT', status: 'failed', userId, detail: `platform=${platform}`, reason: 'state mismatch (csrf)' });
    return {
      ok: false,
      response: backToPortal(platform, 'failed', 'unverified'),
    };
  }

  return { ok: true, state: { userId, creatorId } };
}

// ── The mobile app's round trip ──────────────────────────────────────────────

/**
 * How the mobile app connects an account, and why it cannot use the cookie.
 *
 * The app talks to this API with `fetch` and a bearer token. A cookie set on the
 * `/connect` response lands in React Native's own cookie jar, and the consent
 * screen opens in the phone's browser (`ASWebAuthenticationSession` / Chrome
 * Custom Tabs), which has a different jar. The callback would arrive with no
 * cookie, every time.
 *
 * So for the app, `state` itself is the signed JWT: `{ sub, creatorId, nonce,
 * type: '<platform>_connect_app' }`, HS256 with `JWT_SECRET`, the same 15
 * minutes as the cookie. The callback does **not** exchange the code. It checks
 * the signature and bounces `code` and `state` to `mealio://creator/connect`,
 * and the app posts both to `/complete` with its bearer token.
 *
 * What replaces the cookie's protection is `/complete` requiring
 * `state.sub === bearer user` and that the user is still that creator. The
 * cookie proved "the browser finishing this is the one that started it"; the
 * binding proves "the account finishing this is the one that started it", which
 * is the property that matters for account-linking CSRF:
 *
 *   - An attacker who gets a creator to consent on a URL the attacker started
 *     cannot redeem the result: the creator's app posts it with the creator's
 *     bearer, and `sub` names the attacker. 403.
 *   - An app that hijacks the `mealio://` scheme and reads code and state
 *     cannot redeem them either, for want of the creator's bearer token.
 *
 * `state` in a query string is identity that round-tripped through a third
 * party, which the cookie design exists to avoid. Here it is only a claim, and
 * it is never believed on its own: it has to match the bearer token too.
 *
 * The provider's `redirect_uri` is the registered web callback, unchanged. That
 * is why the callback, not the app, receives the code first.
 */

/** The JWT `type` of an app-flow state, distinct from the cookie's `<platform>_connect`. */
export function appStateType(platform: ConnectedPlatform): string {
  return `${platform}_connect_app`;
}

/** Where the callback sends the phone's browser back into the app. */
export const APP_CONNECT_LINK = 'mealio://creator/connect';

/**
 * `{"client":"app"}` in the body of `/connect`. Anything else, including an empty
 * or unreadable body, is the website, which must behave exactly as before.
 *
 * Reads a clone so a route that parses the body itself (YouTube) still can.
 */
export async function wantsAppClient(request: NextRequest): Promise<boolean> {
  try {
    const body = await request.clone().json();
    return Boolean(body) && typeof body === 'object' && (body as { client?: unknown }).client === 'app';
  } catch {
    return false;
  }
}

/** The signed state the app flow puts in the provider's `state` parameter. */
export async function signAppConnectState(
  platform: ConnectedPlatform,
  userId: string,
  creatorId: string,
  extraClaims: Record<string, unknown> = {},
): Promise<string> {
  return new SignJWT({
    sub: userId,
    creatorId,
    nonce: randomBytes(16).toString('hex'),
    ...extraClaims,
    type: appStateType(platform),
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${STATE_TTL_SECONDS}s`)
    .sign(JWT_SECRET());
}

type AppStateCheck =
  | { ok: true; payload: JWTPayload }
  | { ok: false; why: 'expired' | 'invalid' };

async function verifyAppState(platform: ConnectedPlatform, state: string): Promise<AppStateCheck> {
  try {
    const { payload } = await jwtVerify(state, JWT_SECRET(), { algorithms: ['HS256'] });
    if (payload.type !== appStateType(platform)) return { ok: false, why: 'invalid' };
    if (typeof payload.sub !== 'string' || typeof payload.creatorId !== 'string') return { ok: false, why: 'invalid' };
    return { ok: true, payload };
  } catch (err) {
    return { ok: false, why: err instanceof joseErrors.JWTExpired ? 'expired' : 'invalid' };
  }
}

/** A web state is a 32-character hex nonce; an app state is a three-part JWT. */
function looksLikeJwt(value: string | null): value is string {
  return typeof value === 'string' && value.split('.').length === 3;
}

function appRedirect(params: Record<string, string>): NextResponse {
  const query = new URLSearchParams(params).toString();
  return NextResponse.redirect(`${APP_CONNECT_LINK}?${query}`, 302);
}

/**
 * The callback's app branch. Returns null when this is not an app round trip,
 * and the web path carries on exactly as before.
 *
 * Never exchanges the code: that happens in `/complete`, once the bearer token
 * has been matched to the state. What it does check is the signature, so an
 * expired or forged state is turned away here rather than handed to the app.
 */
export async function appCallbackRedirect(
  request: NextRequest,
  platform: ConnectedPlatform,
): Promise<NextResponse | null> {
  const { searchParams } = new URL(request.url);
  const state = searchParams.get('state');
  if (!looksLikeJwt(state)) return null;

  const checked = await verifyAppState(platform, state);
  if (!checked.ok) {
    log({ event: 'CREATOR:SOURCE_CONNECT', status: 'failed', detail: `platform=${platform} client=app`, reason: `app state ${checked.why}` });
    return appRedirect({ platform, outcome: 'failed', reason: 'expired' });
  }
  const userId = String(checked.payload.sub);

  const error = searchParams.get('error');
  if (error || searchParams.get('error_reason') || searchParams.get('error_description')) {
    // TikTok is the one provider whose `error` does not always mean the creator
    // pressed Cancel (MEAL-101): `access_denied` is Cancel, anything else is
    // TikTok refusing the account, and the web path says so. The app gets the
    // same distinction rather than being told the creator changed their mind.
    const refused = platform === 'tiktok' && error !== 'access_denied';
    log({
      event: 'CREATOR:SOURCE_CONNECT',
      status: 'failed',
      userId,
      detail:
        `platform=${platform} client=app error=${JSON.stringify(error ?? '')} ` +
        `description=${JSON.stringify(searchParams.get('error_description') ?? '')}`,
      reason: refused ? 'refused' : 'cancelled',
    });
    return refused
      ? appRedirect({ platform, outcome: 'failed', reason: 'unavailable' })
      : appRedirect({ platform, outcome: 'cancelled' });
  }

  const code = searchParams.get('code');
  if (!code) {
    return appRedirect({ platform, outcome: 'failed', reason: 'no-code' });
  }

  // Kept exactly as received, Instagram's trailing `#_` included; the exchange
  // strips it (`cleanAuthCode`).
  return appRedirect({ platform, code, state });
}

/**
 * `POST /api/creator/<platform>/complete`: the app hands back what the callback
 * bounced to it, with its bearer token, and the connection is finished here.
 *
 * Status codes: 401 no or bad bearer; 400 missing `code` or `state`; 403 a state
 * we did not sign, of the wrong type, bound to another user, or naming a creator
 * this user no longer is. Everything past those checks answers 200 with
 * `{ ok, outcome, reason?, message? }`, because a provider or account failure is
 * something the creator can act on and the app has to be able to show it.
 */
export async function completeAppConnect<Reason extends string>(
  request: NextRequest,
  platform: ConnectedPlatform,
  finish: (verified: VerifiedConnect, claims: JWTPayload) => Promise<FinishResult<Reason>>,
): Promise<NextResponse> {
  const user = await requireAuth(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: { code?: unknown; state?: unknown } = {};
  try {
    body = await request.json();
  } catch {
    /* treated as missing fields below */
  }
  const code = typeof body?.code === 'string' ? body.code : '';
  const state = typeof body?.state === 'string' ? body.state : '';
  if (!code || !state) {
    return NextResponse.json({ error: 'code and state are required' }, { status: 400 });
  }

  const failed = (reason: string, status = 200) =>
    NextResponse.json(
      {
        ok: false,
        outcome: 'failed',
        reason,
        message: connectFailureCopy(platform, reason) ?? GENERIC_CONNECT_FAILURE,
      },
      { status },
    );

  const checked = await verifyAppState(platform, state);
  if (!checked.ok) {
    log({
      event: 'CREATOR:SOURCE_CONNECT',
      status: 'failed',
      userId: user.userId,
      detail: `platform=${platform} client=app`,
      reason: `app state ${checked.why}`,
    });
    // An expired state is a creator who took too long; a forged or cookie-type
    // one is not a creator's mistake at all.
    return checked.why === 'expired' ? failed('expired') : failed('unverified', 403);
  }

  // The binding that replaces the cookie. See the block comment above.
  const stateUserId = String(checked.payload.sub);
  const stateCreatorId = String(checked.payload.creatorId);
  if (stateUserId !== user.userId) {
    log({
      event: 'CREATOR:SOURCE_CONNECT',
      status: 'failed',
      userId: user.userId,
      detail: `platform=${platform} client=app`,
      reason: 'state bound to a different user (csrf)',
    });
    return failed('unverified', 403);
  }

  const supabase = createServerSupabaseClient();
  const { data: creator } = await supabase.from('creators').select('id').eq('user_id', user.userId).maybeSingle();
  if (!creator || (creator as { id: string }).id !== stateCreatorId) {
    log({
      event: 'CREATOR:SOURCE_CONNECT',
      status: 'failed',
      userId: user.userId,
      detail: `platform=${platform} client=app`,
      reason: 'state names a creator this user is not',
    });
    return failed('unverified', 403);
  }

  const finished = await finish({ userId: user.userId, creatorId: stateCreatorId, code }, checked.payload);
  if (!finished.ok) return failed(finished.reason);
  return NextResponse.json({ ok: true, outcome: 'connected' });
}

// ── Status and disconnect ────────────────────────────────────────────────────

/**
 * `GET /api/creator/<platform>` — the creator's own view of their connection.
 *
 * Nothing here returns a token. `describeConnection` is the only projection
 * allowed out of the grant table, and `expiresAt` is included deliberately: for
 * Instagram it is the date the account silently stops working unless we renew
 * it, and a creator who can see it can ask about it.
 */
export async function platformConnectionStatus(
  request: NextRequest,
  platform: ConnectedPlatform,
  /**
   * Whether this deployment can start a connection for this platform at all.
   *
   * Reported here so the card can say so *before* the creator presses Connect.
   * The connect route already refuses with a clear 500 when the credentials are
   * missing, but a refusal that only arrives after a press is a button that
   * looks broken — and on a platform whose availability is genuinely provisional
   * that is the worst possible ambiguity to leave lying around.
   *
   * Defaults true: the two platforms that do not pass it have no such state.
   */
  configured = true,
): Promise<NextResponse> {
  const user = await requireAuth(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const supabase = createServerSupabaseClient();
  const { data: creator } = await supabase.from('creators').select('id').eq('user_id', user.userId).maybeSingle();
  if (!creator) return NextResponse.json({ error: 'Not a creator' }, { status: 403 });

  const connection = await loadConnection(supabase, (creator as { id: string }).id, platform);
  const summary = connection ? describeConnection(connection) : null;

  return NextResponse.json({
    connected: Boolean(connection),
    account: summary ? { id: summary.externalId, name: summary.externalName } : null,
    /** Non-null means the creator has to reconnect before anything can be read. */
    brokenReason: summary?.brokenReason ?? null,
    expiresAt: summary?.expiresAt ?? null,
    configured,
  });
}

/** `DELETE /api/creator/<platform>` — remove the grant. */
export async function disconnectPlatform(
  request: NextRequest,
  platform: ConnectedPlatform,
): Promise<NextResponse> {
  const user = await requireAuth(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const supabase = createServerSupabaseClient();
  const { data: creator } = await supabase.from('creators').select('id').eq('user_id', user.userId).maybeSingle();
  if (!creator) return NextResponse.json({ error: 'Not a creator' }, { status: 403 });

  // A revocation is the one action that must not report success optimistically.
  // Telling a creator their account is disconnected while the grant is still in
  // the table — and still live at the provider — is the failure they are least
  // likely to check up on. `deleteConnection` throws rather than swallowing the
  // error precisely so this branch exists.
  try {
    await deleteConnection(supabase, (creator as { id: string }).id, platform);
  } catch (err) {
    log({ event: 'CREATOR:SOURCE_DISCONNECT', status: 'error', userId: user.userId, email: user.email, error: err });
    return NextResponse.json(
      { error: `We could not disconnect that account. It is still connected. Please try again.` },
      { status: 500 },
    );
  }

  log({
    event: 'CREATOR:SOURCE_DISCONNECT',
    status: 'success',
    userId: user.userId,
    email: user.email,
    detail: `platform=${platform} creator=${(creator as { id: string }).id}`,
  });

  return NextResponse.json({ ok: true });
}
