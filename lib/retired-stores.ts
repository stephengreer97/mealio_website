/**
 * Stores the product no longer has, and the admin dashboard therefore must not
 * draw a card for.
 *
 * The Health Dashboard's store lists are not a configured set — they are
 * whatever store ids came back on the rows in the window. That is the right
 * design (a store nobody ran does not deserve a card, and a store id nobody
 * planned for should not be silently swallowed), but it has one consequence: a
 * store that has been REMOVED from the product goes on having a card for as long
 * as its rows survive, and after that its rows sit in the table with no card and
 * no explanation.
 *
 * Amazon Fresh went on 2026-09-04 with the last of the DOM automation, and
 * `price_chopper` was never in `src/constants/stores.ts` at all. Neither can be
 * picked when saving a meal, so neither can produce another row. What they can
 * still do is take up two cards on a dashboard about what is working now, and
 * pull two dead stores into a funnel an operator reads for regressions.
 *
 * This filters the VIEW, not the data. The rows stay where they are: a run that
 * happened, happened, and the numbers behind a decision made last month must not
 * change because a store was retired this month. To actually delete them, see
 * the clear-down query in `supabase/automation-telemetry-reset.sql`.
 */
export const RETIRED_STORE_IDS: readonly string[] = ['amazon', 'price_chopper'];

const RETIRED = new Set(RETIRED_STORE_IDS);

/** Whether this store id is one the dashboard should no longer draw. */
export function isRetiredStore(storeId: string | null | undefined): boolean {
  return typeof storeId === 'string' && RETIRED.has(storeId);
}

/** Drops retired stores from a list of `{ storeId }` rows. */
export function withoutRetiredStores<T extends { storeId: string }>(rows: readonly T[] | null | undefined): T[] {
  return (rows ?? []).filter((row) => !isRetiredStore(row.storeId));
}

/**
 * Drops retired stores from a list of bare store ids.
 *
 * The alert banners carry these — `confirmRateAlerting`, `blockedAlerting`,
 * `successDropAlerting`, `partialInstrumentation` — and a banner naming a store
 * with no card below it sends an operator looking for something that is not
 * there.
 */
export function withoutRetiredStoreIds(ids: readonly string[] | null | undefined): string[] {
  return (ids ?? []).filter((id) => !isRetiredStore(id));
}
