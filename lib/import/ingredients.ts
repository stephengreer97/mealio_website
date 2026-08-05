/**
 * Ingredient canonicalisation (MEAL-71).
 *
 * A badly normalised ingredient becomes a failed add-to-cart in MEAL-1's funnel,
 * so the shape the pipeline emits has to be exactly the shape the rest of the
 * product already uses: the `Ingredient` produced by `normalizeIngredients`
 * (mealio_app `src/lib/normalizeIngredients.ts`) and consumed by
 * `IngredientEditor`.
 *
 * The model does the *semantic* work — reading "2 tbsp unsalted butter, melted"
 * and deciding the product is butter, the amount is 2 and the unit is tbsp. This
 * module does the *structural* work: forcing the result into the unit vocabulary
 * the editor actually offers, so a value the model invents can never reach the
 * cart. It is the same normalisation path, not a second one.
 */

import type { DraftIngredient, ExtractedIngredient } from './types';

/**
 * The unit picker's vocabulary, copied from `IngredientEditor.tsx`. `qty` is the
 * internal token for the picker's "Qty" (countable) option.
 */
export const UNITS = ['cups', 'fl oz', 'g', 'kg', 'L', 'lb', 'mg', 'ml', 'oz', 'tbsp', 'tsp'] as const;
export const COUNT_UNIT = 'qty';

/**
 * Units a cook writes that do not convert to anything, and never needed to.
 *
 * "3 cloves garlic" used to collapse to a count of 3 because `clove` was not in
 * the vocabulary — which read as "garlic, 3" to the cook and, worse, told the
 * cart to buy **three heads of garlic** for three cloves. Carrying the word
 * fixes both: the line reads the way the recipe wrote it, and the amount stops
 * being a package count.
 *
 * Nothing downstream converts these, and nothing needs to. `unit` is display
 * text everywhere it is read — the store search uses `searchTerm`/
 * `ingredientName`, the number of packages comes from `productQty`, and
 * consolidation keys on `searchTerm`. The only branch that inspects a unit at
 * all is `unit === 'qty'`, which chooses between two display formats.
 *
 * Plural because that is how a line reads in the common case ("3 cloves"), and
 * the singular spellings alias onto it below.
 */
export const COOK_UNITS = ['cloves', 'cans', 'bunches', 'sprigs', 'pinches', 'handfuls', 'grinds', 'slices', 'thumbs'] as const;

/** Everything the picker offers, in the order it offers it. */
export const ALL_UNITS = [...UNITS, ...COOK_UNITS] as const;

/** Everything a recipe writer might type, mapped to the picker's tokens. */
const UNIT_ALIASES: Record<string, string> = {
  c: 'cups', cup: 'cups', cups: 'cups',
  tbsp: 'tbsp', tbs: 'tbsp', tb: 'tbsp', tablespoon: 'tbsp', tablespoons: 'tbsp', 'tbsp.': 'tbsp',
  tsp: 'tsp', teaspoon: 'tsp', teaspoons: 'tsp', 'tsp.': 'tsp',
  g: 'g', gram: 'g', grams: 'g', gr: 'g',
  kg: 'kg', kilogram: 'kg', kilograms: 'kg', kilo: 'kg',
  mg: 'mg', milligram: 'mg', milligrams: 'mg',
  ml: 'ml', milliliter: 'ml', milliliters: 'ml', millilitre: 'ml', millilitres: 'ml', cc: 'ml',
  l: 'L', liter: 'L', liters: 'L', litre: 'L', litres: 'L',
  lb: 'lb', lbs: 'lb', pound: 'lb', pounds: 'lb', '#': 'lb',
  oz: 'oz', ounce: 'oz', ounces: 'oz',
  'fl oz': 'fl oz', floz: 'fl oz', 'fluid ounce': 'fl oz', 'fluid ounces': 'fl oz',
  qty: COUNT_UNIT, count: COUNT_UNIT, each: COUNT_UNIT, ea: COUNT_UNIT, '': COUNT_UNIT,

  // Cook's units. Singular and plural both land on the plural spelling, so
  // "1 clove garlic" and "3 cloves garlic" render the same way.
  clove: 'cloves', cloves: 'cloves',
  can: 'cans', cans: 'cans', tin: 'cans', tins: 'cans',
  bunch: 'bunches', bunches: 'bunches',
  sprig: 'sprigs', sprigs: 'sprigs',
  pinch: 'pinches', pinches: 'pinches',
  handful: 'handfuls', handfuls: 'handfuls',
  grind: 'grinds', grinds: 'grinds',
  slice: 'slices', slices: 'slices',
  thumb: 'thumbs', thumbs: 'thumbs',
};

