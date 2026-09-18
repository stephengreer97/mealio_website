/**
 * A daily ceiling on what one creator can make us spend (review finding 6).
 *
 * Both creator-triggered entry points, pasting a link (`/api/creator/import`)
 * and importing a back catalogue (`/api/creator/sync`), used to start work with
 * no ceiling at all. Each run is capped at `CREATOR_SELECTION_MAX` items, but
 * nothing stopped the next run starting the moment the last one finished, and a
 * rejected or failed post is extracted again every time it is ticked. A script
 * holding a creator's token could spend without limit, and so could a creator
 * pressing Import in a loop.
 *
 * **Counted from `recipe_imports`, not from a counter of its own.** That table
 * is already one row per attempt with the dollars on it (MEAL-222), written by
 * every path that imports on a creator's behalf: their own paste, their own
 * sync, an operator's sync of their catalogue and the poller. So the cap is
 * "what this creator's account cost us in the last day", whoever pressed the
 * button, and it cannot disagree with the spend dashboard because it reads the
 * same rows. The row is written fire-and-forget after each import, so the count
 * trails by a second or two; a cap that is off by one import is fine.
 *
 * **Fails open**, like the login throttle and for the same reason: a guard that
 * cannot read its own state must not become an outage for every creator. A
 * failed read is logged so "the cap is not running" is visible.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { log } from '@/lib/logger';

/**
 * Import attempts per creator per rolling day.
 *
 * Twice the per-run selection cap, so a creator can bring in two full pages of
 * back catalogue in a day, and far above what anyone publishes. The poller adds
 * at most a handful a day for a real creator.
 */
export const CREATOR_DAILY_IMPORT_CAP = 200;

/**
 * Dollars per creator per rolling day.
 *
 * An import costs about a cent and a half on the current models (gate plus
 * extraction), so 200 imports is about $3. This is the ceiling for the day the
 * models or the pages get more expensive, not the one expected to bind.
 */
export const CREATOR_DAILY_SPEND_CAP_USD = 5;

const WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Rows read to add up the spend. Above the import cap on purpose: a creator
 * with more rows than this in a day is over the count cap anyway, so a sum that
 * stops here can only understate spend for someone already refused.
 */
const SPEND_ROWS = 1000;

export type BudgetCheck = { ok: true } | { ok: false; error: string };

/**
 * May this creator start `wanted` more imports now?
 *
 * The message is written for the creator and says what to do: how many they
 * have left, or to come back tomorrow.
 */
export async function checkCreatorImportBudget(
  supabase: SupabaseClient,
  creatorId: string,
  wanted: number,
  now: () => number = Date.now,
): Promise<BudgetCheck> {
  const since = new Date(now() - WINDOW_MS).toISOString();
  const { data, count, error } = await supabase
    .from('recipe_imports')
    .select('total_cost_usd', { count: 'exact' })
    .eq('creator_id', creatorId)
    .gte('occurred_at', since)
    .limit(SPEND_ROWS);

  if (error) {
    log({ event: 'CREATOR:IMPORT_BUDGET', status: 'error', userId: creatorId, reason: error.message ?? String(error) });
    return { ok: true };
  }

  const rows = (data ?? []) as Array<{ total_cost_usd: number | string | null }>;
  const used = count ?? rows.length;
  const spent = rows.reduce((sum, row) => sum + (Number(row.total_cost_usd) || 0), 0);

  if (spent >= CREATOR_DAILY_SPEND_CAP_USD) {
    log({ event: 'CREATOR:IMPORT_BUDGET', status: 'failed', userId: creatorId, reason: `spend $${spent.toFixed(2)} in 24h` });
    return {
      ok: false,
      error: 'You have reached today’s import limit. Everything you already imported is saved. Try again tomorrow.',
    };
  }

  const left = Math.max(0, CREATOR_DAILY_IMPORT_CAP - used);
  if (wanted > left) {
    log({ event: 'CREATOR:IMPORT_BUDGET', status: 'failed', userId: creatorId, reason: `${used} imports in 24h, asked for ${wanted}` });
    return {
      ok: false,
      error:
        left === 0
          ? `You have used today’s ${CREATOR_DAILY_IMPORT_CAP} imports. Everything you already imported is saved. Try again tomorrow.`
          : `That is ${wanted} posts, and you have ${left} of today’s ${CREATOR_DAILY_IMPORT_CAP} imports left. ` +
            `Select ${left} or fewer, or try again tomorrow.`,
    };
  }

  return { ok: true };
}
