import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';
import { createAccessToken, verifySessionToken } from '@/lib/tokens';
import { log } from '@/lib/logger';

/**
 * Extension Session Check Endpoint
 *
 * Extension polls this endpoint after opening login page.
 * If user has logged in (has session cookie), returns tokens.
 * If not logged in yet, returns success: false.
 */
export async function GET(request: NextRequest) {
  const ip = request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || 'unknown';
  try {
    const sessionCookie = request.cookies.get('mealio_session');

    if (!sessionCookie) {
      log({ event: 'AUTH:POLL', status: 'pending', ip, reason: 'no cookie' });
      return NextResponse.json({ success: false, message: 'Not logged in' });
    }

    const sessionData = await verifySessionToken(sessionCookie.value);
    if (!sessionData) {
      log({ event: 'AUTH:POLL', status: 'failed', ip, reason: 'invalid session token' });
      const response = NextResponse.json({ success: false, message: 'Invalid session' });
      response.cookies.delete('mealio_session');
      return response;
    }

    const { userId, email } = sessionData;

    const accessToken = await createAccessToken(userId, email);

    const supabase = createServerSupabaseClient();
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('subscription_tier, created_at, last_login_at')
      .eq('id', userId)
      .single();

    log({ event: 'AUTH:POLL', status: 'success', email, userId, ip });

    return NextResponse.json({
      success: true,
      accessToken,
      user: {
        id: userId,
        email,
        tier: profile?.subscription_tier ?? 'free',
        createdAt: profile?.created_at,
        lastLoginAt: profile?.last_login_at,
      }
    });

  } catch (error) {
    log({ event: 'AUTH:POLL', status: 'error', ip, error });
    return NextResponse.json({ success: false, message: 'Internal error' }, { status: 500 });
  }
}
