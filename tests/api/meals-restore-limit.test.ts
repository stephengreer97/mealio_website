import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeDb } from '../helpers/supabase-mock';
import { jsonRequest } from '../helpers/request';

vi.mock('@/lib/supabase', async () =>
  (await import('../helpers/supabase-mock')).mockSupabaseModule());
vi.mock('@/lib/logger', () => ({ log: vi.fn() }));

import { POST as RESTORE } from '@/app/api/meals/[id]/restore/route';
import { createAccessToken } from '@/lib/tokens';

/**
 * Restoring a meal makes it active again, so it is the same act as creating one
 * as far as the free plan is concerned. It used to skip the check entirely: a
 * free user could delete three meals, add three more, and restore the first
 * three, ending with six active meals on a plan that allows three.
 */

const USER = 'user-1';

function seed(tier: string, meals: Array<{ id: string; is_active: boolean; user_id?: string }>) {
  fakeDb.seed('user_profiles', [{ id: USER, subscription_tier: tier }]);
  fakeDb.seed('meals', meals.map((m) => ({ user_id: USER, ...m })));
}

async function restore(id: string) {
  const token = await createAccessToken(USER, 'a@b.test');
  return RESTORE(jsonRequest(`/api/meals/${id}/restore`, { token }), { params: Promise.resolve({ id }) });
}

beforeEach(() => { fakeDb.reset(); });

describe('POST /api/meals/[id]/restore: free-tier limit', () => {
  it('refuses a free user already at 3 active meals, with the create path\'s body', async () => {
    seed('free', [
      { id: 'a', is_active: true }, { id: 'b', is_active: true }, { id: 'c', is_active: true },
      { id: 'gone', is_active: false },
    ]);

    const res = await restore('gone');

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.tierLimitReached).toBe(true);
    expect(body.error).toBe('Free plan is limited to 3 meals. Upgrade to Full Access to add more.');
    // And nothing changed.
    expect(fakeDb.row('meals', 'gone')!.is_active).toBe(false);
  });

  it('restores for a free user under the limit', async () => {
    seed('free', [{ id: 'a', is_active: true }, { id: 'gone', is_active: false }]);

    const res = await restore('gone');

    expect(res.status).toBe(200);
    expect(fakeDb.row('meals', 'gone')!.is_active).toBe(true);
  });

  it('restores for a paid user whatever the count', async () => {
    seed('paid', [
      { id: 'a', is_active: true }, { id: 'b', is_active: true }, { id: 'c', is_active: true },
      { id: 'gone', is_active: false },
    ]);

    const res = await restore('gone');

    expect(res.status).toBe(200);
    expect(fakeDb.row('meals', 'gone')!.is_active).toBe(true);
  });

  it('404s on a meal that belongs to someone else', async () => {
    seed('paid', [{ id: 'theirs', is_active: false, user_id: 'someone-else' }]);

    const res = await restore('theirs');

    expect(res.status).toBe(404);
    expect(fakeDb.row('meals', 'theirs')!.is_active).toBe(false);
  });
});
