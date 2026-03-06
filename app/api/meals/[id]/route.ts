import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';
import { verifyAccessToken, extractTokenFromHeader } from '@/lib/tokens';
import { log } from '@/lib/logger';
import { resolvePhotoUrl } from '@/lib/photos';

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
  const { name, ingredients, website, recipe, photoUrl, author, difficulty, tags } = await request.json();

  const resolvedPhotoUrl = photoUrl !== undefined
    ? await resolvePhotoUrl(photoUrl, decoded.userId)
    : undefined;

  const supabase = createServerSupabaseClient();
  const { data: meal, error } = await supabase
    .from('meals')
    .update({
      ...(name               !== undefined && { name }),
      ...(ingredients        !== undefined && { ingredients }),
      ...(website            !== undefined && { website:    website    || null }),
      ...(recipe             !== undefined && { recipe:     recipe     || null }),
      ...(resolvedPhotoUrl   !== undefined && { photo_url:  resolvedPhotoUrl || null }),
      ...(author      !== undefined && { author:     author     || null }),
      ...(difficulty  !== undefined && { difficulty: difficulty || null }),
      ...(tags        !== undefined && { tags: Array.isArray(tags) ? tags : [] }),
      updated_at: new Date().toISOString(),
      edited: true,
    })
    .eq('id', id)
    .eq('user_id', decoded.userId) // user can only update their own meals
    .select()
    .single();

  if (error) {
    log({ event: 'MEAL:UPDATE', status: 'error', userId: decoded.userId, detail: id, error });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (!meal) {
    return NextResponse.json({ error: 'Meal not found' }, { status: 404 });
  }

  return NextResponse.json({ meal });
}

// DELETE /api/meals/[id]
// Without ?permanent=true: soft-delete (set is_active=false)
// With ?permanent=true: hard-delete (remove from DB)
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const decoded = await getUser(request);
  if (!decoded) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  const permanent = request.nextUrl.searchParams.get('permanent') === 'true';
  const supabase = createServerSupabaseClient();

  if (permanent) {
    const { error } = await supabase
      .from('meals')
      .delete()
      .eq('id', id)
      .eq('user_id', decoded.userId);

    if (error) {
      log({ event: 'MEAL:DELETE_PERMANENT', status: 'error', userId: decoded.userId, detail: id, error });
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    log({ event: 'MEAL:DELETE_PERMANENT', status: 'success', userId: decoded.userId, detail: id });
  } else {
    const { error } = await supabase
      .from('meals')
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('user_id', decoded.userId);

    if (error) {
      log({ event: 'MEAL:DELETE', status: 'error', userId: decoded.userId, detail: id, error });
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    log({ event: 'MEAL:DELETE', status: 'success', userId: decoded.userId, detail: id });
  }

  return NextResponse.json({ success: true });
}
