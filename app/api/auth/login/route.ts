import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient, createAnonSupabaseClient } from '@/lib/supabase';
import { createAccessToken, createTwoFactorToken, hashToken } from '@/lib/tokens';
import { generateOtp, hashOtp } from '@/lib/otp';
import { sendOtpEmail } from '@/lib/email';
import { SignJWT } from 'jose';
import { log } from '@/lib/logger';

export async function POST(request: NextRequest) {
  try {
    const { email, password } = await request.json();

    if (!email || !password) {
      return NextResponse.json({ error: 'Email and password required' }, { status: 400 });
    }

    const ip = request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || 'unknown';

    // Use anon client for credential verification — calling signInWithPassword() on
    // the service role client sets a user JWT session in memory, causing subsequent
    // from() calls to use the user JWT instead of the service role key, which breaks
    // RLS-protected tables like otp_codes.
    const anonClient = createAnonSupabaseClient();
    const { data: authData, error: authError } = await anonClient.auth.signInWithPassword({ email, password });

    // All data operations use a fresh service role client with no user session set.
    const supabase = createServerSupabaseClient();

    if (authError || !authData.user) {
      log({ event: 'AUTH:LOGIN', status: 'failed', email, ip, reason: authError?.message || 'Invalid credentials' });
      return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 });
    }

    if (!authData.user.email_confirmed_at) {
      log({ event: 'AUTH:LOGIN', status: 'failed', email, ip, reason: 'email not verified' });
      return NextResponse.json(
        { error: 'Please verify your email before logging in.', requiresVerification: true, email },
        { status: 403 }
      );
    }

    const userId = authData.user.id;

    const { data: profile } = await supabase
      .from('user_profiles')
      .select('subscription_tier, is_admin')
      .eq('id', userId)
      .single();

    // 2FA gate: required for admins and approved creators
    const isAdmin = profile?.is_admin ?? false;
    const { data: creator } = await supabase
      .from('creators')
      .select('id')
      .eq('user_id', userId)
      .maybeSingle();

    if (isAdmin || creator) {
      // Check for a trusted remembered device — skip 2FA if found
      const deviceCookie = request.cookies.get('mealio_device')?.value;
      if (deviceCookie) {
        const { data: trustedDevice } = await supabase
          .from('remembered_devices')
          .select('id')
          .eq('user_id', userId)
          .eq('token_hash', hashToken(deviceCookie))
          .gte('expires_at', new Date().toISOString())
          .maybeSingle();

        if (trustedDevice) {
          log({ event: 'AUTH:LOGIN', status: 'success', email, userId, ip, reason: 'trusted device' });
          // Fall through to normal token issuance below
          const accessToken = await createAccessToken(userId, email);
          await supabase.from('user_profiles').update({ last_login_at: new Date().toISOString() }).eq('id', userId);
          const tier = profile?.subscription_tier ?? 'free';
          const JWT_SECRET = new TextEncoder().encode(process.env.JWT_SECRET || '');
          const sessionToken = await new SignJWT({ sub: userId, email, type: 'session' })
            .setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('90d').sign(JWT_SECRET);
          const response = NextResponse.json({ success: true, user: { id: userId, email, tier, isAdmin }, accessToken });
          response.cookies.set('mealio_session', sessionToken, {
            httpOnly: true, secure: process.env.NODE_ENV === 'production',
            sameSite: 'lax', maxAge: 60 * 60 * 24 * 90, path: '/',
          });
          return response;
        }
      }

      // Invalidate any existing unused OTPs
      await supabase.from('otp_codes').update({ used: true }).eq('user_id', userId).eq('used', false);

      const code = generateOtp();
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
      const { error: otpInsertError } = await supabase.from('otp_codes').insert({
        user_id: userId,
        code_hash: hashOtp(code),
        expires_at: expiresAt.toISOString(),
      });

      if (otpInsertError) {
        log({ event: 'AUTH:2FA_SENT', status: 'error', email, userId, ip, error: otpInsertError });
        return NextResponse.json({ error: 'Failed to send verification code. Please try again.' }, { status: 500 });
      }

      await sendOtpEmail(email, code);
      const twoFactorToken = await createTwoFactorToken(userId);

      log({ event: 'AUTH:2FA_SENT', status: 'success', email, userId, ip });
      return NextResponse.json({ requiresTwoFactor: true, twoFactorToken });
    }

    // Normal login — issue access token
    const accessToken = await createAccessToken(userId, email);

    await supabase.from('user_profiles').update({ last_login_at: new Date().toISOString() }).eq('id', userId);

    const tier = profile?.subscription_tier ?? 'free';

    // Create session token for cookie (90 days)
    const JWT_SECRET = new TextEncoder().encode(process.env.JWT_SECRET || '');
    const sessionToken = await new SignJWT({
      sub: userId,
      email,
      type: 'session'
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('90d')
      .sign(JWT_SECRET);

    const response = NextResponse.json({
      success: true,
      user: { id: userId, email, tier, isAdmin },
      accessToken,
    });

    // Set HTTP-only cookie for extension polling
    response.cookies.set('mealio_session', sessionToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 90,
      path: '/'
    });

    log({ event: 'AUTH:LOGIN', status: 'success', email, userId, ip });
    return response;
  } catch (error) {
    log({ event: 'AUTH:LOGIN', status: 'error', ip: 'unknown', error });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}