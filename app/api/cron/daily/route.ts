import { NextRequest, NextResponse } from 'next/server';
import { log } from '@/lib/logger';
import { runCreatorReminders, runUserUpsellDrip } from '@/lib/email-campaigns';
import { resumeStalledSyncRuns } from '@/lib/admin-sync';
import { refreshExpiringTokens } from '@/lib/platform-tokens';
import { createServerSupabaseClient } from '@/lib/supabase';
import { checkPushReceipts } from '@/lib/push';

export const dynamic = 'force-dynamic';

/**
 * Five passes in one invocation, the last of which talks to three third parties.
 *
 * This route declared no `maxDuration` at all while its siblings declare 30-300,
 * so it inherited the platform default — 10s on Hobby. Two separate things went
 * wrong there. The sync sweep could start 200s of sequential work and be killed
 * mid-chunk *holding a lease it had just claimed*, leaving the run it was
 * recovering unavailable to everyone else until that lease expired. And the
 * token sweep can spend real time waiting on Google, Meta and TikTok.
 *
 * 300 is the ceiling because a run killed part-way leaves the platforms at the
 * end of the loop unswept, and Instagram is the one platform where a missed pass
 * costs something that cannot be recovered. Both sweeps hold their own tighter
 * deadlines (`SWEEP_BUDGET_MS` in each) so they stop on their own terms rather
 * than being killed — the two together are what make the backstop honest.
 */
export const maxDuration = 300;

// Daily cron for the lifecycle passes that must run exactly once a day —
// everything email. Kept to one job so we stay within Vercel Hobby's cron
// limits (see vercel.json). Vercel injects `Authorization: Bearer <CRON_SECRET>`
// on scheduled invocations.
//
// The two email passes route through sendMarketingEmail() (suppression + dedup
// + the physical-address gate handled there), so nothing sends until
// MEALIO_MAILING_ADDRESS is set to a real address.
//
// The push pass sends nothing — it reads settled Expo delivery receipts and
// prunes the tokens of uninstalled apps (MEAL-88). It rides along here so a
// receipt written just after the other sweep still gets read the same day; the
// second, offset pass lives at /api/cron/push-receipts, which explains why a
// once-daily sweep is not enough. The pass is idempotent, so running it from
// two schedules is free.
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
    pushTokensPruned: 0,
    syncRunsResumed: 0,
    tokensRefreshed: 0,
    tokensBroken: 0,
    tokensDeferred: 0,
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
  try {
    results.pushTokensPruned = (await checkPushReceipts()).revoked;
  } catch (err: any) {
    log({ event: 'CRON:DAILY', status: 'error', detail: 'pushReceipts', reason: err.message });
  }
  // Admin sync runs are driven by the admin screen, so closing the tab stops the
  // loop. This sweep is the backstop, and it is worth being exact about what it
  // does and does not promise: one fire a day, bounded by `SWEEP_BUDGET_MS`,
  // advances each stalled run by a chunk or two. A small abandoned run finishes
  // here; a 200-item one does not — it takes weeks at a chunk a day, and the
  // real recovery for that is an operator reopening the run and pressing Resume.
  // What this guarantees is that no run is *forgotten*, not that every run
  // finishes without anyone. Nothing publishes from a run either way, so nobody
  // is mis-notified.
  try {
    results.syncRunsResumed = await resumeStalledSyncRuns({ supabase: createServerSupabaseClient() });
  } catch (err: any) {
    log({ event: 'CRON:DAILY', status: 'error', detail: 'syncRuns', reason: err.message });
  }

  // Creator platform grants (MEAL-74 / MEAL-82 / MEAL-83). Every one of the
  // three platforms fails the same silent way — an expired or revoked token
  // produces a poller that finds nothing rather than an error — so this pass
  // exists to turn that into a `broken_reason` an operator can list.
  try {
    const sweep = await refreshExpiringTokens({ supabase: createServerSupabaseClient() });
    results.tokensRefreshed = sweep.refreshed;
    results.tokensBroken = sweep.broken;
    // Reported separately from `broken` on purpose: a provider that was
    // unreachable leaves its grants untouched for tomorrow, so a run where this
    // number is suddenly large is an outage at Google, Instagram or TikTok — not
    // a set of creators to email about reconnecting.
    results.tokensDeferred = sweep.deferred ?? 0;
  } catch (err: any) {
    log({ event: 'CRON:DAILY', status: 'error', detail: 'tokenRefresh', reason: err.message });
  }

  log({ event: 'CRON:DAILY', status: 'success', detail: JSON.stringify(results) });
  return NextResponse.json({ ok: true, ...results });
}
