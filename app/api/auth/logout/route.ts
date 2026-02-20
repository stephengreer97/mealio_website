import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';
import { verifyRefreshToken, hashToken } from '@/lib/tokens';
import { log } from '@/lib/logger';

export async function POST(request: NextRequest) {
  const ip = request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || 'unknown';

  try {
    const { refreshToken } = await request.json().catch(() => ({}));
    const supabase = createServerSupabaseClient();

    // Revoke refresh token in database if provided
    if (refreshToken) {
      const decoded = await verifyRefreshToken(refreshToken);
      if (decoded) {
        const tokenHash = hashToken(decoded.token);
        await supabase
          .from('refresh_tokens')
          .update({ revoked: true })
          .eq('token_hash', tokenHash)
          .eq('user_id', decoded.userId);
      }
    }

    log({ event: 'AUTH:LOGIN', status: 'pending', ip, reason: 'logout' });

    // Clear the session cookie
    const response = NextResponse.json({ success: true });
    response.cookies.set('mealio_session', '', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 0,
      path: '/'
    });

    return response;
  } catch (error) {
    console.error('Logout error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
