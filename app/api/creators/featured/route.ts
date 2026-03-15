import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';

// GET /api/creators/featured
// Ranks creators by distinct publish days in the rolling 30-day window.
// Runs entirely in Postgres — returns 8 rows regardless of meal volume.
export async function GET() {
  const supabase = createServerSupabaseClient();

  const { data, error } = await supabase.rpc('get_featured_creators');

  if (error) {
    return NextResponse.json({ creators: [] });
  }

  return NextResponse.json({ creators: data ?? [] });
}
