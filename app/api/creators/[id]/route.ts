import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';

// GET /api/creators/[id] — public, returns creator info + their meals + follower count
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = createServerSupabaseClient();

  const [creatorRes, mealsRes, followCountRes] = await Promise.all([
    supabase
      .from('creators')
      .select('id, display_name, bio, social_handle, photo_url, approved_at')
      .eq('id', id)
      .single(),

    supabase
      .from('preset_meals')
      .select('id, name, photo_url, difficulty, tags')
      .eq('creator_id', id)
      .order('created_at', { ascending: false }),

    supabase
      .from('creator_follows')
      .select('*', { count: 'exact', head: true })
      .eq('creator_id', id),
  ]);

  if (creatorRes.error || !creatorRes.data) {
    return NextResponse.json({ error: 'Creator not found' }, { status: 404 });
  }

  return NextResponse.json({
    creator: creatorRes.data,
    meals: mealsRes.data ?? [],
    followerCount: followCountRes.count ?? 0,
  });
}
