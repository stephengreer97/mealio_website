import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';

// GET /api/creators/search?q=... — search all approved creators by name
export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams.get('q')?.trim();
  if (!q) return NextResponse.json({ creators: [] });

  const supabase = createServerSupabaseClient();
  const { data, error } = await supabase
    .from('creators')
    .select('id, display_name, photo_url')
    .not('approved_at', 'is', null)
    .ilike('display_name', `%${q}%`)
    .limit(10);

  if (error) return NextResponse.json({ creators: [] });
  return NextResponse.json({ creators: data ?? [] });
}
