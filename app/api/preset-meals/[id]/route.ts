import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';

// GET /api/preset-meals/[id] — public, returns a single preset meal by ID
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = createServerSupabaseClient();

  const { data: meal, error } = await supabase
    .from('preset_meals')
    .select('id, name, author, creator_id, ingredients, source, story, recipe, photo_url, difficulty, serves, tags, creators!creator_id ( display_name, social_handle )')
    .eq('id', id)
    .single();

  if (error || !meal) {
    return NextResponse.json({ error: 'Meal not found' }, { status: 404 });
  }

  const m = meal as any;
  return NextResponse.json({
    meal: {
      ...m,
      creator_name:   m.creators?.display_name  ?? null,
      creator_social: m.creators?.social_handle ?? null,
      creators:       undefined,
    },
  });
}