/**
 * The singular spelling of a stored unit, for the one place it is read aloud.
 *
 * Storing the plural is right — one token per unit, and the aliases above fold
 * "clove" and "cloves" onto it — but it is a *storage* decision that leaked into
 * the render: a card showed "cannellini beans, 1 cans" and "parsley, 1 bunches",
 * which is our data model talking rather than a recipe. Only the words that
 * actually inflect are in here; `tbsp`, `g` and `fl oz` read the same either
 * way and must not be trimmed to `tbs`, `` or `fl o`.
 */
const SINGULAR_UNITS: Record<string, string> = {
  cups: 'cup',
  cloves: 'clove',
  cans: 'can',
  bunches: 'bunch',
  sprigs: 'sprig',
  pinches: 'pinch',
  handfuls: 'handful',
  grinds: 'grind',
  slices: 'slice',
  thumbs: 'thumb',
};

/**
 * How a unit should be spelled beside `amount`.
 *
 * Singular for exactly one and nothing else. Deliberately a string comparison
 * rather than `parseAmount`: that reads "1 1/2" as 1 — it is built to answer
 * "how many packages" — and one and a half cups is still cups. Anything that is
 * not the bare character "1" keeps the stored plural, which is the safe way for
 * this to be wrong.
 */
export function unitLabel(unit: string, amount: string | number | null | undefined): string {
  const text = String(amount ?? '').trim();
  // A bare fraction takes the singular too: a cook writes "1/2 cup" and "1/4
  // cup", never "1/2 cups". Matched as a string rather than parsed, so "1 1/2"
  // — which is more than one and keeps the plural — cannot be caught by it.
  const one = typeof amount === 'number'
    ? amount <= 1
    : text === '1' || /^\d+\s*\/\s*\d+$/.test(text);
  return one ? (SINGULAR_UNITS[unit] ?? unit) : unit;
}

/**
 * Vulgar fractions in their ASCII form. Kept as text rather than numbers so one
 * table serves both readers: `parseAmount` wants the value, `statedAmounts`
 * rewrites "1½" to "1 1/2" so a single scanner handles both spellings.
 */
const VULGAR_ASCII: Record<string, string> = {
  '½': '1/2', '⅓': '1/3', '⅔': '2/3', '¼': '1/4', '¾': '3/4',
  '⅕': '1/5', '⅖': '2/5', '⅗': '3/5', '⅘': '4/5', '⅙': '1/6', '⅚': '5/6',
  '⅛': '1/8', '⅜': '3/8', '⅝': '5/8', '⅞': '7/8',
};

const VULGAR_FRACTIONS: Record<string, number> = Object.fromEntries(
  Object.entries(VULGAR_ASCII).map(([glyph, ascii]) => {
    const [numerator, denominator] = ascii.split('/');
    return [glyph, Number(numerator) / Number(denominator)];
  }),
);

/**
 * Parses the amount a recipe writer wrote: "2", "1 1/2", "½", "1.5", "2-3"
 * (takes the lower bound), "a" / "" (none).
 */
export function parseAmount(input: string | null | undefined): number | null {
  if (input == null) return null;
  let text = String(input).trim().toLowerCase();
  if (!text) return null;

  // A range or an alternative — take the first number a cook would buy for.
  text = text.split(/\s*(?:-|–|—|to|or)\s*/)[0].trim();
  if (!text) return null;

  let total = 0;
  let sawNumber = false;

  for (const token of text.split(/\s+/)) {
    if (VULGAR_FRACTIONS[token] != null) {
      total += VULGAR_FRACTIONS[token];
      sawNumber = true;
      continue;
    }
    // A vulgar fraction glued to a whole number: "1½"
    const glued = /^(\d+)([¼-¾⅐-⅞])$/.exec(token);
    if (glued) {
      total += Number(glued[1]) + (VULGAR_FRACTIONS[glued[2]] ?? 0);
      sawNumber = true;
      continue;
    }
    const fraction = /^(\d+)\/(\d+)$/.exec(token);
    if (fraction && Number(fraction[2]) !== 0) {
      total += Number(fraction[1]) / Number(fraction[2]);
      sawNumber = true;
      continue;
    }
    const decimal = /^\d+(?:\.\d+)?$/.exec(token);
    if (decimal) {
      total += Number(decimal[0]);
      sawNumber = true;
      continue;
    }
    // Anything else ("large", "cloves") is not part of the amount.
    break;
  }

  if (!sawNumber) return null;
  return Math.round(total * 1000) / 1000;
}

