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

  // ── Partial adds, before and after the migration ──────────────────────────
  //
  // A `success` that added fewer items than requested is a failure — a selector
  // regression that drops one item per basket looks exactly like it — and PostgREST
  // cannot express it, because it compares a column to a value and never to another
  // column. `partial_adds`, the generated column in this branch's migration, is the
  // only cheap way to filter on it. Only Stephen can apply a migration, so both
  // worlds have to work: post-migration the rows are FOUND, pre-migration the route
  // degrades to computing the flag per row and says the gap is there.

  /** What PostgREST answers a filter over a column the database does not have. */
  const UNDEFINED_COLUMN = {
    data: null,
    count: null,
    error: { code: '42703', message: 'column automation_runs.partial_adds does not exist' },
  };

  const orPredicates = () =>
    fakeDb.calls.filter((c) => c.table === 'automation_runs' && c.method === 'or').map((c) => String(c.args[0]));

  it('finds a success that added fewer items than requested, once partial_adds exists', async () => {
    // The regression the empty failing list used to hide entirely: every run at the
    // store reports success and adds one fewer item than it was asked for.
    asAdmin();
    fakeDb.seed('automation_runs', [
      runRow({ id: 'clean', outcome: 'success', items_requested: 4, items_added: 4, partial_adds: null }),
      runRow({ id: 'partial', outcome: 'success', items_requested: 4, items_added: 3, partial_adds: true }),
    ]);

    const body = await (await list('', token)).json();
    expect(ids(body)).toEqual(['partial']);
    expect(body.partialAddsFiltered).toBe(true);
    expect(body.runs[0].concern).toMatchObject({ partialAdds: true, failed: false, clean: false });
    // Filtered server-side, so nothing tells the operator to go and look elsewhere.
    expect(body.caveats.join(' ')).not.toMatch(/filter=all/);
    expect(orPredicates()[0]).toContain('partial_adds.is.true');
  });

  it('degrades to the per-row flag and says so when partial_adds is not applied yet', async () => {
    // The pre-migration database. A 42703 must not 500 the whole list — the other
    // three ways a run is not clean are still findable, and only Stephen can apply
    // the column.
    asAdmin();
    fakeDb.queue('automation_runs', UNDEFINED_COLUMN);
    fakeDb.seed('automation_runs', [
      runRow({ id: 'failed', outcome: 'failed' }),
      runRow({ id: 'partial', outcome: 'success', items_requested: 4, items_added: 2 }),
    ]);

    const res = await list('', token);
    expect(res.status).toBe(200);
    const body = await res.json();
    // Still finds everything today's filter finds.
    expect(ids(body)).toEqual(['failed']);
    expect(body.partialAddsFiltered).toBe(false);
    // And admits the one it cannot, rather than leaving an empty list to be read as
    // "nothing is wrong".
    expect(body.caveats.join(' ')).toMatch(/partialAdds/);
    expect(body.caveats.join(' ')).toMatch(/filter=all/);
    // Retried WITHOUT the term, not with it.
    const predicates = orPredicates();
    expect(predicates).toHaveLength(2);
    expect(predicates[0]).toContain('partial_adds.is.true');
    expect(predicates[1]).not.toContain('partial_adds');
    expect(predicates[1]).toBe('status.eq.started,outcome.is.null,outcome.neq.success');
  });

  it('still flags partialAdds per row under filter=all, either way', async () => {
    asAdmin();
    fakeDb.seed('automation_runs', [
      runRow({ id: 'partial', outcome: 'success', items_requested: 4, items_added: 2 }),
    ]);
    const all = await (await list('?filter=all', token)).json();
    expect(all.runs[0].concern).toMatchObject({ partialAdds: true, failed: false, clean: false });
    // No predicate at all on filter=all, so the missing column cannot bite here.
    expect(orPredicates()).toHaveLength(0);
  });

  it('500s on a column error that is not partial_adds rather than retrying blind', async () => {
    asAdmin();
    fakeDb.queue('automation_runs', {
      data: null, count: null, error: { message: 'permission denied for table automation_runs' },
    });
    fakeDb.seed('automation_runs', [runRow({ outcome: 'failed' })]);
    expect((await list('', token)).status).toBe(500);
    // One attempt. A retry here would turn an authorisation failure into a list.
    expect(orPredicates()).toHaveLength(1);
  });

  // ── In flight is not abandoned ────────────────────────────────────────────

  it('calls a run that started seconds ago RUNNING, not abandoned', async () => {
    // The list is newest-first, so in-flight runs are the FIRST rows on screen.
    // Badging them abandoned reads as an engine wedging under load, and every one of
    // them finishes a minute later.
    asAdmin();
    fakeDb.seed('automation_runs', [
      runRow({ id: 'in-flight', status: 'started', outcome: null, completed_at: null, started_at: hoursAgo(0) }),
      runRow({ id: 'wedged', status: 'started', outcome: null, completed_at: null, started_at: hoursAgo(3) }),
    ]);

    const body = await (await list('', token)).json();
    expect(ids(body)).toEqual(['in-flight', 'wedged']);
    const byId = Object.fromEntries(body.runs.map((r: any) => [r.id, r.concern]));
    expect(byId['in-flight']).toMatchObject({ running: true, abandoned: false, clean: false });
    expect(byId['wedged']).toMatchObject({ running: false, abandoned: true, clean: false });
    // Counted and named, because they sort to the top.
    expect(body.inFlight).toBe(1);
    expect(body.caveats.join(' ')).toMatch(/IN FLIGHT/);
  });

  it('says nothing about in-flight runs when there are none', async () => {
    asAdmin();
    fakeDb.seed('automation_runs', [runRow({ id: 'wedged', status: 'started', outcome: null, started_at: hoursAgo(3) })]);
    const body = await (await list('', token)).json();
    expect(body.inFlight).toBe(0);
    expect(body.caveats.join(' ')).not.toMatch(/IN FLIGHT/);
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
