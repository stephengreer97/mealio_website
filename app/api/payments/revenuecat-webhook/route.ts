import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';
import { log } from '@/lib/logger';
import { grantPaid, endPaid, canEnd, sourceFromRevenueCatStore } from '@/lib/subscription-source';
import { notifyAdminsOfNewSubscriber } from '@/lib/new-subscriber-alert';

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
  // Verify shared secret — fail CLOSED if it isn't configured so we never grant
  // paid access on an unauthenticated request.
  const secret = process.env.REVENUECAT_WEBHOOK_SECRET;
  if (!secret) {
    log({ event: 'PAYMENT:RC_WEBHOOK', status: 'error', reason: 'REVENUECAT_WEBHOOK_SECRET not configured' });
    return NextResponse.json({ error: 'Webhook not configured' }, { status: 500 });
  }
  const auth = request.headers.get('authorization') ?? '';
  if (auth !== `Bearer ${secret}`) {
    log({ event: 'PAYMENT:RC_WEBHOOK', status: 'failed', reason: 'invalid auth' });
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
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

  // TRANSFER names no app_user_id at all: it moves a store purchase from one set
  // of users to another, so it is handled before the single-user path below
  // (which would drop it as "no user id").
  if (eventType === 'TRANSFER') {
    await handleTransfer(createServerSupabaseClient(), event);
    return NextResponse.json({ received: true });
  }

  const userId: string = event.app_user_id ?? event.original_app_user_id ?? '';

  if (!userId) {
    log({ event: 'PAYMENT:RC_WEBHOOK', status: 'failed', reason: 'no user id', detail: eventType });
    return NextResponse.json({ received: true });
  }

  const supabase = createServerSupabaseClient();

  if (ACTIVE_EVENTS.has(eventType)) {
    const source = sourceFromRevenueCatStore(event.store);
    const { error } = await grantPaid(supabase, userId, source, { subscription_ends_at: null });

    if (error) {
      log({ event: 'PAYMENT:RC_WEBHOOK', status: 'error', userId, reason: error.message, detail: eventType });
    } else {
      log({ event: 'PAYMENT:RC_WEBHOOK', status: 'success', userId, detail: `${eventType}→paid (${source})` });
      // Only the first purchase is a new subscriber; renewals and the rest are not.
      if (eventType === 'INITIAL_PURCHASE') {
        await notifyAdminsOfNewSubscriber(supabase, userId, source);
      }
    }
  } else if (LAPSED_EVENTS.has(eventType)) {
    const expiresAtMs: number | null = event.expiration_at_ms ?? null;
    const endsAt = expiresAtMs ? new Date(expiresAtMs).toISOString() : null;

    // A store purchase lapsing ends only access a store gave: a web subscriber
    // or a comped creator whose trial purchase expired keeps Full Access.
    const { kept, error } = await endPaid(supabase, userId, 'revenuecat', { subscription_ends_at: endsAt });

    if (error) {
      log({ event: 'PAYMENT:RC_WEBHOOK', status: 'error', userId, reason: error.message, detail: eventType });
    } else if (kept.length) {
      log({ event: 'PAYMENT:RC_WEBHOOK', status: 'success', userId, detail: `${eventType}: tier kept (source ${kept[0].source})` });
    } else {
      log({ event: 'PAYMENT:RC_WEBHOOK', status: 'success', userId, detail: `${eventType}→free` });
    }
  } else {
    // CANCELLATION — subscription still active until period end, no tier change
    log({ event: 'PAYMENT:RC_WEBHOOK', status: 'pending', userId, detail: eventType, reason: 'no tier change' });
  }

  return NextResponse.json({ received: true });
}

/** Our user ids are uuids; RevenueCat also lists its own `$RCAnonymousID:...` aliases, which match no profile. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuidList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.filter((x): x is string => typeof x === 'string' && UUID_RE.test(x)))];
}

/**
 * A store purchase moved between app users (a restore on a different Mealio
 * account). Before this, TRANSFER fell into the no-op branch: the old owner kept
 * `paid` for ever with nothing left to expire it (RevenueCat sends the old owner
 * no further events), and the new owner was never upgraded.
 *
 * The event shape is `{ type: 'TRANSFER', transferred_from: string[],
 * transferred_to: string[] }`, with no app_user_id and usually no entitlement or
 * expiry. So:
 *
 *  - FROM users go to free, unless their access came from somewhere other than
 *    a store (`subscription_source`: a web subscription or a comp is not
 *    affected by a store purchase leaving).
 *  - TO users go to paid when the transferred purchase carries access. When the
 *    event lists `entitlement_ids`, that list decides (empty means nothing
 *    active moved). When it does not, the old owners decide: if any of them was
 *    paid through the store, what moved was live access. An expiry already in
 *    the past never upgrades.
 *
 * Idempotent: every write sets an absolute state, so a redelivered TRANSFER
 * writes the same rows to the same values.
 */
async function handleTransfer(supabase: ReturnType<typeof createServerSupabaseClient>, event: any) {
  const from = uuidList(event.transferred_from);
  const to = uuidList(event.transferred_to).filter((id) => !from.includes(id));

  const { data: fromProfiles, error: readErr } = from.length
    ? await supabase
        .from('user_profiles')
        .select('id, subscription_tier, subscription_source')
        .in('id', from)
        .limit(from.length)
    : { data: [] as Array<{ id: string; subscription_tier: string | null; subscription_source: string | null }>, error: null };

  if (readErr) {
    log({ event: 'PAYMENT:RC_WEBHOOK', status: 'error', reason: readErr.message, detail: 'TRANSFER read failed' });
    return;
  }

  const rows = fromProfiles ?? [];
  const storePaid = rows.filter((p) => p.subscription_tier === 'paid' && canEnd('revenuecat', p.subscription_source));
  const nowIso = new Date().toISOString();

  if (storePaid.length) {
    const ids = storePaid.map((p) => p.id);
    const { error } = await endPaid(supabase, ids, 'revenuecat', { subscription_ends_at: nowIso });
    if (error) {
      log({ event: 'PAYMENT:RC_WEBHOOK', status: 'error', reason: error.message, detail: `TRANSFER downgrade ${ids.join(',')}` });
    } else {
      log({ event: 'PAYMENT:RC_WEBHOOK', status: 'success', detail: `TRANSFER→free ${ids.join(',')}` });
    }
  }

  const expiresAtMs: number | null = typeof event.expiration_at_ms === 'number' ? event.expiration_at_ms : null;
  const expired = expiresAtMs !== null && expiresAtMs <= Date.now();
  const carriesAccess = Array.isArray(event.entitlement_ids)
    ? event.entitlement_ids.length > 0
    : storePaid.length > 0;

  if (to.length && carriesAccess && !expired) {
    const { error } = await grantPaid(supabase, to, sourceFromRevenueCatStore(event.store), { subscription_ends_at: null });
    if (error) {
      log({ event: 'PAYMENT:RC_WEBHOOK', status: 'error', reason: error.message, detail: `TRANSFER upgrade ${to.join(',')}` });
    } else {
      log({ event: 'PAYMENT:RC_WEBHOOK', status: 'success', detail: `TRANSFER→paid ${to.join(',')}` });
    }
  } else {
    log({
      event: 'PAYMENT:RC_WEBHOOK', status: 'pending', detail: 'TRANSFER',
      reason: to.length ? 'transferred purchase carries no active access' : 'no Mealio user to transfer to',
    });
  }
}
