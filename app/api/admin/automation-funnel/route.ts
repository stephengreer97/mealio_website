import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';
import { requireAdmin } from '@/lib/requireAdmin';
import { aggregateFunnel } from '@/lib/automation-funnel';
import { fetchFunnelRows } from '@/lib/automation-funnel-rows';
import { log } from '@/lib/logger';

// GET /api/admin/automation-funnel?days=30[&storeId=heb]
//
// The per-store add-to-cart reliability dashboard. Answers the question the app
// previously couldn't without asking a user for their logs: what percent of adds
// confirmed, on which step runs die, WHY they died (MEAL-4's failure codes), how
// slow each step is, and whether this week is worse than last.
//
// Response shape:
//   {
//     days, since, truncated, stepRowsScanned, runRowsScanned,
//     stores: StoreFunnel[],   // see lib/automation-funnel.ts
//     alerting: string[],              // store ids alerting for any reason
//     confirmRateAlerting: string[],   // …below the confirm-rate threshold
//     successDropAlerting: string[],   // …fallen away from their own trailing median
//     blockedAlerting: string[],       // …with a large share of runs walled off
//     partialInstrumentation: string[],  // stores whose funnel has no middle
//   }
//
// Fetching and aggregation are deliberately separate — all the interesting logic
// lives in lib/automation-funnel.ts and is unit-tested there.

export const dynamic = 'force-dynamic';

const MAX_DAYS = 90;

export async function GET(request: NextRequest) {
  const admin = await requireAdmin(request);
  if (!admin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const daysParam = Number(request.nextUrl.searchParams.get('days'));
  const days = Number.isFinite(daysParam) && daysParam > 0 ? Math.min(Math.trunc(daysParam), MAX_DAYS) : 30;
  const storeId = request.nextUrl.searchParams.get('storeId');

  const now = Date.now();
  const since = new Date(now - days * 24 * 60 * 60 * 1000).toISOString();
  const supabase = createServerSupabaseClient();

  try {
    // The same read the daily alert email does (`lib/automation-funnel-rows.ts`),
    // handed to the same aggregator with the same thresholds — so the page and
    // the inbox cannot name different stores.
    const rows = await fetchFunnelRows(supabase, { since, storeId });

    const funnel = aggregateFunnel(rows.runs, rows.steps, { now, days });

    return NextResponse.json({
      days,
      since,
      // Surfaced so the dashboard can warn that it is showing a partial window
      // rather than silently under-reporting.
      truncated: rows.truncated,
      stepRowsScanned: rows.stepRowsScanned,
      runRowsScanned: rows.runRowsScanned,
      stores: funnel,
      // Every alerting store, whatever the reason, plus the reason-specific lists
      // the page banners off. A store can be alerting for the blocked reason with
      // a perfect confirm rate, so one undifferentiated list would have the page
      // blame the confirm rate for a WAF campaign.
      alerting: funnel.filter((s) => s.alerting).map((s) => s.storeId),
      confirmRateAlerting: funnel.filter((s) => s.alertReasons.includes('confirm_rate')).map((s) => s.storeId),
      // Stores that have fallen away from their OWN trailing median (MEAL-6).
      // Separate from the confirm-rate list because it is a different claim: not
      // "this store is bad" but "this store got worse", which is the one a
      // renamed selector produces and an absolute floor cannot see.
      successDropAlerting: funnel.filter((s) => s.alertReasons.includes('success_drop')).map((s) => s.storeId),
      blockedAlerting: funnel.filter((s) => s.alertReasons.includes('blocked')).map((s) => s.storeId),
      // Stores whose funnel has no middle at all (MEAL-122). Hoisted to the top
      // level because "HEB looks perfect" is the failure mode of this page, and
      // it should be visible before anyone scrolls.
      partialInstrumentation: funnel.filter((s) => s.coverage.partialInstrumentation).map((s) => s.storeId),
    });
  } catch (error) {
    log({ event: 'ADMIN:AUTOMATION_FUNNEL', status: 'error', userId: admin.userId, error });
    return NextResponse.json({ error: 'Failed to load funnel' }, { status: 500 });
  }
}
