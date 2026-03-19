import { NextRequest, NextResponse } from 'next/server';
import { verifyGoogleIdToken, upsertSocialUser } from '@/lib/oauth';
import { createAccessToken } from '@/lib/tokens';
import { log, abbreviateUa } from '@/lib/logger';
import { SignJWT } from 'jose';

const JWT_SECRET = () => new TextEncoder().encode(process.env.JWT_SECRET || '');

// GET — web: redirect to Google OAuth
export async function GET(request: NextRequest) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    return NextResponse.json({ error: 'Google OAuth not configured' }, { status: 500 });
  }

  const { searchParams } = new URL(request.url);
  const redirect = searchParams.get('redirect') || '/discover';

  const state = Buffer.from(JSON.stringify({ redirect })).toString('base64url');
  const redirectUri = `${process.env.NEXT_PUBLIC_APP_URL || 'https://mealio.co'}/api/auth/callback/google`;

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    access_type: 'online',
    prompt: 'select_account',
  });

  return NextResponse.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
}

// POST — mobile: verify id_token sent from expo-auth-session
export async function POST(request: NextRequest) {
  const ip = request.headers.get('x-forwarded-for') || 'unknown';
  const ua = abbreviateUa(request.headers.get('user-agent'));

  try {
    const { idToken } = await request.json();
    if (!idToken) {
      return NextResponse.json({ error: 'idToken required' }, { status: 400 });
    }

    const claims = await verifyGoogleIdToken(idToken);
    if (!claims) {
      log({ event: 'AUTH:OAUTH_GOOGLE', status: 'failed', ip, ua, reason: 'invalid id_token' });
      return NextResponse.json({ error: 'Invalid Google token' }, { status: 401 });
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

    log({ event: 'AUTH:OAUTH_GOOGLE', status: 'success', email, userId, ip, ua });

    const response = NextResponse.json({
      success: true,
      accessToken,
      user: { id: userId, email, tier, isAdmin },
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
    log({ event: 'AUTH:OAUTH_GOOGLE', status: 'error', ip, ua, error });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
