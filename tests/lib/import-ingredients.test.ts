import { describe, it, expect } from 'vitest';
import { canonicalizeIngredient, canonicalizeIngredients, canonicalUnit, parseAmount } from '@/lib/import/ingredients';
import { canonicalizeDifficulty, canonicalizeTags } from '@/lib/import/vocab';
import type { ExtractedIngredient } from '@/lib/import/types';

/**
 * Ingredient canonicalisation has to survive the cart automation downstream —
 * a badly normalised ingredient becomes a failed add-to-cart in MEAL-1's funnel.
 * The output shape is the one `normalizeIngredients` produces in the mobile app.
 */

function ing(overrides: Partial<ExtractedIngredient>): ExtractedIngredient {
  return {
    productName: 'butter',
    measure: '2',
    unit: 'tbsp',
    qty: 1,
    evidence: null,
    derivation: 'json-ld',
    ...overrides,
  };
}

describe('import/ingredients — parseAmount', () => {
  it.each([
    ['2', 2],
    ['1.5', 1.5],
    ['1/2', 0.5],
    ['1 1/2', 1.5],
    ['½', 0.5],
    ['1½', 1.5],
    ['¾', 0.75],
    ['  3  ', 3],
  ])('parses %s as %s', (input, expected) => {
    expect(parseAmount(input)).toBeCloseTo(expected, 3);
  });

  it('takes the lower bound of a range — what a shopper actually buys for', () => {
    expect(parseAmount('2-3')).toBe(2);
    expect(parseAmount('2 to 3')).toBe(2);
    expect(parseAmount('1 or 2')).toBe(1);
  });

  it('returns null when there is no amount at all', () => {
    for (const input of ['', null, undefined, 'to taste', 'a handful', 'a knob of']) {
      expect(parseAmount(input)).toBeNull();
    }
  });
});

describe('import/ingredients — canonicalUnit', () => {
  it.each([
    ['tablespoon', 'tbsp'],
    ['Tablespoons', 'tbsp'],
    ['tsp.', 'tsp'],
    ['cup', 'cups'],
    ['grams', 'g'],
    ['pounds', 'lb'],
    ['fluid ounces', 'fl oz'],
    ['millilitres', 'ml'],
    ['Liter', 'L'],
  ])('maps %s to %s', (input, expected) => {
    expect(canonicalUnit(input)).toBe(expected);
  });

  it('treats an empty or count-like unit as qty', () => {
    for (const input of ['', 'qty', 'each', 'count']) {
      expect(canonicalUnit(input)).toBe('qty');
    }
  });

  it('returns null for units the editor cannot display', () => {
    for (const input of ['clove', 'can', 'bunch', 'pinch', 'sprig', 'stalk']) {
      expect(canonicalUnit(input)).toBeNull();
    }
  });
});

describe('import/ingredients — canonicalizeIngredient', () => {
  it('keeps a measured ingredient as unit + measure with qty 1', () => {
    expect(canonicalizeIngredient(ing({ productName: 'unsalted butter', measure: '2', unit: 'tbsp' }))).toEqual({
      ingredientName: 'unsalted butter',
      qty: 1,
      productQty: 1,
      unit: 'tbsp',
      measure: '2',
      searchTerm: null,
    });
  });

  it('turns a countable ingredient into a positive integer qty', () => {
    expect(canonicalizeIngredient(ing({ productName: 'eggs', measure: '3', unit: 'qty', qty: 3 }))).toMatchObject({
      ingredientName: 'eggs',
      qty: 3,
      productQty: 3,
      unit: 'qty',
      measure: null,
    });
  });

  it('folds a unit outside the picker vocabulary into a count', () => {
    // "3 cloves garlic" — the editor has no "clove", and a cart cannot act on
    // one. The original wording survives in the evidence span the UI shows.
    expect(canonicalizeIngredient(ing({ productName: 'garlic', measure: '3', unit: 'cloves', qty: 3 }))).toMatchObject({
      ingredientName: 'garlic',
      qty: 3,
      unit: 'qty',
      measure: null,
    });
  });

  it('defaults an unmeasured ingredient to one countable item', () => {
    // "salt to taste" — never guess an amount.
    expect(canonicalizeIngredient(ing({ productName: 'salt', measure: null, unit: 'qty', qty: 1 }))).toMatchObject({
      ingredientName: 'salt',
      qty: 1,
      unit: 'qty',
      measure: null,
    });
  });

  it('never emits a zero or negative quantity', () => {
    expect(canonicalizeIngredient(ing({ productName: 'x', measure: '0', unit: 'qty', qty: 0 }))!.qty).toBe(1);
    expect(canonicalizeIngredient(ing({ productName: 'x', measure: '-4', unit: 'qty', qty: -4 }))!.qty).toBe(1);
  });

  it('rounds a fractional count rather than sending a fraction to the cart', () => {
    expect(canonicalizeIngredient(ing({ productName: 'lemon', measure: '1/2', unit: 'qty' }))!.qty).toBe(1);
  });

  it('drops a row with no product name', () => {
    expect(canonicalizeIngredient(ing({ productName: '   ' }))).toBeNull();
  });

  it('keeps kept-indices aligned when a row is dropped', () => {
    const { ingredients, keptIndices } = canonicalizeIngredients([
      ing({ productName: 'flour' }),
      ing({ productName: '' }),
      ing({ productName: 'sugar' }),
    ]);
    expect(ingredients.map((i) => i.ingredientName)).toEqual(['flour', 'sugar']);
    expect(keptIndices).toEqual([0, 2]);
  });
});

describe('import/vocab', () => {
  it('keeps only tags the discover filters actually offer', () => {
    expect(canonicalizeTags(['Mexican', 'no cook', 'Guacamole', 'Avocado Toast', 'VEGAN'])).toEqual([
      'Mexican',
      'No Cook',
      'Vegan',
    ]);
  });

  it('drops duplicates while preserving order', () => {
    expect(canonicalizeTags(['Soup', 'soup', 'Vegan'])).toEqual(['Soup', 'Vegan']);
  });

  it('clamps difficulty to the 1–5 the portal renders', () => {
    expect(canonicalizeDifficulty(3)).toBe(3);
    expect(canonicalizeDifficulty(2.4)).toBe(2);
    expect(canonicalizeDifficulty(0)).toBeNull();
    expect(canonicalizeDifficulty(9)).toBeNull();
    expect(canonicalizeDifficulty(null)).toBeNull();
  });
});
