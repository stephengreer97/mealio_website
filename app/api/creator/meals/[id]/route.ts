import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';
import { verifyAccessToken, extractTokenFromHeader } from '@/lib/tokens';
import { log } from '@/lib/logger';

async function getCreator(request: NextRequest) {
  const token = extractTokenFromHeader(request.headers.get('authorization'));
  if (!token) return null;
  const decoded = await verifyAccessToken(token);
  if (!decoded) return null;

  const supabase = createServerSupabaseClient();
  const { data: creator } = await supabase
    .from('creators')
    .select('id, display_name')
    .eq('user_id', decoded.userId)
    .maybeSingle();

  return creator ?? null;
}

// PUT /api/creator/meals/:id — edit own preset meal
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const creator = await getCreator(request);
  if (!creator) {
    return NextResponse.json({ error: 'Creator account required' }, { status: 403 });
  }

  const supabase = createServerSupabaseClient();

  // Verify ownership
  const { data: existing } = await supabase
    .from('preset_meals')
    .select('id')
    .eq('id', id)
    .eq('creator_id', creator.id)
    .maybeSingle();

  if (!existing) {
    return NextResponse.json({ error: 'Meal not found or not yours' }, { status: 404 });
  }

  const body = await request.json();
  const { name, ingredients, recipe, source, photoUrl, difficulty, tags } = body;

  const normalizeUrl = (url?: string) => {
    if (!url?.trim()) return '';
    const u = url.trim();
    return u.startsWith('http://') || u.startsWith('https://') ? u : `https://${u}`;
  };

  const updates: Record<string, unknown> = {};
  if (name)        updates.name        = name.trim();
  if (ingredients) updates.ingredients = ingredients;
  if (recipe !== undefined) updates.recipe = recipe?.trim() || null;
  if (source !== undefined) updates.source = normalizeUrl(source);
  if (photoUrl !== undefined) updates.photo_url = photoUrl || null;
  if (difficulty !== undefined) updates.difficulty = difficulty || null;
  if (tags !== undefined) updates.tags = Array.isArray(tags) ? tags : [];

  const { data: meal, error } = await supabase
    .from('preset_meals')
    .update(updates)
    .eq('id', id)
    .select()
    .single();

  if (error) {
    log({ event: 'CREATOR:MEAL_UPDATE', status: 'error', detail: id, error });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ meal });
}

// DELETE /api/creator/meals/:id — unpublish own preset meal
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const creator = await getCreator(request);
  if (!creator) {
    return NextResponse.json({ error: 'Creator account required' }, { status: 403 });
  }

  const supabase = createServerSupabaseClient();

  const { error } = await supabase
    .from('preset_meals')
    .delete()
    .eq('id', id)
    .eq('creator_id', creator.id);

  if (error) {
    log({ event: 'CREATOR:MEAL_DELETE', status: 'error', detail: id, error });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
