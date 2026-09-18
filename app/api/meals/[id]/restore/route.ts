import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';
import { verifyAccessToken, extractTokenFromHeader } from '@/lib/tokens';
import { log } from '@/lib/logger';
import { freeTierLimitResponse } from '@/lib/free-tier';

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

  // Restoring makes a meal active again, so it is gated exactly like creating
  // one. Without this a free user could delete, re-add and restore their way past
  // the three-meal limit. Only a meal that is actually inactive is gated:
  // restoring one that is already active changes nothing and must not 403.
  const { data: existing, error: readError } = await supabase
    .from('meals')
    .select('id, is_active')
    .eq('id', id)
    .eq('user_id', decoded.userId)
    .maybeSingle();

  if (readError) {
    log({ event: 'MEAL:RESTORE', status: 'error', userId: decoded.userId, detail: id, error: readError });
    return NextResponse.json({ error: readError.message }, { status: 500 });
  }
  if (!existing) {
    return NextResponse.json({ error: 'Meal not found' }, { status: 404 });
  }
  if (!existing.is_active) {
    const limited = await freeTierLimitResponse(supabase, decoded.userId, 'MEAL:RESTORE');
    if (limited) return limited;
  }

  const { data: meal, error } = await supabase
    .from('meals')
    .update({ is_active: true, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('user_id', decoded.userId)
    .select()
    .maybeSingle();

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
