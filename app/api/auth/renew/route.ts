import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';
import { verifyAccessToken, createAccessToken, extractTokenFromHeader } from '@/lib/tokens';
import { log } from '@/lib/logger';

/**
 * POST /api/auth/renew
 * Called by the mobile app on launch to reset the 90-day access token clock.
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

    // Look up current tier + admin status so clients stay up to date, plus
    // tokens_invalidated_at to reject tokens issued before the user logged out
    // (so post-logout tokens can't be renewed indefinitely) — one query.
    const supabase = createServerSupabaseClient();
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('subscription_tier, is_admin, tokens_invalidated_at')
      .eq('id', userId)
      .single();

    if (
      profile?.tokens_invalidated_at &&
      decoded.issuedAt * 1000 < new Date(profile.tokens_invalidated_at).getTime()
    ) {
      log({ event: 'AUTH:RENEW', status: 'failed', ip, reason: 'token revoked' });
      return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 });
    }

    const accessToken = await createAccessToken(userId, email);

    log({ event: 'AUTH:RENEW', status: 'success', email, userId, ip });
    return NextResponse.json({
      success: true,
      accessToken,
      user: {
        id: userId,
        email,
        tier: profile?.subscription_tier ?? 'free',
        isAdmin: profile?.is_admin ?? false,
      },
    });
  } catch (error) {
    log({ event: 'AUTH:RENEW', status: 'error', ip: 'unknown', error });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
