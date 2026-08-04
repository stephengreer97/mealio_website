import { describe, it, expect } from 'vitest';
import { fmtMeasurement } from '@/components/MealCard';

/**
 * What a countable ingredient reads as.
 *
 * The rule used to be "hide any count of one", because an unquantified line
 * ("salt to taste") arrives as a countable 1 and printing it states an amount
 * nobody wrote. It hid "1 onion" too — `qty: 1` cannot tell the two apart.
 *
 * `measure` can, and always could: it is what the source said, where `qty` is
 * how many products to buy.
 */
const ing = (over: Record<string, unknown>) =>
  ({ ingredientName: 'Onion', qty: 1, unit: 'qty', measure: null, searchTerm: null, productQty: 1, ...over }) as any;

describe('fmtMeasurement — countables', () => {
  it('prints a stated count of one', () => {
    expect(fmtMeasurement(ing({ measure: '1' }))).toBe('1 Onion');
  });

  it('says nothing for a line the source never quantified', () => {
    // The whole reason the old rule existed. "1 Salt" is a number we invented.
    expect(fmtMeasurement(ing({ ingredientName: 'Salt', measure: null, qty: 1 }))).toBe('Salt');
  });

  it('still reads qty on rows written before measure carried the count', () => {
    // MEAL-103: most preset rows keep their amount in `qty` with `measure`
    // null. Without this fallback "12 Corn Tortillas" becomes "Corn Tortillas"
    // until that migration lands — a regression dressed as a fix.
    expect(fmtMeasurement(ing({ ingredientName: 'Corn Tortillas', qty: 12, measure: null }))).toBe('12 Corn Tortillas');
  });

  it('prefers what the source said over the product count', () => {
    expect(fmtMeasurement(ing({ measure: '2', qty: 6 }))).toBe('2 Onion');
  });

  it('leaves measured units alone', () => {
    expect(fmtMeasurement(ing({ ingredientName: 'Flour', unit: 'cups', measure: '1.5', qty: 1 }))).toBe('1.5 cups Flour');
  });
});
