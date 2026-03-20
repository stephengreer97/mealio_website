import { NextRequest, NextResponse } from 'next/server';
import { verifyAppleIdentityToken, generateAppleClientSecret, upsertSocialUser } from '@/lib/oauth';
import { createAccessToken } from '@/lib/tokens';
import { log } from '@/lib/logger';
import { SignJWT } from 'jose';

const JWT_SECRET = () => new TextEncoder().encode(process.env.JWT_SECRET || '');
const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://mealio.co';

// Apple sends a form_post to this endpoint — use 303 so redirects always become GET
function redirect303(url: string) {
  return NextResponse.redirect(url, { status: 303 });
}

// Apple sends a form_post to this endpoint
export async function POST(request: NextRequest) {
  const ip = request.headers.get('x-forwarded-for') || 'unknown';

  try {
    const formData = await request.formData();
    const code = formData.get('code') as string | null;
    const idToken = formData.get('id_token') as string | null;
    const stateParam = formData.get('state') as string | null;
    const userJson = formData.get('user') as string | null; // only on first sign-in
    const errorParam = formData.get('error') as string | null;

    if (errorParam) {
      return redirect303(`${APP_URL}/signin?error=oauth_cancelled`);
    }

    if (!code || !idToken) {
      log({ event: 'AUTH:OAUTH_APPLE', status: 'failed', ip, reason: `missing_params code=${!!code} idToken=${!!idToken}` });
      return redirect303(`${APP_URL}/signin?error=oauth_missing_params`);
    }

    let redirectTo = '/discover';
    try {
      if (stateParam) {
        const decoded = JSON.parse(Buffer.from(stateParam, 'base64url').toString());
        if (decoded.redirect?.startsWith('/')) redirectTo = decoded.redirect;
      }
    } catch {}

    // Parse Apple user object (name only provided on first authorization)
    let appleUser: { name?: { firstName?: string; lastName?: string }; email?: string } | null = null;
    try {
      if (userJson) appleUser = JSON.parse(userJson);
    } catch {}

    // Verify the identity token
    const claims = await verifyAppleIdentityToken(idToken, process.env.APPLE_SERVICE_ID);
    if (!claims) {
      log({ event: 'AUTH:OAUTH_APPLE', status: 'failed', ip, reason: 'identityToken verification failed' });
      return redirect303(`${APP_URL}/signin?error=oauth_failed`);
    }

    // Exchange code for tokens (required to get refresh_token, optional but good practice)
    try {
      const clientSecret = await generateAppleClientSecret();
      await fetch('https://appleid.apple.com/auth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: process.env.APPLE_SERVICE_ID!,
          client_secret: clientSecret,
          code,
          grant_type: 'authorization_code',
          redirect_uri: `${APP_URL}/api/auth/callback/apple`,
        }),
      });
    } catch {
      // Non-fatal — we already have a verified identity token
    }

    const email = claims.email || appleUser?.email;
    if (!email) {
      log({ event: 'AUTH:OAUTH_APPLE', status: 'failed', ip, reason: 'no email from Apple' });
      return redirect303(`${APP_URL}/signin?error=apple_no_email`);
    }

    const { userId, email: resolvedEmail, tier, isAdmin } = await upsertSocialUser({
      provider: 'apple',
      providerId: claims.sub,
      email,
      firstName: appleUser?.name?.firstName,
      lastName: appleUser?.name?.lastName,
    });

    const accessToken = await createAccessToken(userId, resolvedEmail);
    const sessionToken = await new SignJWT({ sub: userId, email: resolvedEmail, type: 'session' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('90d')
      .sign(JWT_SECRET());

    log({ event: 'AUTH:OAUTH_APPLE', status: 'success', email: resolvedEmail, userId, ip });

    const callbackUrl = new URL(`${APP_URL}/auth/social-callback`);
    callbackUrl.searchParams.set('token', accessToken);
    callbackUrl.searchParams.set('user', Buffer.from(JSON.stringify({ id: userId, email: resolvedEmail, tier, isAdmin })).toString('base64url'));
    callbackUrl.searchParams.set('redirect', redirectTo);

    const response = redirect303(callbackUrl.toString());
    response.cookies.set('mealio_session', sessionToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 90,
      path: '/',
    });
    return response;
  } catch (error) {
    log({ event: 'AUTH:OAUTH_APPLE', status: 'error', ip, error });
    return redirect303(`${APP_URL}/signin?error=oauth_failed`);
  }
}
