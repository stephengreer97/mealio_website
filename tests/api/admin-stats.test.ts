import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeDb, DEFAULT_PAGE_ROWS } from '../helpers/supabase-mock';
import { jsonRequest } from '../helpers/request';

// vi.mock is hoisted above imports, so the factory must import the helper
// dynamically rather than close over the static import.
vi.mock('@/lib/supabase', async () =>
  (await import('../helpers/supabase-mock')).mockSupabaseModule());
vi.mock('@/lib/logger', () => ({ log: vi.fn() }));

import { GET } from '@/app/api/admin/stats/route';
import { clearRevocationCache, createAccessToken } from '@/lib/tokens';

// The admin stats screen, and specifically MEAL-127.
//
// Every number here is read out by a human, and the profit-share leaderboard is
// read out to decide what creators get PAID. The route used to select
// `preset_meal_saves` and `subscription_events` with no `.limit()` and fold the
// result in memory, which PostgREST answers with an arbitrary, unordered 1000 rows
// and no indication that it truncated — so a creator whose saves sat past the cut
// was silently under-credited, and the cut moved with physical row order.
//
// So the assertions below are deliberately sized PAST the ceiling the fake models
// (`DEFAULT_PAGE_ROWS`). A test seeding 900 rows passes against the broken code and
// proves nothing; 1500 is the smallest seed that can tell the two apart.

/**
 * Queues the two `user_profiles` reads one admin request makes: the token
 * revocation check (memoised for 30s, hence the cache clear) and `is_admin`.
 */
function asAdmin(isAdmin = true) {
  clearRevocationCache();
  fakeDb.queue('user_profiles', { data: { tokens_invalidated_at: null } });
  fakeDb.queue('user_profiles', { data: { is_admin: isAdmin } });
}

const SARAH = { id: 'c1', display_name: 'Chef Sarah' };
const DEV   = { id: 'c2', display_name: 'Chef Dev' };

/** Now, and a moment that is inside every window the route asks about. */
const nowIso = () => new Date().toISOString();
const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();

/**
 * One save row shaped like the embed the route selects.
 *
 * Ids are zero-padded so `.order('id')` is a stable, meaningful order — the same
 * property the paged read depends on, and the reason a truncated read takes an
 * interleaved slice of both creators rather than all of one.
 */
function save(i: number, creator: { id: string; display_name: string }, savedAt = nowIso()) {
  return {
    id: `save-${String(i).padStart(5, '0')}`,
    saved_at: savedAt,
    preset_meals: { creator_id: creator.id, creators: creator },
  };
}

/**
 * 1500 in-window saves: 1000 for Sarah, 500 for Dev, interleaved.
 *
 * The interleaving is the point. An unbounded read stops after
 * `DEFAULT_PAGE_ROWS`, which here is the first 1000 rows by id — 666 of Sarah's
 * and 334 of Dev's. Both creators still appear and both counts still look like
 * plausible numbers, which is exactly why the bug survived: nothing about
 * "Sarah 666 / 66.6%" says it is wrong.
 */
function seedFifteenHundredSaves() {
  const rows = [];
  for (let i = 0; i < 1500; i++) rows.push(save(i, i % 3 === 0 ? DEV : SARAH));
  fakeDb.seed('preset_meal_saves', rows);
  return rows;
}

type Body = {
  totals: Record<string, number | null>;
  incomplete: string[];
  leaderboard: { name: string; annualSaves: number; sharePercent: number }[] | null;
};

async function getStats(token: string, query = ''): Promise<Body> {
  const res = await GET(jsonRequest(`/api/admin/stats${query}`, { method: 'GET', token }));
  expect(res.status).toBe(200);
  return res.json();
}

