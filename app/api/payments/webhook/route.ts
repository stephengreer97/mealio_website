import { NextRequest, NextResponse } from 'next/server';
import { createHmac } from 'crypto';
import { createServerSupabaseClient } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

function verifySignature(rawBody: string, signature: string, secret: string): boolean {
  const hmac = createHmac('sha256', secret);
  hmac.update(rawBody);
  return hmac.digest('hex') === signature;
}

// Lemon Squeezy subscription statuses that mean the user is active
const ACTIVE_STATUSES = new Set(['active', 'on_trial']);

export async function POST(request: NextRequest) {
  const signature  = request.headers.get('X-Signature') ?? '';
  const eventName  = request.headers.get('X-Event-Name') ?? '';
  const secret     = process.env.LEMONSQUEEZY_WEBHOOK_SECRET ?? '';

  // Must read as text before JSON.parse to preserve exact bytes for HMAC
  const rawBody = await request.text();

  if (!secret || !verifySignature(rawBody, signature, secret)) {
    console.error('Webhook: invalid signature for event', eventName);
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  let payload: any;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  // LS echoes checkout[custom][user_id] back in meta.custom_data
  const userId       = payload.meta?.custom_data?.user_id as string | undefined;
  const userEmail    = payload.data?.attributes?.user_email as string | undefined;
  const lsCustomerId = String(payload.data?.attributes?.customer_id ?? '');
  const lsSubId      = String(payload.data?.id ?? '');
  const status       = payload.data?.attributes?.status as string | undefined;
  const endsAt       = payload.data?.attributes?.ends_at as string | null | undefined;

  const supabase = createServerSupabaseClient();

  // Find the user — prefer the UUID from custom_data, fall back to email
  let query = supabase.from('user_profiles').select('id').limit(1);
  if (userId) {
    query = query.eq('id', userId);
  } else if (userEmail) {
    query = query.eq('email', userEmail);
  } else {
    console.error('Webhook: payload has no user_id or email', { eventName });
    return NextResponse.json({ received: true }); // Return 200 so LS doesn't retry
  }

  const { data: rows } = await query;
  const dbUserId = rows?.[0]?.id;

  if (!dbUserId) {
    console.error('Webhook: user not found', { userId, userEmail, eventName });
    return NextResponse.json({ received: true });
  }

  switch (eventName) {
    case 'subscription_created':
    case 'subscription_resumed':
      await supabase.from('user_profiles').update({
        subscription_tier:            'paid',
        lemonsqueezy_customer_id:     lsCustomerId,
        lemonsqueezy_subscription_id: lsSubId,
        subscription_ends_at:         null,
      }).eq('id', dbUserId);
      console.log(`[LS] ${eventName}: user ${dbUserId} → paid`);
      break;

    case 'subscription_updated': {
      const newTier = ACTIVE_STATUSES.has(status ?? '') ? 'paid' : 'free';
      await supabase.from('user_profiles').update({
        subscription_tier:            newTier,
        lemonsqueezy_customer_id:     lsCustomerId,
        lemonsqueezy_subscription_id: lsSubId,
      }).eq('id', dbUserId);
      console.log(`[LS] subscription_updated: user ${dbUserId} status=${status} → ${newTier}`);
      break;
    }

    case 'subscription_cancelled':
    case 'subscription_expired':
    case 'subscription_payment_failed':
      await supabase.from('user_profiles').update({
        subscription_tier:    'free',
        subscription_ends_at: endsAt ?? null,
      }).eq('id', dbUserId);
      console.log(`[LS] ${eventName}: user ${dbUserId} → free`);
      break;

    default:
      console.log(`[LS] unhandled event: ${eventName}`);
  }

  return NextResponse.json({ received: true });
}
