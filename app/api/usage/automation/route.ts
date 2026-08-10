import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';
import { verifyAccessToken, extractTokenFromHeader } from '@/lib/tokens';
import { log } from '@/lib/logger';

// POST /api/usage/automation — logs an add-to-cart automation run.
//   { phase: 'start', storeId, source, mealCount?, itemsRequested?,
//     configVersion?, appVersion?, platform? } -> { runId }
//   { phase: 'complete', runId, itemsAdded?, itemsRequested?, outcome }
// One row per run: created at start, updated at completion (rows left 'started'
// are abandoned/never-finished runs).
//
// The outcomes a finished run may report. `automation_runs.outcome` is a plain
// text column with no CHECK constraint, so this list is the only thing that keeps
// it to a vocabulary — a value not named here is stored as NULL.
//
//   success     added what it was asked for and the cart agreed
//   partial     the cart was READ and it disagreed with the run
//   unverified  the cart could not be read at all (MEAL-190)
//   failed      added nothing
//
// `unverified` is separate from `partial` deliberately, and the distinction is the
// point of MEAL-190 rather than a nicety. A run that could not read the cart has
// no evidence either way: the only thing that could have contradicted it is
// missing, so its item counts come from the run's own report of itself. Recording
// that as `partial` says the cart was checked and came up short — a claim about
// the cart, made without having seen it — and it is indistinguishable from a run
// that really did under-add. Stores whose cart URL redirects (Walmart today, HEB
// while heb.com/cart 302s) can be in this state on EVERY run, so the two must be
// countable apart or the success rate silently absorbs a store's whole traffic.
const OUTCOMES = ['success', 'partial', 'unverified', 'failed'];

// configVersion/appVersion/platform attribute the run to the remote config and
// client build that produced it, so a confirm-rate regression in the step funnel
// (see ./steps) can be traced to the config push or release that caused it.
// Per-step detail lives in automation_steps, keyed by the runId returned here.
//
// OUTCOMES below is the whole vocabulary — anything else is stored as NULL, which
// the run drilldown reads as "finished without reporting an outcome". So a client
// that ships a value this list does not carry loses the fact entirely rather than
// degrading to a near-enough one, and this route has to accept a new outcome
// BEFORE the app that sends it reaches anyone's phone.
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
        config_version: num(body?.configVersion),
        app_version: typeof body?.appVersion === 'string' ? body.appVersion.slice(0, 40) : null,
        platform: body?.platform === 'ios' || body?.platform === 'android' ? body.platform : null,
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
    const outcome = OUTCOMES.includes(body?.outcome) ? body.outcome : null;
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
