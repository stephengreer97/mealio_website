import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';
import { verifyAccessToken, extractTokenFromHeader } from '@/lib/tokens';
import { log } from '@/lib/logger';

// POST /api/usage/automation/steps
//
// Batched per-step telemetry for one add-to-cart run:
//   { runId, configVersion?, appVersion?, platform?, steps: [
//       { seq, step, outcome, durationMs?, itemIndex?, detail? }, ...
//   ] }
//
// This is the funnel that answers "what percent of HEB adds confirmed on the
// first click this week" without asking a user for their logs. The client batches
// and retries, so ingest is IDEMPOTENT: (run_id, seq) carries a unique index and
// we upsert with ignoreDuplicates, making a redelivered batch a no-op rather than
// a double-count.
//
// Telemetry must never break automation, so every failure here returns a shape the
// client can shrug off. The client drops the batch on a 4xx and retries a 5xx.

export const dynamic = 'force-dynamic';

const MAX_STEPS_PER_BATCH = 200;
const MAX_DETAIL_BYTES = 2048;

const STEPS = new Set([
  'login_check', 'search', 'candidates', 'add_click',
  'confirm', 'reconcile', 'blocked', 'run_summary',
]);
const OUTCOMES = new Set(['ok', 'empty', 'timeout', 'error', 'blocked', 'skipped']);

const int = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : null;

const str = (v: unknown, max: number): string | null =>
  typeof v === 'string' && v.length > 0 ? v.slice(0, max) : null;

export async function POST(request: NextRequest) {
  const token = extractTokenFromHeader(request.headers.get('authorization'));
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const decoded = await verifyAccessToken(token);
  if (!decoded) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json().catch(() => null);
  if (!body?.runId || !Array.isArray(body?.steps)) {
    return NextResponse.json({ error: 'runId and steps[] required' }, { status: 400 });
  }
  if (body.steps.length === 0) return NextResponse.json({ ok: true, inserted: 0 });
  if (body.steps.length > MAX_STEPS_PER_BATCH) {
    return NextResponse.json({ error: `max ${MAX_STEPS_PER_BATCH} steps per batch` }, { status: 400 });
  }

  const supabase = createServerSupabaseClient();

  // Ownership check, and take store_id from the RUN rather than the request body
  // so the funnel can't be skewed by a client reporting the wrong store.
  const { data: run } = await supabase
    .from('automation_runs')
    .select('id, store_id, user_id')
    .eq('id', body.runId)
    .eq('user_id', decoded.userId)
    .maybeSingle();

  if (!run) return NextResponse.json({ error: 'Run not found' }, { status: 404 });

  const configVersion = int(body?.configVersion);
  const appVersion = str(body?.appVersion, 40);
  const platform = body?.platform === 'ios' || body?.platform === 'android' ? body.platform : null;

  const rows = [];
  for (const raw of body.steps) {
    const seq = int(raw?.seq);
    const step = str(raw?.step, 40);
    const outcome = str(raw?.outcome, 20);
    // Skip unrecognized rows instead of 400-ing the batch: a newer client may
    // emit a step name this deploy doesn't know yet, and losing one row is far
    // better than losing the whole run's funnel.
    if (seq == null || !step || !outcome || !STEPS.has(step) || !OUTCOMES.has(outcome)) continue;

    let detail = null;
    if (raw?.detail && typeof raw.detail === 'object') {
      const s = JSON.stringify(raw.detail);
      detail = s.length <= MAX_DETAIL_BYTES ? raw.detail : { truncated: true, bytes: s.length };
    }

    rows.push({
      run_id: run.id,
      user_id: decoded.userId,
      store_id: run.store_id,
      step,
      outcome,
      seq,
      duration_ms: int(raw?.durationMs),
      item_index: int(raw?.itemIndex),
      detail,
      config_version: configVersion,
      app_version: appVersion,
      platform,
    });
  }

  if (rows.length === 0) return NextResponse.json({ ok: true, inserted: 0 });

  const { error } = await supabase
    .from('automation_steps')
    .upsert(rows, { onConflict: 'run_id,seq', ignoreDuplicates: true });

  if (error) {
    log({ event: 'USAGE:AUTOMATION_STEPS', status: 'error', userId: decoded.userId, error });
    return NextResponse.json({ error: 'Failed to record steps' }, { status: 500 });
  }

  return NextResponse.json({ ok: true, inserted: rows.length });
}
