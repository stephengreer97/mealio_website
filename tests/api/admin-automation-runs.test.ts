import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeDb } from '../helpers/supabase-mock';
import { jsonRequest } from '../helpers/request';

vi.mock('@/lib/supabase', async () =>
  (await import('../helpers/supabase-mock')).mockSupabaseModule());
vi.mock('@/lib/logger', () => ({ log: vi.fn() }));

import { GET } from '@/app/api/admin/automation-runs/route';
import { clearRevocationCache, createAccessToken } from '@/lib/tokens';

// The way IN to a run trace (MEAL-143). Without this endpoint the drilldown is only
// usable by someone who already has a run id, which nobody does — the funnel deals
// in rates and a rate has no rows under it once computed.
//
// The design decision under test is WHICH TABLE the failing filter reads. It reads
// the RUN row, and the tests below are the argument: the parallel and pre-search add
// pools emit no step rows at all (MEAL-122), and an abandoned run has no failing
// step by definition, so a filter over `automation_steps` would hide exactly the
// runs someone is hunting.

function asAdmin(isAdmin = true) {
  clearRevocationCache();
  fakeDb.queue('user_profiles', { data: { tokens_invalidated_at: null } });
  fakeDb.queue('user_profiles', { data: { is_admin: isAdmin } });
}

const hoursAgo = (h: number) => new Date(Date.now() - h * 60 * 60 * 1000).toISOString();

let n = 0;
const runRow = (over: Record<string, unknown> = {}) => ({
  id: `run-${++n}`,
  store_id: 'heb',
  source: 'my_meals',
  status: 'completed',
  outcome: 'success',
  meal_count: 1,
  items_requested: 3,
  items_added: 3,
  started_at: hoursAgo(2),
  completed_at: hoursAgo(2),
  config_version: 12,
  app_version: '1.4.0',
  platform: 'ios',
  user_id: 'shopper-1',
  ...over,
});

const list = (query = '', token?: string) =>
  GET(jsonRequest(`/api/admin/automation-runs${query}`, { method: 'GET', token }));

const ids = (body: any) => body.runs.map((r: any) => r.id);

