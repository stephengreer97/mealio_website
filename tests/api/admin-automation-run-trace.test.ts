import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeDb, DEFAULT_PAGE_ROWS } from '../helpers/supabase-mock';
import { jsonRequest } from '../helpers/request';

vi.mock('@/lib/supabase', async () =>
  (await import('../helpers/supabase-mock')).mockSupabaseModule());
vi.mock('@/lib/logger', () => ({ log: vi.fn() }));

import { GET } from '@/app/api/admin/automation-runs/[runId]/route';
import { MAX_PAGES } from '@/lib/paged-select';
import { clearRevocationCache, createAccessToken } from '@/lib/tokens';

// The read side of the per-run drilldown (MEAL-143).
//
// The aggregate funnel can say HEB's confirm step fails 12% of the time and
// nothing at all about any of the runs that failed. This endpoint is the answer,
// and it has exactly one way to be catastrophically wrong: a trace exists to be
// COMPLETE, so a trace cut off at PostgREST's 1000-row ceiling and presented as
// whole is worse than no trace — the last row reads as where the run stopped when
// it is only where the read stopped. So the paging and the truncation reporting are
// tested here, alongside the ordering that makes the rows a trace rather than a
// bag, and the guard that keeps `detail` payloads off an unauthenticated route.

const RUN_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_RUN = '22222222-2222-4222-8222-222222222222';

function asAdmin(isAdmin = true) {
  clearRevocationCache();
  fakeDb.queue('user_profiles', { data: { tokens_invalidated_at: null } });
  fakeDb.queue('user_profiles', { data: { is_admin: isAdmin } });
}

const runRow = (over: Record<string, unknown> = {}) => ({
  id: RUN_ID,
  store_id: 'heb',
  source: 'my_meals',
  status: 'completed',
  outcome: 'failed',
  meal_count: 2,
  items_requested: 4,
  items_added: 2,
  started_at: '2026-08-01T10:00:00.000Z',
  completed_at: '2026-08-01T10:02:00.000Z',
  config_version: 12,
  app_version: '1.4.0',
  platform: 'ios',
  user_id: 'shopper-1',
  ...over,
});

const stepRow = (seq: number, over: Record<string, unknown> = {}) => ({
  run_id: RUN_ID,
  user_id: 'shopper-1',
  store_id: 'heb',
  seq,
  step: 'search',
  outcome: 'ok',
  code: null,
  duration_ms: 120,
  item_index: 0,
  detail: null,
  config_version: 12,
  app_version: '1.4.0',
  platform: 'ios',
  occurred_at: '2026-08-01T10:00:05.000Z',
  ...over,
});

/** Call the route the way Next hands it a dynamic segment. */
function trace(runId: string, token?: string) {
  return GET(
    jsonRequest(`/api/admin/automation-runs/${runId}`, { method: 'GET', token }),
    { params: Promise.resolve({ runId }) },
  );
}

/**
 * The column list the route asked `table` for.
 *
 * Skips a `{ head: true, count }` select — that one asks for a count and no rows,
 * and its column list says nothing about what the trace returns.
 */
function selectFor(table: string): string {
  const call = fakeDb.calls.find((c) => c.table === table && c.method === 'select' && !c.args[1]?.head);
  return String(call?.args[0] ?? '');
}

/** The `.order()` arguments the route paged `table` by. */
function orderFor(table: string): any[] {
  return fakeDb.calls.find((c) => c.table === table && c.method === 'order')?.args ?? [];
}

