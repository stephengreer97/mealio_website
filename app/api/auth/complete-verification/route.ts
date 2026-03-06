import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';
import { createAccessToken } from '@/lib/tokens';
import { SignJWT, decodeJwt } from 'jose';
import { log } from '@/lib/logger';

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

    // Step 1: Decode the Supabase JWT to extract the user UUID.
    // decodeJwt validates structure but not signature — that's fine because step 2
    // re-fetches the user from Supabase using the service role key, so we never
    // trust the token payload alone.
    let supabaseUserId: string;
    try {
      const payload = decodeJwt(supabaseAccessToken);
      supabaseUserId = payload.sub as string;
      if (!supabaseUserId) throw new Error('missing sub');
    } catch {
      log({ event: 'AUTH:VERIFY_EMAIL', status: 'failed', ip, reason: 'malformed token' });
      return NextResponse.json({ error: 'Invalid or expired verification link' }, { status: 401 });
    }

    // Step 2: Fetch the user from Supabase by UUID using the admin API.
    // admin.getUserById() expects a UUID (correct usage), and uses the service role
    // key to bypass RLS — completely server-side, no client auth header issues.
    const { data: userData, error: userError } = await supabase.auth.admin.getUserById(supabaseUserId);

    if (userError || !userData.user) {
      log({ event: 'AUTH:VERIFY_EMAIL', status: 'failed', ip, reason: 'user not found' });
      return NextResponse.json({ error: 'Invalid or expired verification link' }, { status: 401 });
    }

    const supabaseUser = userData.user;

    if (!supabaseUser.email_confirmed_at) {
      log({ event: 'AUTH:VERIFY_EMAIL', status: 'failed', ip, reason: 'email not confirmed' });
      return NextResponse.json({ error: 'Email address has not been confirmed' }, { status: 403 });
    }

    const userId = supabaseUser.id;
    const email = supabaseUser.email!;

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
