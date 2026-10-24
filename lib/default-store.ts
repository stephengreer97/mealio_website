/**
 * Moving an account to a store: the switch on My Meals, and the one-time
 * backfill that gave every existing account its first default.
 *
 * Every meal of the user's comes along, active or deleted (a restored meal must
 * land at the same store as the rest). Each ingredient keeps what was chosen at
 * the store it is leaving, and takes whatever was chosen at the new one, or
 * nothing. See `lib/store-choices.ts` for what that means field by field.
 *
 * `updated_at` and `edited` are left alone: moving store is not an edit of the
 * meal, and the lists that sort by those would reorder for no reason.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { log } from '@/lib/logger';
import { moveIngredients, mostUsedStore } from '@/lib/store-choices';
import { isSupportedStore } from '@/lib/stores';

/** A meal row as this file reads it, kept so a dry run can hand back a backup. */
export interface MealStoreRow {
  id: string;
  store_id: string | null;
  ingredients: unknown;
  is_active?: boolean;
  created_at?: string | null;
}

export interface MoveResult {
  userId: string;
  from: string | null;
  to: string;
  /** Meals whose store or ingredients change. */
  changed: number;
  /** The rows as they were, for a backup, when `includeBefore` is set. */
  before?: MealStoreRow[];
  errors: string[];
}

/** Reads every meal of one user. Bounded by the user: a person, not a table. */
export async function mealsForUser(supabase: SupabaseClient, userId: string): Promise<MealStoreRow[]> {
  // unbounded-select-ok: one user's own meals, and every one of them has to move
  const { data, error } = await supabase
    .from('meals')
    .select('id, store_id, ingredients, is_active, created_at')
    .eq('user_id', userId);
  if (error) throw new Error(error.message);
  return (data ?? []) as MealStoreRow[];
}

/** The user's default store, or null when they have not got one yet. */
export async function defaultStoreFor(supabase: SupabaseClient, userId: string): Promise<string | null> {
  const { data } = await supabase.from('user_profiles').select('default_store_id').eq('id', userId).maybeSingle();
  const store = (data as { default_store_id?: string | null } | null)?.default_store_id ?? null;
  return isSupportedStore(store) ? store : null;
}

/**
 * Sets the user's default to `to` and moves every meal there.
 *
 * With `dryRun`, nothing is written and the result says what would change.
 * Rows are written one at a time and a failure does not stop the rest; the
 * profile is written last, so a partly moved account is retried by moving again.
 */
export async function moveAccountToStore(
  supabase: SupabaseClient,
  userId: string,
  to: string,
  options: { dryRun?: boolean; includeBefore?: boolean; meals?: MealStoreRow[] } = {},
): Promise<MoveResult> {
  const meals = options.meals ?? (await mealsForUser(supabase, userId));
  const from = mostUsedStore(meals, isSupportedStore);
  const errors: string[] = [];
  let changed = 0;

  for (const meal of meals) {
    const storeNow = meal.store_id ?? to;
    const ingredients = moveIngredients(meal.ingredients, storeNow, to);
    const same = meal.store_id === to && JSON.stringify(ingredients) === JSON.stringify(meal.ingredients ?? []);
    if (same) continue;
    changed += 1;
    if (options.dryRun) continue;
    const { error } = await supabase.from('meals').update({ store_id: to, ingredients }).eq('id', meal.id).eq('user_id', userId);
    if (error) errors.push(`meal ${meal.id}: ${error.message}`);
  }

  if (!options.dryRun && errors.length === 0) {
    const { error } = await supabase.from('user_profiles').update({ default_store_id: to }).eq('id', userId);
    if (error) errors.push(`profile: ${error.message}`);
  }

  log({
    event: 'MEAL:DEFAULT_STORE',
    status: errors.length > 0 ? 'error' : 'success',
    userId,
    detail: `to=${to} from=${from ?? 'none'} changed=${changed}${options.dryRun ? ' dry-run' : ''}`,
  });

  return {
    userId,
    from,
    to,
    changed,
    ...(options.includeBefore ? { before: meals } : {}),
    errors,
  };
}

/**
 * The store an account with no default should start on: the one with most of
 * its meals. Null for an account with no meals at a supported store, which
 * gets its default on its first save instead.
 */
export function startingStore(meals: MealStoreRow[]): string | null {
  return mostUsedStore(meals, isSupportedStore);
}

export interface SaveStore {
  /** The store the meal is saved under: the user's default. */
  target: string;
  /** The store the client was choosing products for. */
  writtenAt: string;
}

/**
 * Which store a save goes to, adopting a default for an account that has none.
 *
 * New clients send the default (or nothing); old ones send the store the user
 * picked for this one meal. Either way the meal is saved at the default, and
 * what the client chose is filed under the store it chose it at.
 *
 * An account with no default yet gets one here: the store with most of its
 * meals, or, with none, the store this save names. Existing meals move with
 * it, so the account is consistent from its first write after this shipped,
 * whether or not the backfill has reached it. Null when there is no store to go
 * on at all; the route answers that with "choose your store".
 */
export async function resolveSaveStore(
  supabase: SupabaseClient,
  userId: string,
  sentStoreId: unknown,
): Promise<SaveStore | null> {
  const sent = isSupportedStore(sentStoreId) ? sentStoreId : null;
  const current = await defaultStoreFor(supabase, userId);
  if (current) return { target: current, writtenAt: sent ?? current };

  const meals = await mealsForUser(supabase, userId);
  const start = startingStore(meals) ?? sent;
  if (!start) return null;
  const moved = await moveAccountToStore(supabase, userId, start, { meals });
  if (moved.errors.length > 0) {
    // The save still lands at `start`; the next write retries the move.
    log({ event: 'MEAL:DEFAULT_STORE', status: 'error', userId, detail: moved.errors.join('; ') });
  }
  return { target: start, writtenAt: sent ?? start };
}
