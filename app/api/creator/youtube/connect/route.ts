import { NextRequest, NextResponse } from 'next/server';
import { randomBytes } from 'crypto';
import { SignJWT } from 'jose';
import { createServerSupabaseClient } from '@/lib/supabase';
import { requireAuth } from '@/lib/requireAuth';
import { log } from '@/lib/logger';
import { youtubeAuthUrl } from '@/lib/youtube';

/**
 * POST /api/creator/youtube/connect — start the YouTube OAuth round trip (MEAL-74).
 *
 * Returns the consent URL for the client to navigate to, rather than issuing a
 * redirect itself: the creator portal authenticates with a bearer token out of
 * localStorage, and a `<a href>` to a redirecting endpoint would arrive without
 * one.
 *
 * The state is split deliberately. The `state` parameter Google echoes back is a
 * nonce and nothing else; **who** is connecting travels in an httpOnly, signed
 * cookie. Identity that round-trips through a third party and comes back in a
 * query string is identity anyone can supply, and the thing being attached here
 * is write access to a creator's channel.
 */

export const STATE_COOKIE = 'mealio_youtube_state';

/** Long enough to read a consent screen, short enough that a stale tab is not a key. */
export const STATE_TTL_SECONDS = 900;

const JWT_SECRET = () => new TextEncoder().encode(process.env.JWT_SECRET || '');

export async function POST(request: NextRequest) {
  const user = await requireAuth(request);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: { appendOptIn?: unknown } = {};
  try {
    body = await request.json();
  } catch {
    /* an empty body is a connect with no append consent, which is the default */
  }

  // Consent to have descriptions edited is a separate, explicit choice from
  // consent to have videos read (MEAL-77). Anything other than a literal `true`
  // is a no — a missing field, a null, the string "false".
  const appendOptIn = body.appendOptIn === true;

  const supabase = createServerSupabaseClient();
  const { data: creator } = await supabase
    .from('creators')
    .select('id')
    .eq('user_id', user.userId)
    .maybeSingle();

  if (!creator) {
    return NextResponse.json({ error: 'Only approved creators can connect a channel.' }, { status: 403 });
  }

  const nonce = randomBytes(16).toString('hex');
  // The write scope rides on the tick, not on connecting.
  const authUrl = youtubeAuthUrl(nonce, { write: appendOptIn });
  if (!authUrl) {
    return NextResponse.json({ error: 'YouTube connection is not configured on this deployment.' }, { status: 500 });
  }

  const state = await new SignJWT({
    sub: user.userId,
    creatorId: (creator as { id: string }).id,
    nonce,
    appendOptIn,
    type: 'youtube_connect',
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
    detail: `platform=youtube appendOptIn=${appendOptIn}`,
  });

  const response = NextResponse.json({ url: authUrl });
  response.cookies.set(STATE_COOKIE, state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: STATE_TTL_SECONDS,
    path: '/',
  });
  return response;
}
