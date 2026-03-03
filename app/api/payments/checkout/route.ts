import { NextRequest, NextResponse } from 'next/server';
import Stripe from 'stripe';
import { createServerSupabaseClient } from '@/lib/supabase';
import { verifyAccessToken, extractTokenFromHeader } from '@/lib/tokens';
import { log } from '@/lib/logger';

export const dynamic = 'force-dynamic';

// APP_URL_SERVER is a server-only env var (no NEXT_PUBLIC_ prefix) so it is
// available at runtime in Vercel functions. NEXT_PUBLIC_APP_URL is inlined at
// build time and may be undefined on the server if not explicitly set.
const APP_URL = (process.env.APP_URL_SERVER ?? process.env.NEXT_PUBLIC_APP_URL ?? 'https://mealio.co').replace(/\/$/, '');

export async function POST(request: NextRequest) {
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
  if (!priceId) return NextResponse.json({ error: 'priceId is required — check NEXT_PUBLIC_STRIPE_MONTHLY_PRICE_ID / NEXT_PUBLIC_STRIPE_ANNUAL_PRICE_ID env vars' }, { status: 400 });

  const supabase = createServerSupabaseClient();
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('stripe_customer_id')
    .eq('id', decoded.userId)
    .single();

  const sessionParams: Stripe.Checkout.SessionCreateParams = {
    mode: 'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    metadata: { user_id: decoded.userId },
    success_url: `${APP_URL}/dashboard?subscribed=1`,
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
