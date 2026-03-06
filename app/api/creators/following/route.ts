import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';
import { verifyAccessToken, extractTokenFromHeader } from '@/lib/tokens';

// GET /api/creators/following — list of creators the current user follows
export async function GET(request: NextRequest) {
  const token = extractTokenFromHeader(request.headers.get('authorization'));
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const decoded = await verifyAccessToken(token);
  if (!decoded) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const supabase = createServerSupabaseClient();

  const { data, error } = await supabase
    .from('creator_follows')
    .select('creator_id, followed_at, creators!creator_id ( id, display_name, social_handle, photo_url )')
    .eq('user_id', decoded.userId)
    .order('followed_at', { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const creators = (data ?? []).map((row: any) => ({
    ...row.creators,
    followed_at: row.followed_at,
  }));

  return NextResponse.json({ creators });
}
