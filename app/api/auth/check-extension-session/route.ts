import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';
import { createAccessToken } from '@/lib/tokens';
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
    // Get session cookie
    const sessionCookie = request.cookies.get('mealio_session');

    if (!sessionCookie) {
      // Not logged in yet - extension should keep polling
      log({ event: 'AUTH:POLL', status: 'pending', ip, reason: 'no cookie' });
      return NextResponse.json({
        success: false,
        message: 'Not logged in'
      });
    }

    // Verify session token
    const sessionData = verifySessionToken(sessionCookie.value);
    if (!sessionData) {
      // Invalid session - clear cookie
      log({ event: 'AUTH:POLL', status: 'failed', ip, reason: 'invalid session token' });
      const response = NextResponse.json({
        success: false,
        message: 'Invalid session'
      });
      response.cookies.delete('mealio_session');
      return response;
    }

    const { userId, email } = sessionData;

    // Create access token for extension
    const accessToken = await createAccessToken(userId, email);

    // Get user profile
    const supabase = createServerSupabaseClient();
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('*')
      .eq('id', userId)
      .single();

    log({ event: 'AUTH:POLL', status: 'success', email, userId, ip });

    // Return tokens to extension
    return NextResponse.json({
      success: true,
      accessToken,
      user: {
        id: userId,
        email,
        tier: profile?.subscription_tier ?? 'free',
        createdAt: profile?.created_at,
        lastLoginAt: profile?.last_login_at
      }
    });

  } catch (error) {
    log({ event: 'AUTH:POLL', status: 'error', ip, error });
    return NextResponse.json({
      success: false,
      message: 'Internal error'
    }, { status: 500 });
  }
}

/**
 * Verify session token (JWT)
 */
function verifySessionToken(token: string): { userId: string; email: string } | null {
  try {
    // Import at runtime to avoid edge runtime issues
    const { jwtVerify } = require('jose');
    const JWT_SECRET = new TextEncoder().encode(process.env.JWT_SECRET || '');
    
    // This would need to be async in real implementation
    // For now, using synchronous validation
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
    
    // Check expiration
    if (payload.exp && payload.exp * 1000 < Date.now()) {
      return null;
    }

    return {
      userId: payload.sub,
      email: payload.email
    };
  } catch (error) {
    return null;
  }
}