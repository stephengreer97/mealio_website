/**
 * One store per account (the default store), and what a meal's product choices
 * mean under it.
 *
 * A user shops at one store at a time. Their meals all follow that store, and
 * each ingredient remembers what was chosen at every store separately, so a
 * switch away and back loses nothing. At a store with no choices yet, a meal is
 * productless: it goes through Choose Products like a new meal.
 *
 * Two fields hold a choice, both keyed by `storeProductKey` (the Kroger banners
 * share one key):
 *
 *   - `storeProducts[key]`     the product the store identified (upc and so on)
 *   - `storeSearchTerms[key]`  the product name we search that store for
 *
 * `searchTerm` is the old single, store-less field. It is kept, and the server
 * keeps it equal to the choice at the meal's current store, because everything
 * that runs a cart reads it, including app versions that predate this file.
 *
 * **The server is the compatibility layer.** Every write to a meal goes through
 * `reconcileIngredients`, so a client that drops fields it does not know (an
 * old app rewriting the ingredient list, or a form that rebuilds rows) cannot
 * erase another store's choices: they are merged back from the row as stored.
 * The one thing a client decides is the choice at the store it was writing at.
 */

import { storeProductKey } from '@/lib/store-products';

type Ingredient = Record<string, any>;

const nameKey = (ing: Ingredient): string =>
  String(ing?.ingredientName ?? ing?.productName ?? ing?.name ?? '').trim().toLowerCase();

const cleanTerm = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value : null;

/** The search term chosen for this store, or null. */
export function searchTermAt(ing: Ingredient, storeId: string | null | undefined): string | null {
  const key = storeProductKey(storeId);
  if (!key) return null;
  return cleanTerm(ing?.storeSearchTerms?.[key]);
}

/** Whether this store has any choice recorded on this ingredient. */
export function hasChoiceAt(ing: Ingredient, storeId: string | null | undefined): boolean {
  const key = storeProductKey(storeId);
  if (!key) return false;
  return Boolean(searchTermAt(ing, storeId) || ing?.storeProducts?.[key]?.upc);
}

/** Whether any store other than this one has a choice on this ingredient. */
export function hasChoiceElsewhere(ing: Ingredient, storeId: string | null | undefined): boolean {
  const key = storeProductKey(storeId);
  const others = (map: unknown) =>
    map && typeof map === 'object' ? Object.keys(map as object).some((k) => k !== key && (map as any)[k]) : false;
  return others(ing?.storeSearchTerms) || others(ing?.storeProducts);
}

/**
 * Records `searchTerm` as the choice at the store it was written at.
 *
 * The client's `searchTerm` is authoritative for that one store: a re-chosen
 * name replaces it, and null clears it. Map entries are written only when they
 * have a value, so an ingredient nobody chose for serialises without the field.
 */
function absorb(ing: Ingredient, writtenAt: string): Ingredient {
  const key = storeProductKey(writtenAt);
  if (!key) return ing;
  const term = cleanTerm(ing.searchTerm);
  const terms = { ...(ing.storeSearchTerms ?? {}) };
  if (term) terms[key] = term;
  else delete terms[key];
  const { storeSearchTerms: _old, ...rest } = ing;
  return Object.keys(terms).length > 0 ? { ...rest, storeSearchTerms: terms } : rest;
}

/** Copies other stores' choices from the stored row where the incoming one lacks them. */
function mergeOthers(ing: Ingredient, stored: Ingredient | undefined, writtenAt: string): Ingredient {
  if (!stored) return ing;
  const key = storeProductKey(writtenAt);
  const merge = (field: 'storeSearchTerms' | 'storeProducts') => {
    const from = stored[field];
    if (!from || typeof from !== 'object') return ing[field];
    const into = { ...(ing[field] ?? {}) };
    for (const [k, v] of Object.entries(from)) {
      if (k !== key && v && !(k in into)) into[k] = v;
    }
    return Object.keys(into).length > 0 ? into : undefined;
  };
  const terms = merge('storeSearchTerms');
  const products = merge('storeProducts');
  const { storeSearchTerms: _t, storeProducts: _p, ...rest } = ing;
  return {
    ...rest,
    ...(products ? { storeProducts: products } : {}),
    ...(terms ? { storeSearchTerms: terms } : {}),
  };
}

/**
 * Sets `searchTerm` to the choice at `storeId`, which is what a cart run reads.
 * Absent rather than null when there is none, so an ingredient nobody chose for
 * serialises exactly as it always has.
 */
function projectTo(ing: Ingredient, storeId: string): Ingredient {
  const term = searchTermAt(ing, storeId);
  const { searchTerm: _old, ...rest } = ing;
  return term ? { ...rest, searchTerm: term } : rest;
}

/**
 * The ingredient list to store, given what a client sent.
 *
 * @param incoming   the list the client sent
 * @param stored     the list as stored now (null for a new meal)
 * @param writtenAt  the store the client was choosing products for
 * @param target     the store the meal is saved under (the user's default)
 */
export function reconcileIngredients(
  incoming: unknown,
  stored: unknown,
  writtenAt: string,
  target: string,
): Ingredient[] {
  if (!Array.isArray(incoming)) return [];
  const byName = new Map<string, Ingredient>();
  for (const row of Array.isArray(stored) ? stored : []) {
    const k = nameKey(row);
    if (k && !byName.has(k)) byName.set(k, row);
  }
  return incoming.map((raw) => {
    if (!raw || typeof raw !== 'object') return raw;
    const ing = mergeOthers(absorb(raw as Ingredient, writtenAt), byName.get(nameKey(raw as Ingredient)), writtenAt);
    return projectTo(ing, target);
  });
}

/**
 * The same list moved from one store to another: what was chosen at `from` is
 * kept under `from`, and `searchTerm` becomes whatever was chosen at `to`, or
 * nothing. Used by a switch and by the one-time backfill. Safe to run twice.
 */
export function moveIngredients(ingredients: unknown, from: string, to: string): Ingredient[] {
  return reconcileIngredients(ingredients, null, from, to);
}

/**
 * Which store an account should start on: the one with most of its meals.
 * Ties go to the store whose meal was saved most recently. Unsupported or
 * retired stores never count.
 */
export function mostUsedStore(
  meals: Array<{ store_id: string | null; created_at?: string | null }>,
  isSupported: (storeId: string) => boolean,
): string | null {
  const tally = new Map<string, { count: number; latest: string }>();
  for (const meal of meals) {
    const store = meal.store_id;
    if (!store || !isSupported(store)) continue;
    const entry = tally.get(store) ?? { count: 0, latest: '' };
    entry.count += 1;
    if ((meal.created_at ?? '') > entry.latest) entry.latest = meal.created_at ?? '';
    tally.set(store, entry);
  }
  let best: string | null = null;
  let bestEntry = { count: 0, latest: '' };
  for (const [store, entry] of tally) {
    if (entry.count > bestEntry.count || (entry.count === bestEntry.count && entry.latest > bestEntry.latest)) {
      best = store;
      bestEntry = entry;
    }
  }
  return best;
}
