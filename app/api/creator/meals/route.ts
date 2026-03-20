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

// POST /api/creator/meals — publish a new preset meal
export async function POST(request: NextRequest) {
  const result = await getCreator(request);
  if (!result) {
    return NextResponse.json({ error: 'Creator account required' }, { status: 403 });
  }
  const { creator, userId } = result;

  const body = await request.json();
  const { name, ingredients, recipe, source, story, photoUrl, difficulty, tags, serves } = body;

  if (!name?.trim() || !Array.isArray(ingredients) || ingredients.length === 0) {
    return NextResponse.json({ error: 'name and ingredients are required' }, { status: 400 });
  }

  const normalizeUrl = (url?: string) => {
    if (!url?.trim()) return '';
    const u = url.trim();
    return u.startsWith('http://') || u.startsWith('https://') ? u : `https://${u}`;
  };

  const resolvedPhotoUrl = await resolvePhotoUrl(photoUrl, userId).catch(() => photoUrl ?? null);

  const supabase = createServerSupabaseClient();
  const { data: meal, error } = await supabase
    .from('preset_meals')
    .insert({
      name:        name.trim(),
      author:      creator.display_name,
      creator_id:  creator.id,
      ingredients,
      source:      normalizeUrl(source),
      recipe:      recipe?.trim() || null,
      story:       story?.trim() || null,
      photo_url:   resolvedPhotoUrl || null,
      difficulty:  difficulty || null,
      serves:      serves || null,
      ...(Array.isArray(tags) && tags.length ? { tags } : {}),
    })
    .select()
    .single();

  if (error) {
    log({ event: 'CREATOR:MEAL_CREATE', status: 'error', userId: creator.id, detail: String(error) });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  revalidateTag('trending-meals', 'max');
  log({ event: 'CREATOR:MEAL_CREATE', status: 'success', userId: creator.id, detail: `id=${meal.id} name="${meal.name}"` });
  return NextResponse.json({ meal }, { status: 201 });
}
