import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeDb, DEFAULT_PAGE_ROWS } from '../helpers/supabase-mock';
import { jsonRequest } from '../helpers/request';

// vi.mock is hoisted above imports, so the factory must import the helper
// dynamically rather than close over the static import.
vi.mock('@/lib/supabase', async () =>
  (await import('../helpers/supabase-mock')).mockSupabaseModule());
vi.mock('@/lib/logger', () => ({ log: vi.fn() }));

import { GET } from '@/app/api/admin/email-stats/route';
import { clearRevocationCache, createAccessToken } from '@/lib/tokens';

/**
 * Queues the two `user_profiles` reads one admin request makes: the token
 * revocation check (memoised for 30s, hence the cache clear) and `is_admin`.
 */
function asAdmin(isAdmin = true) {
  clearRevocationCache();
  fakeDb.queue('user_profiles', { data: { tokens_invalidated_at: null } });
  fakeDb.queue('user_profiles', { data: { is_admin: isAdmin } });
}

/**
 * `n` sends of one campaign, `opened` of them opened and `clicked` clicked.
 *
 * The opened rows are the LAST ones by id, which is the detail that makes this a
 * test of the bug rather than of the arithmetic. An unbounded select returns the
 * front of the table, so putting the opens at the back means a truncated read does
 * not merely undercount them — it reports an open rate of zero for a campaign
 * half of whose recipients opened it.
 */
function seedSends(n: number, opened: number, clicked: number) {
  const rows = Array.from({ length: n }, (_, i) => ({
    id: `s-${String(i).padStart(6, '0')}`,
    type: 'user_upsell_1',
    status: 'delivered',
    opened_at: i >= n - opened ? '2026-08-01T00:00:00.000Z' : null,
    clicked_at: i >= n - clicked ? '2026-08-01T00:00:00.000Z' : null,
  }));
  fakeDb.seed('email_sends', rows);
  fakeDb.seed('user_profiles', []);
  return rows;
}

describe('/api/admin/email-stats', () => {
  let token: string;

  beforeEach(async () => {
    fakeDb.reset();
    token = await createAccessToken('admin-1', 'admin@mealio.co');
  });

  it('403 for a non-admin', async () => {
    asAdmin(false);
    const res = await GET(jsonRequest('/api/admin/email-stats', { method: 'GET', token }));
    expect(res.status).toBe(403);
  });

  it('reports a small campaign exactly, and says nothing was truncated', async () => {
    asAdmin();
    seedSends(10, 4, 2);

    const body = await (await GET(jsonRequest('/api/admin/email-stats', { method: 'GET', token }))).json();

    expect(body.totals.totalSent).toBe(10);
    expect(body.campaigns).toHaveLength(1);
    expect(body.campaigns[0]).toMatchObject({ sent: 10, delivered: 10, opened: 4, clicked: 2, openRate: 40, clickRate: 20 });
    expect(body.incomplete).toEqual([]);
  });

  /**
   * MEAL-128. Every funnel figure was computed over at most 1000 rows, because
   * PostgREST caps an unbounded select at `db-max-rows` and says nothing about it.
   *
   * Measured at 1500 seeded sends: `totalSent` came back 1000. The rates were
   * worse than merely undercounted — membership of the surviving 1000 is decided by
   * physical row order, so they were computed over a biased slice, and the same
   * request could answer differently twice with neither answer admitting it was
   * partial.
   */
  describe(`past the ${DEFAULT_PAGE_ROWS}-row page ceiling`, () => {
    const SENDS = 1500;

    it(`counts all ${SENDS} sends, not ${DEFAULT_PAGE_ROWS}`, async () => {
      asAdmin();
      seedSends(SENDS, 600, 300);

      const body = await (await GET(jsonRequest('/api/admin/email-stats', { method: 'GET', token }))).json();

      // The exact number from the ticket, and the one the operator reads first.
      expect(body.totals.totalSent).toBe(SENDS);
      expect(body.incomplete).toEqual([]);
    });

    it('computes the open and click rates over every send, not the front of the table', async () => {
      asAdmin();
      seedSends(SENDS, 600, 300);

      const body = await (await GET(jsonRequest('/api/admin/email-stats', { method: 'GET', token }))).json();

      expect(body.campaigns).toHaveLength(1);
      // 600/1500 and 300/1500. Under the bug both were 0: the opened rows are the
      // last 600 by id, and a capped read never reached them.
      expect(body.campaigns[0]).toMatchObject({
        sent: SENDS, delivered: SENDS, opened: 600, clicked: 300, openRate: 40, clickRate: 20,
      });
    });

    it('asks Postgres for the total rather than measuring an array', async () => {
      asAdmin();
      seedSends(SENDS, 600, 300);

      await GET(jsonRequest('/api/admin/email-stats', { method: 'GET', token }));

      // `db-max-rows` caps rows, not the count in `Content-Range` — so a count is
      // exact however big the table gets, and cheaper than shipping every row to
      // Node to call `.length` on it.
      const headCount = fakeDb.calls.find(
        (c) => c.table === 'email_sends' && c.method === 'select'
          && c.args[1]?.count === 'exact' && c.args[1]?.head === true,
      );
      expect(headCount).toBeDefined();
    });

    it('counts only the statuses that were actually handed to Resend', async () => {
      asAdmin();
      // 1200 attempted, 300 skipped. The headline is "emails sent", so a suppressed
      // or errored row must not inflate it — and the count now happens in SQL, so
      // the status filter has to go with it.
      const rows = Array.from({ length: SENDS }, (_, i) => ({
        id: `s-${String(i).padStart(6, '0')}`,
        type: 'user_upsell_1',
        status: i < 1200 ? 'delivered' : 'suppressed',
        opened_at: null,
        clicked_at: null,
      }));
      fakeDb.seed('email_sends', rows);
      fakeDb.seed('user_profiles', []);

      const body = await (await GET(jsonRequest('/api/admin/email-stats', { method: 'GET', token }))).json();

      expect(body.totals.totalSent).toBe(1200);
      expect(body.campaigns[0]).toMatchObject({ sent: 1200, suppressed: 300 });
    });
  });

  it('withholds the funnel rather than showing a partial one', async () => {
    asAdmin();
    seedSends(10, 4, 2);
    // The row walk fails on its first page. A read that could not be completed must
    // not be presentable as a completed one, so the campaigns come back `null` —
    // not `[]`, which would mean "no campaign has ever sent" — and `incomplete`
    // names what is missing.
    fakeDb.queue('email_sends', { data: null, count: 1500 }); // the head count still works
    fakeDb.queue('email_sends', { data: null, error: { message: 'boom' } });

    const body = await (await GET(jsonRequest('/api/admin/email-stats', { method: 'GET', token }))).json();

    expect(body.campaigns).toBeNull();
    expect(body.incomplete).toContain('campaigns');
  });
});
