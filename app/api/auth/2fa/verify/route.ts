import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';
import { createAccessToken, verifyTwoFactorToken, hashToken } from '@/lib/tokens';
import { hashOtp } from '@/lib/otp';
import { randomBytes } from 'crypto';
import { SignJWT } from 'jose';
import { log } from '@/lib/logger';

const MAX_ATTEMPTS = 5;

export async function POST(request: NextRequest) {
  const ip = request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || 'unknown';
  try {
    const { twoFactorToken, code, rememberDevice } = await request.json();

    if (!twoFactorToken || !code) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    const decoded = await verifyTwoFactorToken(twoFactorToken);
    if (!decoded) {
      log({ event: 'AUTH:2FA_VERIFY', status: 'failed', ip, reason: 'invalid or expired twoFactorToken' });
      return NextResponse.json({ error: 'Session expired. Please log in again.' }, { status: 401 });
    }

    const { userId } = decoded;
    const supabase = createServerSupabaseClient();

    // Fetch the latest valid OTP for this user
    const { data: otp, error: otpFetchError } = await supabase
      .from('otp_codes')
      .select('*')
      .eq('user_id', userId)
      .eq('used', false)
      .gte('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (!otp) {
      log({ event: 'AUTH:2FA_VERIFY', status: 'failed', userId, ip, reason: 'otp not found', detail: otpFetchError?.message });
      return NextResponse.json({ error: 'Code expired. Please log in again.' }, { status: 401 });
    }

    if (otp.attempts >= MAX_ATTEMPTS) {
      return NextResponse.json({ error: 'Too many attempts. Please log in again.' }, { status: 429 });
    }

    // Increment attempt count before verifying (prevents timing-based enumeration)
    await supabase.from('otp_codes').update({ attempts: otp.attempts + 1 }).eq('id', otp.id);

    if (hashOtp(String(code)) !== otp.code_hash) {
      const remaining = MAX_ATTEMPTS - otp.attempts - 1;
      log({ event: 'AUTH:2FA_VERIFY', status: 'failed', userId, ip, reason: 'wrong code' });
      return NextResponse.json(
        { error: `Incorrect code. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.` },
        { status: 401 }
      );
    }

    // Mark OTP as used
    await supabase.from('otp_codes').update({ used: true }).eq('id', otp.id);

    // Fetch profile for email and tier
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('email, subscription_tier, is_admin')
      .eq('id', userId)
      .single();

    if (!profile) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    const { email, subscription_tier } = profile;

    // Issue access token
    const accessToken = await createAccessToken(userId, email);

    await supabase.from('user_profiles').update({ last_login_at: new Date().toISOString() }).eq('id', userId);

    // Session cookie (same as normal login)
    const JWT_SECRET = new TextEncoder().encode(process.env.JWT_SECRET || '');
    const sessionToken = await new SignJWT({ sub: userId, email, type: 'session' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('90d')
      .sign(JWT_SECRET);

    const response = NextResponse.json({
      success: true,
      user: { id: userId, email, tier: subscription_tier ?? 'free', isAdmin: profile.is_admin ?? false },
      accessToken,
    });

    response.cookies.set('mealio_session', sessionToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 90,
      path: '/',
    });

    // Remember this device for 90 days
    if (rememberDevice) {
      const deviceToken = randomBytes(32).toString('hex');
      const deviceExpiry = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
      await supabase.from('remembered_devices').insert({
        user_id:    userId,
        token_hash: hashToken(deviceToken),
        expires_at: deviceExpiry.toISOString(),
        user_agent: request.headers.get('user-agent') || 'unknown',
        ip_address: ip,
      });
      response.cookies.set('mealio_device', deviceToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 60 * 60 * 24 * 90,
        path: '/',
      });
    }

    log({ event: 'AUTH:2FA_VERIFY', status: 'success', email, userId, ip });
    return response;
  } catch (error) {
    log({ event: 'AUTH:2FA_VERIFY', status: 'error', ip, error });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
