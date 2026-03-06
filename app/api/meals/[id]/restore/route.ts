import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';
import { verifyAccessToken, extractTokenFromHeader } from '@/lib/tokens';
import { log } from '@/lib/logger';

async function getUser(request: NextRequest) {
  const token = extractTokenFromHeader(request.headers.get('authorization'));
  if (!token) return null;
  return verifyAccessToken(token);
}

// POST /api/meals/[id]/restore — restore a soft-deleted meal
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const decoded = await getUser(request);
  if (!decoded) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  const supabase = createServerSupabaseClient();

  const { data: meal, error } = await supabase
    .from('meals')
    .update({ is_active: true, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('user_id', decoded.userId)
    .select()
    .single();

  if (error) {
    log({ event: 'MEAL:RESTORE', status: 'error', userId: decoded.userId, detail: id, error });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (!meal) {
    return NextResponse.json({ error: 'Meal not found' }, { status: 404 });
  }

  log({ event: 'MEAL:RESTORE', status: 'success', userId: decoded.userId, detail: id });
  return NextResponse.json({ meal });
}
