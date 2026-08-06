import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';
import { requireAdmin } from '@/lib/requireAdmin';
import { aggregateFunnel, RunRow, StepRow } from '@/lib/automation-funnel';
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
//     blockedAlerting: string[],       // …with a large share of runs walled off
//     partialInstrumentation: string[],  // stores whose funnel has no middle
//   }
//
// Fetching and aggregation are deliberately separate — all the interesting logic
// lives in lib/automation-funnel.ts and is unit-tested there.

export const dynamic = 'force-dynamic';

const MAX_DAYS = 90;
// PostgREST caps a single select at db-max-rows (1000 on Supabase) and says
// NOTHING about having truncated. Thirty days of steps is far past that, and so
// is thirty days of runs on a busy month — BOTH have to be paged, or the funnel
// silently reports the first page of the window as if it were the whole window.
const PAGE_SIZE = 1000;
const MAX_PAGES = 50;

/** Reads a whole filtered window a page at a time. Returns rows + whether it hit the cap. */
async function fetchAllPages<T>(
  build: (from: number, to: number) => PromiseLike<{ data: unknown; error: unknown }>,
): Promise<{ rows: T[]; truncated: boolean }> {
  const rows: T[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const { data, error } = await build(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
    if (error) throw error;
    const batch = (data ?? []) as T[];
    if (batch.length === 0) return { rows, truncated: false };
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) return { rows, truncated: false };
  }
  // Ran out of pages with a full page in hand: there is more we did not read.
  return { rows, truncated: true };
}

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
    // Both tables page by their PRIMARY KEY. OFFSET paging needs a TOTAL order,
    // and only a unique column gives one: order by non-unique started_at and a
    // tie group straddling a page boundary can hand back one row twice and skip
    // another, because the database is free to break the tie differently on each
    // query. That `id` is a uuid rather than a sequence makes no difference — it
    // is unique, so the order is total. (Runs are one insert per request with a
    // server-side DEFAULT now(), so real started_at ties are vanishingly rare;
    // this is correctness, not a bug anyone has seen.)
    //
    // `id` is also selected, not just ordered by: the funnel counts DISTINCT runs
    // behind a WAF wall, which needs run identity on both sides of the join.
    const runsPage = await fetchAllPages<RunRow>((from, to) => {
      let q = supabase
        .from('automation_runs')
        .select('id, store_id, outcome, status, items_requested, items_added, started_at')
        .gte('started_at', since)
        .order('id', { ascending: true })
        .range(from, to);
      if (storeId) q = q.eq('store_id', storeId);
      return q;
    });

    const stepsPage = await fetchAllPages<StepRow>((from, to) => {
      let q = supabase
        .from('automation_steps')
        // `code` is MEAL-4's failure taxonomy — the field that turns "add_click
        // is at 60%" into something someone can act on. NULL for every ok row
        // and for everything written before the column existed.
        // `run_id` is what makes the blocked rate a share of RUNS: a walled-off
        // run emits one blocked row per item, so counting rows over runs is a
        // ratio of two different units and read 450% on a blocked store.
        .select('store_id, run_id, step, outcome, code, duration_ms, detail, occurred_at')
        .gte('occurred_at', since)
        .order('id', { ascending: true })
        .range(from, to);
      if (storeId) q = q.eq('store_id', storeId);
      return q;
    });

    const funnel = aggregateFunnel(runsPage.rows, stepsPage.rows, { now, days });

    return NextResponse.json({
      days,
      since,
      // Surfaced so the dashboard can warn that it is showing a partial window
      // rather than silently under-reporting.
      truncated: runsPage.truncated || stepsPage.truncated,
      stepRowsScanned: stepsPage.rows.length,
      runRowsScanned: runsPage.rows.length,
      stores: funnel,
      // Every alerting store, whatever the reason, plus the reason-specific lists
      // the page banners off. A store can be alerting for the blocked reason with
      // a perfect confirm rate, so one undifferentiated list would have the page
      // blame the confirm rate for a WAF campaign.
      alerting: funnel.filter((s) => s.alerting).map((s) => s.storeId),
      confirmRateAlerting: funnel.filter((s) => s.alertReasons.includes('confirm_rate')).map((s) => s.storeId),
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
