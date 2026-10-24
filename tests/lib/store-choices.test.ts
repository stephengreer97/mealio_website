import { describe, it, expect } from 'vitest';
import {
  hasChoiceAt,
  hasChoiceElsewhere,
  moveIngredients,
  mostUsedStore,
  reconcileIngredients,
  searchTermAt,
} from '@/lib/store-choices';

const heb = { upc: 'h-1', name: 'H-E-B Whole Milk', sku: 's1' };
const kro = { upc: 'k-1', name: 'Kroger Whole Milk' };

describe('moveIngredients — switching the default store', () => {
  const milkAtHeb = { ingredientName: 'milk', qty: 1, unit: 'qty', searchTerm: 'H-E-B Whole Milk', storeProducts: { heb } };

  it('keeps the old store’s choice and leaves the new store productless', () => {
    const [moved] = moveIngredients([milkAtHeb], 'heb', 'kroger');
    expect(moved.searchTerm).toBeUndefined();
    expect(moved.storeSearchTerms).toEqual({ heb: 'H-E-B Whole Milk' });
    expect(moved.storeProducts).toEqual({ heb });
    expect(hasChoiceAt(moved, 'kroger')).toBe(false);
    expect(hasChoiceElsewhere(moved, 'kroger')).toBe(true);
  });

  it('brings the choice back on switching back', () => {
    const [atKroger] = moveIngredients([milkAtHeb], 'heb', 'kroger');
    const [back] = moveIngredients([atKroger], 'kroger', 'heb');
    expect(back.searchTerm).toBe('H-E-B Whole Milk');
    expect(back.storeProducts).toEqual({ heb });
  });

  it('treats Kroger banners as one store, so Kroger to Ralphs keeps the choice', () => {
    const atKroger = { ingredientName: 'milk', searchTerm: 'Kroger Whole Milk', storeProducts: { kroger: kro } };
    const [atRalphs] = moveIngredients([atKroger], 'kroger', 'ralphs');
    expect(atRalphs.searchTerm).toBe('Kroger Whole Milk');
  });

  it('treats Albertsons banners as one store too, matching the app', () => {
    const atSafeway = { ingredientName: 'milk', searchTerm: 'Lucerne Milk', storeProducts: { albertsons: { upc: 'a-1', name: 'Lucerne Milk' } } };
    const [atVons] = moveIngredients([atSafeway], 'safeway', 'vons');
    expect(atVons.searchTerm).toBe('Lucerne Milk');
    expect(atVons.storeSearchTerms).toEqual({ albertsons: 'Lucerne Milk' });
  });

  it('is safe to run twice', () => {
    const once = moveIngredients([milkAtHeb], 'heb', 'kroger');
    const twice = moveIngredients(once, 'kroger', 'kroger');
    expect(twice).toEqual(once);
  });

  it('leaves an ingredient nobody chose for exactly as it was', () => {
    const [moved] = moveIngredients([{ ingredientName: 'salt', qty: 1, unit: 'qty', searchTerm: null }], 'heb', 'kroger');
    expect(moved).toEqual({ ingredientName: 'salt', qty: 1, unit: 'qty' });
  });
});

describe('reconcileIngredients — every write to a meal', () => {
  const stored = [{
    ingredientName: 'milk',
    searchTerm: 'Kroger Whole Milk',
    storeSearchTerms: { heb: 'H-E-B Whole Milk', kroger: 'Kroger Whole Milk' },
    storeProducts: { heb, kroger: kro },
  }];

  it('restores other stores’ choices an old client dropped while re-choosing at its store', () => {
    // An old app re-picks at Kroger and, like it always has, drops every store's
    // products along with the fields it does not know.
    const incoming = [{ ingredientName: 'milk', searchTerm: 'Kroger 2% Milk' }];
    const [row] = reconcileIngredients(incoming, stored, 'kroger', 'kroger');
    expect(row.searchTerm).toBe('Kroger 2% Milk');
    expect(row.storeSearchTerms).toEqual({ heb: 'H-E-B Whole Milk', kroger: 'Kroger 2% Milk' });
    // H-E-B's product survives; Kroger's was cleared by the client, at its store.
    expect(row.storeProducts).toEqual({ heb });
  });

  it('keeps this store’s product when a form drops the field but the name is unchanged', () => {
    const [row] = reconcileIngredients([{ ingredientName: 'milk', searchTerm: 'Kroger Whole Milk' }], stored, 'kroger', 'kroger');
    expect(row.storeProducts).toEqual({ heb, kroger: kro });
  });

  it('lets the client clear the choice at its own store', () => {
    const [row] = reconcileIngredients([{ ingredientName: 'milk', searchTerm: null }], stored, 'kroger', 'kroger');
    expect(row.searchTerm).toBeUndefined();
    expect(searchTermAt(row, 'heb')).toBe('H-E-B Whole Milk');
  });

  it('files an old client’s choice under the store it chose at, and saves the meal at the default', () => {
    // An old app still offers a store per meal; the user picked H-E-B while
    // their default is Kroger.
    const [row] = reconcileIngredients([{ ingredientName: 'eggs', searchTerm: 'H-E-B Large Eggs' }], null, 'heb', 'kroger');
    expect(row.storeSearchTerms).toEqual({ heb: 'H-E-B Large Eggs' });
    expect(row.searchTerm).toBeUndefined();
  });

  it('matches rows by name, whatever order they arrive in', () => {
    const twoStored = [
      { ingredientName: 'Eggs', storeSearchTerms: { heb: 'H-E-B Eggs' } },
      { ingredientName: 'milk', storeSearchTerms: { heb: 'H-E-B Milk' } },
    ];
    const rows = reconcileIngredients(
      [{ ingredientName: 'milk', searchTerm: null }, { ingredientName: 'eggs', searchTerm: null }],
      twoStored,
      'kroger',
      'kroger',
    );
    expect(searchTermAt(rows[0], 'heb')).toBe('H-E-B Milk');
    expect(searchTermAt(rows[1], 'heb')).toBe('H-E-B Eggs');
  });

  it('does not invent a field on a new meal nobody chose products for', () => {
    const [row] = reconcileIngredients([{ ingredientName: 'salt', qty: 1 }], null, 'heb', 'heb');
    expect(row).toEqual({ ingredientName: 'salt', qty: 1 });
  });

  it('returns an empty list for something that is not a list', () => {
    expect(reconcileIngredients(null, stored, 'heb', 'heb')).toEqual([]);
  });
});

describe('mostUsedStore', () => {
  const supported = (s: string) => s !== 'amazon';

  it('picks the store with most meals, ignoring retired stores', () => {
    const meals = [
      { store_id: 'amazon' }, { store_id: 'amazon' }, { store_id: 'amazon' },
      { store_id: 'heb' }, { store_id: 'heb' }, { store_id: 'kroger' },
    ];
    expect(mostUsedStore(meals, supported)).toBe('heb');
  });

  it('breaks a tie by the most recent meal', () => {
    const meals = [
      { store_id: 'heb', created_at: '2026-01-01' },
      { store_id: 'kroger', created_at: '2026-03-01' },
    ];
    expect(mostUsedStore(meals, supported)).toBe('kroger');
  });

  it('is null with nothing usable', () => {
    expect(mostUsedStore([{ store_id: 'amazon' }, { store_id: null }], supported)).toBeNull();
  });
});
