import { NextRequest, NextResponse } from 'next/server';
import { verifyAppleIdentityToken, upsertSocialUser, findLinkedSocialUser } from '@/lib/oauth';
import { createAccessToken } from '@/lib/tokens';
import { log, abbreviateUa } from '@/lib/logger';
import { SignJWT } from 'jose';
import { randomBytes } from 'crypto';
import { safeRedirectPath } from '@/lib/safe-redirect';

const APPLE_NO_EMAIL = 'Apple did not share an email for this account. Please sign in with your email and password, or with Google.';
const JWT_SECRET = () => new TextEncoder().encode(process.env.JWT_SECRET || '');

// GET — web: redirect to Apple OAuth
export async function GET(request: NextRequest) {
  const serviceId = process.env.APPLE_SERVICE_ID;
  if (!serviceId) {
    return NextResponse.json({ error: 'Apple OAuth not configured' }, { status: 500 });
  }

  const { searchParams } = new URL(request.url);
  const redirect = safeRedirectPath(searchParams.get('redirect'));

  // CSRF: bind this auth attempt to a nonce cookie, echoed via state. Apple posts
  // the callback cross-site (form_post), so the cookie must be SameSite=None to be
  // sent back on that request.
  const nonce = randomBytes(16).toString('hex');
  const state = Buffer.from(JSON.stringify({ redirect, nonce })).toString('base64url');
  const redirectUri = `${process.env.NEXT_PUBLIC_APP_URL || 'https://mealio.co'}/api/auth/callback/apple`;

  const params = new URLSearchParams({
    client_id: serviceId,
    redirect_uri: redirectUri,
    response_type: 'code id_token',
    response_mode: 'form_post',
    scope: 'name email',
    state,
  });

  const response = NextResponse.redirect(`https://appleid.apple.com/auth/authorize?${params}`);
  response.cookies.set('mealio_oauth_state', nonce, {
    httpOnly: true,
    secure: true,
    sameSite: 'none',
    maxAge: 600,
    path: '/',
  });
  return response;
}

// POST — mobile: verify identityToken sent from expo-apple-authentication
export async function POST(request: NextRequest) {
  const ip = request.headers.get('x-forwarded-for') || 'unknown';
  const ua = abbreviateUa(request.headers.get('user-agent'));

  try {
    const { identityToken, user } = await request.json();
    if (!identityToken) {
      return NextResponse.json({ error: 'identityToken required' }, { status: 400 });
    }

    const claims = await verifyAppleIdentityToken(identityToken, process.env.APPLE_BUNDLE_ID ?? process.env.APPLE_SERVICE_ID);
    if (!claims) {
      log({ event: 'AUTH:OAUTH_APPLE', status: 'failed', ip, ua, reason: 'invalid identityToken' });
      return NextResponse.json({ error: 'Invalid Apple token' }, { status: 401 });
    }

    // The email comes from Apple's signed token or not at all. `user.email` is
    // whatever the client posted, and creating or linking an account from it
    // would let anyone with an Apple ID claim any address, already confirmed.
    // With no email in the token, the only safe answer is the account already
    // linked to this Apple ID.
    const account = claims.email
      ? await upsertSocialUser({
          provider: 'apple',
          providerId: claims.sub,
          email: claims.email,
          emailVerified: claims.email_verified,
          firstName: user?.name?.firstName,
          lastName: user?.name?.lastName,
        })
      : await findLinkedSocialUser('apple', claims.sub);
    if (!account) {
      log({ event: 'AUTH:OAUTH_APPLE', status: 'failed', ip, ua, reason: 'no email in token and no linked account' });
      return NextResponse.json({ error: APPLE_NO_EMAIL }, { status: 400 });
    }
    const { userId, email: resolvedEmail, tier, isAdmin } = account;

    const accessToken = await createAccessToken(userId, resolvedEmail);
    const sessionToken = await new SignJWT({ sub: userId, email: resolvedEmail, type: 'session' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('90d')
      .sign(JWT_SECRET());

    log({ event: 'AUTH:OAUTH_APPLE', status: 'success', email: resolvedEmail, userId, ip, ua });

    const response = NextResponse.json({
      success: true,
      accessToken,
      user: { id: userId, email: resolvedEmail, tier, isAdmin },
    });
    response.cookies.set('mealio_session', sessionToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 90,
      path: '/',
    });
    return response;
  } catch (error) {
    log({ event: 'AUTH:OAUTH_APPLE', status: 'error', ip, ua, error });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
