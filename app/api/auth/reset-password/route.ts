import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';
import { decodeJwt } from 'jose';
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

    // Decode the Supabase JWT to extract the user UUID
    let userId: string;
    try {
      const payload = decodeJwt(supabaseAccessToken);
      userId = payload.sub as string;
      if (!userId) throw new Error('missing sub');
    } catch {
      log({ event: 'AUTH:RESET_PASSWORD', status: 'failed', ip, reason: 'malformed token' });
      return NextResponse.json({ error: 'Invalid or expired reset link' }, { status: 401 });
    }

    // Update password via admin API (correct usage: UUID, not JWT)
    const { error } = await supabase.auth.admin.updateUserById(userId, {
      password: newPassword,
    });

    if (error) {
      log({ event: 'AUTH:RESET_PASSWORD', status: 'failed', ip, userId, reason: error.message });
      return NextResponse.json({ error: 'Failed to reset password. The link may have expired.' }, { status: 400 });
    }

    log({ event: 'AUTH:RESET_PASSWORD', status: 'success', ip, userId });
    return NextResponse.json({ success: true });
  } catch (error) {
    log({ event: 'AUTH:RESET_PASSWORD', status: 'error', ip: 'unknown', error });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