describe('GET /api/admin/stats', () => {
  let token: string;

  beforeEach(async () => {
    fakeDb.reset();
    token = await createAccessToken('admin-1', 'admin@mealio.co');
  });

  it('403 for a non-admin', async () => {
    asAdmin(false);
    const res = await GET(jsonRequest('/api/admin/stats', { method: 'GET', token }));
    expect(res.status).toBe(403);
  });

  it('counts every creator save past the 1000-row page ceiling', async () => {
    asAdmin();
    seedFifteenHundredSaves();

    const body = await getStats(token);

    // The regression, stated as the review measured it: 1500 saves exist, and the
    // broken route reported 1000 of them.
    expect(body.totals.totalCreatorAnnualSaves).toBe(1500);
    expect(body.totals.totalCreatorAnnualSaves).toBeGreaterThan(DEFAULT_PAGE_ROWS);

    const rows = body.leaderboard!;
    expect(rows.map(r => [r.name, r.annualSaves])).toEqual([
      ['Chef Sarah', 1000],
      ['Chef Dev', 500],
    ]);

    // And the shares — the actual payout figure — are shares of the real pool,
    // not of the truncated one.
    expect(rows[0].sharePercent).toBeCloseTo(66.7, 1);
    expect(rows[1].sharePercent).toBeCloseTo(33.3, 1);
    expect(body.incomplete).toEqual([]);
  });

  it('reads the saves ordered and paged rather than in one unbounded select', async () => {
    asAdmin();
    seedFifteenHundredSaves();
    await getStats(token);

    const calls = fakeDb.calls.filter(c => c.table === 'preset_meal_saves');
    // An OFFSET walk with no ORDER BY may repeat one row and skip another, which
    // for a set of counters is wrong in both directions at once.
    expect(calls.some(c => c.method === 'order')).toBe(true);
    // 1500 rows is two pages, and the second one being short is what ends the loop.
    expect(calls.filter(c => c.method === 'range')).toHaveLength(2);
  });

  it('excludes saves older than the rolling 12-month window', async () => {
    asAdmin();
    fakeDb.seed('preset_meal_saves', [
      save(1, SARAH, daysAgo(10)),
      save(2, SARAH, daysAgo(400)),
      save(3, DEV, daysAgo(366)),
    ]);

    const body = await getStats(token);
    expect(body.totals.totalCreatorAnnualSaves).toBe(1);
    expect(body.leaderboard).toEqual([
      { name: 'Chef Sarah', annualSaves: 1, sharePercent: 100 },
    ]);
  });

  it('counts subscription events past the ceiling, without materializing them', async () => {
    asAdmin();
    const events = [];
    for (let i = 0; i < 1200; i++) events.push({ id: `e-s-${i}`, event: 'started', created_at: nowIso() });
    for (let i = 0; i < 1100; i++) events.push({ id: `e-c-${i}`, event: 'cancelled', created_at: nowIso() });
    fakeDb.seed('subscription_events', events);

    const body = await getStats(token);

    expect(body.totals.subsStartedAll).toBe(1200);
    expect(body.totals.subsCancelledAll).toBe(1100);
    expect(body.totals.subsStarted30d).toBe(1200);
    expect(body.totals.subsCancelled30d).toBe(1100);
    expect(body.totals.netNewPaidAll).toBe(100);
    expect(body.incomplete).toEqual([]);

    // Postgres does the counting: `{ count: 'exact', head: true }` is not capped by
    // `db-max-rows` — that caps the ROWS in a response, not the number in
    // Content-Range — and it does not ship 2300 rows to Node to call .length on.
    const selects = fakeDb.calls.filter(c => c.table === 'subscription_events' && c.method === 'select');
    expect(selects.length).toBeGreaterThan(0);
    for (const call of selects) {
      expect(call.args[1]).toMatchObject({ count: 'exact', head: true });
    }
  });

  it('withholds the leaderboard instead of reporting a short read', async () => {
    asAdmin();
    seedFifteenHundredSaves();
    // A failed page: the rows fetched so far are a fraction of the truth.
    fakeDb.queue('preset_meal_saves', { data: null, error: { message: 'connection reset' } });

    const body = await getStats(token);

    // Null, not `[]` and not a smaller number: an empty leaderboard means "no
    // creator saves", which is a different and equally actionable answer.
    expect(body.leaderboard).toBeNull();
    expect(body.totals.totalCreatorAnnualSaves).toBeNull();
    expect(body.incomplete).toContain('creatorSaves');
  });

  it('withholds a subscription figure whose count failed', async () => {
    asAdmin();
    fakeDb.seed('subscription_events', [{ id: 'e1', event: 'started', created_at: nowIso() }]);
    // The first count the route issues is started-in-30d.
    fakeDb.queue('subscription_events', { data: null, count: null, error: { message: 'timeout' } });

    const body = await getStats(token);

    expect(body.totals.subsStarted30d).toBeNull();
    // A net built on an unknown is unknown, not zero.
    expect(body.totals.netNewPaid30d).toBeNull();
    expect(body.incomplete).toContain('subscriptionEvents');
    // The reads that did succeed are still reported.
    expect(body.totals.subsStartedAll).toBe(1);
  });
});