describe('GET /api/admin/automation-runs/[runId]', () => {
  let token: string;

  beforeEach(async () => {
    fakeDb.reset();
    token = await createAccessToken('admin-1', 'admin@mealio.test');
  });

  // ── The guard ─────────────────────────────────────────────────────────────

  it('403s a non-admin — a trace carries client-supplied detail payloads', async () => {
    asAdmin(false);
    fakeDb.seed('automation_runs', [runRow()]);
    fakeDb.seed('automation_steps', [stepRow(1, { detail: { query: 'organic whole milk' } })]);

    const res = await trace(RUN_ID, token);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.steps).toBeUndefined();
    // Nothing was even read: the guard runs before the query.
    expect(fakeDb.calls.some((c) => c.table === 'automation_steps')).toBe(false);
  });

  it('403s with no token at all', async () => {
    const res = await trace(RUN_ID);
    expect(res.status).toBe(403);
  });

  // ── Missing and malformed ids ─────────────────────────────────────────────

  it('404s an unknown run id rather than returning an empty trace', async () => {
    // An empty `steps` array with a 200 would read as "this run did nothing",
    // which is the one sentence this endpoint must never accidentally say.
    asAdmin();
    fakeDb.seed('automation_runs', []);
    fakeDb.seed('automation_steps', []);

    const res = await trace(RUN_ID, token);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatch(/not found/i);
  });

  it('400s a malformed run id instead of letting PostgREST 400 as a 500', async () => {
    // `automation_runs.id` is a uuid column: comparing it to "banana" is error
    // 22P02, which the catch would log as an internal error and return as a 500.
    asAdmin();
    const res = await trace('banana', token);
    expect(res.status).toBe(400);
    expect(fakeDb.calls.some((c) => c.table === 'automation_runs')).toBe(false);
  });

  // ── The trace itself ──────────────────────────────────────────────────────

  it('returns the steps in seq order, with the fields a diagnosis needs', async () => {
    asAdmin();
    fakeDb.seed('automation_runs', [runRow()]);
    // Seeded out of order on purpose: physical row order is not seq order, and
    // nothing but the query's `.order('seq')` makes the response a trace.
    fakeDb.seed('automation_steps', [
      stepRow(4, { step: 'confirm', outcome: 'error', code: 'confirm_failed', item_index: 1 }),
      stepRow(1, { step: 'login_check' }),
      stepRow(3, { step: 'add_click', item_index: 1 }),
      stepRow(2, { step: 'search', item_index: 1, detail: { query: 'whole milk' } }),
    ]);

    const res = await trace(RUN_ID, token);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.steps.map((s: any) => s.seq)).toEqual([1, 2, 3, 4]);
    expect(body.steps.map((s: any) => s.step)).toEqual(['login_check', 'search', 'add_click', 'confirm']);
    // The columns the ticket asks for, present on the row rather than renamed.
    expect(body.steps[3]).toMatchObject({
      step: 'confirm', outcome: 'error', code: 'confirm_failed',
      duration_ms: 120, item_index: 1,
    });
    expect(body.steps[1].detail).toEqual({ query: 'whole milk' });
    // …and the run row's own figures alongside them.
    expect(body.run).toMatchObject({
      store_id: 'heb', status: 'completed', items_requested: 4, items_added: 2,
    });
    expect(body.truncated).toBe(false);
    expect(body.read.complete).toBe(true);
  });

  it('orders and filters on the columns that make the order total', async () => {
    // `(run_id, seq)` is unique, so `seq` ASC over one run is a TOTAL order — which
    // is why this may page on its display column while the funnel may not page on
    // `occurred_at`. Filtering on the wrong column would return another run's rows
    // in a plausible-looking order.
    asAdmin();
    fakeDb.seed('automation_runs', [runRow()]);
    fakeDb.seed('automation_steps', []);
    await trace(RUN_ID, token);

    expect(orderFor('automation_steps')[0]).toBe('seq');
    expect(orderFor('automation_steps')[1]).toMatchObject({ ascending: true });
    expect(fakeDb.calls.some((c) =>
      c.table === 'automation_steps' && c.method === 'eq' && c.args[0] === 'run_id' && c.args[1] === RUN_ID,
    )).toBe(true);
  });

  it('never returns another run\'s rows', async () => {
    asAdmin();
    fakeDb.seed('automation_runs', [runRow()]);
    fakeDb.seed('automation_steps', [
      stepRow(1, { step: 'login_check' }),
      stepRow(1, { run_id: OTHER_RUN, step: 'confirm', outcome: 'error' }),
      stepRow(2, { run_id: OTHER_RUN, step: 'reconcile' }),
    ]);

    const body = await (await trace(RUN_ID, token)).json();
    expect(body.steps).toHaveLength(1);
    expect(body.steps[0].step).toBe('login_check');
  });

  it('selects config_version and app_version per step, not only off the run', async () => {
    // A config push that lands mid-run is visible in the step rows and nowhere
    // else. Losing these columns loses the ability to attribute a trace to a push.
    asAdmin();
    fakeDb.seed('automation_runs', [runRow()]);
    fakeDb.seed('automation_steps', []);
    await trace(RUN_ID, token);

    const steps = selectFor('automation_steps');
    for (const column of ['seq', 'step', 'outcome', 'code', 'duration_ms', 'item_index', 'detail', 'config_version', 'app_version']) {
      expect(steps, `step select is missing ${column}`).toContain(column);
    }
    const run = selectFor('automation_runs');
    for (const column of ['store_id', 'status', 'items_requested', 'items_added', 'config_version', 'app_version']) {
      expect(run, `run select is missing ${column}`).toContain(column);
    }
    // Not selected on purpose: an operator debugging a selector does not need to
    // know whose basket it was.
    expect(run).not.toContain('user_id');
    expect(steps).not.toContain('user_id');
  });

  // ── The row ceiling ───────────────────────────────────────────────────────

  it('pages a run with more step rows than one page', async () => {
    // A run really can exceed a page: ingest takes 200 steps per batch with no cap
    // on batches, and a large basket emits several rows per item. Truncated at
    // 1000 the last row reads as where the run stopped.
    asAdmin();
    fakeDb.seed('automation_runs', [runRow()]);
    fakeDb.seed('automation_steps', Array.from({ length: 1500 }, (_, i) => stepRow(i + 1)));

    const body = await (await trace(RUN_ID, token)).json();
    expect(body.steps).toHaveLength(1500);
    expect(body.read.stepsRead).toBe(1500);
    expect(body.read.expectedSteps).toBe(1500);
    expect(body.truncated).toBe(false);
    // Still ordered across the page boundary.
    expect(body.steps[0].seq).toBe(1);
    expect(body.steps[DEFAULT_PAGE_ROWS].seq).toBe(DEFAULT_PAGE_ROWS + 1);
    expect(body.steps[1499].seq).toBe(1500);
  });

  it('stops at one page when the run holds exactly one page', async () => {
    asAdmin();
    fakeDb.seed('automation_runs', [runRow()]);
    fakeDb.seed('automation_steps', Array.from({ length: DEFAULT_PAGE_ROWS }, (_, i) => stepRow(i + 1)));

    const body = await (await trace(RUN_ID, token)).json();
    expect(body.read.stepsRead).toBe(DEFAULT_PAGE_ROWS);
    expect(body.truncated).toBe(false);
  });

  it('says so loudly when the page ceiling is reached', async () => {
    asAdmin();
    fakeDb.seed('automation_runs', [runRow()]);
    // The count query runs first, then MAX_PAGES full pages with more behind them.
    fakeDb.queue('automation_steps', { data: null, count: 999999, error: null });
    const fullPage = Array.from({ length: DEFAULT_PAGE_ROWS }, (_, i) => stepRow(i + 1));
    for (let i = 0; i < MAX_PAGES; i++) fakeDb.queue('automation_steps', { data: fullPage, error: null });

    const body = await (await trace(RUN_ID, token)).json();
    expect(body.truncated).toBe(true);
    expect(body.read.complete).toBe(false);
    expect(body.read.pagesComplete).toBe(false);
    expect(body.read.reason).toMatch(/page ceiling/i);
    expect(body.caveats.join(' ')).toMatch(/INCOMPLETE/);
    // And the derived verdict refuses rather than guessing off a prefix.
    expect(body.summary.firstFailure.kind).toBe('incomplete');
  });

  it('reports truncation when the rows read fall short of the row count', async () => {
    // The other shape of a short read: every page succeeded and ended early, but
    // there are more rows in the table than arrived. Reconciling against a count
    // taken before the walk is what catches it.
    asAdmin();
    fakeDb.seed('automation_runs', [runRow()]);
    fakeDb.queue('automation_steps', { data: null, count: 10, error: null });
    fakeDb.queue('automation_steps', { data: [stepRow(1), stepRow(2), stepRow(3)], error: null });

    const body = await (await trace(RUN_ID, token)).json();
    expect(body.read.pagesComplete).toBe(true);
    expect(body.read.complete).toBe(false);
    expect(body.truncated).toBe(true);
    expect(body.read.reason).toMatch(/read 3 of 10/);
    expect(body.summary.firstFailure.kind).toBe('incomplete');
  });

  it('500s rather than returning a partial trace when a page errors', async () => {
    // A failed page is a broken read, not a short run. Answering 200 with the rows
    // that arrived first would dress a database problem up as a diagnosis.
    asAdmin();
    fakeDb.seed('automation_runs', [runRow()]);
    fakeDb.queue('automation_steps', { data: null, count: 4, error: null });
    fakeDb.queue('automation_steps', { data: null, error: { message: 'db down' } });
    const res = await trace(RUN_ID, token);
    expect(res.status).toBe(500);
  });

  it('500s when the row count itself cannot be read', async () => {
    asAdmin();
    fakeDb.seed('automation_runs', [runRow()]);
    fakeDb.queue('automation_steps', { data: null, count: null, error: { message: 'db down' } });
    const res = await trace(RUN_ID, token);
    expect(res.status).toBe(500);
  });

  // ── What the trace refuses to claim ───────────────────────────────────────

  it('names the first failing step in run order, over what run_summary claims', async () => {
    // MEAL-123: run_summary carries the run's MOST FREQUENT code, not its most
    // severe. Three confirm_failed and one waf_block reports confirm_failed and
    // buries the only actionable half. Within one run the steps are totally
    // ordered, so the wall is an observation rather than a ranking.
    asAdmin();
    fakeDb.seed('automation_runs', [runRow()]);
    fakeDb.seed('automation_steps', [
      stepRow(1, { step: 'login_check' }),
      stepRow(2, { step: 'add_click', outcome: 'blocked', code: 'waf_block', item_index: 0 }),
      stepRow(3, { step: 'confirm', outcome: 'error', code: 'confirm_failed', item_index: 1 }),
      stepRow(4, { step: 'confirm', outcome: 'error', code: 'confirm_failed', item_index: 2 }),
      stepRow(5, { step: 'confirm', outcome: 'error', code: 'confirm_failed', item_index: 3 }),
      stepRow(6, { step: 'run_summary', outcome: 'error', code: 'confirm_failed', item_index: null }),
    ]);

    const body = await (await trace(RUN_ID, token)).json();
    expect(body.summary.firstFailure).toMatchObject({
      kind: 'failed', seq: 2, step: 'add_click', code: 'waf_block', blocked: true,
    });
    expect(body.summary.runSummaryCode).toBe('confirm_failed');
    expect(body.summary.blocked).toBe(1);
    expect(body.summary.failures).toBe(4);
    // And the response says out loud that the summary code is not the verdict.
    expect(body.caveats.join(' ')).toMatch(/MEAL-123/);
  });

  it('calls an empty trace uninstrumented, not idle', async () => {
    // MEAL-122: the parallel and pre-search add pools emit no per-item rows at
    // all, and Kroger never runs the WebView engine. A run at one of those stores
    // can add everything it was asked for and leave nothing behind.
    asAdmin();
    fakeDb.seed('automation_runs', [runRow({ outcome: 'success', items_added: 4 })]);
    fakeDb.seed('automation_steps', []);

    const body = await (await trace(RUN_ID, token)).json();
    expect(body.steps).toEqual([]);
    expect(body.summary.stepsRead).toBe(0);
    expect(body.summary.firstFailure.kind).toBe('no_trace');
    expect(body.summary.noItemInstrumentation).toBe(true);
    expect(body.caveats.join(' ')).toMatch(/MEAL-122/);
    expect(body.caveats.join(' ')).toMatch(/NOT a run that did nothing/);
  });

  it('flags a hole in the seq numbering as rows missing, not as a shorter run', async () => {
    // seq is client-assigned and ingest keeps it verbatim, skipping any row whose
    // step name this deploy does not recognise. A gap therefore means rows are
    // gone from the table, which is a different statement from "the run did less".
    asAdmin();
    fakeDb.seed('automation_runs', [runRow()]);
    fakeDb.seed('automation_steps', [stepRow(2), stepRow(5, { step: 'confirm' })]);

    const body = await (await trace(RUN_ID, token)).json();
    expect(body.summary.seq).toMatchObject({ min: 2, max: 5, count: 2, missing: 2, startsLate: true });
    expect(body.caveats.join(' ')).toMatch(/hole/);
  });

  it('surfaces every config and app version the run touched', async () => {
    asAdmin();
    fakeDb.seed('automation_runs', [runRow({ config_version: 11, app_version: '1.4.0' })]);
    fakeDb.seed('automation_steps', [
      stepRow(1, { config_version: 11, app_version: '1.4.0' }),
      stepRow(2, { config_version: 12, app_version: '1.4.0' }),
    ]);

    const body = await (await trace(RUN_ID, token)).json();
    expect(body.summary.versions.configVersions).toEqual([11, 12]);
    expect(body.summary.versions.appVersions).toEqual(['1.4.0']);
    expect(body.summary.versions.mixed).toBe(true);
    expect(body.caveats.join(' ')).toMatch(/config push/);
  });

  it('reports a clean run as clean without inventing a failure', async () => {
    asAdmin();
    fakeDb.seed('automation_runs', [runRow({ outcome: 'success', items_added: 4 })]);
    fakeDb.seed('automation_steps', [
      stepRow(1, { step: 'login_check' }),
      stepRow(2, { step: 'search' }),
      stepRow(3, { step: 'candidates' }),
      stepRow(4, { step: 'add_click' }),
      stepRow(5, { step: 'confirm' }),
      stepRow(6, { step: 'reconcile', outcome: 'skipped' }),
    ]);

    const body = await (await trace(RUN_ID, token)).json();
    expect(body.summary.firstFailure).toEqual({ kind: 'clean' });
    expect(body.summary.failures).toBe(0);
    expect(body.summary.noItemInstrumentation).toBe(false);
    expect(body.summary.itemsMissed).toBe(0);
    expect(body.caveats).toEqual([]);
  });
});
