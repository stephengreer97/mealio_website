import { NextRequest, NextResponse } from 'next/server';
import { log } from '@/lib/logger';

/**
 * Local logout: clears the web session cookie. The client also discards its
 * stored access token. This does NOT revoke tokens on the user's other devices —
 * that is intentional (logging out on the web shouldn't sign you out on your
 * phone). Use /api/auth/logout-all to revoke every device, and note that a
 * password change also revokes all prior sessions.
 */
export async function POST(request: NextRequest) {
  const ip = request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || 'unknown';

  const response = NextResponse.json({ success: true });
  response.cookies.set('mealio_session', '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 0,
    path: '/',
  });

  log({ event: 'AUTH:LOGOUT', status: 'success', ip });
  return response;
}
