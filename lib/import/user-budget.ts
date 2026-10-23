/**
 * What a user, as opposed to a creator, may import into their own meals.
 *
 * Two allowances, by tier:
 *
 *  - **Free:** one successful import, ever. A rejection (a site that blocks us,
 *    a page that is not a recipe) does not use it up — the user got nothing.
 *  - **Full Access:** $2.50 per rolling 30 days, plus 30 attempts a day. The
 *    dollar cap is the real limit (about 230 imports a month at today's cost);
 *    the daily count only stops a stuck client or a script spending the month in
 *    an hour.
 *
 * Counted from `recipe_imports`, like the creator budget and for the same
 * reason: it is already one row per attempt with the dollars on it, so the cap
 * cannot disagree with the spend dashboard. Only `actor = 'user'` rows count —
 * a user who is also a creator has a separate creator budget for their own
 * catalogue. The row is written fire-and-forget after each import, so two
 * requests fired at once can both slip under a cap. A free user getting two
 * imports out of a double tap is fine.
 *
 * **Fails open**, as the creator budget does: a guard that cannot read its own
 * state must not become an outage. A failed read is logged.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { log } from '@/lib/logger';

export const USER_MONTHLY_SPEND_CAP_USD = 2.5;
export const USER_DAILY_IMPORT_CAP = 30;
export const FREE_IMPORT_ALLOWANCE = 1;

const DAY_MS = 24 * 60 * 60 * 1000;
const MONTH_MS = 30 * DAY_MS;

/**
 * Rows the 30-day spend read may pull. At about a cent an import the cap is
 * reached long before this; beyond it the sum is a floor, which only errs
 * toward refusing.
 */
const SPEND_ROWS = 2000;

export type UserImportAllowance =
  | { ok: true; tier: 'free' | 'paid'; freeImportsLeft: number | null }
  | { ok: false; reason: 'upgrade-required' | 'limit'; error: string };

export async function checkUserImportAllowance(
  supabase: SupabaseClient,
  userId: string,
  now: () => number = Date.now,
): Promise<UserImportAllowance> {
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('subscription_tier')
    .eq('id', userId)
    .maybeSingle();
  const tier = ((profile as { subscription_tier?: string } | null)?.subscription_tier ?? 'free') === 'free'
    ? 'free'
    : 'paid';

  if (tier === 'free') {
    const { count, error } = await supabase
      .from('recipe_imports')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('actor', 'user')
      .eq('outcome', 'ok');
    if (error) {
      log({ event: 'USER:IMPORT_BUDGET', status: 'error', userId, reason: error.message ?? String(error) });
      return { ok: true, tier, freeImportsLeft: FREE_IMPORT_ALLOWANCE };
    }
    const left = Math.max(0, FREE_IMPORT_ALLOWANCE - (count ?? 0));
    if (left === 0) {
      log({ event: 'USER:IMPORT_BUDGET', status: 'failed', userId, reason: 'free import used' });
      return {
        ok: false,
        reason: 'upgrade-required',
        error: 'You have used your free import. Upgrade to Full Access to import as many recipes as you like.',
      };
    }
    return { ok: true, tier, freeImportsLeft: left };
  }

  const since = new Date(now() - MONTH_MS).toISOString();
  // unbounded-select-ok: one user's own import rows for 30 days, capped at SPEND_ROWS
  const { data, error } = await supabase
    .from('recipe_imports')
    .select('total_cost_usd, occurred_at')
    .eq('user_id', userId)
    .eq('actor', 'user')
    .gte('occurred_at', since)
    .limit(SPEND_ROWS);
  if (error) {
    log({ event: 'USER:IMPORT_BUDGET', status: 'error', userId, reason: error.message ?? String(error) });
    return { ok: true, tier, freeImportsLeft: null };
  }

  const rows = (data ?? []) as Array<{ total_cost_usd: number | string | null; occurred_at: string }>;
  const spent = rows.reduce((sum, row) => sum + (Number(row.total_cost_usd) || 0), 0);
  if (spent >= USER_MONTHLY_SPEND_CAP_USD) {
    log({ event: 'USER:IMPORT_BUDGET', status: 'failed', userId, reason: `spend $${spent.toFixed(2)} in 30 days` });
    return {
      ok: false,
      reason: 'limit',
      error: 'You have reached this month’s import limit. You can still add meals by typing them in.',
    };
  }

  const dayStart = now() - DAY_MS;
  const today = rows.filter((row) => Date.parse(row.occurred_at) >= dayStart).length;
  if (today >= USER_DAILY_IMPORT_CAP) {
    log({ event: 'USER:IMPORT_BUDGET', status: 'failed', userId, reason: `${today} imports in 24h` });
    return {
      ok: false,
      reason: 'limit',
      error: `You have used today’s ${USER_DAILY_IMPORT_CAP} imports. Try again tomorrow.`,
    };
  }

  return { ok: true, tier, freeImportsLeft: null };
}
