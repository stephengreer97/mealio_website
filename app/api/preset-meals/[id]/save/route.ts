import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';
import { verifyAccessToken, extractTokenFromHeader } from '@/lib/tokens';
import { log } from '@/lib/logger';

/**
 * How many save records one account may write per window. Far above what a
 * person adding meals to their plan does, and far below a script.
 */
const SAVE_WINDOW_SECONDS = 60 * 60;
const MAX_SAVES_PER_WINDOW = 60;

// POST /api/preset-meals/:id/save
// Records that the authenticated user added this preset meal. Idempotent.
//
// This is a RECORD of a save, not the save itself: every client first creates
// the user's own copy through POST /api/meals (with `presetMealId`), then calls
// this. A save row decides trending and the creator profit share, so it is only
// written when that copy exists. Before, any verified account could write a row
// for any meal without saving anything, which is money with nothing behind it.
// Making this route create the meal instead would double every save from the
// clients that already create it, so it checks rather than creates.
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

  // Per-account rate limit on the shared attempt counter. Fails open, like the
  // login throttle: a counter that cannot be read must not stop real saves, and
  // the payout-side filters in /api/admin/stats do not depend on it.
  const { data: attempts, error: throttleError } = await supabase.rpc('record_login_attempt', {
    p_key: `save:${decoded.userId}`,
    p_window_seconds: SAVE_WINDOW_SECONDS,
  });
  if (throttleError || typeof attempts !== 'number') {
    log({ event: 'MEAL:SAVE_PRESET', status: 'error', userId: decoded.userId, detail: id, reason: `throttle unavailable: ${throttleError?.message ?? 'no count returned'}` });
  } else if (attempts > MAX_SAVES_PER_WINDOW) {
    log({ event: 'MEAL:SAVE_PRESET', status: 'failed', userId: decoded.userId, detail: id, reason: 'rate limited' });
    return NextResponse.json({ error: 'Too many saves. Please try again later.' }, { status: 429 });
  }

  // The user's own copy of this meal, soft-deleted or not: saving and later
  // removing it was still a save.
  const { data: copies, error: copyError } = await supabase
    .from('meals')
    .select('id')
    .eq('user_id', decoded.userId)
    .eq('preset_meal_id', id)
    .limit(1);

  if (copyError) {
    log({ event: 'MEAL:SAVE_PRESET', status: 'error', userId: decoded.userId, detail: id, error: copyError });
    return NextResponse.json({ error: copyError.message }, { status: 500 });
  }
  if (!copies || copies.length === 0) {
    log({ event: 'MEAL:SAVE_PRESET', status: 'failed', userId: decoded.userId, detail: id, reason: 'no saved copy' });
    return NextResponse.json({ error: 'Save the meal before recording it.' }, { status: 409 });
  }

  const { error } = await supabase
    .from('preset_meal_saves')
    .upsert(
      { preset_meal_id: id, user_id: decoded.userId },
      { onConflict: 'preset_meal_id,user_id', ignoreDuplicates: true }
    );

  if (error) {
    log({ event: 'MEAL:SAVE_PRESET', status: 'error', userId: decoded.userId, detail: id, error });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  log({ event: 'MEAL:SAVE_PRESET', status: 'success', userId: decoded.userId, detail: id });
  return NextResponse.json({ ok: true });
}
