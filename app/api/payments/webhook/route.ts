import { NextRequest, NextResponse } from 'next/server';
import Stripe from 'stripe';
import { createServerSupabaseClient } from '@/lib/supabase';
import { log } from '@/lib/logger';

export const dynamic = 'force-dynamic';

// Stripe requires the raw body for signature verification
export async function POST(request: NextRequest) {
  if (!process.env.STRIPE_SECRET_KEY) {
    return NextResponse.json({ error: 'Stripe is not configured' }, { status: 503 });
  }
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

  const sig = request.headers.get('stripe-signature') ?? '';
  const secret = process.env.STRIPE_WEBHOOK_SECRET ?? '';
  const rawBody = await request.text();

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, secret);
  } catch (err) {
    log({ event: 'PAYMENT:WEBHOOK', status: 'failed', reason: 'invalid signature', detail: String(err) });
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  const supabase = createServerSupabaseClient();

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session;
      const userId = session.metadata?.user_id;
      const stripeCustomerId = typeof session.customer === 'string' ? session.customer : session.customer?.id;
      const stripeSubId = typeof session.subscription === 'string' ? session.subscription : session.subscription?.id;

      if (!userId) {
        log({ event: 'PAYMENT:WEBHOOK', status: 'failed', reason: 'no user_id in metadata', detail: event.type });
        break;
      }

      const { error: updateErr } = await supabase.from('user_profiles').update({
        subscription_tier: 'paid',
        stripe_customer_id: stripeCustomerId ?? null,
        stripe_subscription_id: stripeSubId ?? null,
        subscription_ends_at: null,
      }).eq('id', userId);

      if (updateErr) {
        log({ event: 'PAYMENT:WEBHOOK', status: 'error', userId, reason: updateErr.message, detail: 'update failed' });
        break;
      }

      const { error: insertErr } = await supabase.from('subscription_events').insert({ user_id: userId, event: 'started' });
      if (insertErr) {
        log({ event: 'PAYMENT:WEBHOOK', status: 'error', userId, reason: insertErr.message, detail: 'subscription_events insert failed' });
      }

      log({ event: 'PAYMENT:WEBHOOK', status: 'success', userId, detail: 'checkout.session.completed→paid' });
      break;
    }

    case 'customer.subscription.updated': {
      const sub = event.data.object as Stripe.Subscription;
      const stripeCustomerId = typeof sub.customer === 'string' ? sub.customer : sub.customer.id;
      const newTier = (sub.status === 'active' || sub.status === 'trialing') ? 'paid' : 'free';

      const { data: rows } = await supabase
        .from('user_profiles')
        .select('id')
        .eq('stripe_customer_id', stripeCustomerId)
        .limit(1);

      const dbUserId = rows?.[0]?.id;
      if (!dbUserId) {
        log({ event: 'PAYMENT:WEBHOOK', status: 'failed', reason: 'user not found', detail: event.type });
        break;
      }

      await supabase.from('user_profiles').update({ subscription_tier: newTier }).eq('id', dbUserId);
      log({ event: 'PAYMENT:WEBHOOK', status: 'success', userId: dbUserId, detail: `subscription.updated→${newTier}` });
      break;
    }

    case 'customer.subscription.deleted': {
      const sub = event.data.object as Stripe.Subscription;
      const stripeCustomerId = typeof sub.customer === 'string' ? sub.customer : sub.customer.id;
      const endsAt = sub.canceled_at ? new Date(sub.canceled_at * 1000).toISOString() : null;

      const { data: rows } = await supabase
        .from('user_profiles')
        .select('id')
        .eq('stripe_customer_id', stripeCustomerId)
        .limit(1);

      const dbUserId = rows?.[0]?.id;
      if (!dbUserId) {
        log({ event: 'PAYMENT:WEBHOOK', status: 'failed', reason: 'user not found', detail: event.type });
        break;
      }

      await supabase.from('user_profiles').update({
        subscription_tier: 'free',
        subscription_ends_at: endsAt,
      }).eq('id', dbUserId);

      await supabase.from('subscription_events').insert({ user_id: dbUserId, event: 'cancelled' });
      log({ event: 'PAYMENT:WEBHOOK', status: 'success', userId: dbUserId, detail: 'subscription.deleted→free' });
      break;
    }

    case 'invoice.payment_failed': {
      // Stripe retries automatically — log only, don't downgrade
      const invoice = event.data.object as Stripe.Invoice;
      const stripeCustomerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id;
      log({ event: 'PAYMENT:WEBHOOK', status: 'pending', detail: 'invoice.payment_failed', reason: stripeCustomerId ?? 'unknown customer' });
      break;
    }

    default:
      log({ event: 'PAYMENT:WEBHOOK', status: 'pending', detail: event.type, reason: 'unhandled event' });
  }

  return NextResponse.json({ received: true });
}
