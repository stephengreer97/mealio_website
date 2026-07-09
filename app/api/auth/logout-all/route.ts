import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';
import { requireAuth } from '@/lib/requireAuth';
import { clearRevocationCache } from '@/lib/tokens';
import { log } from '@/lib/logger';

/**
 * Log out of ALL devices: stamps user_profiles.tokens_invalidated_at = now, which
 * revokes every access token issued before this moment (the caller's included).
 * The client must re-authenticate afterward.
 */
export async function POST(request: NextRequest) {
  const ip = request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || 'unknown';

  const user = await requireAuth(request);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = createServerSupabaseClient();
  await supabase
    .from('user_profiles')
    .update({ tokens_invalidated_at: new Date().toISOString() })
    .eq('id', user.userId);
  clearRevocationCache(user.userId);

  const response = NextResponse.json({ success: true });
  response.cookies.set('mealio_session', '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 0,
    path: '/',
  });

  log({ event: 'AUTH:LOGOUT_ALL', status: 'success', ip, userId: user.userId });
  return response;
}
