import { NextRequest } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';
import { verifyAccessToken, extractTokenFromHeader } from '@/lib/tokens';

export async function requireAdmin(request: NextRequest) {
  const token = extractTokenFromHeader(request.headers.get('authorization'));
  if (!token) return null;

  const decoded = await verifyAccessToken(token);
  if (!decoded) return null;

  const supabase = createServerSupabaseClient();
  const { data } = await supabase
    .from('user_profiles')
    .select('is_admin, tokens_invalidated_at')
    .eq('id', decoded.userId)
    .single();

  if (!data?.is_admin) return null;

  // Reject if token was issued before the user logged out
  if (
    data.tokens_invalidated_at &&
    decoded.issuedAt * 1000 < new Date(data.tokens_invalidated_at).getTime()
  ) {
    return null;
  }

  return decoded;
}