/** Maps a written unit onto the picker's vocabulary, or null if it isn't one. */
export function canonicalUnit(input: string | null | undefined): string | null {
  if (input == null) return null;
  // Trailing periods go first. Recipe writers abbreviate with them — "1 lb.
  // ground Italian sausage", "8 oz. cream cheese" — and an unrecognised unit
  // does not fail loudly: it falls through to `qty` below and takes the amount
  // with it, so a pound of sausage became "1 qty of ground Italian sausage" on
  // a draft that looked otherwise correct.
  const key = String(input).trim().toLowerCase().replace(/\s+/g, ' ').replace(/\.+$/, '').trim();
  if (!key) return COUNT_UNIT;
  if (UNIT_ALIASES[key]) return UNIT_ALIASES[key];
  // Singular/plural fallback: "cupss" won't match, "cup" already did.
  const depluralised = key.replace(/s$/, '');
  return UNIT_ALIASES[depluralised] ?? null;
}

/**
 * The fractions recipes are written in, and `parseAmount` reads back.
 *
 * "0.25 cups tahini" is not a line any cook has written. Round-trip safe: every
 * spelling here parses to the number it came from.
 */
const AMOUNT_FRACTIONS: Array<[number, string]> = [
  [0.125, '1/8'], [0.2, '1/5'], [0.25, '1/4'], [1 / 3, '1/3'], [0.375, '3/8'],
  [0.4, '2/5'], [0.5, '1/2'], [0.6, '3/5'], [0.625, '5/8'], [2 / 3, '2/3'],
  [0.75, '3/4'], [0.8, '4/5'], [0.875, '7/8'],
];

function formatAmount(value: number): string {
  if (Number.isInteger(value)) return String(value);
  const whole = Math.floor(value);
  const remainder = value - whole;
  // Tolerance rather than equality: a third arrives as 0.33 from one source and
  // 0.3333 from another, and both are a third to a cook.
  const match = AMOUNT_FRACTIONS.find(([n]) => Math.abs(n - remainder) < 0.011);
  if (!match) return String(Math.round(value * 100) / 100);
  return whole ? `${whole} ${match[1]}` : match[1];
}

/**
 * Forces one model-produced ingredient into the canonical `Ingredient` shape.
 *
 * Two rules carry the weight:
 *  - A unit outside the editor's vocabulary ("clove", "can", "bunch", "pinch")
 *    becomes a count, because the editor cannot display it and the cart cannot
 *    act on it. The original wording survives in the evidence span the UI shows.
 *  - No amount at all ("salt to taste") becomes a single countable item, which
 *    is what a shopper actually adds to a cart.
 */
export function canonicalizeIngredient(input: ExtractedIngredient): DraftIngredient | null {
  const ingredientName = String(input.productName ?? '').trim().replace(/\s+/g, ' ');
  if (!ingredientName) return null;

  const amount = parseAmount(input.measure);
  const unit = canonicalUnit(input.unit);

  // Measured units keep the amount as display text; qty stays 1, matching
  // `fromFormIng` in IngredientEditor.
  if (unit && unit !== COUNT_UNIT) {
    return {
      ingredientName,
      qty: 1,
      productQty: 1,
      unit,
      measure: amount != null ? formatAmount(amount) : (input.measure?.trim() || null),
      searchTerm: null,
    };
  }

  // Countable: qty must be a positive integer — 0 is not a valid cart quantity.
  const rawCount = amount ?? (Number.isFinite(input.qty) ? Number(input.qty) : null);
  const count = rawCount != null && rawCount >= 1 ? Math.round(rawCount) : 1;
  const qty = Math.min(count, 99);

  // The count goes in `measure` as well as `qty`, and the two mean different
  // things: `qty` is how many products to buy, `measure` is what the recipe
  // said. Null when it said nothing — every unquantified line ("salt to taste")
  // lands here as a countable 1, and writing "1" would invent an amount nobody
  // wrote, which is exactly what the card uses `measure` to tell apart.
  return {
    ingredientName,
    qty,
    productQty: qty,
    unit: COUNT_UNIT,
    measure: amount != null ? formatAmount(amount) : null,
    searchTerm: null,
  };
}

