import { NextRequest, NextResponse } from 'next/server';
import { log } from '@/lib/logger';
import { runCreatorReminders, runUserUpsellDrip } from '@/lib/email-campaigns';
import { resumeStalledSyncRuns } from '@/lib/admin-sync';
import { createServerSupabaseClient } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

/**
 * Long enough for two email passes and one bounded sweep of stalled sync runs.
 *
 * Without it this function ran at the platform default — 10s on Hobby — while
 * the sweep alone could start 200s of sequential work. What actually happened
 * was worse than slow: the function was killed mid-chunk *holding a lease it
 * had just claimed*, so the run it was recovering became unavailable to
 * everyone else until that lease expired. `SWEEP_BUDGET_MS` keeps the sweep
 * inside this number; the two together are what make the backstop honest.
 */
export const maxDuration = 60;

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

  const results = { creatorReminders: 0, userUpsell: 0, syncRunsResumed: 0 };

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
  // loop. This sweep is the backstop, and it is worth being exact about what it
  // does and does not promise: one fire a day, bounded by `SWEEP_BUDGET_MS`,
  // advances each stalled run by a chunk or two. A small abandoned run finishes
  // here; a 200-item one does not — it takes weeks at a chunk a day, and the
  // real recovery for that is an operator reopening the run and pressing Resume.
  // What this guarantees is that no run is *forgotten*, not that every run
  // finishes without anyone. Finishing large abandoned runs unattended needs a
  // job queue, which this project does not have and this cron cannot pretend to
  // be. Nothing publishes from a run either way, so nobody is mis-notified.
  try {
    results.syncRunsResumed = await resumeStalledSyncRuns({ supabase: createServerSupabaseClient() });
  } catch (err: any) {
    log({ event: 'CRON:DAILY', status: 'error', detail: 'syncRuns', reason: err.message });
  }

  log({ event: 'CRON:DAILY', status: 'success', detail: JSON.stringify(results) });
  return NextResponse.json({ ok: true, ...results });
}
