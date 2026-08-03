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
 * YouTube keeps its own copy of this dance. Its state also carries the separate
 * consent to edit descriptions, and rewriting a route that landed hours ago is
 * not what these two tickets are for — but there is one shape here, and a third
 * platform should use this rather than a third copy.
 */

import { NextRequest, NextResponse } from 'next/server';
import { randomBytes } from 'crypto';
import { SignJWT, jwtVerify } from 'jose';
import { createServerSupabaseClient } from '@/lib/supabase';
import { requireAuth } from '@/lib/requireAuth';
import { log } from '@/lib/logger';
import { deleteConnection, describeConnection, loadConnection } from '@/lib/platform-tokens';
import { SOURCE_LABELS, type ConnectedPlatform } from '@/lib/creator-sources';

const APP_URL = () => process.env.NEXT_PUBLIC_APP_URL || 'https://mealio.co';
const JWT_SECRET = () => new TextEncoder().encode(process.env.JWT_SECRET || '');

/** Long enough to read a consent screen, short enough that a stale tab is not a key. */
export const STATE_TTL_SECONDS = 900;

/** One cookie per platform, so connecting two accounts in two tabs cannot cross. */
export function stateCookieName(platform: ConnectedPlatform): string {
  return `mealio_${platform}_state`;
}

/** Where the creator lands afterwards, with something the portal can render. */
export function backToPortal(platform: ConnectedPlatform, outcome: string, detail?: string): NextResponse {
  const url = new URL(`${APP_URL()}/creator`);
  url.searchParams.set(platform, outcome);
  if (detail) url.searchParams.set('detail', detail);
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
    creatorId: (creator as { id: string }).id,
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
      response: backToPortal(platform, 'failed', 'This connection attempt has expired. Start again from the creator portal.'),
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
      response: backToPortal(platform, 'failed', 'That connection could not be verified. Start again from the creator portal.'),
    };
  }

  if (echoedState !== nonce) {
    log({ event: 'CREATOR:SOURCE_CONNECT', status: 'failed', userId, detail: `platform=${platform}`, reason: 'state mismatch (csrf)' });
    return {
      ok: false,
      response: backToPortal(platform, 'failed', 'That connection could not be verified. Start again from the creator portal.'),
    };
  }

  return { ok: true, state: { userId, creatorId } };
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
      { error: `We could not disconnect that account. It is still connected — please try again.` },
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
