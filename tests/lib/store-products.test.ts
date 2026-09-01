import { describe, it, expect } from 'vitest';
import {
  storeProductKey,
  getStoreProduct,
  withStoreProduct,
  withoutStoreProducts,
} from '@/lib/store-products';

/**
 * MEAL-19 — remembering WHICH product the user chose, not just what it is called.
 *
 * `searchTerm` is a display name, so re-deriving a product from it lets the
 * store's relevance ranking re-decide the choice on every cart run. Storing the
 * store's own identifier fixes that and introduces exactly one new way to be
 * wrong: an identifier that reaches the wrong store, or outlives the choice it
 * came from, RESOLVES — it does not merely bias a search, it adds a real
 * product nobody picked. Every test here is about that one failure.
 *
 * The mobile app carries a second copy of these rules
 * (`mealio_app/src/lib/storeProducts.ts`, and its own tests). The two write the
 * same saved rows, so they have to agree on the key.
 */

const MILK = { upc: '0001111041700', name: 'Kroger Whole Milk, 1 gal' };

describe('storeProductKey — the rail, not the banner', () => {
  it('files every Kroger-family banner under one key', () => {
    for (const banner of ['kroger', 'ralphs', 'fred_meyer', 'king_soopers', 'harris_teeter']) {
      expect(storeProductKey(banner)).toBe('kroger');
    }
  });

  it('gives a non-Kroger store its own key, and a missing store none', () => {
    expect(storeProductKey('heb')).toBe('heb');
    expect(storeProductKey(null)).toBe('');
    expect(storeProductKey(undefined)).toBe('');
  });
});

describe('getStoreProduct — a choice cannot leak between stores', () => {
  const ing = { ingredientName: 'Whole Milk', storeProducts: { kroger: MILK } };

  it('returns the choice for the rail that made it, at any of its banners', () => {
    expect(getStoreProduct(ing, 'kroger')).toEqual(MILK);
    expect(getStoreProduct(ing, 'ralphs')).toEqual(MILK);
  });

  it('returns nothing for a store that never made one', () => {
    expect(getStoreProduct(ing, 'heb')).toBeNull();
  });

  it('returns nothing for a row nobody has chosen for', () => {
    expect(getStoreProduct({ ingredientName: 'Whole Milk' }, 'kroger')).toBeNull();
    expect(getStoreProduct({ storeProducts: {} }, 'kroger')).toBeNull();
  });

  it('ignores an entry with no usable identifier', () => {
    // Better to search than to look up an id that can only resolve to nothing.
    expect(getStoreProduct({ storeProducts: { kroger: { name: 'Milk' } } }, 'kroger')).toBeNull();
    expect(getStoreProduct({ storeProducts: { kroger: { upc: '  ' } } }, 'kroger')).toBeNull();
  });
});

describe('withStoreProduct / withoutStoreProducts', () => {
  it('records the choice under the rail without touching the rest of the row', () => {
    expect(withStoreProduct({ ingredientName: 'Whole Milk', productQty: 2 }, 'ralphs', MILK)).toEqual({
      ingredientName: 'Whole Milk',
      productQty: 2,
      storeProducts: { kroger: MILK },
    });
  });

  it('does not forget another store’s choice', () => {
    const heb = { upc: 'heb-1', name: 'H-E-B Milk' };
    expect(withStoreProduct({ storeProducts: { heb } }, 'kroger', MILK).storeProducts)
      .toEqual({ heb, kroger: MILK });
  });

  it('writes nothing without a store or without an identifier', () => {
    const row = { ingredientName: 'Whole Milk' };
    expect(withStoreProduct(row, null, MILK)).toEqual(row);
    expect(withStoreProduct(row, 'kroger', { upc: '', name: 'Milk' })).toEqual(row);
  });

  it('removes the key rather than emptying it', () => {
    // These rows are PATCHed back whole with no migration, so a row with no
    // choice has to serialise the way it did before the field existed.
    const out = withoutStoreProducts({ ingredientName: 'Whole Milk', storeProducts: { kroger: MILK } });
    expect(JSON.stringify(out)).not.toContain('storeProducts');
  });

  it('leaves a row that never had one untouched', () => {
    const row = { ingredientName: 'Whole Milk' };
    expect(withoutStoreProducts(row)).toBe(row);
  });

  it('does not mutate its input', () => {
    const before = { storeProducts: { kroger: MILK } };
    withStoreProduct(before, 'kroger', { upc: 'other', name: 'Other' });
    withoutStoreProducts(before);
    expect(before.storeProducts).toEqual({ kroger: MILK });
  });
});
