// @vitest-environment jsdom
// MEAL-165 — the creator can correct a preparation nothing verified.
//
// `prep` is free text the model writes, and unlike the product name and the
// amount it is never checked against the evidence span it claims to come from
// (`lib/import/pipeline.ts` assesses `ingredientName` and the amount, nothing
// else). So a row whose name and amount both verify can still carry a cooking
// instruction nobody confirmed, rendered on the review card looking exactly as
// confirmed as the product name beside it.
//
// The decision was: do NOT downgrade the row, DO let the creator fix the text.
// Downgrading a row that is otherwise right would teach creators to ignore the
// badge, which is the failure the exceptions-only design exists to avoid — and a
// wrong prep is usually the model rewording the line rather than inventing a
// dish. Before this, the only way to remove a wrong preparation was to delete
// the whole ingredient row.
//
// The additive rule from MEAL-102 is what most of this file is about. `prep` is
// absent-or-string, never `''` and never null: `canonicalPrep` returns `{}` so a
// row with nothing to say serialises exactly as it did before the field existed.
//
// These tests assert what `onSave` is HANDED, which is the component's own
// output and not the wire — `editableDraft` canonicalises after this, and would
// strip a `prep: ''` on its own. That is worth stating because an earlier
// version of this header justified the rule with a hazard the server already
// neutralises. The rule stands on its own ground: the shape should be right
// where it is decided, not tidied up two stages later.

import React from 'react';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';

// Each test renders the editor; without this they pile up in the same document
// and every getByLabelText finds several.
afterEach(cleanup);
import DraftEditor from '@/components/DraftEditor';
import type { CreatorMealDraft, DraftIngredient } from '@/lib/import/types';
import { MAX_PREP_CHARS } from '@/lib/import/ingredients';

const ing = (over: Partial<DraftIngredient> = {}): DraftIngredient => ({
  ingredientName: 'onion',
  qty: 1,
  productQty: 1,
  unit: 'qty',
  measure: null,
  searchTerm: null,
  ...over,
});

const draftWith = (ingredients: DraftIngredient[]): CreatorMealDraft => ({
  name: 'Chili',
  ingredients,
  recipe: null,
  source: 'https://example.test/chili',
  story: null,
  photoUrl: null,
  difficulty: null,
  tags: [],
  serves: null,
});

/** Render the editor and return a way to read what a save would send. */
function mount(ingredients: DraftIngredient[]) {
  const onSave = vi.fn();
  render(
    <DraftEditor draft={draftWith(ingredients)} busy={false} onCancel={() => {}} onSave={onSave} />,
  );
  const box = (n: number) => screen.getByLabelText(`Ingredient ${n} preparation`) as HTMLInputElement;
  const save = () => {
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    return onSave.mock.calls[onSave.mock.calls.length - 1][0] as CreatorMealDraft;
  };
  return { onSave, box, save };
}

describe('the preparation is on screen and editable', () => {
  it('shows the one the import extracted', () => {
    const { box } = mount([ing({ prep: 'finely diced' })]);
    expect(box(1).value).toBe('finely diced');
  });

  it('stops typing at the cap, because over the cap the save DELETES it', () => {
    // `editableDraft` canonicalises every saved row and `canonicalPrep` drops an
    // over-cap prep rather than truncating it — so without this a creator could
    // paste a method step, get a 200, and watch the text vanish. A cold review
    // deleted this attribute from both prep boxes and the whole suite stayed
    // green, so the fix existed and nothing held it in place.
    const { box } = mount([ing({ prep: 'finely diced' })]);
    expect(box(1).maxLength).toBe(MAX_PREP_CHARS);
  });

  it('saves a correction', () => {
    const { box, save } = mount([ing({ prep: 'finely diced' })]);
    fireEvent.change(box(1), { target: { value: 'roughly chopped' } });
    expect(save().ingredients[0].prep).toBe('roughly chopped');
  });

  it('adds one to a row the import left bare', () => {
    const { box, save } = mount([ing()]);
    expect(box(1).value).toBe('');
    fireEvent.change(box(1), { target: { value: 'thinly sliced' } });
    expect(save().ingredients[0].prep).toBe('thinly sliced');
  });

  it('edits the right row when there are several', () => {
    // Deliberately edits the SECOND row. The first version of this test typed
    // into row 0 and asserted row 1 was untouched, so hardcoding the setter to
    // row zero passed it — a cold review found that mutant surviving. Any bug
    // that collapses toward the first row has to fail here.
    const { box, save } = mount([
      ing({ ingredientName: 'onion', prep: 'finely diced' }),
      ing({ ingredientName: 'garlic' }),
    ]);
    fireEvent.change(box(2), { target: { value: 'minced' } });

    const saved = save().ingredients;
    expect(saved[1].prep).toBe('minced');
    expect(saved[0].prep).toBe('finely diced');
  });
});

describe('clearing it removes the field rather than emptying it', () => {
  it('leaves no key behind when the box is emptied', () => {
    // The whole point of the absent-or-string rule. `prep: ''` would render as a
    // stray trailing comma on every surface that prints the line, and would mark
    // the row as edited for `stripEditedConfidence`.
    const { box, save } = mount([ing({ prep: 'finely diced' })]);
    fireEvent.change(box(1), { target: { value: '' } });

    const saved = save().ingredients[0];
    expect('prep' in saved).toBe(false);
    expect(JSON.stringify(saved)).not.toContain('prep');
  });

  it('treats whitespace as empty', () => {
    const { box, save } = mount([ing({ prep: 'finely diced' })]);
    fireEvent.change(box(1), { target: { value: '   ' } });
    expect('prep' in save().ingredients[0]).toBe(false);
  });

  it('adds no key to a row nobody touched', () => {
    // The additive guarantee: opening a pre-MEAL-102 draft and saving it must
    // not rewrite rows that had nothing to say.
    const { save } = mount([ing(), ing({ ingredientName: 'garlic' })]);
    const saved = save().ingredients;
    expect(saved.every((row) => !('prep' in row))).toBe(true);
    expect(JSON.stringify(saved)).not.toContain('prep');
  });

  it('adds no key to a row the creator typed into and then cleared', () => {
    const { box, save } = mount([ing()]);
    fireEvent.change(box(1), { target: { value: 'diced' } });
    fireEvent.change(box(1), { target: { value: '' } });
    expect('prep' in save().ingredients[0]).toBe(false);
  });
});
