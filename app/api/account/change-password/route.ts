import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient, createAnonSupabaseClient } from '@/lib/supabase';
import { verifyAccessToken, extractTokenFromHeader } from '@/lib/tokens';
import { log } from '@/lib/logger';

export async function POST(request: NextRequest) {
  const ip = request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || 'unknown';
  try {
    const token = extractTokenFromHeader(request.headers.get('authorization'));
    if (!token) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const decoded = await verifyAccessToken(token);
    if (!decoded) {
      return NextResponse.json({ error: 'Invalid token' }, { status: 401 });
    }

    const { userId, email } = decoded;

    const { currentPassword, newPassword } = await request.json();

    if (!currentPassword || !newPassword) {
      return NextResponse.json({ error: 'Current and new password are required' }, { status: 400 });
    }

    if (newPassword.length < 8) {
      return NextResponse.json({ error: 'New password must be at least 8 characters' }, { status: 400 });
    }

    // Verify the current password by attempting a sign-in
    const anonClient = createAnonSupabaseClient();
    const { error: authError } = await anonClient.auth.signInWithPassword({ email, password: currentPassword });

    if (authError) {
      log({ event: 'ACCOUNT:CHANGE_PASSWORD', status: 'failed', userId, email, ip, reason: 'wrong_current_password' });
      return NextResponse.json({ error: 'Current password is incorrect' }, { status: 400 });
    }

    // Update the password using the admin client
    const supabase = createServerSupabaseClient();
    const { error: updateError } = await supabase.auth.admin.updateUserById(userId, {
      password: newPassword,
    });

    if (updateError) {
      log({ event: 'ACCOUNT:CHANGE_PASSWORD', status: 'error', userId, email, ip, error: updateError });
      return NextResponse.json({ error: 'Failed to update password. Please try again.' }, { status: 500 });
    }

    log({ event: 'ACCOUNT:CHANGE_PASSWORD', status: 'success', userId, email, ip });
    return NextResponse.json({ success: true });
  } catch (error) {
    log({ event: 'ACCOUNT:CHANGE_PASSWORD', status: 'error', ip, error });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
