/**
 * My Meals' ingredient edit form, and the two conversions either side of it
 * (MEAL-102 review).
 *
 * Lifted out of `page.tsx` so the round trip can be tested without rendering the
 * page. Nothing here changed in the move. The creator portal's near-twin lives
 * at `app/creator/ingredient-form.ts` and is deliberately kept separate: it
 * keeps a typed `measure` for countables where this one writes null, so sharing
 * one implementation would change one page's behaviour without saying so.
 */
import type { Ingredient } from '@/components/MealCard';

export interface IngredientForm {
  ingredientName: string;
  measure: string;
  unit: string;
  searchTerm: string | null;
  qty: number;
  productQty?: number;
  /**
   * Carried through the edit form untouched, with no input bound to it.
   *
   * There is nothing to type into yet — how a creator *enters* prep is still
   * open — but the round trip has to preserve it regardless: this form is
   * `Ingredient -> IngredientForm -> Ingredient`, and a field the form does not
   * carry is a field that opening the edit modal and pressing Save deletes.
   */
  prep?: string | null;
}

export function toFormIng(ing: Ingredient): IngredientForm {
  return {
    ingredientName: ing.ingredientName,
    // Blank rather than "1" for a plain count: a line the source gave no amount
    // for ("many grinds of black pepper") arrives as a countable 1, and typing
    // that into the box reads as a quantity we read rather than one we assumed.
    // `fromFormIng` parses an empty measure straight back to 1.
    measure: ing.unit === 'qty' ? ((ing.qty ?? 1) > 1 ? String(ing.qty) : '') : (ing.measure ?? ''),
    unit: ing.unit ?? 'qty',
    searchTerm: ing.searchTerm ?? null,
    qty: ing.qty ?? 1,
    productQty: ing.productQty ?? ing.qty ?? 1,
    prep: ing.prep ?? null,
  };
}

export function fromFormIng(form: IngredientForm): Ingredient {
  if (form.unit === 'qty') {
    const q = parseInt(form.measure) || 1;
    return {
      ingredientName: form.ingredientName.trim(),
      qty: q,
      unit: 'qty',
      measure: null,
      searchTerm: form.searchTerm ?? null,
      productQty: q,
      // Omitted rather than written as null, so a row that never had a
      // preparation is saved back exactly as it was loaded.
      ...(form.prep ? { prep: form.prep } : {}),
    };
  }
  return {
    ingredientName: form.ingredientName.trim(),
    qty: form.qty,
    unit: form.unit,
    measure: form.measure.trim() || null,
    searchTerm: form.searchTerm ?? null,
    productQty: form.productQty ?? 1,
    ...(form.prep ? { prep: form.prep } : {}),
  };
}

