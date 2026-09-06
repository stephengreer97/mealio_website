/**
 * MEAL-219, the nightly half. Rolls yesterday into `automation_daily` and
 * prunes raw steps past the retention window.
 *
 * WHY THIS IS A CRON ROUTE AND NOT pg_cron. Both are real options and pg_cron
 * is the obvious one, but this repository already runs three scheduled jobs
 * through Vercel (`vercel.json`), with a shared secret, a `maxDuration`, and a
 * pattern where each pass is isolated so one failing does not drop the others.
 * Adding a second scheduler means a job that is invisible from the repository
 * and a second place to look when something has not run. Reusing the one that
 * exists costs an extension nobody has to install.
 *
 * THE ORDER IS SAFE BY CONSTRUCTION, and that is the database's doing rather
 * than this file's: `prune_automation_steps` rolls every day it is about to
 * delete into the aggregate BEFORE deleting it. Pruning a day that was never
 * rolled up destroys it and is not recoverable, so that ordering lives inside
 * one function where it cannot be got wrong by a caller.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { log } from '@/lib/logger';

/**
 * How many recent days to roll up on each run.
 *
 * Not one. Rolling up only yesterday means a night the cron does not fire
 * leaves a HOLE in `automation_daily` for that day, and the hole survives until
 * the prune reaches it thirty days later. A funnel with a missing day reads as
 * a day when nothing happened, which is the same misreading the whole retention
 * design exists to avoid. Three is cheap -- one grouped scan per day over a
 * table that is already indexed by time -- and it closes a two-night gap on the
 * next successful run.
 *
 * Idempotent: the rollup deletes that day's aggregate rows and rebuilds them,
 * so re-rolling a day that was already correct changes nothing.
 */
export const ROLLUP_DAYS = 3;

/** Days are UTC, matching how both SQL functions bucket `occurred_at`. */
function utcDaysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

export interface RollupResult {
  /** Days re-aggregated by this run, most recent first. */
  daysRolled: string[];
  /** Aggregate rows written across those days. */
  rowsWritten: number;
  /** Older days the prune rolled up before deleting them. */
  prunedDaysRolled: number;
  /** Raw step rows deleted. */
  prunedRows: number;
  /** Anything that failed, named. An empty list means the whole pass ran. */
  errors: string[];
}

export async function runAutomationRollup(deps: {
  supabase: SupabaseClient;
  days?: number;
  keepDays?: number;
}): Promise<RollupResult> {
  const days = deps.days ?? ROLLUP_DAYS;
  const result: RollupResult = {
    daysRolled: [], rowsWritten: 0, prunedDaysRolled: 0, prunedRows: 0, errors: [],
  };

  // Recent days first, so the day the dashboard is most likely to be looking at
  // is the one that lands even if a later call fails.
  for (let n = 1; n <= days; n++) {
    const day = utcDaysAgo(n);
    const { data, error } = await deps.supabase.rpc('roll_up_automation_day', { target_day: day });
    if (error) {
      // Named, not swallowed. A missing function means the migration has not
      // been run, and the failure mode of a quiet catch is a dashboard reading
      // zero that looks like nobody used the app.
      result.errors.push(`roll_up_automation_day(${day}): ${error.code ?? '-'} ${error.message}`);
      continue;
    }
    result.daysRolled.push(day);
    result.rowsWritten += typeof data === 'number' ? data : 0;
  }

  // Runs even if a rollup above failed. The prune does its own rollup of every
  // day it touches, so it is not depending on the loop having succeeded, and
  // skipping it would let raw steps accumulate past the window for no gain.
  const { data: pruned, error: pruneErr } = await deps.supabase
    .rpc('prune_automation_steps', { keep_days: deps.keepDays ?? 30 });
  if (pruneErr) {
    result.errors.push(`prune_automation_steps: ${pruneErr.code ?? '-'} ${pruneErr.message}`);
  } else {
    // RETURNS TABLE, so supabase-js hands back an array of one row.
    const row = Array.isArray(pruned) ? pruned[0] : pruned;
    result.prunedDaysRolled = Number(row?.rolled_days ?? 0);
    result.prunedRows = Number(row?.deleted_rows ?? 0);
  }

  if (result.errors.length > 0) {
    log({ event: 'CRON:DAILY', status: 'error', detail: 'automationRollup', reason: result.errors.join('; ') });
  }
  return result;
}
