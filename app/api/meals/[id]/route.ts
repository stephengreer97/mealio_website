import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';
import { verifyAccessToken, extractTokenFromHeader } from '@/lib/tokens';

async function getUser(request: NextRequest) {
  const token = extractTokenFromHeader(request.headers.get('authorization'));
  if (!token) return null;
  return verifyAccessToken(token);
}

// PUT /api/meals/[id] — update name and/or ingredients
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const decoded = await getUser(request);
  if (!decoded) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  const { name, ingredients, website, recipe, photoUrl, author, difficulty } = await request.json();

  const supabase = createServerSupabaseClient();
  const { data: meal, error } = await supabase
    .from('meals')
    .update({
      ...(name        !== undefined && { name }),
      ...(ingredients !== undefined && { ingredients }),
      ...(website     !== undefined && { website:    website    || null }),
      ...(recipe      !== undefined && { recipe:     recipe     || null }),
      ...(photoUrl    !== undefined && { photo_url:  photoUrl   || null }),
      ...(author      !== undefined && { author:     author     || null }),
      ...(difficulty  !== undefined && { difficulty: difficulty || null }),
      updated_at: new Date().toISOString(),
      edited: true,
    })
    .eq('id', id)
    .eq('user_id', decoded.userId) // user can only update their own meals
    .select()
    .single();

  if (error) {
    console.error('PUT /api/meals/[id] error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (!meal) {
    return NextResponse.json({ error: 'Meal not found' }, { status: 404 });
  }

  return NextResponse.json({ meal });
}

// DELETE /api/meals/[id]
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const decoded = await getUser(request);
  if (!decoded) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  const supabase = createServerSupabaseClient();
  const { error } = await supabase
    .from('meals')
    .delete()
    .eq('id', id)
    .eq('user_id', decoded.userId); // user can only delete their own meals

  if (error) {
    console.error('DELETE /api/meals/[id] error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
