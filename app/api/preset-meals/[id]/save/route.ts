import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';
import { verifyAccessToken, extractTokenFromHeader } from '@/lib/tokens';
import { log } from '@/lib/logger';

// POST /api/preset-meals/:id/save
// Records that the authenticated user added this preset meal. Idempotent.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const token = extractTokenFromHeader(request.headers.get('authorization'));
  if (!token) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const decoded = await verifyAccessToken(token);
  if (!decoded) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = createServerSupabaseClient();
  const { error } = await supabase
    .from('preset_meal_saves')
    .upsert(
      { preset_meal_id: id, user_id: decoded.userId },
      { onConflict: 'preset_meal_id,user_id', ignoreDuplicates: true }
    );

  if (error) {
    log({ event: 'MEAL:CREATE', status: 'error', userId: decoded.userId, detail: id, error });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  log({ event: 'MEAL:SAVE_PRESET', status: 'success', userId: decoded.userId, detail: id });
  return NextResponse.json({ ok: true });
}
