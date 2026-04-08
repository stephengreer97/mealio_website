import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';
import { verifySessionToken, extractTokenFromHeader, verifyAccessToken } from '@/lib/tokens';
import { log } from '@/lib/logger';

export async function POST(request: NextRequest) {
  const ip = request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || 'unknown';

  // Identify the user from session cookie or Bearer token so we can revoke their tokens.
  let userId: string | null = null;
  try {
    const sessionCookie = request.cookies.get('mealio_session');
    if (sessionCookie) {
      const session = await verifySessionToken(sessionCookie.value);
      userId = session?.userId ?? null;
    }
    if (!userId) {
      const bearer = extractTokenFromHeader(request.headers.get('authorization'));
      if (bearer) {
        const decoded = await verifyAccessToken(bearer);
        userId = decoded?.userId ?? null;
      }
    }
  } catch {
    // Token unreadable — still clear the cookie below
  }

  if (userId) {
    try {
      const supabase = createServerSupabaseClient();
      await supabase
        .from('user_profiles')
        .update({ tokens_invalidated_at: new Date().toISOString() })
        .eq('id', userId);
    } catch {
      // Non-fatal — cookie will still be cleared
    }
  }

  const response = NextResponse.json({ success: true });
  response.cookies.set('mealio_session', '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 0,
    path: '/',
  });

  log({ event: 'AUTH:LOGOUT', status: 'success', ip, userId: userId ?? 'unknown' });
  return response;
}
