import { NextRequest, NextResponse } from 'next/server';
import { createAnonSupabaseClient } from '@/lib/supabase';
import { log } from '@/lib/logger';

export async function POST(request: NextRequest) {
  const ip = request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || 'unknown';
  try {
    const { email, password, firstName, lastName } = await request.json();

    if (!email || !password) {
      return NextResponse.json({ error: 'Email and password required' }, { status: 400 });
    }

    if (!firstName || !lastName) {
      return NextResponse.json({ error: 'First and last name required' }, { status: 400 });
    }

    if (password.length < 8) {
      return NextResponse.json({ error: 'Password must be 8+ characters' }, { status: 400 });
    }

    // Use the anon client so Supabase respects its email confirmation settings
    // and sends a verification email. The service role client would bypass this.
    const supabase = createAnonSupabaseClient();

    const { data: authData, error: authError } = await supabase.auth.signUp({
      email,
      password,
      options: {
        // Supabase appends #access_token=...&type=signup to this URL after
        // the user clicks the verification link.
        emailRedirectTo: `${process.env.NEXT_PUBLIC_APP_URL}/verify-email`,
        data: {
          first_name: firstName.trim(),
          last_name: lastName.trim(),
          display_name: `${firstName.trim()} ${lastName.trim()}`,
        },
      },
    });

    if (authError || !authData.user) {
      log({ event: 'AUTH:REGISTER', status: 'failed', email, ip, reason: authError?.message || 'Failed to create user' });
      return NextResponse.json({ error: authError?.message || 'Failed to create user' }, { status: 400 });
    }

    // Supabase returns a user with an empty identities array when the email
    // is already registered (instead of returning an error, to avoid leaking info).
    if (authData.user.identities?.length === 0) {
      log({ event: 'AUTH:REGISTER', status: 'failed', email, ip, reason: 'email already registered' });
      return NextResponse.json({ error: 'An account with this email already exists' }, { status: 400 });
    }

    // Do NOT issue tokens or set a session cookie yet — the user must verify
    // their email first. complete-verification/route.ts handles that step.
    log({ event: 'AUTH:REGISTER', status: 'pending', email, ip });

    return NextResponse.json({
      requiresVerification: true,
      email,
      message: 'Check your email to complete signup',
    });
  } catch (error) {
    log({ event: 'AUTH:REGISTER', status: 'error', ip, error });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
