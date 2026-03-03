import { NextResponse } from 'next/server';
import Stripe from 'stripe';
import { createServerSupabaseClient } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

// Temporary diagnostic endpoint — DELETE after debugging.
// Returns a plain-text checklist of what is/isn't working.
export async function GET() {
  const results: Record<string, string> = {};

  // 1. Env vars present?
  results.STRIPE_SECRET_KEY      = process.env.STRIPE_SECRET_KEY      ? `set (${process.env.STRIPE_SECRET_KEY.slice(0, 7)}...)` : 'MISSING';
  results.STRIPE_WEBHOOK_SECRET  = process.env.STRIPE_WEBHOOK_SECRET  ? `set (${process.env.STRIPE_WEBHOOK_SECRET.slice(0, 7)}...)` : 'MISSING';
  results.STRIPE_MONTHLY_PRICE   = process.env.NEXT_PUBLIC_STRIPE_MONTHLY_PRICE_ID || 'MISSING';
  results.STRIPE_ANNUAL_PRICE    = process.env.NEXT_PUBLIC_STRIPE_ANNUAL_PRICE_ID  || 'MISSING';

  // 2. Can Stripe initialize + reach the API?
  if (process.env.STRIPE_SECRET_KEY) {
    try {
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
      const acct = await stripe.accounts.retrieve();
      results.stripe_api = `OK — account: ${acct.id} (${acct.charges_enabled ? 'charges enabled' : 'charges NOT enabled'})`;
    } catch (err: any) {
      results.stripe_api = `FAILED — ${err?.message ?? String(err)}`;
    }

    // 3. Do the price IDs resolve?
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    for (const [label, priceId] of [
      ['monthly_price', process.env.NEXT_PUBLIC_STRIPE_MONTHLY_PRICE_ID],
      ['annual_price',  process.env.NEXT_PUBLIC_STRIPE_ANNUAL_PRICE_ID],
    ] as [string, string | undefined][]) {
      if (!priceId) { results[label] = 'MISSING'; continue; }
      try {
        const price = await stripe.prices.retrieve(priceId);
        results[label] = `OK — ${price.currency.toUpperCase()} ${((price.unit_amount ?? 0) / 100).toFixed(2)} / ${price.recurring?.interval ?? 'one-time'} (${price.active ? 'active' : 'INACTIVE'})`;
      } catch (err: any) {
        results[label] = `FAILED — ${err?.message ?? String(err)}`;
      }
    }
  }

  // 4. Does the stripe_customer_id column exist in the DB?
  try {
    const supabase = createServerSupabaseClient();
    const { error } = await supabase
      .from('user_profiles')
      .select('stripe_customer_id')
      .limit(1);
    results.db_stripe_customer_id_column = error ? `MISSING — ${error.message}` : 'OK';
  } catch (err: any) {
    results.db_stripe_customer_id_column = `ERROR — ${err?.message ?? String(err)}`;
  }

  return NextResponse.json(results, { status: 200 });
}
