import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';
import { verifyAccessToken, extractTokenFromHeader } from '@/lib/tokens';

// GET /api/preset-meals
export async function GET(request: NextRequest) {
  const token = extractTokenFromHeader(request.headers.get('authorization'));
  if (!token) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const decoded = verifyAccessToken(token);
  if (!decoded) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = createServerSupabaseClient();
  const { data: presetMeals, error } = await supabase
    .from('preset_meals')
    .select('id, name, description, source, recipe, ingredients, photo_url, author, difficulty')
    .order('created_at', { ascending: true });

  if (error) {
    console.error('GET /api/preset-meals error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ presetMeals: presetMeals ?? [] });
}
