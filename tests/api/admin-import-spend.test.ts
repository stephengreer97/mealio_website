// The read side of MEAL-222. The aggregation itself is unit-tested in
// tests/lib/import-spend.test.ts; what is tested HERE is the route, which has
// two ways to be badly wrong and neither is arithmetic.
//
//   1. It is an ADMIN endpoint over every creator's URLs and what we spent.
//   2. The table is new, so the likeliest failure in the field is that the
//      migration has not been run. A 500 renders as "something broke"; the
//      answer is one SQL file away and the message should say which.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeDb } from '../helpers/supabase-mock';
import { jsonRequest } from '../helpers/request';

vi.mock('@/lib/supabase', async () =>
  (await import('../helpers/supabase-mock')).mockSupabaseModule());
vi.mock('@/lib/logger', () => ({ log: vi.fn() }));

import { GET } from '@/app/api/admin/import-spend/route';
import { clearRevocationCache, createAccessToken } from '@/lib/tokens';

const ADMIN = 'admin-1';
let token: string;

const row = (over: Record<string, unknown> = {}) => ({
  id: Math.floor(Math.random() * 1e9),
  occurred_at: new Date().toISOString(),
  actor: 'creator',
  outcome: 'ok',
  stage: 'complete',
  cached: false,
  gate_cost_usd: '0.0031',
  extract_cost_usd: '0.0123',
  total_cost_usd: '0.0154',
  gate_input_tokens: 2500,
  gate_output_tokens: 120,
  extract_input_tokens: 6000,
  extract_output_tokens: 1350,
  ...over,
});

/**
 * requireAdmin makes TWO reads of user_profiles -- the revocation check, then
 * the flag -- so both are queued, in that order. Queueing one leaves the second
 * read answering from an empty table, which reads as "not an admin" and makes
 * every test below a 403 for the wrong reason.
 */
function asAdmin(isAdmin = true) {
  clearRevocationCache();
  fakeDb.queue('user_profiles', { data: { tokens_invalidated_at: null } });
  fakeDb.queue('user_profiles', { data: { is_admin: isAdmin } });
}

beforeEach(async () => {
  fakeDb.reset();
  fakeDb.seed('recipe_imports', []);
  token = await createAccessToken(ADMIN, 'a@b.co');
});

const call = (qs = '') => {
  asAdmin();
  return GET(jsonRequest(`/api/admin/import-spend${qs}`, { method: 'GET', token }) as never);
};

describe('who can read it', () => {
  it('refuses a request with no token', async () => {
    const res = await GET(jsonRequest('/api/admin/import-spend', { method: 'GET' }) as never);
    expect(res.status).toBe(403);
  });

  it('refuses a signed-in non-admin', async () => {
    // Every creator's URLs and what we spent on them. Being logged in is not
    // the bar for that.
    asAdmin(false);
    const res = await GET(jsonRequest('/api/admin/import-spend', { method: 'GET', token }) as never);
    expect(res.status).toBe(403);
  });
});

describe('what it answers', () => {
  it('splits the window by actor', async () => {
    fakeDb.seed('recipe_imports', [
      row({ actor: 'creator' }), row({ actor: 'creator' }), row({ actor: 'user' }),
    ]);
    const res = await call('?days=30');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total.imports).toBe(3);
    expect(body.byActor.creator.imports).toBe(2);
    expect(body.byActor.user.imports).toBe(1);
  });

  it('carries the median token shape, which is what checks the estimate', async () => {
    fakeDb.seed('recipe_imports', [
      row({ extract_input_tokens: 6000 }), row({ extract_input_tokens: 6200 }),
    ]);
    const body = await (await call()).json();
    expect(body.total.medianTokens.extractInput).toBe(6100);
  });

  it('answers an empty window with zeroes rather than an error', async () => {
    const body = await (await call()).json();
    expect(body.total.imports).toBe(0);
    expect(body.byActor).toEqual({});
  });
});

describe('when the migration has not been run', () => {
  it('says WHICH file, with a 409 rather than a 500', async () => {
    // The distinction matters: a 500 tells an operator something is broken, and
    // this is not broken, it is unmigrated. The admin page can render one as a
    // prompt and the other as an alarm only if the route tells them apart.
    asAdmin();
    // RETURNED, not thrown. supabase-js does not throw for a missing relation:
    // PostgREST answers the request and the error arrives in the result, the
    // same way PGRST204 arrives for a missing column. My first version of this
    // test threw instead, which `fetchAllPages` does not catch -- so it was
    // exercising a path the database never takes and the route never sees.
    fakeDb.queue('recipe_imports', {
      data: null,
      error: { code: '42P01', message: 'relation "public.recipe_imports" does not exist' },
    });
    const res = await GET(jsonRequest('/api/admin/import-spend', { method: 'GET', token }) as never);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.needsMigration).toBe(true);
    expect(body.error).toContain('20260906000001_recipe_imports.sql');
  });
});
