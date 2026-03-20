import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';
import { verifyAccessToken, extractTokenFromHeader } from '@/lib/tokens';
import { log } from '@/lib/logger';

async function getUser(request: NextRequest) {
  const token = extractTokenFromHeader(request.headers.get('authorization'));
  if (!token) return null;
  return verifyAccessToken(token);
}

// GET /api/creators/[id]/follow — returns { following: bool }
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const decoded = await getUser(request);
  if (!decoded) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  const supabase = createServerSupabaseClient();
  const { data } = await supabase
    .from('creator_follows')
    .select('id')
    .eq('user_id', decoded.userId)
    .eq('creator_id', id)
    .maybeSingle();

  return NextResponse.json({ following: !!data });
}

// POST /api/creators/[id]/follow — follow (idempotent)
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const decoded = await getUser(request);
  if (!decoded) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  const supabase = createServerSupabaseClient();
  const { error } = await supabase
    .from('creator_follows')
    .upsert({ user_id: decoded.userId, creator_id: id }, { onConflict: 'user_id,creator_id' });

  if (error) {
    log({ event: 'CREATOR:FOLLOW', status: 'error', userId: decoded.userId, detail: `creator=${id}`, error });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  log({ event: 'CREATOR:FOLLOW', status: 'success', userId: decoded.userId, detail: `creator=${id} action=follow` });
  return NextResponse.json({ following: true });
}

// DELETE /api/creators/[id]/follow — unfollow
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const decoded = await getUser(request);
  if (!decoded) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  const supabase = createServerSupabaseClient();
  const { error } = await supabase
    .from('creator_follows')
    .delete()
    .eq('user_id', decoded.userId)
    .eq('creator_id', id);

  if (error) {
    log({ event: 'CREATOR:FOLLOW', status: 'error', userId: decoded.userId, detail: `creator=${id}`, error });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  log({ event: 'CREATOR:FOLLOW', status: 'success', userId: decoded.userId, detail: `creator=${id} action=unfollow` });
  return NextResponse.json({ following: false });
}
