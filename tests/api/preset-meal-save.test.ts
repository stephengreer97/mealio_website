import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeDb } from '../helpers/supabase-mock';
import { jsonRequest } from '../helpers/request';

vi.mock('@/lib/supabase', async () =>
  (await import('../helpers/supabase-mock')).mockSupabaseModule());
vi.mock('@/lib/logger', () => ({ log: vi.fn() }));

import { POST } from '@/app/api/preset-meals/[id]/save/route';
import { createAccessToken } from '@/lib/tokens';

/**
 * A save row is money: the creator profit share is divided by them. The route
 * used to write one for any meal id any verified account sent, without that
 * account having saved anything. It now records only a save the user holds (a
 * meals row copied from this preset), and is rate limited per account.
 */

const USER = 'user-1';
const RPC = 'rpc:record_login_attempt';

async function save(id = 'pm-1') {
  const token = await createAccessToken(USER, 'a@b.test');
  return POST(jsonRequest(`/api/preset-meals/${id}/save`, { token }), { params: Promise.resolve({ id }) });
}

beforeEach(() => {
  fakeDb.reset();
  fakeDb.seed('preset_meal_saves', []);
  fakeDb.queue(RPC, { data: 1 });
});

describe('POST /api/preset-meals/[id]/save', () => {
  it('records a save the user actually holds', async () => {
    fakeDb.seed('meals', [{ id: 'm1', user_id: USER, preset_meal_id: 'pm-1', is_active: true }]);

    const res = await save();

    expect(res.status).toBe(200);
    expect(fakeDb.rows('preset_meal_saves')).toEqual([
      expect.objectContaining({ preset_meal_id: 'pm-1', user_id: USER }),
    ]);
  });

  it('refuses to record a save with no saved copy behind it', async () => {
    fakeDb.seed('meals', [
      { id: 'm1', user_id: USER, preset_meal_id: 'pm-other', is_active: true },
      { id: 'm2', user_id: 'someone-else', preset_meal_id: 'pm-1', is_active: true },
    ]);

    const res = await save();

    expect(res.status).toBe(409);
    expect(fakeDb.rows('preset_meal_saves')).toHaveLength(0);
  });

  it('rate limits an account past the window budget', async () => {
    fakeDb.reset();
    fakeDb.seed('preset_meal_saves', []);
    fakeDb.seed('meals', [{ id: 'm1', user_id: USER, preset_meal_id: 'pm-1', is_active: true }]);
    fakeDb.queue(RPC, { data: 61 });

    const res = await save();

    expect(res.status).toBe(429);
    expect(fakeDb.rows('preset_meal_saves')).toHaveLength(0);
    expect(fakeDb.calls).toContainEqual(expect.objectContaining({
      table: RPC, method: 'rpc', args: [expect.objectContaining({ p_key: `save:${USER}` })],
    }));
  });

  it('fails open when the throttle cannot be read', async () => {
    fakeDb.reset();
    fakeDb.seed('preset_meal_saves', []);
    fakeDb.seed('meals', [{ id: 'm1', user_id: USER, preset_meal_id: 'pm-1', is_active: true }]);
    fakeDb.queue(RPC, { error: { message: 'function does not exist' } });

    const res = await save();

    expect(res.status).toBe(200);
    expect(fakeDb.rows('preset_meal_saves')).toHaveLength(1);
  });
});
