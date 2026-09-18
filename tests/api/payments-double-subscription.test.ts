import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeDb } from '../helpers/supabase-mock';
import { jsonRequest } from '../helpers/request';

vi.mock('@/lib/supabase', async () =>
  (await import('../helpers/supabase-mock')).mockSupabaseModule());
vi.mock('@/lib/logger', () => ({ log: vi.fn() }));

const constructEvent = vi.fn();
const listSubs = vi.fn();
const createCheckout = vi.fn();
const createPortal = vi.fn();
vi.mock('stripe', () => ({
  default: class {
    webhooks = { constructEvent: (...a: unknown[]) => constructEvent(...a) };
    subscriptions = { list: (...a: unknown[]) => listSubs(...a) };
    checkout = { sessions: { create: (...a: unknown[]) => createCheckout(...a) } };
    billingPortal = { sessions: { create: (...a: unknown[]) => createPortal(...a) } };
  },
}));

import { POST as checkout } from '@/app/api/payments/checkout/route';
import { POST as webhook } from '@/app/api/payments/webhook/route';
import { createAccessToken, clearRevocationCache } from '@/lib/tokens';

/**
 * One customer, one subscription.
 *
 * Checkout let a user who was already paying start a second Stripe
 * subscription, billed twice for the same Full Access. And when either of two
 * subscriptions was deleted, the webhook set the tier to free while the other
 * was still being charged.
 */

const MONTHLY = 'price_monthly';

async function startCheckout() {
  const token = await createAccessToken('u1', 'a@b.test');
  return checkout(jsonRequest('/api/payments/checkout', { body: { priceId: MONTHLY }, token }));
}

const deleted = (subId: string) => {
  constructEvent.mockReturnValue({
    id: `evt_del_${subId}`,
    type: 'customer.subscription.deleted',
    data: { object: { id: subId, customer: 'cus_1', canceled_at: 1767225600, items: { data: [] } } },
  });
  return webhook(new Request('https://mealio.co/api/payments/webhook', {
    method: 'POST', headers: { 'stripe-signature': 'sig' }, body: '{}',
  }) as never);
};

beforeEach(() => {
  vi.unstubAllEnvs();
  fakeDb.reset();
  clearRevocationCache();
  for (const m of [constructEvent, listSubs, createCheckout, createPortal]) m.mockReset();
  createCheckout.mockResolvedValue({ url: 'https://checkout.stripe.test/s' });
  createPortal.mockResolvedValue({ url: 'https://billing.stripe.test/p' });
  listSubs.mockResolvedValue({ data: [] });
  vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test');
  vi.stubEnv('STRIPE_WEBHOOK_SECRET', 'whsec');
  vi.stubEnv('NEXT_PUBLIC_STRIPE_MONTHLY_PRICE_ID', MONTHLY);
  fakeDb.seed('user_profiles', [{
    id: 'u1', stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_A',
    subscription_tier: 'paid', subscribed_at: '2026-01-01T00:00:00Z', tokens_invalidated_at: null,
  }]);
  fakeDb.seed('subscription_events', []);
});

describe('checkout for someone already paying', () => {
  it('sends a customer with a live Stripe subscription to the billing portal, not a second checkout', async () => {
    listSubs.mockResolvedValue({ data: [{ id: 'sub_A', status: 'active' }] });

    const body = await (await startCheckout()).json();

    expect(body).toEqual({ url: 'https://billing.stripe.test/p', alreadySubscribed: true });
    expect(createCheckout).not.toHaveBeenCalled();
    expect(listSubs).toHaveBeenCalledWith(expect.objectContaining({ customer: 'cus_1' }));
  });

  it('refuses a user paid outside Stripe (in-app purchase) with a clear message', async () => {
    fakeDb.patch('user_profiles', 'u1', { stripe_customer_id: null });

    const res = await startCheckout();

    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/already have Full Access/);
    expect(createCheckout).not.toHaveBeenCalled();
  });

  it('still sells to a returning customer whose old subscription ended', async () => {
    fakeDb.patch('user_profiles', 'u1', { subscription_tier: 'free' });
    listSubs.mockResolvedValue({ data: [{ id: 'sub_A', status: 'canceled' }] });

    const body = await (await startCheckout()).json();

    expect(body).toEqual({ url: 'https://checkout.stripe.test/s' });
    expect(createCheckout).toHaveBeenCalledWith(expect.objectContaining({ customer: 'cus_1' }));
  });
});

describe('customer.subscription.deleted', () => {
  it('downgrades when the ended subscription was the only one', async () => {
    listSubs.mockResolvedValue({ data: [{ id: 'sub_A', status: 'canceled' }] });

    await deleted('sub_A');

    expect(fakeDb.row('user_profiles', 'u1').subscription_tier).toBe('free');
  });

  it('keeps Full Access while another subscription is still active', async () => {
    listSubs.mockResolvedValue({ data: [{ id: 'sub_A', status: 'canceled' }, { id: 'sub_B', status: 'active' }] });

    await deleted('sub_A');

    expect(fakeDb.row('user_profiles', 'u1').subscription_tier).toBe('paid');
    // The cancellation is still a fact worth recording.
    expect(fakeDb.rows('subscription_events')).toHaveLength(1);
  });

  it('keeps Full Access when the tier on record is from a different subscription', async () => {
    fakeDb.patch('user_profiles', 'u1', { stripe_subscription_id: 'sub_B' });

    await deleted('sub_A');

    expect(fakeDb.row('user_profiles', 'u1').subscription_tier).toBe('paid');
  });

  it('asks Stripe to retry, rather than guessing, when it cannot list subscriptions', async () => {
    listSubs.mockRejectedValue(new Error('stripe down'));

    const res = await deleted('sub_A');

    expect(res.status).toBe(500);
    expect(fakeDb.row('user_profiles', 'u1').subscription_tier).toBe('paid');
  });
});
