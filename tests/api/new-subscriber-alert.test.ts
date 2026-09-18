import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fakeDb } from '../helpers/supabase-mock';
import { jsonRequest } from '../helpers/request';

vi.mock('@/lib/supabase', async () =>
  (await import('../helpers/supabase-mock')).mockSupabaseModule());
vi.mock('@/lib/logger', () => ({ log: vi.fn() }));
vi.mock('@/lib/requireAdmin', () => ({
  requireAdmin: vi.fn(async () => ({ userId: 'admin-1', email: 'admin@mealio.co' })),
}));

const sendNewSubscriberEmail = vi.fn(async (_opts: unknown) => {});
vi.mock('@/lib/email', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/email')>()),
  sendNewSubscriberEmail: (opts: unknown) => sendNewSubscriberEmail(opts),
}));

const constructEvent = vi.fn();
vi.mock('stripe', () => ({
  default: class {
    webhooks = { constructEvent: (...a: unknown[]) => constructEvent(...a) };
    subscriptions = { list: async () => ({ data: [] }) };
  },
}));

import { POST as stripePost } from '@/app/api/payments/webhook/route';
import { POST as rcPost } from '@/app/api/payments/revenuecat-webhook/route';
import { requireAdmin } from '@/lib/requireAdmin';

const USER = '11111111-1111-4111-8111-111111111111';

const checkoutCompleted = {
  id: 'evt_1',
  type: 'checkout.session.completed',
  data: { object: { metadata: { user_id: USER }, customer: 'cus_1', subscription: 'sub_1', currency: 'usd' } },
};

const stripe = async (event: Record<string, unknown>) => {
  constructEvent.mockReturnValue(event);
  return stripePost(new Request('https://mealio.co/api/payments/webhook', {
    method: 'POST', headers: { 'stripe-signature': 'sig' }, body: '{}',
  }) as never);
};

const rc = (event: Record<string, unknown>) =>
  rcPost(jsonRequest('/api/payments/revenuecat-webhook', {
    headers: { authorization: 'Bearer rc-secret' },
    body: { event },
  }));

beforeEach(() => {
  fakeDb.reset();
  sendNewSubscriberEmail.mockClear();
  process.env.STRIPE_SECRET_KEY = 'sk_test';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec';
  process.env.REVENUECAT_WEBHOOK_SECRET = 'rc-secret';
  fakeDb.seed('user_profiles', [
    { id: USER, email: 'new@sub.test', subscription_tier: 'free', subscription_source: null, subscribed_at: null },
    { id: 'admin-1', email: 'admin@mealio.co', is_admin: true },
  ]);
  fakeDb.seed('subscription_events', []);
  fakeDb.seed('app_settings', []);
});
afterEach(() => { delete process.env.REVENUECAT_WEBHOOK_SECRET; });

describe('admins are emailed when someone subscribes to Full Access', () => {
  it('on a Stripe checkout, once — a redelivered event does not email again', async () => {
    expect((await stripe(checkoutCompleted)).status).toBe(200);
    expect(sendNewSubscriberEmail).toHaveBeenCalledTimes(1);
    expect(sendNewSubscriberEmail).toHaveBeenCalledWith({
      adminEmails: ['admin@mealio.co'], userEmail: 'new@sub.test', channel: 'Web (Stripe)',
    });

    await stripe(checkoutCompleted);
    expect(sendNewSubscriberEmail).toHaveBeenCalledTimes(1);
  });

  it('on a first store purchase through RevenueCat', async () => {
    expect((await rc({ type: 'INITIAL_PURCHASE', app_user_id: USER, store: 'APP_STORE' })).status).toBe(200);
    expect(sendNewSubscriberEmail).toHaveBeenCalledWith({
      adminEmails: ['admin@mealio.co'], userEmail: 'new@sub.test', channel: 'App Store',
    });
  });

  it('not on a renewal', async () => {
    await rc({ type: 'RENEWAL', app_user_id: USER, store: 'APP_STORE' });
    await stripe({ id: 'evt_2', type: 'invoice.payment_succeeded', data: { object: { customer: 'cus_1', amount_paid: 499, currency: 'usd' } } });
    expect(sendNewSubscriberEmail).not.toHaveBeenCalled();
  });

  it('a failed send still grants access and answers 200, so nothing is redelivered', async () => {
    sendNewSubscriberEmail.mockRejectedValueOnce(new Error('Resend refused'));
    expect((await stripe(checkoutCompleted)).status).toBe(200);
    expect(fakeDb.row('user_profiles', USER)!.subscription_tier).toBe('paid');
  });
});

describe('the admin toggle', () => {
  it('is on until someone turns it off', async () => {
    const { GET } = await import('@/app/api/admin/notification-settings/route');
    expect(await (await GET(jsonRequest('/api/admin/notification-settings', { method: 'GET' }) as never)).json())
      .toEqual({ newSubscriber: true });
  });

  it('switched off, a new subscriber emails nobody — and still gets access', async () => {
    const { PATCH, GET } = await import('@/app/api/admin/notification-settings/route');
    const res = await PATCH(jsonRequest('/api/admin/notification-settings', { method: 'PATCH', body: { newSubscriber: false } }) as never);
    expect(res.status).toBe(200);
    expect(await (await GET(jsonRequest('/api/admin/notification-settings', { method: 'GET' }) as never)).json())
      .toEqual({ newSubscriber: false });

    await stripe(checkoutCompleted);
    await rc({ type: 'INITIAL_PURCHASE', app_user_id: USER, store: 'APP_STORE' });
    expect(sendNewSubscriberEmail).not.toHaveBeenCalled();
    expect(fakeDb.row('user_profiles', USER)!.subscription_tier).toBe('paid');
  });

  it('switched back on, it sends again', async () => {
    fakeDb.seed('app_settings', [{ key: 'notify_new_subscribers', value: 'off' }]);
    const { PATCH } = await import('@/app/api/admin/notification-settings/route');
    await PATCH(jsonRequest('/api/admin/notification-settings', { method: 'PATCH', body: { newSubscriber: true } }) as never);
    await stripe(checkoutCompleted);
    expect(sendNewSubscriberEmail).toHaveBeenCalledTimes(1);
  });

  it('rejects anything but a boolean, and non-admins', async () => {
    const { PATCH } = await import('@/app/api/admin/notification-settings/route');
    expect((await PATCH(jsonRequest('/api/admin/notification-settings', { method: 'PATCH', body: { newSubscriber: 'no' } }) as never)).status).toBe(400);
    vi.mocked(requireAdmin).mockResolvedValueOnce(null as never);
    expect((await PATCH(jsonRequest('/api/admin/notification-settings', { method: 'PATCH', body: { newSubscriber: false } }) as never)).status).toBe(403);
  });
});
