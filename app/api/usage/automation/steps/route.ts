import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';
import { verifyAccessToken, extractTokenFromHeader } from '@/lib/tokens';
import { log } from '@/lib/logger';

// POST /api/usage/automation/steps
//
// Batched per-step telemetry for one add-to-cart run:
//   { runId, configVersion?, appVersion?, platform?, steps: [
//       { seq, step, outcome, code?, durationMs?, itemIndex?, detail?,
//         httpStatus?, phase?, attempts?, rail? }, ...
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

// MEAL-219. The network rail's four phases, which `step` cannot express.
//
// Validated but NOT used to skip a row: an unknown phase is stored as-is, the
// same way an unknown `code` is. The row is worth more than the field, and a
// newer client shipping a fifth phase must not have its rows silently dropped
// by an older deploy — that loses exactly the rows worth having, at exactly the
// moment something new is happening.
const MAX_PHASE_LENGTH = 20;
const MAX_RAIL_LENGTH = 40;

// A status outside this is not a status. smallint tops out at 32767 and the
// column would reject it, which would fail the whole batch rather than one row.
const httpStatus = (v: unknown): number | null => {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : null;
  return n !== null && n >= 100 && n <= 599 ? n : null;
};

// Clamped, not trusted: this arrives from a script running in a page we do not
// control, and smallint would reject anything past 32767 — failing the batch.
const attempts = (v: unknown): number | null => {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : null;
  return n !== null && n >= 1 ? Math.min(n, 99) : null;
};

// MEAL-4's failure taxonomy. Deliberately NOT part of the row-skip guard below:
// that guard `continue`s, so an older server meeting a newer client's ninth code
// would silently delete the whole step from the funnel — losing the row we most
// want to see, at exactly the moment a new failure mode appears. An unrecognized
// code is stored as-is and shows up in the dashboard as its own bucket instead.
const MAX_CODE_LENGTH = 40;

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

    // Top-level field on the step record, not inside `detail`. Sanitized on its
    // own — length-clamped and nothing more — so a code this deploy has never
    // heard of still lands in the table and stays countable.
    const code = str(raw?.code, MAX_CODE_LENGTH);

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
      code,
      seq,
      duration_ms: int(raw?.durationMs),
      item_index: int(raw?.itemIndex),
      detail,
      // MEAL-219. The store's own answer, and where in the run it happened.
      http_status: httpStatus(raw?.httpStatus),
      phase: str(raw?.phase, MAX_PHASE_LENGTH),
      attempts: attempts(raw?.attempts),
      rail: str(raw?.rail, MAX_RAIL_LENGTH),
      config_version: configVersion,
      app_version: appVersion,
      platform,
    });
  }

  if (rows.length === 0) return NextResponse.json({ ok: true, inserted: 0 });

  const upsert = (batch: Record<string, unknown>[]) =>
    supabase.from('automation_steps')
      .upsert(batch, { onConflict: 'run_id,seq', ignoreDuplicates: true });

  let { error } = await upsert(rows);

  // THE DEPLOY ORDER MUST NOT MATTER. MEAL-219.
  //
  // The app ships httpStatus/phase/attempts/rail as soon as it is released; the
  // columns appear only when someone runs the migration by hand. Between those
  // two moments every insert here would fail on an unknown column and ALL step
  // telemetry would stop — not just the new fields, the whole funnel — which is
  // the opposite of this file's own rule that telemetry must never break
  // automation.
  //
  // 42703 is Postgres for "column does not exist". Retrying once without the
  // four new keys keeps the run's funnel arriving, minus the part the database
  // cannot hold yet. Logged as a warning rather than swallowed, because a
  // deploy that stays in this state is a migration someone forgot.
  if (error && (error as { code?: string }).code === '42703') {
    log({
      event: 'USAGE:AUTOMATION_STEPS', status: 'error', userId: decoded.userId,
      error: { message: 'automation_steps is missing the MEAL-219 columns; storing without them', code: '42703' },
    });
    const withoutNew = rows.map(({ http_status, phase, attempts, rail, ...rest }) => rest);
    ({ error } = await upsert(withoutNew));
  }

  if (error) {
    log({ event: 'USAGE:AUTOMATION_STEPS', status: 'error', userId: decoded.userId, error });
    return NextResponse.json({ error: 'Failed to record steps' }, { status: 500 });
  }

  return NextResponse.json({ ok: true, inserted: rows.length });
}
