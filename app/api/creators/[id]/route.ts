import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';

/**
 * Meals shown on a public creator profile.
 *
 * Well under `db-max-rows` on purpose. The ceiling is 1000 and picking a number
 * just below it would be a bound that never binds — the read would still be
 * "everything, probably", which is the habit that produced nine truncation bugs
 * here. 200 is a number someone chose: it is more than any creator has published,
 * it is a grid a browser can render, and if it is ever reached that is a product
 * decision about paginating profiles rather than a constant to raise.
 */
const PROFILE_MEALS = 200;

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
      .not('approved_at', 'is', null)
      .single(),

    // A creator's published meals, bounded explicitly. This is a public profile
    // grid with no pagination in the client, so "every meal" was never really the
    // contract — the honest version says how many it will show. A creator past
    // this many published meals needs a paginated profile, not a bigger number.
    supabase
      .from('preset_meals')
      .select('id, name, photo_url, difficulty, tags')
      .eq('creator_id', id)
      .order('created_at', { ascending: false })
      .limit(PROFILE_MEALS),

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
