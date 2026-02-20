import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';
import { verifyAccessToken, extractTokenFromHeader } from '@/lib/tokens';
import { log } from '@/lib/logger';

export async function GET(request: NextRequest) {
  try {
    const ip = request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || 'unknown';
    const token = extractTokenFromHeader(request.headers.get('authorization'));
    if (!token) {
      log({ event: 'AUTH:VERIFY', status: 'failed', ip, reason: 'no token' });
      return NextResponse.json({ error: 'No token provided' }, { status: 401 });
    }

    const decoded = await verifyAccessToken(token);
    if (!decoded) {
      log({ event: 'AUTH:VERIFY', status: 'failed', ip, reason: 'invalid token' });
      return NextResponse.json({ error: 'Invalid token' }, { status: 401 });
    }

    const { userId, email } = decoded;
    const supabase = createServerSupabaseClient();
    const { data: profile } = await supabase.from('user_profiles').select('*').eq('id', userId).single();

    if (!profile) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    log({ event: 'AUTH:VERIFY', status: 'success', email, userId, ip });
    return NextResponse.json({
      success: true,
      user: {
        id: userId,
        email,
        createdAt: profile.created_at,
        lastLoginAt: profile.last_login_at
      }
    });
  } catch (error) {
    console.error('Verify error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