// ── Reading amounts back out of a written line ───────────────────────────────

/**
 * Every amount a line of source text states, as numbers: "1 1/2" → 1.5,
 * "½" → 0.5, "2-3" → 2 and 3.
 *
 * The inverse of `parseAmount`, and it exists for one job: checking a draft
 * row's amount against the evidence span it cites. The span is what the page
 * actually says, so a row carrying `12 cups` cited to "1 teaspoon kosher salt"
 * is a number nobody wrote down — and that is a 48× error heading for a cart.
 */
export function statedAmounts(text: string): number[] {
  const ascii = String(text).replace(/[¼-¾⅐-⅞]/g, (glyph) => ` ${VULGAR_ASCII[glyph] ?? ''} `);
  const out: number[] = [];
  // Mixed number first, so "1 1/2" reads as 1.5 rather than as 1 and then 0.5.
  const pattern = /(\d+)\s+(\d+)\s*\/\s*(\d+)|(\d+)\s*\/\s*(\d+)|\d+(?:\.\d+)?/g;
  for (const match of ascii.matchAll(pattern)) {
    if (match[1] != null) {
      const denominator = Number(match[3]);
      if (denominator !== 0) out.push(Number(match[1]) + Number(match[2]) / denominator);
    } else if (match[4] != null) {
      const denominator = Number(match[5]);
      if (denominator !== 0) out.push(Number(match[4]) / denominator);
    } else {
      out.push(Number(match[0]));
    }
  }
  return out;
}

/**
 * Canonical units named anywhere in a line of source text ("teaspoon" → "tsp").
 *
 * Word pairs are tried as well as single words because two of the picker's units
 * are spelled with a space — "8 fl oz" must not read as a bare "oz".
 */
export function statedUnits(text: string): Set<string> {
  const words = String(text).toLowerCase().match(/[a-z]+\.?/g) ?? [];
  const out = new Set<string>();
  for (let i = 0; i < words.length; i++) {
    for (const candidate of [words[i], `${words[i]} ${words[i + 1] ?? ''}`.trim()]) {
      const unit = canonicalUnit(candidate);
      if (unit && unit !== COUNT_UNIT) out.add(unit);
    }
  }
  return out;
}

/** The amount a draft row will act on, in the form its evidence span states it. */
export interface CartAmount {
  value: number;
  /** The canonical unit, or null for a countable row — "3 eggs" names no unit. */
  unit: string | null;
}

/**
 * The amount a draft row puts in the cart, or null when the row carries no
 * amount worth checking.
 *
 * `qty: 1` on a countable row is this module's own default for "the source
 * stated no amount" — `salt to taste` becomes one countable salt — not a number
 * anyone read off the page. Demanding a "1" in the span would demote every
 * honest to-taste row, so a row whose amount we invented is exempt rather than
 * unverified. A `qty` the *model* invented is not: it is checked like any other.
 */
export function cartAmount(
  draft: DraftIngredient,
  extracted: ExtractedIngredient,
): CartAmount | null {
  if (draft.unit !== COUNT_UNIT) {
    const value = parseAmount(draft.measure);
    return value == null ? null : { value, unit: draft.unit };
  }
  const sourceStatedOne = parseAmount(extracted.measure) != null;
  if (!sourceStatedOne && draft.qty === 1) return null;
  return { value: draft.qty, unit: null };
}

/** Canonicalises a list, dropping rows with no product name. */
export function canonicalizeIngredients(inputs: ExtractedIngredient[]): {
  ingredients: DraftIngredient[];
  /** Indices in `inputs` that survived, so per-ingredient confidence stays aligned. */
  keptIndices: number[];
} {
  const ingredients: DraftIngredient[] = [];
  const keptIndices: number[] = [];
  inputs.forEach((input, index) => {
    const canonical = canonicalizeIngredient(input);
    if (canonical) {
      ingredients.push(canonical);
      keptIndices.push(index);
    }
  });
  return { ingredients, keptIndices };
}
