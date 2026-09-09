import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeDb } from '../helpers/supabase-mock';

vi.mock('@/lib/supabase', async () =>
  (await import('../helpers/supabase-mock')).mockSupabaseModule());
vi.mock('@/lib/logger', () => ({ log: vi.fn() }));

/** Stripe's signature check is not what this file is about; hand it the event. */
const constructEvent = vi.fn();
vi.mock('stripe', () => ({
  default: class {
    webhooks = { constructEvent: (...a: unknown[]) => constructEvent(...a) };
  },
}));

import { POST } from '@/app/api/payments/webhook/route';

/**
 * Revenue, recorded as rows rather than left in Stripe.
 *
 * `subscription_events` held `started` and `cancelled` and nothing about money,
 * so lifetime value was not computable from this database at all — and adding an
 * amount to `started` would not have fixed it, because `started` fires once. A
 * user who paid for fourteen months and one who paid for a single month were the
 * same two rows. Renewals were invisible: `invoice.payment_succeeded` was not
 * handled.
 *
 * The invariant these tests exist for is the one that makes the sum safe:
 *
 *     sum(amount_cents) WHERE event = 'payment_succeeded'
 *
 * must be the whole of a user's revenue and must not count anything twice.
 * Stripe fires `invoice.payment_succeeded` for the FIRST payment as well as
 * every renewal, so an amount on the `started` row too would double the first
 * month — a wrong LTV that looks entirely plausible.
 */

const post = async (event: Record<string, unknown>) => {
  constructEvent.mockReturnValue(event);
  return POST(new Request('https://mealio.co/api/payments/webhook', {
    method: 'POST',
    headers: { 'stripe-signature': 'sig' },
    body: '{}',
  }) as never);
};

beforeEach(() => {
  fakeDb.reset();
  constructEvent.mockReset();
  process.env.STRIPE_SECRET_KEY = 'sk_test';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec';
  fakeDb.seed('user_profiles', [{ id: 'u1', stripe_customer_id: 'cus_1', subscribed_at: null }]);
  fakeDb.seed('subscription_events', []);
});

describe('POST /api/payments/webhook — money on the log', () => {
  it('records what a collected invoice was actually worth', async () => {
    await post({
      id: 'evt_pay_1',
      type: 'invoice.payment_succeeded',
      data: { object: {
        customer: 'cus_1',
        amount_paid: 499,
        currency: 'usd',
        lines: { data: [{ price: { recurring: { interval: 'month' } } }] },
      } },
    });

    expect(fakeDb.rows('subscription_events')).toEqual([expect.objectContaining({
      user_id: 'u1',
      event: 'payment_succeeded',
      stripe_event_id: 'evt_pay_1',
      amount_cents: 499,
      currency: 'usd',
      interval: 'month',
    })]);
  });

  it('puts no amount on the started row, so the first month is not counted twice', async () => {
    await post({
      id: 'evt_checkout_1',
      type: 'checkout.session.completed',
      data: { object: { metadata: { user_id: 'u1' }, customer: 'cus_1', subscription: 'sub_1', currency: 'usd' } },
    });
    await post({
      id: 'evt_pay_1',
      type: 'invoice.payment_succeeded',
      data: { object: { customer: 'cus_1', amount_paid: 499, currency: 'usd', lines: { data: [] } } },
    });

    const rows = fakeDb.rows('subscription_events');
    const started = rows.find((r) => r.event === 'started');
    expect(started.amount_cents ?? null).toBeNull();
    // The sum an LTV query would compute, over both rows that now exist.
    const revenue = rows
      .filter((r) => r.event === 'payment_succeeded')
      .reduce((total, r) => total + (r.amount_cents ?? 0), 0);
    expect(revenue).toBe(499);
  });

  it('records a fully discounted invoice as a zero rather than dropping it', async () => {
    // "They were a customer that month and paid nothing" is a fact retention
    // wants. A missing row destroys it; a zero keeps it.
    await post({
      id: 'evt_pay_free',
      type: 'invoice.payment_succeeded',
      data: { object: { customer: 'cus_1', amount_paid: 0, currency: 'usd', lines: { data: [] } } },
    });

    expect(fakeDb.rows('subscription_events')[0]).toMatchObject({
      event: 'payment_succeeded', amount_cents: 0,
    });
  });

  it('carries the plan onto the cancellation, but no money', async () => {
    await post({
      id: 'evt_cancel_1',
      type: 'customer.subscription.deleted',
      data: { object: {
        customer: 'cus_1',
        canceled_at: 1767225600,
        items: { data: [{ price: { currency: 'usd', recurring: { interval: 'year' } } }] },
      } },
    });

    const [row] = fakeDb.rows('subscription_events');
    expect(row).toMatchObject({ event: 'cancelled', currency: 'usd', interval: 'year' });
    // A cancellation collects nothing; a final plan price here would be revenue
    // that never happened.
    expect(row.amount_cents ?? null).toBeNull();
  });

  it('does not invent a user for a payment whose account is gone', async () => {
    // Exactly what the deleted-user work expects to see: Stripe keeps billing
    // history for a customer whose profile no longer exists.
    fakeDb.seed('user_profiles', []);

    const res = await post({
      id: 'evt_pay_orphan',
      type: 'invoice.payment_succeeded',
      data: { object: { customer: 'cus_gone', amount_paid: 499, currency: 'usd', lines: { data: [] } } },
    });

    expect(res.status).toBe(200);
    expect(fakeDb.rows('subscription_events')).toHaveLength(0);
  });

  it('survives an invoice with no recurring line', async () => {
    await post({
      id: 'evt_pay_oneoff',
      type: 'invoice.payment_succeeded',
      data: { object: { customer: 'cus_1', amount_paid: 1500, currency: 'usd' } },
    });

    expect(fakeDb.rows('subscription_events')[0]).toMatchObject({ amount_cents: 1500, interval: null });
  });
});
