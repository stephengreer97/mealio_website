import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';
import { verifyAccessToken, createAccessToken, extractTokenFromHeader } from '@/lib/tokens';
import { log } from '@/lib/logger';

/**
 * POST /api/auth/renew
 * Called by the extension on every open to reset the 90-day access token clock.
 * Accepts the current (still-valid) access token, returns a fresh 90-day one.
 */
export async function POST(request: NextRequest) {
  const ip = request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || 'unknown';
  try {
    const token = extractTokenFromHeader(request.headers.get('authorization'));
    if (!token) {
      log({ event: 'AUTH:RENEW', status: 'failed', ip, reason: 'invalid or missing token' });
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const decoded = await verifyAccessToken(token);
    if (!decoded) {
      log({ event: 'AUTH:RENEW', status: 'failed', ip, reason: 'invalid or missing token' });
      return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 });
    }

    const { userId, email } = decoded;

    // Look up current tier so the extension's user object stays up to date
    const supabase = createServerSupabaseClient();
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('subscription_tier')
      .eq('id', userId)
      .single();

    const accessToken = await createAccessToken(userId, email);

    log({ event: 'AUTH:RENEW', status: 'success', email, userId, ip });
    return NextResponse.json({
      success: true,
      accessToken,
      user: {
        id: userId,
        email,
        tier: profile?.subscription_tier ?? 'free',
      },
    });
  } catch (error) {
    log({ event: 'AUTH:RENEW', status: 'error', ip: 'unknown', error });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
