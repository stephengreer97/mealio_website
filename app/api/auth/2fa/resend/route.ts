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
      log({ event: 'AUTH:2FA_RESEND', status: 'failed', ip, reason: 'invalid_token' });
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
      log({ event: 'AUTH:2FA_RESEND', status: 'failed', userId, ip, reason: 'rate_limited' });
      return NextResponse.json({ error: 'Please wait before requesting a new code.' }, { status: 429 });
    }

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

    /*
     * Send BEFORE writing anything, and this order is the whole point.
     *
     * The person clicking *Resend* usually has a working code sitting in their
     * inbox; they are impatient, not stuck. Invalidating it first meant that a
     * send Resend refuses — a suppressed address after a bounce, a burst that
     * trips `rate_limit_exceeded` — left them with the old code dead, the new
     * code never delivered, and the 60-second cooldown (keyed on
     * `otp_codes.created_at`, which the insert had just written) blocking the
     * retry. One click, and the only way into the account is gone for a minute.
     *
     * `sendOtpEmail` throws on a refusal, so nothing below runs: the old code
     * stays valid, no cooldown row exists, and the 500 the `catch` returns is
     * about a code the person never needed to lose. The cost is that a run of
     * failing sends is not rate-limited by the cooldown — the cooldown starts
     * when a code is actually delivered — which is the right way round.
     */
    await sendOtpEmail(profile.email, code);

    // Only now is there a delivered code worth making the only one. Invalidate
    // first, then insert, so the new row is not caught by its own sweep.
    await supabase.from('otp_codes').update({ used: true }).eq('user_id', userId).eq('used', false);

    await supabase.from('otp_codes').insert({
      user_id:   userId,
      code_hash: hashOtp(code),
      expires_at: expiresAt.toISOString(),
    });

    log({ event: 'AUTH:2FA_RESEND', status: 'success', userId, ip });
    return NextResponse.json({ ok: true });
  } catch (error) {
    log({ event: 'AUTH:2FA_RESEND', status: 'error', ip, error });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
