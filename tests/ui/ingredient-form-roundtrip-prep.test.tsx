// MEAL-102 — a preparation survives being opened in an edit form and saved back.
//
// Both editable pages load an ingredient into a form and convert it back on
// save. A cold review deleted the ENTIRE prep round trip from each page — all
// four lines, both directions — and the full 2169-test suite stayed green. The
// helpers were page-local and unexported, so nothing could reach them; they are
// now colocated modules, and this is the file that fails.
//
// The two pages are tested separately on purpose. Their `fromFormIng`s disagree
// about `measure` for countables (the creator portal keeps what was typed, My
// Meals writes null), so one shared assertion would have to be loose enough to
// pass for either — which is how a test ends up agreeing with whichever one
// broke.

import { describe, it, expect } from 'vitest';
import * as creator from '@/app/creator/ingredient-form';
import * as myMeals from '@/app/my-meals/ingredient-form';

const PAGES = [
  ['the creator portal', creator],
  ['My Meals', myMeals],
] as const;

describe.each(PAGES)('%s carries a preparation through the edit form', (_name, page) => {
  const { toFormIng, fromFormIng } = page;

  it('keeps it on a countable row', () => {
    const back = fromFormIng(toFormIng({ ingredientName: 'onion', qty: 1, unit: 'qty', measure: '1', prep: 'finely diced' }));
    expect(back.prep).toBe('finely diced');
  });

  it('keeps it on a measured row', () => {
    const back = fromFormIng(toFormIng({ ingredientName: 'chickpeas', qty: 1, unit: 'cans', measure: '2', prep: 'drained and rinsed' }));
    expect(back.prep).toBe('drained and rinsed');
  });

  it('adds no prep key to a row that never had one', () => {
    // Additive in the direction that matters: opening a pre-MEAL-102 meal and
    // saving it unchanged must not rewrite its rows. `stripEditedConfidence`
    // compares by JSON.stringify, so a null here would mark every untouched row
    // as edited.
    const countable = fromFormIng(toFormIng({ ingredientName: 'onion', qty: 1, unit: 'qty', measure: '1' }));
    const measured = fromFormIng(toFormIng({ ingredientName: 'chickpeas', qty: 1, unit: 'cans', measure: '2' }));
    expect('prep' in countable).toBe(false);
    expect('prep' in measured).toBe(false);
    expect(JSON.stringify(countable)).not.toContain('prep');
    expect(JSON.stringify(measured)).not.toContain('prep');
  });

  it('drops a preparation the user cleared', () => {
    const form = { ...toFormIng({ ingredientName: 'onion', qty: 1, unit: 'qty', measure: '1', prep: 'finely diced' }), prep: '' };
    expect('prep' in fromFormIng(form)).toBe(false);
  });

  it('never lets a preparation reach the search term', () => {
    // The cart's add gate is exact equality against searchTerm, so a prep here
    // matches nothing and silently under-adds.
    const back = fromFormIng(toFormIng({
      ingredientName: 'onion', qty: 1, unit: 'qty', measure: '1',
      searchTerm: 'Yellow Onion', prep: 'finely diced',
    }));
    expect(back.searchTerm).toBe('Yellow Onion');
    expect(back.ingredientName).toBe('onion');
  });
});
