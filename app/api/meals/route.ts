import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';
import { verifyAccessToken, extractTokenFromHeader } from '@/lib/tokens';

async function getUser(request: NextRequest) {
  const token = extractTokenFromHeader(request.headers.get('authorization'));
  if (!token) return null;
  return verifyAccessToken(token);
}

// GET /api/meals — return all meals for the authenticated user
export async function GET(request: NextRequest) {
  const decoded = await getUser(request);
  if (!decoded) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = createServerSupabaseClient();
  const { data: meals, error } = await supabase
    .from('meals')
    .select('*')
    .eq('user_id', decoded.userId)
    .order('created_at', { ascending: true });

  if (error) {
    console.error('GET /api/meals error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ meals });
}

// POST /api/meals — create a new meal
export async function POST(request: NextRequest) {
  const decoded = await getUser(request);
  if (!decoded) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await request.json();
  const { name, storeId, ingredients, createdAt, presetMealId, website, recipe } = body;

  if (!name || !storeId || !Array.isArray(ingredients)) {
    return NextResponse.json({ error: 'name, storeId, and ingredients are required' }, { status: 400 });
  }

  const supabase = createServerSupabaseClient();
  const { data: meal, error } = await supabase
    .from('meals')
    .insert({
      user_id: decoded.userId,
      name,
      store_id: storeId,
      ingredients,
      created_at: createdAt ? new Date(createdAt).toISOString() : new Date().toISOString(),
      ...(presetMealId ? { preset_meal_id: presetMealId } : {}),
      ...(website   ? { website }   : {}),
      ...(recipe    ? { recipe }    : {}),
    })
    .select()
    .single();

  if (error) {
    console.error('POST /api/meals error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ meal }, { status: 201 });
}
