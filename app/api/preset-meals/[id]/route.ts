import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';
import { mealIdFromParam } from '@/lib/sourcePlatform';

// GET /api/preset-meals/[id] — public, returns a single preset meal by ID
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: param } = await params;
  // The public link now carries the meal's name in front of its id, so the
  // segment that arrives here may be `weeknight-garlic-butter-shrimp-<uuid>`.
  // Bare ids still arrive from every link published before that, and from the
  // app, so this reads the id out of either.
  const id = mealIdFromParam(param);
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
