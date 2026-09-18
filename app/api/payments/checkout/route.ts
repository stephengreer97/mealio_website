import { NextRequest, NextResponse } from 'next/server';
import Stripe from 'stripe';
import { createServerSupabaseClient } from '@/lib/supabase';
import { verifyAccessToken, extractTokenFromHeader } from '@/lib/tokens';
import { log } from '@/lib/logger';

export const dynamic = 'force-dynamic';


export async function POST(request: NextRequest) {
  const host = request.headers.get('host') ?? 'mealio.co';
  const proto = host.startsWith('localhost') ? 'http' : 'https';
  const APP_URL = `${proto}://${host}`;

  if (!process.env.STRIPE_SECRET_KEY) {
    return NextResponse.json({ error: 'Stripe is not configured' }, { status: 503 });
  }
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

  const token = extractTokenFromHeader(request.headers.get('authorization'));
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const decoded = await verifyAccessToken(token);
  if (!decoded) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: { priceId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { priceId } = body;
  if (!priceId) return NextResponse.json({ error: 'priceId is required. Check NEXT_PUBLIC_STRIPE_MONTHLY_PRICE_ID / NEXT_PUBLIC_STRIPE_ANNUAL_PRICE_ID env vars' }, { status: 400 });

  // Allow-list the price: only our configured monthly/annual plans may be used,
  // otherwise a client could subscribe to an arbitrary Stripe price.
  const allowedPriceIds = [
    process.env.NEXT_PUBLIC_STRIPE_MONTHLY_PRICE_ID,
    process.env.NEXT_PUBLIC_STRIPE_ANNUAL_PRICE_ID,
  ].filter(Boolean);
  if (!allowedPriceIds.includes(priceId)) {
    log({ event: 'PAYMENT:CHECKOUT', status: 'failed', userId: decoded.userId, reason: 'invalid priceId' });
    return NextResponse.json({ error: 'Invalid priceId' }, { status: 400 });
  }

  const supabase = createServerSupabaseClient();
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('stripe_customer_id, subscription_tier')
    .eq('id', decoded.userId)
    .single();

  // ALREADY PAYING? Then this is not a sale. Nothing stopped a paid user from
  // starting a second Stripe subscription and being billed twice for the same
  // Full Access. Stripe is asked directly rather than trusting the tier, which
  // can lag the webhook: anyone with a live subscription is sent to the billing
  // portal to manage the one they have.
  if (profile?.stripe_customer_id) {
    try {
      const subs = await stripe.subscriptions.list({ customer: profile.stripe_customer_id, status: 'all', limit: 20 });
      if (subs.data.some((s) => s.status === 'active' || s.status === 'trialing' || s.status === 'past_due')) {
        const portal = await stripe.billingPortal.sessions.create({
          customer: profile.stripe_customer_id,
          return_url: `${APP_URL}/discover`,
        });
        log({ event: 'PAYMENT:CHECKOUT', status: 'failed', userId: decoded.userId, reason: 'already subscribed; sent to portal' });
        return NextResponse.json({ url: portal.url, alreadySubscribed: true });
      }
    } catch (err: any) {
      const detail = err?.message ?? String(err);
      log({ event: 'PAYMENT:CHECKOUT', status: 'error', userId: decoded.userId, reason: detail, detail: 'subscription check failed' });
      return NextResponse.json({ error: 'Could not check your current subscription. Please try again.' }, { status: 502 });
    }
  }

  // Paid with no live Stripe subscription: bought in the app (RevenueCat) or
  // granted by hand. A Stripe checkout on top would charge for what they have.
  if (profile?.subscription_tier === 'paid') {
    log({ event: 'PAYMENT:CHECKOUT', status: 'failed', userId: decoded.userId, reason: 'already paid (not via Stripe)' });
    return NextResponse.json(
      { error: 'You already have Full Access. Manage your subscription where you bought it.' },
      { status: 409 },
    );
  }

  const sessionParams: Stripe.Checkout.SessionCreateParams = {
    mode: 'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    metadata: { user_id: decoded.userId },
    success_url: `${APP_URL}/discover?subscribed=1`,
    cancel_url: `${APP_URL}/pricing`,
    allow_promotion_codes: true,
  };

  if (profile?.stripe_customer_id) {
    sessionParams.customer = profile.stripe_customer_id;
  } else {
    sessionParams.customer_email = decoded.email;
  }

  try {
    const session = await stripe.checkout.sessions.create(sessionParams);
    log({ event: 'PAYMENT:CHECKOUT', status: 'success', userId: decoded.userId });
    return NextResponse.json({ url: session.url });
  } catch (err: any) {
    const detail = err?.message ?? String(err);
    log({ event: 'PAYMENT:CHECKOUT', status: 'error', userId: decoded.userId, reason: detail });
    return NextResponse.json({ error: 'Failed to create checkout session', detail }, { status: 500 });
  }
}