describe('GET /api/admin/automation-runs', () => {
  let token: string;

  beforeEach(async () => {
    fakeDb.reset();
    n = 0;
    token = await createAccessToken('admin-1', 'admin@mealio.test');
  });

  it('403s a non-admin', async () => {
    asAdmin(false);
    fakeDb.seed('automation_runs', [runRow()]);
    const res = await list('', token);
    expect(res.status).toBe(403);
    expect(fakeDb.calls.some((c) => c.table === 'automation_runs')).toBe(false);
  });

  it('403s with no token', async () => {
    expect((await list()).status).toBe(403);
  });

  // ── What "failing" means ──────────────────────────────────────────────────

  it('lists the three ways a run is not a clean success and skips the clean one', async () => {
    asAdmin();
    fakeDb.seed('automation_runs', [
      runRow({ id: 'clean', outcome: 'success', status: 'completed' }),
      runRow({ id: 'failed', outcome: 'failed' }),
      runRow({ id: 'abandoned', status: 'started', outcome: null }),
      // Finished, but never wrote an outcome. The subtle one — see below.
      runRow({ id: 'no-outcome', status: 'completed', outcome: null }),
    ]);

    const body = await (await list('', token)).json();
    expect(ids(body).sort()).toEqual(['abandoned', 'failed', 'no-outcome']);
  });

  it('includes a run whose outcome is NULL — `outcome <> success` alone drops it', async () => {
    // Postgres three-valued logic: `outcome <> 'success'` over a NULL outcome is
    // NULL, not TRUE, so the row is DROPPED by the predicate meant to find it. The
    // `outcome.is.null` term is what puts it back, and the supabase test double
    // models this correctly — which is how the omission was caught here rather
    // than shipped as a filter that silently hid every hard crash.
    asAdmin();
    fakeDb.seed('automation_runs', [runRow({ id: 'crashed', status: 'completed', outcome: null })]);

    const body = await (await list('', token)).json();
    expect(ids(body)).toEqual(['crashed']);
  });

  it('finds an abandoned run, which has no failing step to find it by', async () => {
    // The load-bearing case for filtering on the run row. `status = started` means
    // the run never reported finishing — the app was killed or the engine wedged —
    // so there is no non-ok step row anywhere. A step-based filter cannot see it.
    asAdmin();
    fakeDb.seed('automation_runs', [runRow({ id: 'wedged', status: 'started', outcome: null })]);
    fakeDb.seed('automation_steps', [
      { run_id: 'wedged', store_id: 'heb', seq: 1, step: 'login_check', outcome: 'ok' },
    ]);

    const body = await (await list('', token)).json();
    expect(ids(body)).toEqual(['wedged']);
    expect(body.runs[0].concern).toMatchObject({ abandoned: true, clean: false });
    // The step table is not consulted at all.
    expect(fakeDb.calls.some((c) => c.table === 'automation_steps')).toBe(false);
  });

  it('finds a failing run at a store that reports no steps at all (MEAL-122)', async () => {
    asAdmin();
    fakeDb.seed('automation_runs', [runRow({ id: 'heb-fail', store_id: 'heb', outcome: 'failed' })]);
    fakeDb.seed('automation_steps', []);

    const body = await (await list('?storeId=heb', token)).json();
    expect(ids(body)).toEqual(['heb-fail']);
    expect(body.caveats.join(' ')).toMatch(/MEAL-122/);
  });

  it('flags a success that added fewer items than requested, and admits it is not filtered on', async () => {
    // PostgREST cannot compare two columns, so `items_added < items_requested` is
    // computed per row rather than filtered on. A store whose partial adds all
    // report success would be invisible in the failing list, so the response says
    // so instead of leaving someone to discover it.
    asAdmin();
    fakeDb.seed('automation_runs', [
      runRow({ id: 'partial', outcome: 'success', items_requested: 4, items_added: 2 }),
    ]);

    const failing = await (await list('', token)).json();
    expect(ids(failing)).toEqual([]);
    expect(failing.caveats.join(' ')).toMatch(/partialAdds/);

    asAdmin();
    const all = await (await list('?filter=all', token)).json();
    expect(all.runs[0].concern).toMatchObject({ partialAdds: true, failed: false, clean: false });
  });

  it('filter=all lists clean runs too — a good trace is the control case', async () => {
    asAdmin();
    fakeDb.seed('automation_runs', [runRow({ id: 'clean' }), runRow({ id: 'failed', outcome: 'failed' })]);

    const body = await (await list('?filter=all', token)).json();
    expect(ids(body).sort()).toEqual(['clean', 'failed']);
    expect(body.filter).toBe('all');
  });

  // ── Scoping and bounds ────────────────────────────────────────────────────

  it('scopes to one store, which is how someone arrives from the funnel', async () => {
    asAdmin();
    fakeDb.seed('automation_runs', [
      runRow({ id: 'heb-1', store_id: 'heb', outcome: 'failed' }),
      runRow({ id: 'kroger-1', store_id: 'kroger', outcome: 'failed' }),
    ]);

    const body = await (await list('?storeId=heb', token)).json();
    expect(ids(body)).toEqual(['heb-1']);
    expect(body.storeId).toBe('heb');
  });

  it('excludes runs older than the window and newest-first inside it', async () => {
    asAdmin();
    fakeDb.seed('automation_runs', [
      runRow({ id: 'old', outcome: 'failed', started_at: hoursAgo(24 * 40) }),
      runRow({ id: 'older-recent', outcome: 'failed', started_at: hoursAgo(30) }),
      runRow({ id: 'newest', outcome: 'failed', started_at: hoursAgo(1) }),
    ]);

    const body = await (await list('?days=7', token)).json();
    expect(ids(body)).toEqual(['newest', 'older-recent']);
    expect(body.days).toBe(7);
  });

  it('bounds the list and says when there is more behind it', async () => {
    // The list is a picker, not an export. "The 20 most recent failures" read as
    // "the failures" is the family of bug this codebase keeps finding, so a full
    // page is reported rather than left implicit.
    asAdmin();
    fakeDb.seed('automation_runs', Array.from({ length: 30 }, () => runRow({ outcome: 'failed' })));

    const body = await (await list('?limit=20', token)).json();
    expect(body.runs).toHaveLength(20);
    expect(body.listMaybeTruncated).toBe(true);
    expect(body.caveats.join(' ')).toMatch(/20 most recent/);

    asAdmin();
    const roomy = await (await list('?limit=100', token)).json();
    expect(roomy.runs).toHaveLength(30);
    expect(roomy.listMaybeTruncated).toBe(false);
  });

  it('clamps the limit and the window rather than trusting the query string', async () => {
    // A limit above db-max-rows would be a bound that binds nothing.
    asAdmin();
    fakeDb.seed('automation_runs', []);
    const wild = await (await list('?limit=99999&days=99999', token)).json();
    expect(wild.limit).toBe(200);
    expect(wild.days).toBe(90);

    asAdmin();
    const junk = await (await list('?limit=banana&days=banana', token)).json();
    expect(junk.limit).toBe(50);
    expect(junk.days).toBe(7);
  });

  it('does not hand back the shopper behind the run', async () => {
    asAdmin();
    fakeDb.seed('automation_runs', [runRow({ outcome: 'failed' })]);
    const body = await (await list('', token)).json();
    expect(body.runs[0].user_id).toBeUndefined();
    const select = String(fakeDb.calls.find((c) => c.table === 'automation_runs' && c.method === 'select')?.args[0]);
    expect(select).not.toContain('user_id');
    // The columns that make a list actionable before any trace is opened.
    for (const column of ['id', 'store_id', 'status', 'outcome', 'items_requested', 'items_added', 'config_version', 'app_version']) {
      expect(select, `run select is missing ${column}`).toContain(column);
    }
  });

  it('500s rather than returning a partial list when the read errors', async () => {
    asAdmin();
    fakeDb.queue('automation_runs', { data: null, error: { message: 'db down' } });
    expect((await list('', token)).status).toBe(500);
  });
});
