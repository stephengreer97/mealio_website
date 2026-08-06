import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeDb, DEFAULT_PAGE_ROWS } from '../helpers/supabase-mock';
import { jsonRequest } from '../helpers/request';

vi.mock('@/lib/supabase', async () =>
  (await import('../helpers/supabase-mock')).mockSupabaseModule());
vi.mock('@/lib/logger', () => ({ log: vi.fn() }));

import { GET } from '@/app/api/admin/automation-funnel/route';
import { clearRevocationCache, createAccessToken } from '@/lib/tokens';

// The read side of the automation funnel. The aggregation itself is unit-tested
// in tests/lib/automation-funnel.test.ts; what is tested HERE is the fetch, and
// the fetch has exactly one way to be catastrophically wrong: PostgREST returns
// the first 1000 rows of an unbounded select, says nothing about the rest, and a
// dashboard built on the first page of a month reads as authoritative while being
// arbitrarily incomplete. Both tables have to be paged, and both are tested.

function asAdmin(isAdmin = true) {
  clearRevocationCache();
  fakeDb.queue('user_profiles', { data: { tokens_invalidated_at: null } });
  fakeDb.queue('user_profiles', { data: { is_admin: isAdmin } });
}

const hoursAgo = (h: number) => new Date(Date.now() - h * 60 * 60 * 1000).toISOString();

const runRow = (over: Record<string, unknown> = {}) => ({
  id: `run-${Math.random()}`,
  store_id: 'heb',
  outcome: 'success',
  status: 'completed',
  items_requested: 3,
  items_added: 3,
  started_at: hoursAgo(2),
  ...over,
});

let seq = 0;
const stepRow = (over: Record<string, unknown> = {}) => ({
  id: ++seq,
  store_id: 'heb',
  step: 'add_click',
  outcome: 'ok',
  code: null,
  duration_ms: 100,
  detail: null,
  occurred_at: hoursAgo(2),
  ...over,
});

/** The select column list the route asked `table` for. */
function selectFor(table: string): string {
  const call = fakeDb.calls.find((c) => c.table === table && c.method === 'select');
  return String(call?.args[0] ?? '');
}

