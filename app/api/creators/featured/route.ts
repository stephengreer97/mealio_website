import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';

// GET /api/creators/featured — top 5 creators by meal count in the last 7 days
export async function GET() {
  const supabase = createServerSupabaseClient();

  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from('preset_meals')
    .select('creator_id, creators!creator_id ( id, display_name, photo_url )')
    .not('creator_id', 'is', null)
    .gte('created_at', since);

  if (error) {
    return NextResponse.json({ creators: [] });
  }

  // Count meals per creator
  const counts = new Map<string, { id: string; display_name: string; photo_url: string | null; count: number }>();
  for (const row of data ?? []) {
    // Supabase may return joined row as object or array — normalise to object
    const raw = row.creators;
    const creator = (Array.isArray(raw) ? raw[0] : raw) as { id: string; display_name: string; photo_url: string | null } | null;
    if (!creator) continue;
    const existing = counts.get(creator.id);
    if (existing) {
      existing.count++;
    } else {
      counts.set(creator.id, { ...creator, count: 1 });
    }
  }

  const featured = Array.from(counts.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, 5)
    .map(({ id, display_name, photo_url }) => ({ id, display_name, photo_url }));

  return NextResponse.json({ creators: featured });
}
