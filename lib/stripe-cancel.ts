import Stripe from 'stripe';

/** Stripe statuses that still bill, or could: everything except the two terminal ones. */
const TERMINAL = new Set<string>(['canceled', 'incomplete_expired']);

/**
 * Shown to a paid account with no Stripe subscription, which is how an App Store
 * or Google Play subscription looks from here. Mealio cannot cancel those: only
 * the store can. Returned alongside `success` for clients that can show it.
 */
export const IN_APP_SUBSCRIPTION_NOTICE =
  'If you subscribed in the Mealio app through the App Store or Google Play, deleting your account does not cancel that subscription. Cancel it in your App Store or Google Play subscription settings.';

export type StripeCancel =
  | { ok: true; cancelled: string[] }
  | { ok: false; reason: string };

function isMissing(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === 'resource_missing';
}

/**
 * Cancels, immediately, every live Stripe subscription an account has.
 *
 * Used by account deletion: a deleted account with a live subscription keeps
 * being charged every month for a product nobody can sign in to. Reads the
 * CUSTOMER's subscriptions rather than trusting `stripe_subscription_id` alone,
 * because a user who cancelled and re-subscribed can have had that column
 * overwritten while an older subscription still runs.
 *
 * Idempotent: a subscription that is already over is skipped, and a customer or
 * subscription Stripe no longer knows about is nothing to cancel, so a retried
 * deletion does not fail on the cancellation the first attempt already made.
 */
export async function cancelStripeSubscriptions(
  customerId: string | null | undefined,
  subscriptionId: string | null | undefined,
): Promise<StripeCancel> {
  if (!customerId && !subscriptionId) return { ok: true, cancelled: [] };

  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return { ok: false, reason: 'STRIPE_SECRET_KEY not configured' };
  const stripe = new Stripe(key);

  const live: string[] = [];
  try {
    if (customerId) {
      for await (const sub of stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 100 })) {
        if (!TERMINAL.has(sub.status)) live.push(sub.id);
      }
    }
    if (subscriptionId && !live.includes(subscriptionId)) {
      try {
        const sub = await stripe.subscriptions.retrieve(subscriptionId);
        if (!TERMINAL.has(sub.status)) live.push(sub.id);
      } catch (err) {
        if (!isMissing(err)) throw err;
      }
    }
  } catch (err) {
    if (!isMissing(err)) return { ok: false, reason: `list failed: ${String(err)}` };
  }

  const cancelled: string[] = [];
  for (const id of live) {
    try {
      await stripe.subscriptions.cancel(id);
      cancelled.push(id);
    } catch (err) {
      if (isMissing(err)) continue;
      return { ok: false, reason: `cancel ${id} failed: ${String(err)}` };
    }
  }
  return { ok: true, cancelled };
}
