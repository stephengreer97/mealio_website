import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';
import { createAccessToken, createRefreshToken } from '@/lib/tokens';
import { SignJWT } from 'jose';
import { log } from '@/lib/logger';

export async function POST(request: NextRequest) {
  try {
    const { email, password } = await request.json();

    if (!email || !password) {
      return NextResponse.json({ error: 'Email and password required' }, { status: 400 });
    }

    const ip = request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || 'unknown';
    const supabase = createServerSupabaseClient();
    const { data: authData, error: authError } = await supabase.auth.signInWithPassword({ email, password });

    if (authError || !authData.user) {
      log({ event: 'AUTH:LOGIN', status: 'failed', email, ip, reason: authError?.message || 'Invalid credentials' });
      return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 });
    }

    if (!authData.user.email_confirmed_at) {
      log({ event: 'AUTH:LOGIN', status: 'failed', email, ip, reason: 'email not verified' });
      return NextResponse.json(
        { error: 'Please verify your email before logging in.', requiresVerification: true, email },
        { status: 403 }
      );
    }

    const userId = authData.user.id;
    
    // Create tokens for browser storage
    const accessToken = await createAccessToken(userId, email);
    const { token: refreshToken, tokenHash, expiresAt } = await createRefreshToken(userId);

    await supabase.from('refresh_tokens').insert({
      user_id: userId,
      token_hash: tokenHash,
      expires_at: expiresAt.toISOString(),
      user_agent: request.headers.get('user-agent') || 'unknown',
      ip_address: request.headers.get('x-forwarded-for') || 'unknown'
    });

    const { data: profile } = await supabase
      .from('user_profiles')
      .select('subscription_tier')
      .eq('id', userId)
      .single();

    await supabase.from('user_profiles').update({ last_login_at: new Date().toISOString() }).eq('id', userId);

    const tier = profile?.subscription_tier ?? 'free';

    // Create session token for cookie (90 days)
    const JWT_SECRET = new TextEncoder().encode(process.env.JWT_SECRET || '');
    const sessionToken = await new SignJWT({ 
      sub: userId,
      email,
      type: 'session'
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('90d')
      .sign(JWT_SECRET);

    // Create response with session cookie
    const response = NextResponse.json({
      success: true,
      user: { id: userId, email, tier },
      accessToken,
      refreshToken,
      expiresIn: 3600
    });

    // Set HTTP-only cookie for extension polling
    response.cookies.set('mealio_session', sessionToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 90, // 90 days
      path: '/'
    });

    log({ event: 'AUTH:LOGIN', status: 'success', email, userId, ip });
    return response;
  } catch (error) {
    console.error('Login error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}