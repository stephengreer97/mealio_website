import { describe, it, expect } from 'vitest';
import {
  canonicalizeIngredient,
  canonicalizeIngredients,
  canonicalUnit,
  cartAmount,
  parseAmount,
  statedAmounts,
  statedUnits,
  unitLabel,
} from '@/lib/import/ingredients';
import { canonicalizeDifficulty, canonicalizeServes, canonicalizeTags, SERVES_PATTERN } from '@/lib/import/vocab';
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

/**
 * The inverse of `parseAmount`, and the input to the amount half of MEAL-72's
 * verification: a row saying `12 cups` cited to "1 teaspoon kosher salt" is a
 * number nobody wrote down.
 */
describe('import/ingredients — statedAmounts', () => {
  it.each([
    ['1 teaspoon kosher salt, more to taste', [1]],
    ['1 ½ cups all-purpose flour', [1.5]],
    ['½ teaspoon fine sea salt', [0.5]],
    ['2 1/2 cups guacamole', [2.5]],
    ['1 (14 oz) can black beans, drained', [1, 14]],
    ['2-3 cloves garlic', [2, 3]],
    ['salt and pepper to taste', []],
  ])('reads %s as %j', (line, expected) => {
    const amounts = statedAmounts(line);
    expect(amounts).toHaveLength(expected.length);
    expected.forEach((value, i) => expect(amounts[i]).toBeCloseTo(value, 3));
  });
});

describe('import/ingredients — statedUnits', () => {
  it('canonicalises the units a line names, including the two-word ones', () => {
    expect(statedUnits('1 teaspoon kosher salt')).toEqual(new Set(['tsp']));
    expect(statedUnits('8 fl oz whole milk')).toEqual(new Set(['fl oz', 'oz']));
    // A cook's unit is a unit the line named, so it is reported like any other.
    expect(statedUnits('3 cloves garlic, minced')).toEqual(new Set(['cloves']));
    // Still nothing for a line that names no unit at all.
    expect(statedUnits('a knob of butter')).toEqual(new Set());
  });
});

