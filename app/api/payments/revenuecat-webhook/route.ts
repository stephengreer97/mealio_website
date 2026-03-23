import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';
import { log } from '@/lib/logger';

export const dynamic = 'force-dynamic';

// RevenueCat event types that indicate an active subscription
const ACTIVE_EVENTS = new Set([
  'INITIAL_PURCHASE',
  'RENEWAL',
  'UNCANCELLATION',
  'PRODUCT_CHANGE',
  'NON_SUBSCRIPTION_PURCHASE',
]);

// RevenueCat event types that indicate a subscription has lapsed
const LAPSED_EVENTS = new Set([
  'EXPIRATION',
  'BILLING_ISSUE',
]);

export async function POST(request: NextRequest) {
  // Verify shared secret
  const secret = process.env.REVENUECAT_WEBHOOK_SECRET;
  if (secret) {
    const auth = request.headers.get('authorization') ?? '';
    if (auth !== `Bearer ${secret}`) {
      log({ event: 'PAYMENT:RC_WEBHOOK', status: 'failed', reason: 'invalid auth' });
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const event = body?.event;
  if (!event) {
    return NextResponse.json({ error: 'Missing event' }, { status: 400 });
  }

  const eventType: string = event.type ?? '';
  const userId: string = event.app_user_id ?? event.original_app_user_id ?? '';

  if (!userId) {
    log({ event: 'PAYMENT:RC_WEBHOOK', status: 'failed', reason: 'no user id', detail: eventType });
    return NextResponse.json({ received: true });
  }

  const supabase = createServerSupabaseClient();

  if (ACTIVE_EVENTS.has(eventType)) {
    const { error } = await supabase
      .from('user_profiles')
      .update({ subscription_tier: 'paid', subscription_ends_at: null })
      .eq('id', userId);

    if (error) {
      log({ event: 'PAYMENT:RC_WEBHOOK', status: 'error', userId, reason: error.message, detail: eventType });
    } else {
      log({ event: 'PAYMENT:RC_WEBHOOK', status: 'success', userId, detail: `${eventType}→paid` });
    }
  } else if (LAPSED_EVENTS.has(eventType)) {
    const expiresAtMs: number | null = event.expiration_at_ms ?? null;
    const endsAt = expiresAtMs ? new Date(expiresAtMs).toISOString() : null;

    const { error } = await supabase
      .from('user_profiles')
      .update({ subscription_tier: 'free', subscription_ends_at: endsAt })
      .eq('id', userId);

    if (error) {
      log({ event: 'PAYMENT:RC_WEBHOOK', status: 'error', userId, reason: error.message, detail: eventType });
    } else {
      log({ event: 'PAYMENT:RC_WEBHOOK', status: 'success', userId, detail: `${eventType}→free` });
    }
  } else {
    // CANCELLATION — subscription still active until period end, no tier change
    log({ event: 'PAYMENT:RC_WEBHOOK', status: 'pending', userId, detail: eventType, reason: 'no tier change' });
  }

  return NextResponse.json({ received: true });
}
