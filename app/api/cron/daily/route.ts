import { NextRequest, NextResponse } from 'next/server';
import { log } from '@/lib/logger';
import { runCreatorReminders, runUserUpsellDrip } from '@/lib/email-campaigns';
import { resumeStalledSyncRuns } from '@/lib/admin-sync';
import { refreshExpiringTokens } from '@/lib/platform-tokens';
import { createServerSupabaseClient } from '@/lib/supabase';

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

  const results = {
    creatorReminders: 0,
    userUpsell: 0,
    syncRunsResumed: 0,
    tokensRefreshed: 0,
    tokensBroken: 0,
    tokensRetried: 0,
  };

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
  // Admin sync runs are driven by the admin screen, so closing the tab stops the
  // loop. This is the backstop: a half-finished run gets finished, and — the
  // part that actually matters — the creator still gets told what published
  // under their name. Slow, but it means no run is abandoned silently.
  try {
    results.syncRunsResumed = await resumeStalledSyncRuns({ supabase: createServerSupabaseClient() });
  } catch (err: any) {
    log({ event: 'CRON:DAILY', status: 'error', detail: 'syncRuns', reason: err.message });
  }

  // Creator platform grants (MEAL-74 / MEAL-82 / MEAL-83). Every one of the
  // three platforms fails the same silent way — an expired or revoked token
  // produces a poller that finds nothing rather than an error — so this pass
  // exists to turn that into a `broken_reason` an operator can list.
  //
  // `tokensRetried` is reported alongside: a provider that was unreachable
  // leaves its grants untouched for tomorrow, and a run where that number is
  // suddenly large is an outage rather than a set of creators to email.
  try {
    const sweep = await refreshExpiringTokens({ supabase: createServerSupabaseClient() });
    results.tokensRefreshed = sweep.refreshed;
    results.tokensBroken = sweep.broken;
    results.tokensRetried = sweep.retried;
  } catch (err: any) {
    log({ event: 'CRON:DAILY', status: 'error', detail: 'tokenRefresh', reason: err.message });
  }

  log({ event: 'CRON:DAILY', status: 'success', detail: JSON.stringify(results) });
  return NextResponse.json({ ok: true, ...results });
}
