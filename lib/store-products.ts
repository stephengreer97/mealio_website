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
  /** The store's SKU, where it addresses a cart line by one. H-E-B does. */
  sku?: string;
  /** The real barcode, where the store gives one. Wegmans product ids are per
   *  store, so this is the only part that survives a store change. */
  barcode?: string;
  /** What it cost when the user chose it, as the store said it. A string
   *  because the rails do not agree on shape and nothing has decided what a
   *  stored price means yet. */
  price?: string;
  /** When `price` was captured. ISO. Absent whenever `price` is. */
  pricedAt?: string;
}

/** The key a store's chosen products are filed under — the rail, not the banner,
 *  so a meal moved from Kroger to Ralphs keeps its choices. */
export function storeProductKey(storeId: string | null | undefined): string {
  if (!storeId) return '';
  return KROGER_RAIL_STORES.has(storeId) ? 'kroger' : storeId;
}

/**
 * The product chosen for this store on this ingredient, or null.
 *
 * READS EVERY FIELD THE APP WRITES, and that is not decoration. This function
 * and `withStoreProduct` below are a round trip: anything the reader drops, a
 * write that goes through the writer then erases from the row. Both used to stop
 * at `{ upc, name }` while the app had been writing `sku` and `barcode` for
 * months -- H-E-B addresses a cart line BY sku and refuses to build a write
 * without one, and a Wegmans product id is per store so the barcode is the only
 * part that survives a store change. Nothing called either function, so it never
 * fired; it was a loaded gun for whoever wired it up.
 *
 * The rule this file now follows: every field on `StoreProduct` is read here and
 * written below. See the same warning on `sanitizeStoreProducts` in the app.
 */
export function getStoreProduct(ing: any, storeId: string | null | undefined): StoreProduct | null {
  const key = storeProductKey(storeId);
  if (!key) return null;
  const entry = ing?.storeProducts?.[key];
  if (!entry || typeof entry.upc !== 'string' || !entry.upc.trim()) return null;
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim() ? v : undefined;
  const sku = str(entry.sku);
  const barcode = str(entry.barcode);
  const price = str(entry.price);
  const pricedAt = str(entry.pricedAt);
  return {
    upc: entry.upc,
    name: typeof entry.name === 'string' ? entry.name : '',
    ...(sku ? { sku } : {}),
    ...(barcode ? { barcode } : {}),
    // Together or not at all: a price with no date is a number nobody can judge
    // the age of.
    ...(price ? { price, ...(pricedAt ? { pricedAt } : {}) } : {}),
  };
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
    storeProducts: {
      ...(ing.storeProducts ?? {}),
      [key]: {
        upc: product.upc,
        name: product.name,
        // Every optional field is written only when it has a value, so a store
        // that has none serialises exactly as it did before the field existed.
        ...(product.sku ? { sku: product.sku } : {}),
        ...(product.barcode ? { barcode: product.barcode } : {}),
        ...(product.price
          ? { price: product.price, ...(product.pricedAt ? { pricedAt: product.pricedAt } : {}) }
          : {}),
      },
    },
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
