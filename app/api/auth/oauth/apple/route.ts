import { NextRequest, NextResponse } from 'next/server';
import { verifyAppleIdentityToken, upsertSocialUser } from '@/lib/oauth';
import { createAccessToken } from '@/lib/tokens';
import { log, abbreviateUa } from '@/lib/logger';
import { SignJWT } from 'jose';

const JWT_SECRET = () => new TextEncoder().encode(process.env.JWT_SECRET || '');

// GET — web: redirect to Apple OAuth
export async function GET(request: NextRequest) {
  const serviceId = process.env.APPLE_SERVICE_ID;
  if (!serviceId) {
    return NextResponse.json({ error: 'Apple OAuth not configured' }, { status: 500 });
  }

  const { searchParams } = new URL(request.url);
  const redirect = searchParams.get('redirect') || '/discover';

  const state = Buffer.from(JSON.stringify({ redirect })).toString('base64url');
  const redirectUri = `${process.env.NEXT_PUBLIC_APP_URL || 'https://mealio.co'}/api/auth/callback/apple`;

  const params = new URLSearchParams({
    client_id: serviceId,
    redirect_uri: redirectUri,
    response_type: 'code id_token',
    response_mode: 'form_post',
    scope: 'name email',
    state,
  });

  return NextResponse.redirect(`https://appleid.apple.com/auth/authorize?${params}`);
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

    const claims = await verifyAppleIdentityToken(identityToken);
    if (!claims) {
      log({ event: 'AUTH:OAUTH_APPLE', status: 'failed', ip, ua, reason: 'invalid identityToken' });
      return NextResponse.json({ error: 'Invalid Apple token' }, { status: 401 });
    }

    // Apple only provides email on first sign-in; mobile passes user object with name
    const email = claims.email || user?.email;
    if (!email) {
      return NextResponse.json({ error: 'Email not available from Apple' }, { status: 400 });
    }

    const { userId, email: resolvedEmail, tier, isAdmin } = await upsertSocialUser({
      provider: 'apple',
      providerId: claims.sub,
      email,
      firstName: user?.name?.firstName,
      lastName: user?.name?.lastName,
    });

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