describe('GET /api/admin/automation-funnel', () => {
  let token: string;

  beforeEach(async () => {
    fakeDb.reset();
    seq = 0;
    token = await createAccessToken('admin-1', 'admin@mealio.test');
  });

  it('403 for a non-admin', async () => {
    asAdmin(false);
    const res = await GET(jsonRequest('/api/admin/automation-funnel', { method: 'GET', token }));
    expect(res.status).toBe(403);
  });

  it('403 without a token', async () => {
    const res = await GET(jsonRequest('/api/admin/automation-funnel', { method: 'GET' }));
    expect(res.status).toBe(403);
  });

  it('aggregates runs and steps per store', async () => {
    asAdmin();
    fakeDb.seed('automation_runs', [
      runRow({ store_id: 'kroger' }),
      runRow({ store_id: 'heb', outcome: 'failed' }),
    ]);
    fakeDb.seed('automation_steps', [
      stepRow({ store_id: 'heb', step: 'add_click', outcome: 'ok' }),
      stepRow({ store_id: 'heb', step: 'confirm', outcome: 'error', code: 'confirm_failed' }),
    ]);

    const res = await GET(jsonRequest('/api/admin/automation-funnel?days=30', { method: 'GET', token }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.days).toBe(30);
    expect(body.stores.map((s: any) => s.storeId).sort()).toEqual(['heb', 'kroger']);
    const heb = body.stores.find((s: any) => s.storeId === 'heb');
    expect(heb.failureCodes).toEqual({ confirm_failed: 1 });
  });

  // ── The row ceiling ───────────────────────────────────────────────────────

  it('pages the STEP fetch past PostgREST\'s 1000-row ceiling', async () => {
    asAdmin();
    fakeDb.seed('automation_runs', [runRow()]);
    fakeDb.seed('automation_steps', Array.from({ length: 1500 }, () => stepRow()));

    const body = await (await GET(jsonRequest('/api/admin/automation-funnel?days=30', { method: 'GET', token }))).json();
    expect(body.stepRowsScanned).toBe(1500);
    expect(body.stores[0].steps.find((s: any) => s.step === 'add_click').total).toBe(1500);
  });

  it('pages the RUN fetch too — a busy month exceeds one page of runs as easily as steps', async () => {
    // The regression this test exists for: the runs query was a bare select with
    // no range, so a store with more than 1000 runs in the window reported
    // exactly 1000, silently, and every rate computed over it was wrong by an
    // amount nobody could see.
    asAdmin();
    fakeDb.seed('automation_runs', Array.from({ length: 1500 }, (_, i) =>
      runRow({ outcome: i % 2 === 0 ? 'success' : 'failed' })));
    fakeDb.seed('automation_steps', []);

    const body = await (await GET(jsonRequest('/api/admin/automation-funnel?days=30', { method: 'GET', token }))).json();
    expect(body.runRowsScanned).toBe(1500);
    expect(body.stores[0].runs).toBe(1500);
    expect(body.stores[0].terminalSuccessRate).toBe(0.5);
  });

  it('stops at exactly one page when the window holds exactly one page', async () => {
    // The off-by-one that turns a working pager into an infinite one: a full
    // final page must be followed by one more fetch, and an empty result ends it.
    asAdmin();
    fakeDb.seed('automation_runs', []);
    fakeDb.seed('automation_steps', Array.from({ length: DEFAULT_PAGE_ROWS }, () => stepRow()));

    const body = await (await GET(jsonRequest('/api/admin/automation-funnel?days=30', { method: 'GET', token }))).json();
    expect(body.stepRowsScanned).toBe(DEFAULT_PAGE_ROWS);
    expect(body.truncated).toBe(false);
  });

  it('reports truncated when the page cap is reached', async () => {
    asAdmin();
    fakeDb.queue('automation_runs', { data: [], error: null });
    // 50 consecutive full pages — the route's MAX_PAGES — with more behind them.
    const fullPage = Array.from({ length: DEFAULT_PAGE_ROWS }, () => stepRow());
    for (let i = 0; i < 50; i++) fakeDb.queue('automation_steps', { data: fullPage, error: null });

    const body = await (await GET(jsonRequest('/api/admin/automation-funnel?days=90', { method: 'GET', token }))).json();
    expect(body.truncated).toBe(true);
  });

  // ── MEAL-4: the code column has to be asked for ───────────────────────────

  it('selects the failure code and the timestamps the trend needs', async () => {
    // The server discarded `code` entirely until MEAL-2. If this select loses it
    // again the dashboard reports every failure as uncoded and looks fine doing it.
    asAdmin();
    fakeDb.seed('automation_runs', []);
    fakeDb.seed('automation_steps', []);
    await GET(jsonRequest('/api/admin/automation-funnel', { method: 'GET', token }));
    expect(selectFor('automation_steps')).toContain('code');
    expect(selectFor('automation_steps')).toContain('occurred_at');
    expect(selectFor('automation_runs')).toContain('started_at');
  });

  it('carries a null code through as an uncoded failure rather than dropping it', async () => {
    // Every row written before the column existed has a null code, and no
    // backfill can change that: steps upsert with ignoreDuplicates.
    asAdmin();
    fakeDb.seed('automation_runs', [runRow()]);
    fakeDb.seed('automation_steps', [stepRow({ step: 'confirm', outcome: 'timeout', code: null })]);

    const body = await (await GET(jsonRequest('/api/admin/automation-funnel', { method: 'GET', token }))).json();
    expect(body.stores[0].failureCodes).toEqual({ uncoded: 1 });
    expect(body.stores[0].coverage.uncodedFailures).toBe(1);
  });

  // ── Caveats hoisted to the top of the response ────────────────────────────

  it('lists stores whose funnel has no middle at all', async () => {
    // MEAL-122: the parallel add pool emits no per-item rows, so the funnel reads
    // perfect precisely because it is empty. The response says so at the top
    // level rather than leaving it buried per store.
    asAdmin();
    fakeDb.seed('automation_runs', [runRow({ store_id: 'heb' }), runRow({ store_id: 'kroger' })]);
    fakeDb.seed('automation_steps', [
      stepRow({ store_id: 'heb', step: 'login_check', outcome: 'ok' }),
      stepRow({ store_id: 'heb', step: 'reconcile', outcome: 'ok' }),
      stepRow({ store_id: 'kroger', step: 'search', outcome: 'ok' }),
      stepRow({ store_id: 'kroger', step: 'candidates', outcome: 'ok' }),
      stepRow({ store_id: 'kroger', step: 'add_click', outcome: 'ok' }),
      stepRow({ store_id: 'kroger', step: 'confirm', outcome: 'ok' }),
    ]);

    const body = await (await GET(jsonRequest('/api/admin/automation-funnel', { method: 'GET', token }))).json();
    expect(body.partialInstrumentation).toEqual(['heb']);
  });

  // ── Parameters ────────────────────────────────────────────────────────────

  it('filters both tables when storeId is given', async () => {
    asAdmin();
    fakeDb.seed('automation_runs', [runRow({ store_id: 'heb' }), runRow({ store_id: 'kroger' })]);
    fakeDb.seed('automation_steps', [stepRow({ store_id: 'heb' }), stepRow({ store_id: 'kroger' })]);

    const body = await (await GET(jsonRequest('/api/admin/automation-funnel?storeId=kroger', { method: 'GET', token }))).json();
    expect(body.stores.map((s: any) => s.storeId)).toEqual(['kroger']);
    expect(body.runRowsScanned).toBe(1);
  });

  it('excludes rows older than the window', async () => {
    asAdmin();
    fakeDb.seed('automation_runs', [runRow({ started_at: hoursAgo(2) }), runRow({ started_at: hoursAgo(24 * 40) })]);
    fakeDb.seed('automation_steps', []);

    const body = await (await GET(jsonRequest('/api/admin/automation-funnel?days=7', { method: 'GET', token }))).json();
    expect(body.runRowsScanned).toBe(1);
  });

  it('clamps an absurd day count and defaults a missing one to 30', async () => {
    asAdmin();
    fakeDb.seed('automation_runs', []);
    fakeDb.seed('automation_steps', []);
    const clamped = await (await GET(jsonRequest('/api/admin/automation-funnel?days=99999', { method: 'GET', token }))).json();
    expect(clamped.days).toBe(90);

    asAdmin();
    const defaulted = await (await GET(jsonRequest('/api/admin/automation-funnel?days=banana', { method: 'GET', token }))).json();
    // 30 by default so the trend line and the week-over-week both have a window.
    expect(defaulted.days).toBe(30);
  });

  it('500s rather than returning a partial funnel when a fetch errors', async () => {
    asAdmin();
    fakeDb.queue('automation_runs', { data: null, error: { message: 'db down' } });
    const res = await GET(jsonRequest('/api/admin/automation-funnel', { method: 'GET', token }));
    expect(res.status).toBe(500);
  });
});
