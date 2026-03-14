import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';

// GET /api/shared/[token] — public endpoint, returns shared meal data
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;
  const supabase = createServerSupabaseClient();

  const { data: meal, error } = await supabase
    .from('meals')
    .select('id, name, store_id, ingredients, author, difficulty, serves, website, recipe, photo_url')
    .eq('share_token', token)
    .single();

  if (error || !meal) {
    return NextResponse.json({ error: 'Meal not found' }, { status: 404 });
  }

  return NextResponse.json({ meal });
}
