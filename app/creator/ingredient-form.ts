/**
 * The creator portal's ingredient edit form, and the two conversions either side
 * of it (MEAL-102 review).
 *
 * Lifted out of `page.tsx` so the round trip can be tested without rendering the
 * page. Nothing here changed in the move; a cold review found that deleting the
 * whole prep round trip from this page failed no test, which is the gap this
 * file closes. My Meals has its own copy at `app/my-meals/ingredient-form.ts` —
 * deliberately NOT shared, because the two disagree about `measure` for
 * countables and merging them would silently change one of the pages.
 */
import type { Ingredient } from '@/components/MealCard';

export interface IngredientForm {
  ingredientName: string;
  measure: string;
  unit: string;
  searchTerm: string | null;
  qty: number;
  /**
   * What the line asks be DONE to the product — "finely diced" (MEAL-102).
   *
   * Bound to its own input as of MEAL-165. It was carried-but-invisible before
   * that, which meant an imported preparation the model invented was published
   * with no way for the creator to see or correct it.
   *
   * Preserving it is still load-bearing on top of that: the edit modal is
   * `Ingredient -> IngredientForm -> Ingredient`, so anything the form drops is
   * deleted by the act of opening a meal and saving it.
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
    // `measure` first for countables too, now that it is what the card reads.
    // The `qty` fallback is for rows written before that (MEAL-103); without it
    // a creator opening an old meal would see an empty box and save the number
    // away.
    measure: ing.unit === 'qty'
      ? ((ing.measure ?? '').trim() || ((ing.qty ?? 1) > 1 ? String(ing.qty) : ''))
      : (ing.measure ?? ''),
    unit: ing.unit ?? 'qty',
    searchTerm: ing.searchTerm ?? null,
    qty: ing.qty ?? 1,
    prep: ing.prep ?? null,
  };
}

export function fromFormIng(form: IngredientForm): Ingredient {
  if (form.unit === 'qty') {
    const typed = form.measure.trim();
    const q = parseInt(typed) || 1;
    return {
      ingredientName: form.ingredientName.trim(),
      qty: q,
      unit: 'qty',
      // Kept, not discarded. The card prints `measure` for countables now, so
      // writing null here would show a creator "1 onion" while they typed it and
      // "onion" the moment they saved — and an empty box stays empty, which is
      // how "salt" goes on staying salt.
      measure: typed || null,
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
    productQty: 1,
    ...(form.prep ? { prep: form.prep } : {}),
  };
}

