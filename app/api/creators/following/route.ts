import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';
import { verifyAccessToken, extractTokenFromHeader } from '@/lib/tokens';
import { fetchAllPages } from '@/lib/paged-select';

// GET /api/creators/following — list of creators the current user follows
export async function GET(request: NextRequest) {
  const token = extractTokenFromHeader(request.headers.get('authorization'));
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const decoded = await verifyAccessToken(token);
  if (!decoded) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const supabase = createServerSupabaseClient();

  // Paged: this is the whole "who you follow" list and the client renders it as
  // one, so a truncated read is a creator the user follows silently disappearing
  // from the only screen that lists them — and from the unfollow button with it.
  const read = await fetchAllPages<any>((from, to) =>
    supabase
      .from('creator_follows')
      .select('creator_id, followed_at, creators!creator_id ( id, display_name, social_handle, photo_url )')
      .eq('user_id', decoded.userId)
      .order('creator_id', { ascending: true })
      .range(from, to));

  if (read.error) return NextResponse.json({ error: read.error.message }, { status: 500 });

  // Most-recently-followed first, as before. The walk pages on `creator_id`,
  // which is unique per user here; `followed_at` is not.
  const creators = [...read.rows]
    .sort((a, b) => String(b.followed_at ?? '').localeCompare(String(a.followed_at ?? '')))
    .map((row: any) => ({ ...row.creators, followed_at: row.followed_at }));

  return NextResponse.json({ creators, incomplete: read.complete ? [] : ['follows'] });
}
