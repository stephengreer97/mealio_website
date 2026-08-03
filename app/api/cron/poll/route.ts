import { NextRequest, NextResponse } from 'next/server';
import { log } from '@/lib/logger';
import { runPollPass, POLL_INTERVAL_MINUTES } from '@/lib/creator-poller';
import { createServerSupabaseClient } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

/**
 * One pass of the creator feed poller (MEAL-75).
 *
 * Its own cron rather than a fifth pass inside `/api/cron/daily`, because the
 * two want opposite schedules the moment the plan allows it: the daily job is
 * lifecycle email that must fire exactly once a day, and this one wants to fire
 * as often as the plan permits (`POLL_INTERVAL_MINUTES`). Folding them together
 * would either send the drip email every fifteen minutes or leave the poller on
 * a daily cadence forever.
 *
 * 300 is the ceiling, and `runPollPass` holds a tighter deadline of its own
 * (`POLL_PASS_BUDGET_MS`) so it stops on its own terms rather than being killed
 * mid-extraction. A killed pass is not merely truncated — an item whose fetch
 * and model calls were paid for but whose record was never written costs the
 * money twice.
 */
export const maxDuration = 300;

export async function GET(request: NextRequest) {
  // Fail CLOSED if the cron secret isn't configured. This endpoint spends money
  // per invocation and emails partners under our name; unauthenticated is not a
  // degraded mode it may run in.
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    log({ event: 'CRON:POLL', status: 'error', reason: 'CRON_SECRET not configured' });
    return NextResponse.json({ error: 'Cron not configured' }, { status: 500 });
  }
  const auth = request.headers.get('authorization') ?? '';
  if (auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const pass = await runPollPass({ supabase: createServerSupabaseClient() });

    // `signals` is the part worth reading. Everything else is a count that
    // trends; a signal is a specific creator whose source has started behaving
    // differently, and it is in the response body rather than only in the log so
    // that whoever is watching the cron sees it without going looking.
    //
    // `sourcesFailed` counts with it. A pass in which every feed returned a 500
    // raises no signal — nothing *changed*, each source simply failed — and
    // reported `polled: 0` with everything else zero, which is character for
    // character what a quiet healthy pass looks like. Fifty creators silently
    // not being polled is exactly the thing a cron log is for.
    const wrong = pass.signals.length > 0 || pass.sourcesFailed > 0;
    log({
      event: 'CRON:POLL',
      status: wrong ? 'error' : 'success',
      detail: JSON.stringify({ intervalMinutes: POLL_INTERVAL_MINUTES, ...pass }),
    });

    return NextResponse.json({ ok: true, intervalMinutes: POLL_INTERVAL_MINUTES, ...pass });
  } catch (err: any) {
    // A pass that throws has left every creator it did not reach untouched, so
    // the next one picks them up in the same order. Reported as a 500 so a
    // failing cron shows up as a failing cron.
    log({ event: 'CRON:POLL', status: 'error', error: err });
    return NextResponse.json({ error: 'Poll pass failed', detail: err?.message ?? String(err) }, { status: 500 });
  }
}
