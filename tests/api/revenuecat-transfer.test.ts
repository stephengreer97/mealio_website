import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fakeDb } from '../helpers/supabase-mock';
import { jsonRequest } from '../helpers/request';

vi.mock('@/lib/supabase', async () =>
  (await import('../helpers/supabase-mock')).mockSupabaseModule());
vi.mock('@/lib/logger', () => ({ log: vi.fn() }));

import { POST } from '@/app/api/payments/revenuecat-webhook/route';

/**
 * TRANSFER moves a store purchase from one Mealio account to another (a restore
 * signed in as someone else). It names no app_user_id, so it used to be dropped
 * as "no user id": the old owner stayed paid for ever, since RevenueCat sends
 * them nothing further, and the new owner was never upgraded.
 */

const OLD = '11111111-1111-4111-8111-111111111111';
const NEW = '22222222-2222-4222-8222-222222222222';
const WEB = '33333333-3333-4333-8333-333333333333';

function send(event: Record<string, unknown>) {
  return POST(jsonRequest('/api/payments/revenuecat-webhook', {
    headers: { authorization: 'Bearer rc-secret' },
    body: { event },
  }));
}

beforeEach(() => {
  fakeDb.reset();
  process.env.REVENUECAT_WEBHOOK_SECRET = 'rc-secret';
});
afterEach(() => { delete process.env.REVENUECAT_WEBHOOK_SECRET; });

describe('RevenueCat TRANSFER', () => {
  it('downgrades the old owner and upgrades the new one', async () => {
    fakeDb.seed('user_profiles', [
      { id: OLD, subscription_tier: 'paid', stripe_subscription_id: null, subscription_ends_at: null },
      { id: NEW, subscription_tier: 'free', stripe_subscription_id: null, subscription_ends_at: null },
    ]);

    const res = await send({
      type: 'TRANSFER',
      transferred_from: [OLD, '$RCAnonymousID:abc'],
      transferred_to: [NEW],
    });

    expect(res.status).toBe(200);
    expect(fakeDb.row('user_profiles', OLD)!.subscription_tier).toBe('free');
    expect(fakeDb.row('user_profiles', NEW)!.subscription_tier).toBe('paid');
    expect(fakeDb.row('user_profiles', NEW)!.subscription_ends_at).toBeNull();
  });

  it('is idempotent: a redelivery leaves the same state', async () => {
    fakeDb.seed('user_profiles', [
      { id: OLD, subscription_tier: 'paid', stripe_subscription_id: null },
      { id: NEW, subscription_tier: 'free', stripe_subscription_id: null },
    ]);
    const event = { type: 'TRANSFER', transferred_from: [OLD], transferred_to: [NEW], entitlement_ids: ['full_access'] };

    await send(event);
    await send(event);

    expect(fakeDb.row('user_profiles', OLD)!.subscription_tier).toBe('free');
    expect(fakeDb.row('user_profiles', NEW)!.subscription_tier).toBe('paid');
  });

  it('leaves an old owner paid through Stripe on paid', async () => {
    fakeDb.seed('user_profiles', [
      { id: WEB, subscription_tier: 'paid', subscription_source: 'stripe', stripe_subscription_id: 'sub_123' },
      { id: NEW, subscription_tier: 'free', stripe_subscription_id: null },
    ]);

    await send({ type: 'TRANSFER', transferred_from: [WEB], transferred_to: [NEW], entitlement_ids: ['full_access'] });

    expect(fakeDb.row('user_profiles', WEB)!.subscription_tier).toBe('paid');
    expect(fakeDb.row('user_profiles', NEW)!.subscription_tier).toBe('paid');
  });

  it('does not upgrade when the transferred purchase carries no entitlement', async () => {
    fakeDb.seed('user_profiles', [
      { id: OLD, subscription_tier: 'free', stripe_subscription_id: null },
      { id: NEW, subscription_tier: 'free', stripe_subscription_id: null },
    ]);

    await send({ type: 'TRANSFER', transferred_from: [OLD], transferred_to: [NEW], entitlement_ids: [] });

    expect(fakeDb.row('user_profiles', NEW)!.subscription_tier).toBe('free');
  });

  it('does not upgrade from a lapsed old owner when the event names no entitlements', async () => {
    fakeDb.seed('user_profiles', [
      { id: OLD, subscription_tier: 'free', stripe_subscription_id: null },
      { id: NEW, subscription_tier: 'free', stripe_subscription_id: null },
    ]);

    await send({ type: 'TRANSFER', transferred_from: [OLD], transferred_to: [NEW] });

    expect(fakeDb.row('user_profiles', NEW)!.subscription_tier).toBe('free');
  });
});
