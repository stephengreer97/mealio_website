import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient, createAnonSupabaseClient } from '@/lib/supabase';
import { clearRevocationCache } from '@/lib/tokens';
import { log } from '@/lib/logger';

export async function POST(request: NextRequest) {
  try {
    const { supabaseAccessToken, newPassword } = await request.json();

    if (!supabaseAccessToken || !newPassword) {
      return NextResponse.json({ error: 'Token and password required' }, { status: 400 });
    }

    if (newPassword.length < 8) {
      return NextResponse.json({ error: 'Password must be at least 8 characters' }, { status: 400 });
    }

    const ip = request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || 'unknown';
    const supabase = createServerSupabaseClient();

    // Validate the Supabase recovery token's signature + expiry server-side via
    // GoTrue (getUser verifies the JWT), then trust its `sub`. Never derive the
    // target user from an unverified token — that would allow account takeover.
    const { data: userData, error: verifyError } = await createAnonSupabaseClient()
      .auth.getUser(supabaseAccessToken);
    if (verifyError || !userData?.user?.id) {
      log({ event: 'AUTH:RESET_PASSWORD', status: 'failed', ip, reason: 'invalid or expired token' });
      return NextResponse.json({ error: 'Invalid or expired reset link' }, { status: 401 });
    }
    const userId = userData.user.id;

    // Update password via admin API (correct usage: UUID, not JWT)
    const { error } = await supabase.auth.admin.updateUserById(userId, {
      password: newPassword,
    });

    if (error) {
      log({ event: 'AUTH:RESET_PASSWORD', status: 'failed', ip, userId, reason: error.message });
      return NextResponse.json({ error: 'Failed to reset password. The link may have expired.' }, { status: 400 });
    }

    // A reset revokes every prior session; the user signs in with the new password.
    await supabase
      .from('user_profiles')
      .update({ tokens_invalidated_at: new Date().toISOString() })
      .eq('id', userId);
    clearRevocationCache(userId);

    log({ event: 'AUTH:RESET_PASSWORD', status: 'success', ip, userId });
    return NextResponse.json({ success: true });
  } catch (error) {
    log({ event: 'AUTH:RESET_PASSWORD', status: 'error', ip: 'unknown', error });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
