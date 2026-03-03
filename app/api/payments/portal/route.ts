import { NextRequest, NextResponse } from 'next/server';
import Stripe from 'stripe';
import { createServerSupabaseClient } from '@/lib/supabase';
import { verifyAccessToken, extractTokenFromHeader } from '@/lib/tokens';
import { log } from '@/lib/logger';

export const dynamic = 'force-dynamic';


export async function GET(request: NextRequest) {
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

  const supabase = createServerSupabaseClient();
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('stripe_customer_id')
    .eq('id', decoded.userId)
    .single();

  if (!profile?.stripe_customer_id) {
    // User has no Stripe subscription yet (e.g. manually granted tier or legacy LS subscriber).
    // Send them to pricing to set up a Stripe subscription.
    return NextResponse.json({ portalUrl: `${APP_URL}/pricing` });
  }

  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: profile.stripe_customer_id,
      return_url: `${APP_URL}/dashboard`,
    });
    return NextResponse.json({ portalUrl: session.url });
  } catch (err) {
    log({ event: 'PAYMENT:PORTAL', status: 'error', userId: decoded.userId, reason: String(err) });
    return NextResponse.json({ error: 'Failed to reach billing portal' }, { status: 502 });
  }
}
