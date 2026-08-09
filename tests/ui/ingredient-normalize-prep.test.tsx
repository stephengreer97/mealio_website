// MEAL-102 — `prep` is absent or a string, never null, at every read boundary.
//
// The cold review that produced this file found the opposite shipped: four
// pages each kept a private copy of `normIng` writing `prep: raw.prep ?? null`,
// and one of them — the preset meal's public page — POSTs its normalised array
// straight to `/api/meals`. So every meal saved from a preset page stored
// `prep: null` on every ingredient, including rows that never had one. The same
// preset saved from Discover, which passes the row through raw, stored no key
// at all.
//
// Nothing noticed, because the copies were unexported page internals and the
// only covered normaliser was the shared one in MealCard. The four copies are
// now that shared one, and this file is what fails if a fifth appears.
//
// Why absent-vs-null is not tidiness: `stripEditedConfidence`
// (`lib/import-drafts.ts`) compares draft ingredient rows by `JSON.stringify`.
// A null where there was no key makes every row of a re-saved pre-MEAL-102 draft
// compare unequal, which flips each one's badge to "edited" — the creator is
// told we changed rows we did not touch.

import { describe, it, expect } from 'vitest';
import { normIng, normIngWithProductQty } from '@/components/MealCard';

const ROW = { ingredientName: 'onion', qty: 1, unit: 'qty', measure: null };

describe('normIng leaves prep off a row that has none', () => {
  it('omits the key entirely rather than nulling it', () => {
    const out = normIng(ROW);
    expect('prep' in out).toBe(false);
  });

  it('serialises byte-identically to the pre-MEAL-102 shape', () => {
    // The assertion the page-local copies would have failed. Field-by-field
    // comparison would not notice an added key; this does.
    expect(JSON.stringify(normIng(ROW))).toBe(
      '{"ingredientName":"onion","searchTerm":null,"qty":1,"unit":"qty","measure":null}',
    );
  });

  it.each([null, undefined, '', '   ', 42, {}, []])('omits it for %p', (prep) => {
    expect('prep' in normIng({ ...ROW, prep })).toBe(false);
  });

  it('keeps a real preparation', () => {
    expect(normIng({ ...ROW, prep: 'finely diced' }).prep).toBe('finely diced');
  });

  it('reads it off a stored row the way the pages receive it', () => {
    // Storage spells the name four ways; `prep` has only one spelling, so this
    // is the shape a real `meals.ingredients` row arrives in.
    const out = normIng({ product_name: 'onion', qty: 2, unit: 'qty', prep: 'roughly chopped' });
    expect(out.ingredientName).toBe('onion');
    expect(out.prep).toBe('roughly chopped');
  });
});

describe('normIngWithProductQty adds productQty and nothing else', () => {
  it('still omits an absent prep', () => {
    const out = normIngWithProductQty(ROW);
    expect('prep' in out).toBe(false);
    expect(out.productQty).toBe(1);
  });

  it('keeps a real preparation', () => {
    expect(normIngWithProductQty({ ...ROW, prep: 'finely diced' }).prep).toBe('finely diced');
  });

  it('differs from normIng by exactly productQty', () => {
    // The two shapes are separate functions so neither page can drift into the
    // other's. An extra key on the read-only pages would be written back by the
    // preset page exactly the way `prep: null` was.
    const bare = Object.keys(normIng({ ...ROW, prep: 'diced' })).sort();
    const withQty = Object.keys(normIngWithProductQty({ ...ROW, prep: 'diced' })).sort();
    expect(withQty.filter((k) => !bare.includes(k))).toEqual(['productQty']);
  });
});
