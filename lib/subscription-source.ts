import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Where a user's Full Access came from (`user_profiles.subscription_source`,
 * migration 20260918000001_subscription_source.sql).
 *
 * `unknown` is what the backfill wrote for paid rows it could not place; it
 * behaves as every row did before the column existed. NULL means free.
 */
export type SubscriptionSource = 'stripe' | 'app_store' | 'play_store' | 'store' | 'comp' | 'unknown';

/** The two systems that grant and end paid access on their own. */
export type Biller = 'stripe' | 'revenuecat';

/**
 * WHICH SOURCES EACH BILLER MAY END.
 *
 * A system may only take away access it gave. Before the column existed, any
 * "it ended" event set the tier to free, so a Stripe cancellation could end
 * someone's App Store access and a RevenueCat EXPIRATION or a Stripe
 * subscription.updated could end a comped creator's. `comp` appears in neither
 * set: nothing automatic ends a comp.
 *
 * `unknown` and NULL are in both, which is exactly the old behaviour for the
 * rows the backfill could not place.
 */
const ENDABLE_BY: Record<Biller, ReadonlySet<string | null>> = {
  stripe: new Set(['stripe', 'unknown', null]),
  revenuecat: new Set(['app_store', 'play_store', 'store', 'unknown', null]),
};

export function canEnd(biller: Biller, source: string | null | undefined): boolean {
  return ENDABLE_BY[biller].has(source ?? null);
}

/**
 * Paid through a store, so only the user can cancel it (in the App Store or
 * Google Play). `unknown` counts: it may be a store purchase, and telling a
 * user to check is cheaper than a charge they did not know would continue.
 */
export function isStoreSource(source: string | null | undefined): boolean {
  return source === 'app_store' || source === 'play_store' || source === 'store' || source === 'unknown';
}

/** RevenueCat's `event.store` to our source. */
export function sourceFromRevenueCatStore(store: unknown): SubscriptionSource {
  if (store === 'APP_STORE' || store === 'MAC_APP_STORE') return 'app_store';
  if (store === 'PLAY_STORE') return 'play_store';
  return 'store';
}

type Db = Pick<SupabaseClient, 'from'>;
type Extra = Record<string, unknown>;

async function readSources(supabase: Db, ids: string[]) {
  return supabase
    .from('user_profiles')
    .select('id, subscription_source')
    .in('id', ids)
    .limit(ids.length);
}

/**
 * Give `ids` Full Access from `source`, writing `extra` alongside.
 *
 * A comped user keeps `comp` as their source: the comp is what must survive if
 * the purchase they also made ends, so recording the purchase over it would
 * hand that purchase's end event the power to remove access the comp gave.
 */
export async function grantPaid(
  supabase: Db,
  ids: string | string[],
  source: SubscriptionSource,
  extra: Extra = {},
): Promise<{ error: { message: string } | null }> {
  const all = [...new Set(Array.isArray(ids) ? ids : [ids])];
  if (!all.length) return { error: null };

  const { data, error: readErr } = await readSources(supabase, all);
  if (readErr) return { error: readErr };

  const comped = new Set((data ?? []).filter((r) => r.subscription_source === 'comp').map((r) => r.id as string));
  const rest = all.filter((id) => !comped.has(id));

  if (comped.size) {
    const { error } = await supabase
      .from('user_profiles')
      .update({ ...extra, subscription_tier: 'paid' })
      .in('id', [...comped]);
    if (error) return { error };
  }
  if (rest.length) {
    const { error } = await supabase
      .from('user_profiles')
      .update({ ...extra, subscription_tier: 'paid', subscription_source: source })
      .in('id', rest);
    if (error) return { error };
  }
  return { error: null };
}

/**
 * End Full Access for those of `ids` whose access `biller` granted, writing
 * `extra` alongside. The rest are left alone and reported in `kept`, so the
 * caller can log why a downgrade it was asked for did not happen.
 */
export async function endPaid(
  supabase: Db,
  ids: string | string[],
  biller: Biller,
  extra: Extra = {},
): Promise<{ ended: string[]; kept: Array<{ id: string; source: string }>; error: { message: string } | null }> {
  const all = [...new Set(Array.isArray(ids) ? ids : [ids])];
  if (!all.length) return { ended: [], kept: [], error: null };

  const { data, error: readErr } = await readSources(supabase, all);
  if (readErr) return { ended: [], kept: [], error: readErr };

  const rows = (data ?? []) as Array<{ id: string; subscription_source: string | null }>;
  const kept = rows
    .filter((r) => !canEnd(biller, r.subscription_source))
    .map((r) => ({ id: r.id, source: r.subscription_source as string }));
  const keptIds = new Set(kept.map((k) => k.id));
  const ended = rows.map((r) => r.id).filter((id) => !keptIds.has(id));

  if (ended.length) {
    const { error } = await supabase
      .from('user_profiles')
      .update({ ...extra, subscription_tier: 'free', subscription_source: null })
      .in('id', ended);
    if (error) return { ended: [], kept, error };
  }
  return { ended, kept, error: null };
}
