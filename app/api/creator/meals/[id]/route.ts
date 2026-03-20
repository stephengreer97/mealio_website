import { NextRequest, NextResponse } from 'next/server';
import { revalidateTag } from 'next/cache';
import { createServerSupabaseClient } from '@/lib/supabase';
import { verifyAccessToken, extractTokenFromHeader } from '@/lib/tokens';
import { resolvePhotoUrl } from '@/lib/photos';
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

  if (!creator) return null;
  return { creator, userId: decoded.userId };
}

// PUT /api/creator/meals/:id — edit own preset meal
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const result = await getCreator(request);
  if (!result) {
    return NextResponse.json({ error: 'Creator account required' }, { status: 403 });
  }
  const { creator, userId } = result;

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
  const { name, ingredients, recipe, source, story, photoUrl, difficulty, tags, serves } = body;

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
  if (story !== undefined) updates.story = story?.trim() || null;
  if (photoUrl !== undefined) {
    updates.photo_url = photoUrl
      ? await resolvePhotoUrl(photoUrl, userId).catch(() => photoUrl)
      : null;
  }
  if (difficulty !== undefined) updates.difficulty = difficulty || null;
  if (serves !== undefined) updates.serves = serves || null;
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

  revalidateTag('trending-meals', 'max');
  log({ event: 'CREATOR:MEAL_UPDATE', status: 'success', userId: creator.id, detail: id });
  return NextResponse.json({ meal });
}

// DELETE /api/creator/meals/:id — unpublish own preset meal
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const result = await getCreator(request);
  if (!result) {
    return NextResponse.json({ error: 'Creator account required' }, { status: 403 });
  }
  const { creator } = result;

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

  revalidateTag('trending-meals', 'max');
  log({ event: 'CREATOR:MEAL_DELETE', status: 'success', userId: creator.id, detail: id });
  return NextResponse.json({ ok: true });
}
