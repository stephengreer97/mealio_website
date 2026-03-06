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
    .select('is_admin')
    .eq('id', decoded.userId)
    .single();

  return data?.is_admin ? decoded : null;
}
