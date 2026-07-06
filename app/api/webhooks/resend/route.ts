import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { createServerSupabaseClient } from '@/lib/supabase';
import { log } from '@/lib/logger';

export const dynamic = 'force-dynamic';

// Resend signs webhooks with Svix. Verify HMAC-SHA256 over
// `${svix-id}.${svix-timestamp}.${rawBody}` using the base64 secret (after the
// `whsec_` prefix). Header `svix-signature` is a space-separated list of
// `v1,<sig>` entries.
function verifySvix(secret: string, id: string, timestamp: string, sigHeader: string, body: string): boolean {
  try {
    const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
    const expected = crypto.createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64');
    const expectedBuf = Buffer.from(expected);
    return sigHeader.split(' ').some((part) => {
      const sig = part.split(',')[1];
      if (!sig) return false;
      const sigBuf = Buffer.from(sig);
      return sigBuf.length === expectedBuf.length && crypto.timingSafeEqual(sigBuf, expectedBuf);
    });
  } catch {
    return false;
  }
}

const STATUS_BY_EVENT: Record<string, string> = {
  'email.delivered': 'delivered',
  'email.opened': 'opened',
  'email.clicked': 'clicked',
  'email.bounced': 'bounced',
  'email.complained': 'complained',
};

export async function POST(request: NextRequest) {
  const body = await request.text();

  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (secret) {
    const ok = verifySvix(
      secret,
      request.headers.get('svix-id') ?? '',
      request.headers.get('svix-timestamp') ?? '',
      request.headers.get('svix-signature') ?? '',
      body,
    );
    if (!ok) {
      log({ event: 'EMAIL:WEBHOOK', status: 'failed', reason: 'invalid signature' });
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  let payload: any;
  try {
    payload = JSON.parse(body);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const type: string = payload?.type ?? '';
  const newStatus = STATUS_BY_EVENT[type];
  if (!newStatus) return NextResponse.json({ received: true }); // e.g. email.sent — ignore

  const messageId: string = payload?.data?.email_id ?? '';
  const to = payload?.data?.to;
  const email: string = Array.isArray(to) ? to[0] : (to ?? '');

  const supabase = createServerSupabaseClient();

  if (messageId) {
    const patch: Record<string, unknown> = { status: newStatus };
    if (type === 'email.opened') patch.opened_at = new Date().toISOString();
    if (type === 'email.clicked') patch.clicked_at = new Date().toISOString();
    await supabase.from('email_sends').update(patch).eq('resend_message_id', messageId);
  }

  // Hard suppression: a bounce or spam complaint stops all future marketing to
  // this address.
  if ((type === 'email.bounced' || type === 'email.complained') && email) {
    await supabase.from('user_profiles').update({ marketing_opt_out: true }).eq('email', email);
    log({ event: 'EMAIL:WEBHOOK', status: 'success', email, detail: `${type}->opt_out` });
  } else {
    log({ event: 'EMAIL:WEBHOOK', status: 'success', detail: type });
  }

  return NextResponse.json({ received: true });
}
