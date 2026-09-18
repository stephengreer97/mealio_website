import { NextRequest, NextResponse } from 'next/server';
import { verifyAppleIdentityToken, generateAppleClientSecret, upsertSocialUser, findLinkedSocialUser } from '@/lib/oauth';
import { createAccessToken } from '@/lib/tokens';
import { log } from '@/lib/logger';
import { SignJWT } from 'jose';
import { safeRedirectPath } from '@/lib/safe-redirect';

const JWT_SECRET = () => new TextEncoder().encode(process.env.JWT_SECRET || '');
const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://mealio.co';
const APPLE_NO_EMAIL = 'Apple did not share an email for this account. Please sign in with your email and password, or with Google.';

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

    // CSRF: the state nonce Apple echoes must match the cookie set at auth start.
    const stateCookie = request.cookies.get('mealio_oauth_state')?.value;
    let redirectTo = '/discover';
    let stateNonce: string | undefined;
    try {
      if (stateParam) {
        const decoded = JSON.parse(Buffer.from(stateParam, 'base64url').toString());
        redirectTo = safeRedirectPath(decoded.redirect);
        stateNonce = decoded.nonce;
      }
    } catch {}

    if (!stateCookie || !stateNonce || stateCookie !== stateNonce) {
      log({ event: 'AUTH:OAUTH_APPLE', status: 'failed', ip, reason: 'invalid state (csrf)' });
      return redirect303(`${APP_URL}/signin?error=oauth_failed`);
    }

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

    // The email comes from Apple's signed token or not at all. The `user` form
    // field is unsigned, and creating or linking an account from its email
    // would let anyone with an Apple ID claim any address, already confirmed.
    // With no email in the token, only the account already linked to this
    // Apple ID can be signed in.
    const account = claims.email
      ? await upsertSocialUser({
          provider: 'apple',
          providerId: claims.sub,
          email: claims.email,
          emailVerified: claims.email_verified,
          firstName: appleUser?.name?.firstName,
          lastName: appleUser?.name?.lastName,
        })
      : await findLinkedSocialUser('apple', claims.sub);
    if (!account) {
      log({ event: 'AUTH:OAUTH_APPLE', status: 'failed', ip, reason: 'no email in token and no linked account' });
      return redirect303(`${APP_URL}/signin?error=${encodeURIComponent(APPLE_NO_EMAIL)}`);
    }
    const { userId, email: resolvedEmail, tier, isAdmin } = account;

    const accessToken = await createAccessToken(userId, resolvedEmail);
    const sessionToken = await new SignJWT({ sub: userId, email: resolvedEmail, type: 'session' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('90d')
      .sign(JWT_SECRET());

    log({ event: 'AUTH:OAUTH_APPLE', status: 'success', email: resolvedEmail, userId, ip });

    // Deliver the access token via a short-lived, path-scoped handoff cookie
    // instead of the URL query string (avoids history / Referer / log leakage).
    const callbackUrl = new URL(`${APP_URL}/auth/social-callback`);
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
    // JS-readable so social-callback can move it into localStorage, then delete it.
    response.cookies.set('mealio_oauth_token', accessToken, {
      httpOnly: false,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 120,
      path: '/auth/social-callback',
    });
    // Clear the CSRF state cookie now that it has been validated.
    response.cookies.set('mealio_oauth_state', '', { path: '/', maxAge: 0 });
    return response;
  } catch (error) {
    log({ event: 'AUTH:OAUTH_APPLE', status: 'error', ip, error });
    return redirect303(`${APP_URL}/signin?error=oauth_failed`);
  }
}
