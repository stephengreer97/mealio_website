import { NextRequest, NextResponse } from 'next/server';
import { verifyGoogleIdToken, upsertSocialUser } from '@/lib/oauth';
import { createAccessToken } from '@/lib/tokens';
import { log } from '@/lib/logger';
import { SignJWT } from 'jose';

const JWT_SECRET = () => new TextEncoder().encode(process.env.JWT_SECRET || '');
const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://mealio.co';

export async function GET(request: NextRequest) {
  const ip = request.headers.get('x-forwarded-for') || 'unknown';
  const { searchParams } = new URL(request.url);
  const code = searchParams.get('code');
  const stateParam = searchParams.get('state');
  const errorParam = searchParams.get('error');

  if (errorParam) {
    return NextResponse.redirect(`${APP_URL}/signin?error=oauth_cancelled`);
  }

  if (!code) {
    return NextResponse.redirect(`${APP_URL}/signin?error=oauth_failed`);
  }

  let redirectTo = '/discover';
  try {
    if (stateParam) {
      const decoded = JSON.parse(Buffer.from(stateParam, 'base64url').toString());
      if (decoded.redirect?.startsWith('/')) redirectTo = decoded.redirect;
    }
  } catch {}

  try {
    // Exchange code for tokens
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID!,
        client_secret: process.env.GOOGLE_CLIENT_SECRET!,
        redirect_uri: `${APP_URL}/api/auth/callback/google`,
        grant_type: 'authorization_code',
      }),
    });

    const tokenData = await tokenRes.json();
    if (!tokenData.id_token) {
      log({ event: 'AUTH:OAUTH_GOOGLE', status: 'failed', ip, reason: 'no id_token in response' });
      return NextResponse.redirect(`${APP_URL}/signin?error=oauth_failed`);
    }

    const claims = await verifyGoogleIdToken(tokenData.id_token);
    if (!claims) {
      log({ event: 'AUTH:OAUTH_GOOGLE', status: 'failed', ip, reason: 'id_token verification failed' });
      return NextResponse.redirect(`${APP_URL}/signin?error=oauth_failed`);
    }

    const { userId, email, tier, isAdmin } = await upsertSocialUser({
      provider: 'google',
      providerId: claims.sub,
      email: claims.email,
      firstName: claims.given_name,
      lastName: claims.family_name,
    });

    const accessToken = await createAccessToken(userId, email);
    const sessionToken = await new SignJWT({ sub: userId, email, type: 'session' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('90d')
      .sign(JWT_SECRET());

    log({ event: 'AUTH:OAUTH_GOOGLE', status: 'success', email, userId, ip });

    // Redirect to client page that stores the token in localStorage
    const callbackUrl = new URL(`${APP_URL}/auth/social-callback`);
    callbackUrl.searchParams.set('token', accessToken);
    callbackUrl.searchParams.set('user', Buffer.from(JSON.stringify({ id: userId, email, tier, isAdmin })).toString('base64url'));
    callbackUrl.searchParams.set('redirect', redirectTo);

    const response = NextResponse.redirect(callbackUrl.toString());
    response.cookies.set('mealio_session', sessionToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 90,
      path: '/',
    });
    return response;
  } catch (error) {
    log({ event: 'AUTH:OAUTH_GOOGLE', status: 'error', ip, error });
    return NextResponse.redirect(`${APP_URL}/signin?error=oauth_failed`);
  }
}
