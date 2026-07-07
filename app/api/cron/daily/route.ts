import { NextRequest, NextResponse } from 'next/server';
import { log } from '@/lib/logger';
import { runCreatorReminders, runUserUpsellDrip } from '@/lib/email-campaigns';

export const dynamic = 'force-dynamic';

// Single daily cron for all lifecycle email passes — kept to one job so we stay
// within Vercel Hobby's cron limits (see vercel.json). Vercel injects
// `Authorization: Bearer <CRON_SECRET>` on scheduled invocations.
//
// Both passes route through sendMarketingEmail() (suppression + dedup + the
// physical-address gate handled there), so nothing sends until
// MEALIO_MAILING_ADDRESS is set to a real address.
export async function GET(request: NextRequest) {
  // Fail CLOSED if the cron secret isn't configured — never run unauthenticated.
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    log({ event: 'CRON:DAILY', status: 'error', reason: 'CRON_SECRET not configured' });
    return NextResponse.json({ error: 'Cron not configured' }, { status: 500 });
  }
  const auth = request.headers.get('authorization') ?? '';
  if (auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const results = { creatorReminders: 0, userUpsell: 0 };

  // Isolate the passes so one failing doesn't drop the other.
  try {
    results.creatorReminders = await runCreatorReminders();
  } catch (err: any) {
    log({ event: 'CRON:DAILY', status: 'error', detail: 'creatorReminders', reason: err.message });
  }
  try {
    results.userUpsell = await runUserUpsellDrip();
  } catch (err: any) {
    log({ event: 'CRON:DAILY', status: 'error', detail: 'userUpsell', reason: err.message });
  }

  log({ event: 'CRON:DAILY', status: 'success', detail: JSON.stringify(results) });
  return NextResponse.json({ ok: true, ...results });
}
