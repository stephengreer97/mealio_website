import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeDb } from '../helpers/supabase-mock';
import { jsonRequest } from '../helpers/request';

vi.mock('@/lib/supabase', async () =>
  (await import('../helpers/supabase-mock')).mockSupabaseModule());
vi.mock('@/lib/logger', () => ({ log: vi.fn() }));

import { POST } from '@/app/api/creator/sync/route';
import { CREATOR_DAILY_IMPORT_CAP, CREATOR_DAILY_SPEND_CAP_USD } from '@/lib/import/creator-budget';
import { createAccessToken } from '@/lib/tokens';

/**
 * Review finding 6: a creator could start import runs with no ceiling. One run
 * at a time, a daily cap in imports and dollars read off `recipe_imports`, and a
 * post the gate already refused is only read again when it was ticked on
 * purpose. Asserted on what the route stored, because the run row is what the
 * worker will spend money on.
 */

const CREATOR = {
  id: 'c1',
  user_id: 'user-1',
  display_name: 'Chef Sarah',
  website_url: 'https://chefsarah.test/',
  youtube_url: null,
  instagram_url: null,
  tiktok_url: null,
  feed_url: 'https://chefsarah.test/feed',
};

const post = (n: number, extra: Record<string, unknown> = {}) => ({
  itemId: `chefsarah.test/post-${n}`,
  url: `https://chefsarah.test/post-${n}`,
  title: `Recipe ${n}`,
  publishedAt: null,
  ...extra,
});

/** `n` recent import attempts for c1, each costing `cost`. */
function recentImports(n: number, cost = 0.01) {
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    creator_id: 'c1',
    occurred_at: new Date(Date.now() - 60_000).toISOString(),
    total_cost_usd: cost,
  }));
}

describe('POST /api/creator/sync — what one creator can start', () => {
  let token: string;

  beforeEach(async () => {
    fakeDb.reset();
    fakeDb.seed('creators', [CREATOR]);
    fakeDb.seed('creator_sync_runs', []);
    fakeDb.seed('creator_source_items', []);
    fakeDb.seed('recipe_imports', []);
    token = await createAccessToken('user-1', 'sarah@chefsarah.test');
  });

  const start = (items: unknown[]) =>
    POST(jsonRequest('/api/creator/sync', { token, body: { source: 'website', items } }));

  it('starts a run when nothing is in the way', async () => {
    const res = await start([post(1), post(2)]);
    expect(res.status).toBe(201);
    expect(fakeDb.rows('creator_sync_runs')).toHaveLength(1);
  });

  it('refuses a second run while one is under way, and hands the first one back', async () => {
    fakeDb.seed('creator_sync_runs', [{
      id: 'r-open', creator_id: 'c1', source: 'website', mode: 'catalog', status: 'queued',
      items: [], created_at: '2027-01-01T00:00:00.000Z',
    }]);

    const res = await start([post(1)]);

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.run.id).toBe('r-open');
    expect(fakeDb.rows('creator_sync_runs')).toHaveLength(1);
  });

  it('does not pay to re-read a post the gate refused unless it was ticked on purpose', async () => {
    fakeDb.seed('creator_source_items', [
      { creator_id: 'c1', source: 'website', item_id: 'chefsarah.test/post-1', status: 'rejected' },
      { creator_id: 'c1', source: 'website', item_id: 'chefsarah.test/post-2', status: 'rejected' },
    ]);

    const res = await start([post(1), post(2, { reselect: true }), post(3)]);

    expect(res.status).toBe(201);
    const stored = fakeDb.rows('creator_sync_runs')[0].items.map((item: { itemId: string }) => item.itemId);
    expect(stored).toEqual(['chefsarah.test/post-2', 'chefsarah.test/post-3']);
  });

  it('refuses a selection past the daily import cap, and says how many are left', async () => {
    fakeDb.seed('recipe_imports', recentImports(CREATOR_DAILY_IMPORT_CAP - 1));

    const res = await start([post(1), post(2)]);

    expect(res.status).toBe(429);
    expect((await res.json()).error).toMatch(/1 of today/);
    expect(fakeDb.rows('creator_sync_runs')).toHaveLength(0);
  });

  it('refuses once the day’s spend is used up, however few items are asked for', async () => {
    fakeDb.seed('recipe_imports', recentImports(2, CREATOR_DAILY_SPEND_CAP_USD / 2));

    const res = await start([post(1)]);

    expect(res.status).toBe(429);
    expect(fakeDb.rows('creator_sync_runs')).toHaveLength(0);
  });

  it('does not count yesterday against today', async () => {
    fakeDb.seed('recipe_imports', recentImports(CREATOR_DAILY_IMPORT_CAP).map((row) => ({
      ...row,
      occurred_at: new Date(Date.now() - 25 * 3_600_000).toISOString(),
    })));

    const res = await start([post(1)]);
    expect(res.status).toBe(201);
  });
});
