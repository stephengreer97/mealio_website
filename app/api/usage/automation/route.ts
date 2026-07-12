import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';
import { verifyAccessToken, extractTokenFromHeader } from '@/lib/tokens';
import { log } from '@/lib/logger';

// POST /api/usage/automation — logs an add-to-cart automation run.
//   { phase: 'start', storeId, source, mealCount?, itemsRequested? } -> { runId }
//   { phase: 'complete', runId, itemsAdded?, itemsRequested?, outcome }
// One row per run: created at start, updated at completion (rows left 'started'
// are abandoned/never-finished runs).
export async function POST(request: NextRequest) {
  const token = extractTokenFromHeader(request.headers.get('authorization'));
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const decoded = await verifyAccessToken(token);
  if (!decoded) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const supabase = createServerSupabaseClient();

  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : null);

  if (body?.phase === 'start') {
    if (!body?.storeId) return NextResponse.json({ error: 'storeId required' }, { status: 400 });
    const { data, error } = await supabase
      .from('automation_runs')
      .insert({
        user_id: decoded.userId,
        store_id: String(body.storeId).slice(0, 60),
        source: body?.source === 'web' ? 'web' : 'app',
        status: 'started',
        meal_count: num(body?.mealCount),
        items_requested: num(body?.itemsRequested),
      })
      .select('id')
      .single();
    if (error || !data) {
      log({ event: 'USAGE:AUTOMATION', status: 'error', userId: decoded.userId, error, detail: 'start' });
      return NextResponse.json({ error: 'Failed to log run' }, { status: 500 });
    }
    return NextResponse.json({ runId: data.id });
  }

  if (body?.phase === 'complete') {
    if (!body?.runId) return NextResponse.json({ error: 'runId required' }, { status: 400 });
    const outcome = ['success', 'partial', 'failed'].includes(body?.outcome) ? body.outcome : null;
    const { error } = await supabase
      .from('automation_runs')
      .update({
        status: outcome === 'failed' ? 'failed' : 'completed',
        outcome,
        items_added: num(body?.itemsAdded),
        items_requested: num(body?.itemsRequested),
        completed_at: new Date().toISOString(),
      })
      .eq('id', body.runId)
      .eq('user_id', decoded.userId); // guard: only your own run
    if (error) {
      log({ event: 'USAGE:AUTOMATION', status: 'error', userId: decoded.userId, error, detail: 'complete' });
      return NextResponse.json({ error: 'Failed to update run' }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: 'Invalid phase' }, { status: 400 });
}
