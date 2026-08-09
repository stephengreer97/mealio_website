import type { SupabaseClient } from '@supabase/supabase-js';
import type { RunRow, StepRow } from './automation-funnel';

/**
 * The rows `aggregateFunnel` judges, read once and shared by both its callers.
 *
 * The admin dashboard (`/api/admin/automation-funnel`) and the daily alert email
 * (`lib/funnel-alerts.ts`) have to agree about which stores are broken, and
 * MEAL-6 makes that agreement structural rather than a thing to remember: they
 * call the same aggregator with the same defaults. That is only worth as much as
 * the rows they hand it, so the SELECT lives here too — a second copy that
 * forgot `code`, or `run_id`, or the paging, would produce an email that quietly
 * disagreed with the page for reasons no one could see from either.
 */

// PostgREST caps a single select at db-max-rows (1000 on Supabase) and says
// NOTHING about having truncated. Thirty days of steps is far past that, and so
// is thirty days of runs on a busy month — BOTH have to be paged, or the funnel
// silently reports the first page of the window as if it were the whole window.
const PAGE_SIZE = 1000;
const MAX_PAGES = 50;

/** Reads a whole filtered window a page at a time. Returns rows + whether it hit the cap. */
export async function fetchAllPages<T>(
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

export interface FunnelRows {
  runs: RunRow[];
  steps: StepRow[];
  /** True when either read hit `MAX_PAGES` — the window is only partly seen. */
  truncated: boolean;
  runRowsScanned: number;
  stepRowsScanned: number;
}

/**
 * Every run and step for a window, paged to exhaustion.
 *
 * Both tables page by their PRIMARY KEY. OFFSET paging needs a TOTAL order, and
 * only a unique column gives one: order by non-unique started_at and a tie group
 * straddling a page boundary can hand back one row twice and skip another,
 * because the database is free to break the tie differently on each query. That
 * `id` is a uuid rather than a sequence makes no difference — it is unique, so
 * the order is total.
 */
export async function fetchFunnelRows(
  supabase: SupabaseClient,
  opts: { since: string; storeId?: string | null },
): Promise<FunnelRows> {
  const runsPage = await fetchAllPages<RunRow>((from, to) => {
    let q = supabase
      .from('automation_runs')
      // `id` is selected, not just ordered by: the funnel counts DISTINCT runs
      // behind a WAF wall, which needs run identity on both sides of the join.
      .select('id, store_id, outcome, status, items_requested, items_added, started_at, completed_at')
      .gte('started_at', opts.since)
      .order('id', { ascending: true })
      .range(from, to);
    if (opts.storeId) q = q.eq('store_id', opts.storeId);
    return q;
  });

  const stepsPage = await fetchAllPages<StepRow>((from, to) => {
    let q = supabase
      .from('automation_steps')
      // `code` is MEAL-4's failure taxonomy — the field that turns "add_click is
      // at 60%" into something someone can act on, and the field the MEAL-6
      // alert email carries so it says more than "store is down". NULL for every
      // ok row and for everything written before the column existed.
      // `run_id` is what makes the blocked rate a share of RUNS: a walled-off run
      // emits one blocked row per item, so counting rows over runs is a ratio of
      // two different units and read 450% on a blocked store.
      // `item_index` is how MEAL-29 counts unavailable ITEMS rather than
      // out-of-stock ROWS. Dropping it fails nothing on its own: every row would
      // arrive with the field undefined, every count would come out zero, and the
      // funnel would go on reporting the pre-MEAL-29 numbers as if the
      // subtraction were happening. `unavailableItemsByRun`'s own tests hand it
      // rows directly and would not notice, which is why the alert sweep test
      // ('does not email anyone about a store that only ran out of stock') drives
      // the whole path through the database fake instead.
      .select('store_id, run_id, step, outcome, code, duration_ms, detail, item_index, occurred_at')
      .gte('occurred_at', opts.since)
      .order('id', { ascending: true })
      .range(from, to);
    if (opts.storeId) q = q.eq('store_id', opts.storeId);
    return q;
  });

  return {
    runs: runsPage.rows,
    steps: stepsPage.rows,
    truncated: runsPage.truncated || stepsPage.truncated,
    runRowsScanned: runsPage.rows.length,
    stepRowsScanned: stepsPage.rows.length,
  };
}
