import { NextRequest, NextResponse } from 'next/server';
import { log } from '@/lib/logger';
import { checkPushReceipts } from '@/lib/push';

export const dynamic = 'force-dynamic';

// Second daily receipt sweep (MEAL-88), scheduled ~12 h from /api/cron/daily.
//
// Expo keeps a delivery receipt for about a day. One sweep a day is therefore
// running with no margin at all: a send five minutes after the cron has its
// receipts read 23 h 55 m later, and anything past RECEIPT_SWEEP_LIMIT in a
// single run waits a further full day, by which point the receipt has expired
// and the dead device behind it is never pruned from it. A second pass halves
// the worst-case read latency and doubles the daily pruning ceiling.
//
// It is a route of its own rather than a second schedule on /api/cron/daily
// because the email passes there must NOT run twice a day. That makes two cron
// jobs, which is the Vercel Hobby ceiling — a third sweep would need a plan
// change, and more frequent scheduling than once-per-job-per-day would too.
export async function GET(request: NextRequest) {
  // Fail CLOSED if the cron secret isn't configured — never run unauthenticated.
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    log({ event: 'CRON:PUSH_RECEIPTS', status: 'error', reason: 'CRON_SECRET not configured' });
    return NextResponse.json({ error: 'Cron not configured' }, { status: 500 });
  }
  const auth = request.headers.get('authorization') ?? '';
  if (auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let pushTokensPruned = 0;
  try {
    pushTokensPruned = (await checkPushReceipts()).revoked;
  } catch (err: any) {
    log({ event: 'CRON:PUSH_RECEIPTS', status: 'error', reason: err.message });
  }

  log({ event: 'CRON:PUSH_RECEIPTS', status: 'success', detail: `pushTokensPruned=${pushTokensPruned}` });
  return NextResponse.json({ ok: true, pushTokensPruned });
}
