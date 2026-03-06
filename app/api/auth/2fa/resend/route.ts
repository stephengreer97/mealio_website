import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';
import { verifyTwoFactorToken } from '@/lib/tokens';
import { generateOtp, hashOtp } from '@/lib/otp';
import { sendOtpEmail } from '@/lib/email';
import { log } from '@/lib/logger';

const COOLDOWN_SECONDS = 60;

export async function POST(request: NextRequest) {
  const ip = request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || 'unknown';
  try {
    const { twoFactorToken } = await request.json();

    const decoded = await verifyTwoFactorToken(twoFactorToken);
    if (!decoded) {
      return NextResponse.json({ error: 'Session expired. Please log in again.' }, { status: 401 });
    }

    const { userId } = decoded;
    const supabase = createServerSupabaseClient();

    // Rate limit: block if an OTP was sent within the cooldown window
    const cooldownThreshold = new Date(Date.now() - COOLDOWN_SECONDS * 1000).toISOString();
    const { data: recent } = await supabase
      .from('otp_codes')
      .select('created_at')
      .eq('user_id', userId)
      .gte('created_at', cooldownThreshold)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (recent) {
      return NextResponse.json({ error: 'Please wait before requesting a new code.' }, { status: 429 });
    }

    // Invalidate old unused codes
    await supabase.from('otp_codes').update({ used: true }).eq('user_id', userId).eq('used', false);

    const { data: profile } = await supabase
      .from('user_profiles')
      .select('email')
      .eq('id', userId)
      .single();

    if (!profile) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    const code = generateOtp();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    await supabase.from('otp_codes').insert({
      user_id:   userId,
      code_hash: hashOtp(code),
      expires_at: expiresAt.toISOString(),
    });

    await sendOtpEmail(profile.email, code);

    log({ event: 'AUTH:2FA_RESEND', status: 'success', userId, ip });
    return NextResponse.json({ ok: true });
  } catch (error) {
    log({ event: 'AUTH:2FA_RESEND', status: 'error', ip, error });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
