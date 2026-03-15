import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';

// GET /api/creators/featured
// Ranks creators by number of distinct days they published a meal in the rolling 30 days.
export async function GET() {
  const supabase = createServerSupabaseClient();

  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  // Pull all meals published in the last 30 days with creator info
  const { data, error } = await supabase
    .from('preset_meals')
    .select('creator_id, created_at, creators!creator_id ( id, display_name, photo_url )')
    .not('creator_id', 'is', null)
    .gte('created_at', since);

  if (error) {
    return NextResponse.json({ creators: [] });
  }

  // Count distinct calendar days per creator
  const daysets = new Map<string, { id: string; display_name: string; photo_url: string | null; days: Set<string> }>();
  for (const row of data ?? []) {
    const raw = row.creators;
    const creator = (Array.isArray(raw) ? raw[0] : raw) as { id: string; display_name: string; photo_url: string | null } | null;
    if (!creator) continue;
    const day = (row.created_at as string).slice(0, 10); // "YYYY-MM-DD"
    const existing = daysets.get(creator.id);
    if (existing) {
      existing.days.add(day);
    } else {
      daysets.set(creator.id, { ...creator, days: new Set([day]) });
    }
  }

  const featured = Array.from(daysets.values())
    .sort((a, b) => b.days.size - a.days.size)
    .slice(0, 8)
    .map(({ id, display_name, photo_url }) => ({ id, display_name, photo_url }));

  return NextResponse.json({ creators: featured });
}