describe('import/ingredients — cartAmount', () => {
  it('reports the amount a measured row will act on', () => {
    const draft = canonicalizeIngredient(ing({ measure: '1', unit: 'teaspoon' }))!;
    expect(cartAmount(draft, ing({ measure: '1', unit: 'teaspoon' }))).toEqual({ value: 1, unit: 'tsp' });
  });

  it('reports the count a countable row will act on', () => {
    const extracted = ing({ productName: 'eggs', measure: '3', unit: 'qty', qty: 3 });
    expect(cartAmount(canonicalizeIngredient(extracted)!, extracted)).toEqual({ value: 3, unit: null });
  });

  it('exempts the qty 1 we invented ourselves for a row with no stated amount', () => {
    // "salt to taste" becomes one countable salt. That 1 is ours, not the
    // page's — demanding it appear in the span would demote every honest
    // to-taste row.
    const extracted = ing({ productName: 'salt', measure: null, unit: 'qty', qty: 1 });
    expect(cartAmount(canonicalizeIngredient(extracted)!, extracted)).toBeNull();
  });

  it('does not exempt a count the model supplied without an amount in the source', () => {
    const extracted = ing({ productName: 'eggs', measure: null, unit: 'qty', qty: 12 });
    expect(cartAmount(canonicalizeIngredient(extracted)!, extracted)).toEqual({ value: 12, unit: null });
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

  it('keeps a cook\'s unit, singular or plural, on the plural spelling', () => {
    // These convert to nothing and never needed to. Carrying the word is what
    // stops "3 cloves garlic" reading as "garlic, 3".
    expect(canonicalUnit('clove')).toBe('cloves');
    expect(canonicalUnit('cloves')).toBe('cloves');
    expect(canonicalUnit('can')).toBe('cans');
    expect(canonicalUnit('tin')).toBe('cans');
    expect(canonicalUnit('pinch')).toBe('pinches');
    expect(canonicalUnit('grind')).toBe('grinds');
  });

  it('spells a unit for the number beside it, and only for a bare one', () => {
    // Storing the plural is right — one token per unit — but it had leaked into
    // the render as "cannellini beans, 1 cans" and "parsley, 1 bunches".
    expect(unitLabel('cans', '1')).toBe('can');
    expect(unitLabel('bunches', '1')).toBe('bunch');
    expect(unitLabel('cups', 1)).toBe('cup');
    expect(unitLabel('cans', '2')).toBe('cans');

    // "1 1/2" starts with a 1 and is one and a half cups. `parseAmount` reads it
    // as 1 — it answers "how many packages" — so this deliberately does not use
    // it, and anything that is not the bare character "1" keeps the plural.
    expect(unitLabel('cups', '1 1/2')).toBe('cups');
    expect(unitLabel('cups', '1-2')).toBe('cups');

    // Abbreviations do not inflect and must not be trimmed to 'tbs' or ''.
    expect(unitLabel('tbsp', '1')).toBe('tbsp');
    expect(unitLabel('g', '1')).toBe('g');
    expect(unitLabel('fl oz', '1')).toBe('fl oz');
  });

  it('returns null for units the editor still cannot display', () => {
    for (const input of ['stalk', 'knob', 'dollop', 'splash']) {
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

  it('keeps a cook\'s unit rather than folding it into a package count', () => {
    // "3 cloves garlic" used to become qty 3 — which read as "garlic, 3" and,
    // worse, told the cart to buy three heads of garlic for three cloves. The
    // amount is now the measure and the package count drops back to one.
    expect(canonicalizeIngredient(ing({ productName: 'garlic', measure: '3', unit: 'cloves', qty: 3 }))).toMatchObject({
      ingredientName: 'garlic',
      qty: 1,
      productQty: 1,
      unit: 'cloves',
      measure: '3',
    });
  });

  it('still folds a unit nothing can display into a count', () => {
    // "a knob of butter" has no amount and no unit we carry, so it falls back
    // to a single countable item — one pack of butter.
    expect(canonicalizeIngredient(ing({ productName: 'butter', measure: null, unit: 'knob', qty: 1 }))).toMatchObject({
      ingredientName: 'butter',
      qty: 1,
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

/**
 * `serves` is how many PEOPLE a dish feeds. Recipe pages overwhelmingly publish
 * `recipeYield`, which is a different quantity and is often a volume or a batch
 * of items. Turning "2 1/2 cups guacamole" into `serves: 2` is wrong data, and
 * because the span is genuinely on the page the confidence model would mark it
 * green — so it has to be caught here.
 */
describe('import/vocab — canonicalizeServes', () => {
  it.each([
    ['4', 'Serves 4', '4'],
    ['4-6', 'Serves 4-6', '4-6'],
    ['4 servings', '4 servings', '4'],
    ['6', 'Feeds a family of 6', '6'],
    ['8', '8 people', '8'],
    ['6', 'Serves 6 generously', '6'],
  ])('keeps %s from %s', (value, evidence, expected) => {
    expect(canonicalizeServes(value, evidence)).toBe(expected);
  });

  it('drops a serving count read off a volume', () => {
    // The owner's case: "2 1/2 cups" must not become "serves 2".
    expect(canonicalizeServes('2', '2 1/2 cups guacamole')).toBeNull();
    expect(canonicalizeServes('2 1/2', '2 1/2 cups guacamole')).toBeNull();
    expect(canonicalizeServes('4', '4 cups of soup')).toBeNull();
    expect(canonicalizeServes('500', '500 g')).toBeNull();
    expect(canonicalizeServes('1', '1 loaf')).toBeNull();
  });

  it('drops a serving count read off a batch of items', () => {
    expect(canonicalizeServes('12', 'Makes about 12 pancakes')).toBeNull();
    expect(canonicalizeServes('24', '24 cookies')).toBeNull();
  });

  it('drops a batch of an item nobody put on a list', () => {
    // The reason this is an allowlist now. A denylist of yield nouns passes
    // every noun nobody thought of, and the span really is on the page, so all
    // of these read green. The set of things a recipe can yield is open; the
    // set of ways to say "people" is not.
    expect(canonicalizeServes('12', 'Makes 12 empanadas')).toBeNull();
    expect(canonicalizeServes('24', 'Makes 24 arancini')).toBeNull();
    expect(canonicalizeServes('30', 'Yields 30 dumplings')).toBeNull();
    // A recorded page publishes this as its recipeYield. Four bowls is a yield
    // in a vessel, not a statement about how many people eat — and guessing
    // costs the creator a wrong number they never look at, where dropping it
    // costs one keystroke. Same trade the extraction prompt already asks for.
    expect(canonicalizeServes('4', '4 (Large bowls)')).toBeNull();
  });

  it('does not read a serving suggestion as a head count', () => {
    // "Serve" the imperative is not "serves" the count. This sentence is
    // genuinely on the guacamole page, which is what makes it dangerous.
    expect(canonicalizeServes('48', 'Serve it with tortilla chips at your next party')).toBeNull();
  });

  it('drops a count with no span to place it against', () => {
    expect(canonicalizeServes('4', null)).toBeNull();
    expect(canonicalizeServes('4', '')).toBeNull();
    expect(canonicalizeServes('4')).toBeNull();
  });

  it('keeps a count when the span says people even alongside an item word', () => {
    expect(canonicalizeServes('4', 'Serves 4, about 12 pancakes')).toBe('4');
  });

  it('rejects anything that is not the form shape', () => {
    for (const value of ['', 'a few', 'lots', '0', '-2', 'many people']) {
      expect(canonicalizeServes(value, 'Serves plenty')).toBeNull();
    }
  });

  it('rejects a fractional count outright — people do not come in halves', () => {
    expect(canonicalizeServes('2 1/2', 'Serves 2 1/2')).toBeNull();
    expect(canonicalizeServes('2.5', 'Serves 2.5')).toBeNull();
  });

  it('matches the form pattern for everything it keeps', () => {
    for (const [value, evidence] of [['4', 'Serves 4'], ['4-6', 'Serves 4-6'], ['10', '10 servings']]) {
      expect(canonicalizeServes(value, evidence)).toMatch(SERVES_PATTERN);
    }
  });
});
