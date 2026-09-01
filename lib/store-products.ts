// Which product the user actually chose, per store (MEAL-19).
//
// The counterpart of `src/lib/storeProducts.ts` in mealio_app, and deliberately
// a second small copy rather than a shared package: the two repos share no code
// today, and the alternative — one of them importing the other — is a bigger
// change than the forty lines below.
//
// The field records the identifier the STORE gave us for a chosen product,
// where `searchTerm` records only what it was CALLED. A display name has to be
// searched back into a product on every cart run, so the store's relevance
// ranking re-decides the user's choice each time; an identifier is looked up.
//
// Two rules, both load-bearing:
//
//   • Keyed per rail, never a bare `upc`. `searchTerm` is one global field and a
//     meal's store can be changed at any time, so a name chosen at H-E-B already
//     reaches Kroger's search — merely wasteful, because the text ladder
//     recovers. An identifier crossing stores would be silently WRONG: it would
//     resolve, and add a real product nobody picked.
//
//   • Absent, never empty. Ingredient arrays are PATCHed back whole with no
//     migration, so a row nobody has chosen a product for must serialise the way
//     it did before this field existed.

/** Banners that share the Kroger product catalogue, and so share one key. */
const KROGER_RAIL_STORES = new Set([
  'kroger', 'ralphs', 'fred_meyer', 'king_soopers', 'smiths', 'frys',
  'qfc', 'city_market', 'dillons', 'bakers', 'marianos', 'pick_n_save',
  'metro_market', 'pay_less', 'harris_teeter',
]);

export interface StoreProduct {
  upc: string;
  name: string;
}

/** The key a store's chosen products are filed under — the rail, not the banner,
 *  so a meal moved from Kroger to Ralphs keeps its choices. */
export function storeProductKey(storeId: string | null | undefined): string {
  if (!storeId) return '';
  return KROGER_RAIL_STORES.has(storeId) ? 'kroger' : storeId;
}

/** The product chosen for this store on this ingredient, or null. */
export function getStoreProduct(ing: any, storeId: string | null | undefined): StoreProduct | null {
  const key = storeProductKey(storeId);
  if (!key) return null;
  const entry = ing?.storeProducts?.[key];
  if (!entry || typeof entry.upc !== 'string' || !entry.upc.trim()) return null;
  return { upc: entry.upc, name: typeof entry.name === 'string' ? entry.name : '' };
}

/** A copy of `ing` with this store's chosen product recorded. Other stores'
 *  entries are preserved — a meal moved away and back has not forgotten. */
export function withStoreProduct<T extends Record<string, any>>(
  ing: T,
  storeId: string | null | undefined,
  product: StoreProduct,
): T {
  const key = storeProductKey(storeId);
  if (!key || !product.upc) return ing;
  return {
    ...ing,
    storeProducts: { ...(ing.storeProducts ?? {}), [key]: { upc: product.upc, name: product.name } },
  };
}

/**
 * A copy of `ing` with every remembered store product dropped.
 *
 * Called wherever `searchTerm` is replaced or cleared without a new identifier
 * to put in its place. A new display name beside the PREVIOUS product's id is
 * the one combination that adds something nobody chose: the name says one
 * product, the id resolves to another, and the id wins.
 */
export function withoutStoreProducts<T extends Record<string, any>>(ing: T): T {
  if (!ing || !('storeProducts' in ing)) return ing;
  const { storeProducts: _dropped, ...rest } = ing;
  return rest as T;
}
