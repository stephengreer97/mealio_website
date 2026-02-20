import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';
import { createAccessToken, createRefreshToken, verifyRefreshToken, hashToken } from '@/lib/tokens';
import { log } from '@/lib/logger';

export async function POST(request: NextRequest) {
  try {
    const { refreshToken } = await request.json();
    if (!refreshToken) {
      return NextResponse.json({ error: 'Refresh token required' }, { status: 400 });
    }

    const ip = request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || 'unknown';

    const decoded = await verifyRefreshToken(refreshToken);
    if (!decoded) {
      log({ event: 'AUTH:REFRESH', status: 'failed', ip, reason: 'invalid refresh token' });
      return NextResponse.json({ error: 'Invalid refresh token' }, { status: 401 });
    }

    const { userId, token } = decoded;
    const tokenHash = hashToken(token);
    const supabase = createServerSupabaseClient();

    const { data: storedToken } = await supabase
      .from('refresh_tokens')
      .select('*')
      .eq('token_hash', tokenHash)
      .eq('user_id', userId)
      .eq('revoked', false)
      .single();

    if (!storedToken || new Date(storedToken.expires_at) < new Date()) {
      log({ event: 'AUTH:REFRESH', status: 'failed', userId, ip, reason: 'token expired or revoked' });
      return NextResponse.json({ error: 'Token expired' }, { status: 401 });
    }

    const { data: profile } = await supabase.from('user_profiles').select('email').eq('id', userId).single();
    if (!profile) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    // Revoke the old refresh token and issue a new one (rotation).
    // This resets the 90-day expiry so active users never get logged out.
    await supabase
      .from('refresh_tokens')
      .update({ revoked: true, last_used_at: new Date().toISOString() })
      .eq('id', storedToken.id);

    const accessToken = await createAccessToken(userId, profile.email);
    const { token: newRefreshToken, tokenHash: newTokenHash, expiresAt } = await createRefreshToken(userId);

    await supabase.from('refresh_tokens').insert({
      user_id: userId,
      token_hash: newTokenHash,
      expires_at: expiresAt.toISOString(),
      user_agent: request.headers.get('user-agent') || 'unknown',
      ip_address: ip,
    });

    log({ event: 'AUTH:REFRESH', status: 'success', email: profile.email, userId, ip });
    return NextResponse.json({ success: true, accessToken, refreshToken: newRefreshToken, expiresIn: 3600 });
  } catch (error) {
    console.error('Refresh error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
