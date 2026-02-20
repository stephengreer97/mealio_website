import { createClient } from '@supabase/supabase-js';

// Service role client — bypasses RLS, used for admin operations.
// NOTE: The service role key also bypasses Supabase's email confirmation
// flow, which is why we need the anon client for user-facing auth.
export function createServerSupabaseClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('Missing Supabase environment variables');
  }

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  });
}

// Anon key client — respects Supabase's email confirmation settings.
// Use this for signUp() and resend() so Supabase sends verification emails.
export function createAnonSupabaseClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

  if (!supabaseUrl || !anonKey) {
    throw new Error('Missing Supabase public environment variables');
  }

  return createClient(supabaseUrl, anonKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      // Force implicit (hash-based) flow so the verification email link
      // redirects with #access_token=... instead of ?code=... (PKCE).
      // PKCE requires a browser-stored code_verifier which doesn't work
      // when signUp() is called server-side.
      flowType: 'implicit',
    }
  });
}
