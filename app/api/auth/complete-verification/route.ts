import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';
import { createAccessToken } from '@/lib/tokens';
import { SignJWT } from 'jose';
import { log } from '@/lib/logger';
import { isMfaExempt } from '@/lib/mfa';

/**
 * How long after the email is confirmed this route will still sign someone in.
 *
 * The page calls it the moment Supabase redirects back from the confirmation
 * link, so a genuine signup is seconds old. Anything older is not a signup
 * finishing: it is a Supabase access token obtained some other way, most simply
 * by calling signInWithPassword against the public anon key, and this route
 * must not turn that into a 90-day Mealio session.
 */
const VERIFICATION_WINDOW_MS = 15 * 60 * 1000;

const EXPIRED = 'This link has expired. Please sign in.';

// Called by /verify-email page after Supabase redirects there with a session
// in the URL hash. Exchanges the Supabase access token for our custom JWTs
// and creates the mealio_session cookie.
export async function POST(request: NextRequest) {
  try {
    const { supabaseAccessToken } = await request.json();

    if (!supabaseAccessToken) {
      return NextResponse.json({ error: 'Missing verification token' }, { status: 400 });
    }

    const ip = request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || 'unknown';
    const supabase = createServerSupabaseClient();

    // Validate the Supabase access token's signature + expiry server-side via
    // GoTrue (getUser verifies the JWT and returns the authenticated user). We
    // must NOT trust an unverified token payload — a forged token with an
    // arbitrary `sub` would otherwise let an attacker mint a 90-day session for
    // any account.
    const { data: userData, error: userError } = await supabase.auth.getUser(supabaseAccessToken);

    if (userError || !userData.user) {
      log({ event: 'AUTH:VERIFY_EMAIL', status: 'failed', ip, reason: 'invalid or expired token' });
      return NextResponse.json({ error: 'Invalid or expired verification link' }, { status: 401 });
    }

    const supabaseUser = userData.user;

    if (!supabaseUser.email_confirmed_at) {
      log({ event: 'AUTH:VERIFY_EMAIL', status: 'failed', ip, reason: 'email not confirmed' });
      return NextResponse.json({ error: 'Email address has not been confirmed' }, { status: 403 });
    }

    // THIS ROUTE IS FOR A SIGNUP THAT HAS JUST BEEN CONFIRMED, AND NOTHING ELSE.
    //
    // It used to accept any valid Supabase token for any confirmed user. The
    // anon key is public, so anyone holding a password could fetch such a token
    // straight from Supabase and post it here, skipping the login throttle and,
    // for admins and creators, 2FA. Two checks close that: the confirmation must
    // be fresh, and an account that signs in through 2FA must keep doing so.
    const confirmedAt = Date.parse(supabaseUser.email_confirmed_at);
    if (!Number.isFinite(confirmedAt) || Date.now() - confirmedAt > VERIFICATION_WINDOW_MS) {
      log({ event: 'AUTH:VERIFY_EMAIL', status: 'failed', ip, userId: supabaseUser.id, reason: 'confirmation not recent' });
      return NextResponse.json({ error: EXPIRED }, { status: 403 });
    }

    const userId = supabaseUser.id;
    const email = supabaseUser.email!;

    // The same rule the login route applies: admins and approved creators get a
    // second factor. A new signup is neither, so refusing here costs a real
    // user nothing.
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('is_admin')
      .eq('id', userId)
      .maybeSingle();
    const { data: creator } = await supabase
      .from('creators')
      .select('id')
      .eq('user_id', userId)
      .maybeSingle();
    if ((profile?.is_admin || creator) && !isMfaExempt(email)) {
      log({ event: 'AUTH:VERIFY_EMAIL', status: 'failed', ip, userId, reason: 'account requires 2FA' });
      return NextResponse.json({ error: EXPIRED }, { status: 403 });
    }

    // Create our custom JWT access token
    const accessToken = await createAccessToken(userId, email);

    // Upsert user_profiles — the Supabase trigger may or may not have created
    // the row when signUp() ran, so we handle both cases with upsert.
    await supabase.from('user_profiles').upsert(
      { id: userId, email, last_login_at: new Date().toISOString(), updated_at: new Date().toISOString() },
      { onConflict: 'id' }
    );

    const JWT_SECRET = new TextEncoder().encode(process.env.JWT_SECRET || '');
    const sessionToken = await new SignJWT({ sub: userId, email, type: 'session' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('90d')
      .sign(JWT_SECRET);

    log({ event: 'AUTH:VERIFY_EMAIL', status: 'success', email, userId, ip });

    const response = NextResponse.json({
      success: true,
      user: { id: userId, email },
      accessToken,
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
    log({ event: 'AUTH:VERIFY_EMAIL', status: 'error', ip: 'unknown', error });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
