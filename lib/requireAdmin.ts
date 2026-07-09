import { NextRequest } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';
import { requireAuth } from '@/lib/requireAuth';

/**
 * Admin guard. Builds on requireAuth (which verifies the token and enforces
 * revocation), then checks the is_admin flag. Returns the authed user or null.
 */
export async function requireAdmin(request: NextRequest) {
  const user = await requireAuth(request);
  if (!user) return null;

  const supabase = createServerSupabaseClient();
  const { data } = await supabase
    .from('user_profiles')
    .select('is_admin')
    .eq('id', user.userId)
    .single();

  if (!data?.is_admin) return null;
  return user;
}
