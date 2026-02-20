import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';
import { verifyAccessToken, extractTokenFromHeader } from '@/lib/tokens';

// GET /api/preset-meals?store=heb
export async function GET(request: NextRequest) {
  const token = extractTokenFromHeader(request.headers.get('authorization'));
  if (!token) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const decoded = verifyAccessToken(token);
  if (!decoded) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const store = request.nextUrl.searchParams.get('store');
  if (!store) {
    return NextResponse.json({ error: 'Missing store parameter' }, { status: 400 });
  }

  const supabase = createServerSupabaseClient();
  const { data: presetMeals, error } = await supabase
    .from('preset_meals')
    .select('id, name, description, source, recipe, ingredients')
    .eq('store_id', store)
    .order('created_at', { ascending: true });

  if (error) {
    console.error('GET /api/preset-meals error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ presetMeals: presetMeals ?? [] });
}
