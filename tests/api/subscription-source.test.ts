import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fakeDb } from '../helpers/supabase-mock';
import { jsonRequest } from '../helpers/request';

vi.mock('@/lib/supabase', async () =>
  (await import('../helpers/supabase-mock')).mockSupabaseModule());
vi.mock('@/lib/logger', () => ({ log: vi.fn() }));

const constructEvent = vi.fn();
const listSubs = vi.fn();
vi.mock('stripe', () => ({
  default: class {
    webhooks = { constructEvent: (...a: unknown[]) => constructEvent(...a) };
    subscriptions = { list: (...a: unknown[]) => listSubs(...a) };
  },
}));

import { POST as stripeWebhook } from '@/app/api/payments/webhook/route';
import { POST as rcWebhook } from '@/app/api/payments/revenuecat-webhook/route';
import { canEnd, sourceFromRevenueCatStore } from '@/lib/subscription-source';

/**
 * A payment system may only end the access it granted.
 *
 * Before `subscription_source`, every "it ended" event set the tier to free,
 * whoever had given it: a Stripe cancellation ended App Store access, and a
 * RevenueCat EXPIRATION or a past_due Stripe status ended a comped creator's.
 */

const U = '11111111-1111-4111-8111-111111111111';

function profile(extra: Record<string, unknown>) {
  fakeDb.seed('user_profiles', [{
    id: U, stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_A',
    subscription_tier: 'paid', subscription_ends_at: null, subscribed_at: '2026-01-01T00:00:00Z',
    ...extra,
  }]);
}

function stripe(type: string, object: Record<string, unknown>) {
  constructEvent.mockReturnValue({ id: `evt_${type}_${Math.random()}`, type, data: { object } });
  return stripeWebhook(new Request('https://mealio.co/api/payments/webhook', {
    method: 'POST', headers: { 'stripe-signature': 'sig' }, body: '{}',
  }) as never);
}

function rc(event: Record<string, unknown>) {
  return rcWebhook(jsonRequest('/api/payments/revenuecat-webhook', {
    headers: { authorization: 'Bearer rc-secret' },
    body: { event },
  }));
}

const tier = () => fakeDb.row('user_profiles', U)!.subscription_tier;
const source = () => fakeDb.row('user_profiles', U)!.subscription_source;

beforeEach(() => {
  vi.unstubAllEnvs();
  fakeDb.reset();
  constructEvent.mockReset();
  listSubs.mockReset();
  listSubs.mockResolvedValue({ data: [] });
  vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test');
  vi.stubEnv('STRIPE_WEBHOOK_SECRET', 'whsec');
  process.env.REVENUECAT_WEBHOOK_SECRET = 'rc-secret';
  fakeDb.seed('subscription_events', []);
});
afterEach(() => { delete process.env.REVENUECAT_WEBHOOK_SECRET; });

describe('which system may end which access', () => {
  it.each([
    ['stripe', 'stripe', true],
    ['stripe', 'app_store', false],
    ['stripe', 'comp', false],
    ['stripe', 'unknown', true],
    ['revenuecat', 'app_store', true],
    ['revenuecat', 'play_store', true],
    ['revenuecat', 'store', true],
    ['revenuecat', 'stripe', false],
    ['revenuecat', 'comp', false],
    ['revenuecat', 'unknown', true],
  ] as const)('%s ending %s: %s', (biller, src, expected) => {
    expect(canEnd(biller, src)).toBe(expected);
  });

  it('maps RevenueCat stores to sources', () => {
    expect(sourceFromRevenueCatStore('APP_STORE')).toBe('app_store');
    expect(sourceFromRevenueCatStore('PLAY_STORE')).toBe('play_store');
    expect(sourceFromRevenueCatStore('PROMOTIONAL')).toBe('store');
  });
});

describe('Stripe', () => {
  it('records a web checkout as stripe', async () => {
    profile({ subscription_tier: 'free', subscription_source: null, stripe_subscription_id: null });
    await stripe('checkout.session.completed', { metadata: { user_id: U }, customer: 'cus_1', subscription: 'sub_B' });
    expect(tier()).toBe('paid');
    expect(source()).toBe('stripe');
  });

  it('keeps a comped creator comped when they also check out', async () => {
    profile({ subscription_source: 'comp', stripe_subscription_id: null });
    await stripe('checkout.session.completed', { metadata: { user_id: U }, customer: 'cus_1', subscription: 'sub_B' });
    expect(tier()).toBe('paid');
    expect(source()).toBe('comp');
  });

  it('does not end a comped creator when their Stripe subscription is deleted', async () => {
    profile({ subscription_source: 'comp' });
    await stripe('customer.subscription.deleted', { id: 'sub_A', customer: 'cus_1', canceled_at: 1767225600, items: { data: [] } });
    expect(tier()).toBe('paid');
    expect(source()).toBe('comp');
  });

  it('does not end App Store access on a past_due Stripe status', async () => {
    profile({ subscription_source: 'app_store' });
    await stripe('customer.subscription.updated', { id: 'sub_A', customer: 'cus_1', status: 'past_due' });
    expect(tier()).toBe('paid');
  });

  it('still ends its own subscription, and clears the source', async () => {
    profile({ subscription_source: 'stripe' });
    await stripe('customer.subscription.deleted', { id: 'sub_A', customer: 'cus_1', canceled_at: 1767225600, items: { data: [] } });
    expect(tier()).toBe('free');
    expect(source()).toBeNull();
  });
});

describe('RevenueCat', () => {
  it('records the store a purchase came from', async () => {
    profile({ subscription_tier: 'free', subscription_source: null, stripe_subscription_id: null });
    await rc({ type: 'INITIAL_PURCHASE', app_user_id: U, store: 'PLAY_STORE' });
    expect(tier()).toBe('paid');
    expect(source()).toBe('play_store');
  });

  it('does not end web or comped access on an EXPIRATION', async () => {
    for (const src of ['stripe', 'comp']) {
      fakeDb.reset();
      profile({ subscription_source: src });
      await rc({ type: 'EXPIRATION', app_user_id: U, expiration_at_ms: 1767225600000 });
      expect(tier(), src).toBe('paid');
      expect(source(), src).toBe(src);
    }
  });

  it('ends store access on an EXPIRATION', async () => {
    profile({ subscription_source: 'app_store', stripe_subscription_id: null });
    await rc({ type: 'EXPIRATION', app_user_id: U, expiration_at_ms: 1767225600000 });
    expect(tier()).toBe('free');
    expect(source()).toBeNull();
  });

  it('leaves a comped old owner alone on a TRANSFER', async () => {
    const NEW = '22222222-2222-4222-8222-222222222222';
    fakeDb.seed('user_profiles', [
      { id: U, subscription_tier: 'paid', subscription_source: 'comp', stripe_subscription_id: null },
      { id: NEW, subscription_tier: 'free', subscription_source: null, stripe_subscription_id: null },
    ]);
    await rc({ type: 'TRANSFER', transferred_from: [U], transferred_to: [NEW], entitlement_ids: ['full_access'], store: 'APP_STORE' });
    expect(tier()).toBe('paid');
    expect(fakeDb.row('user_profiles', NEW)!.subscription_tier).toBe('paid');
    expect(fakeDb.row('user_profiles', NEW)!.subscription_source).toBe('app_store');
  });
});
