import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fakeDb, deleteUser } from '../helpers/supabase-mock';
import { fakeStorage } from '../helpers/storage-mock';
import { jsonRequest } from '../helpers/request';

vi.mock('@/lib/supabase', async () =>
  (await import('../helpers/storage-mock')).mockSupabaseWithStorage());
vi.mock('@/lib/logger', () => ({ log: vi.fn() }));
vi.mock('next/cache', () => ({ revalidateTag: vi.fn() }));

/** The customer's subscriptions as Stripe holds them. */
let stripeSubs: Array<{ id: string; status: string }> = [];
const cancel = vi.fn(async (id: string) => {
  const sub = stripeSubs.find((s) => s.id === id);
  if (!sub) throw Object.assign(new Error('No such subscription'), { code: 'resource_missing' });
  sub.status = 'canceled';
  return sub;
});
vi.mock('stripe', () => ({
  default: class {
    subscriptions = {
      // Auto-paginating list: awaited in a for-await, as the route reads it.
      list: () => ({
        async *[Symbol.asyncIterator]() { for (const s of stripeSubs) yield { ...s }; },
      }),
      retrieve: async (id: string) => {
        const sub = stripeSubs.find((s) => s.id === id);
        if (!sub) throw Object.assign(new Error('No such subscription'), { code: 'resource_missing' });
        return { ...sub };
      },
      cancel: (id: string) => cancel(id),
    };
  },
}));

import { DELETE } from '@/app/api/account/delete/route';
import { clearRevocationCache, createAccessToken } from '@/lib/tokens';

/**
 * Deleting an account used to leave its Stripe subscription running: the
 * profile went, the customer stayed, and the card kept being charged for a
 * product nobody could sign in to.
 */

const USER = 'u1';

function seed(profile: Record<string, unknown>) {
  clearRevocationCache();
  fakeDb.queue('user_profiles', { data: { tokens_invalidated_at: null } });
  fakeDb.seed('user_profiles', [{ id: USER, email: 'a@b.test', created_at: '2026-01-01T00:00:00.000Z', ...profile }]);
  fakeDb.seed('creators', []);
  fakeDb.seed('deleted_users', []);
}

async function del() {
  const token = await createAccessToken(USER, 'a@b.test');
  return DELETE(jsonRequest('/api/account/delete', { method: 'DELETE', token }));
}

beforeEach(() => {
  fakeDb.reset();
  fakeStorage.reset();
  cancel.mockClear();
  stripeSubs = [];
  process.env.STRIPE_SECRET_KEY = 'sk_test_x';
});
afterEach(() => { delete process.env.STRIPE_SECRET_KEY; });

describe('DELETE /api/account/delete: subscriptions', () => {
  it('cancels a live Stripe subscription, then deletes', async () => {
    seed({ subscription_tier: 'paid', stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_1' });
    stripeSubs = [{ id: 'sub_1', status: 'active' }, { id: 'sub_old', status: 'canceled' }];

    const res = await del();

    expect(res.status).toBe(200);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledWith('sub_1');
    expect(fakeDb.rows('user_profiles')).toHaveLength(0);
    // A Stripe subscriber is not told to go and cancel in an app store.
    expect((await res.json()).notice).toBeUndefined();
  });

  it('deletes nothing when the cancellation fails, and says why', async () => {
    seed({ subscription_tier: 'paid', stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_1' });
    stripeSubs = [{ id: 'sub_1', status: 'active' }];
    cancel.mockRejectedValueOnce(Object.assign(new Error('api down'), { code: 'api_error' }));

    const res = await del();

    expect(res.status).toBe(502);
    const { error } = await res.json();
    expect(error).toMatch(/could not cancel your Mealio subscription/);
    expect(error).not.toContain('—');
    expect(fakeDb.rows('user_profiles')).toHaveLength(1);
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it('succeeds on a retry after the subscription is already cancelled', async () => {
    seed({ subscription_tier: 'free', stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_1' });
    stripeSubs = [{ id: 'sub_1', status: 'canceled' }];

    const res = await del();

    expect(res.status).toBe(200);
    expect(cancel).not.toHaveBeenCalled();
  });

  it('tells an in-app subscriber that the store subscription is theirs to cancel', async () => {
    seed({ subscription_tier: 'paid', stripe_customer_id: null, stripe_subscription_id: null });

    const res = await del();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.notice).toMatch(/App Store or Google Play/);
    expect(body.notice).not.toContain('—');
  });
});
