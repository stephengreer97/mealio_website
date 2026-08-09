import { describe, it, expect, beforeEach } from 'vitest';
import { runImport } from '@/lib/import/pipeline';
import { MemoryImportCache } from '@/lib/import/cache';
import {
  canonicalizeIngredient,
  canonicalizeIngredients,
  canonicalPrep,
  readPrep,
  MAX_PREP_CHARS,
} from '@/lib/import/ingredients';
import { draftIngredientToForm } from '@/lib/import/draft-form';
import { editableDraft } from '@/lib/import-drafts';
import { __prompts } from '@/lib/import/extract';
import type { ExtractedIngredient, ImportTelemetry } from '@/lib/import/types';
import {
  extractionFixture,
  publicLookup,
  readHtmlFixture,
  stubCaller,
  stubFetch,
} from '../helpers/import-stubs';

/**
 * MEAL-102 — preparation is a field of its own, and never a search term.
 *
 * A recipe says "1 onion, finely diced". We used to keep the onion and throw
 * "finely diced" away, because the only other place to put it was the product
 * name — and `productName` *is* the grocery search term. "diced onion" does not
 * fetch a worse onion.
 *
 * That is the failure these tests exist for, and it is worth being exact about
 * why it is nasty rather than merely wrong. The add gate is exact equality
 * after normalisation, on `searchTerm ?? ingredientName` — `scoreTarget` in
 * `app/api/kroger/search-products/route.ts`, and the identical line in the
 * app's `WebViewCartSheet.tsx`. A term carrying prep therefore does not add the
 * wrong product. It matches **nothing**, and the item drops silently into
 * review wearing the costume of a matching problem while being a data problem.
 * Nobody would go looking in the extraction prompt for that.
 *
 * So the assertions below are deliberately about *absence*, and are made
 * against what the real pipeline emits rather than against a helper called in
 * isolation — a helper that keeps prep out of a name proves nothing about the
 * eleven places that build a row.
 */

const ing = (over: Partial<ExtractedIngredient> = {}): ExtractedIngredient => ({
  productName: 'onion',
  measure: '1',
  unit: 'qty',
  qty: 1,
  prep: null,
  evidence: null,
  derivation: 'json-ld',
  ...over,
});

// ── The shape ────────────────────────────────────────────────────────────────

describe('MEAL-102 — the ingredient shape', () => {
  it('carries prep beside the name, not inside it', () => {
    const row = canonicalizeIngredient(ing({ prep: 'finely diced' }))!;

    expect(row.ingredientName).toBe('onion');
    expect(row.prep).toBe('finely diced');
    // The two fields the cart reads. Both stay bare.
    expect(row.searchTerm).toBeNull();
  });

  it('carries prep on measured rows as well as countable ones', () => {
    // Two separate return statements in `canonicalizeIngredient`, and an early
    // version filled only the countable one — which is the branch the obvious
    // example ("1 onion, diced") happens to take.
    const row = canonicalizeIngredient(
      ing({ productName: 'unsalted butter', measure: '2', unit: 'tbsp', prep: 'melted' }),
    )!;

    expect(row.unit).toBe('tbsp');
    expect(row.ingredientName).toBe('unsalted butter');
    expect(row.prep).toBe('melted');
  });

  it('leaves the key off entirely when there is no preparation', () => {
    // Not `prep: null`. Every ingredient imported before this field existed has
    // no `prep` key at all, and a row with nothing to say has to serialise the
    // same way one of those does — that is what makes the field additive and
    // what means no migration is owed for the existing catalogue.
    const row = canonicalizeIngredient(ing({ prep: null }))!;

    expect('prep' in row).toBe(false);
  });

  it('emits byte-identical JSON for a row with no preparation', () => {
    // The strongest form of "nothing already imported changes": not that the
    // fields match, that the serialisation does.
    const rows = [
      ing({ productName: 'avocados', measure: '4', unit: 'qty', qty: 4 }),
      ing({ productName: 'flour', measure: '1 1/2', unit: 'cups' }),
      ing({ productName: 'salt', measure: null, unit: 'qty' }),
    ];

    const json = JSON.stringify(canonicalizeIngredients(rows).ingredients);

    expect(json).toBe(
      '[{"ingredientName":"avocados","qty":4,"productQty":4,"unit":"qty","measure":"4","searchTerm":null},'
      + '{"ingredientName":"flour","qty":1,"productQty":1,"unit":"cups","measure":"1 1/2","searchTerm":null},'
      + '{"ingredientName":"salt","qty":1,"productQty":1,"unit":"qty","measure":null,"searchTerm":null}]',
    );
  });
});

// ── Prep never reaches a search term, through the real pipeline ───────────────

describe('MEAL-102 — prep never reaches a name or a search term', () => {
  let cache: MemoryImportCache;
  let events: ImportTelemetry[];

  beforeEach(() => {
    cache = new MemoryImportCache();
    events = [];
  });

  const GUAC_URL = 'https://cookieandkate.com/best-guacamole-recipe';

  function options(overrides: Record<string, unknown> = {}) {
    const { impl } = stubFetch({
      'https://cookieandkate.com/robots.txt': { body: 'User-agent: *\nDisallow: /wp-admin/' },
      [GUAC_URL]: { body: readHtmlFixture('cookieandkate-guacamole.html') },
    });
    return {
      cache,
      telemetry: (event: ImportTelemetry) => events.push(event),
      fetchOptions: { fetchImpl: impl, lookup: publicLookup },
      ...overrides,
    };
  }

  it('keeps every preparation out of every name and search term end to end', async () => {
    // The whole import, fetch through confidence, with a model that returns a
    // preparation on every row — including the two shapes most likely to be
    // concatenated by accident: one that reads like part of a product name
    // ("smoked", "ground") and one carrying a comma of its own.
    const call = stubCaller(() =>
      extractionFixture({
        ingredients: [
          {
            productName: 'avocados', measure: '4', unit: 'qty', qty: 4,
            prep: 'halved and pitted',
            evidence: '4 medium ripe avocados, halved and pitted',
            derivation: 'json-ld',
          },
          {
            productName: 'red onion', measure: '1', unit: 'qty', qty: 1,
            prep: 'finely diced, rinsed under cold water',
            evidence: '4 medium ripe avocados, halved and pitted',
            derivation: 'json-ld',
          },
          {
            productName: 'paprika', measure: '1', unit: 'tsp', qty: 1,
            prep: 'smoked, toasted in a dry pan',
            evidence: '4 medium ripe avocados, halved and pitted',
            derivation: 'json-ld',
          },
        ],
      }),
    );

    const result: any = await runImport(GUAC_URL, options({ call }));

    expect(result.status).toBe('ok');
    const rows = result.draft.ingredients;
    expect(rows).toHaveLength(3);

    // The preparations survived — otherwise the absence assertions below pass
    // for the boring reason that MEAL-102 was never built.
    expect(rows.map((r: any) => r.prep)).toEqual([
      'halved and pitted',
      'finely diced, rinsed under cold water',
      'smoked, toasted in a dry pan',
    ]);

    // The names are the bare products a shop actually sells.
    expect(rows.map((r: any) => r.ingredientName)).toEqual(['avocados', 'red onion', 'paprika']);

    // And nothing the model called preparation appears anywhere the cart
    // reads. Checked word by word rather than as whole phrases, because a
    // concatenation bug that produced "onion finely diced" would slip past an
    // assertion that only looked for the exact prep string.
    //
    // As whole words: "in a dry pan" contributes "a", and a bare substring test
    // for "a" fails against "paprika" — a false alarm that would have to be
    // silenced, and silencing it is how the real check gets weakened.
    for (const row of rows) {
      const cartFacing = `${row.searchTerm ?? ''} ${row.ingredientName}`.toLowerCase();
      for (const word of String(row.prep).toLowerCase().split(/[^a-z]+/).filter(Boolean)) {
        // "smoked" and "toasted" are the trap: both are real product words, so
        // this is the assertion that fires if "smoked paprika" were ever built
        // out of a name plus a prep.
        expect(cartFacing).not.toMatch(new RegExp(`\\b${word}\\b`));
        // Longer words additionally as a substring, which catches a join that
        // left no space behind it ("onionfinely").
        if (word.length >= 4) expect(cartFacing).not.toContain(word);
      }
      expect(row.searchTerm).toBeNull();
    }
  });

  it('asks the model for prep as its own field and tells it why', async () => {
    // The prompt is the origin of the data: without this the field is real
    // everywhere else and permanently empty. Pinned because a later edit to a
    // 200-line prompt is exactly how it would go quiet.
    const { SYSTEM_PROMPT, ExtractionSchema } = __prompts;

    const shape = ExtractionSchema.shape.ingredients.element.shape;
    expect(shape.prep).toBeDefined();

    // Asked for, and asked for as *preparation* rather than as free text.
    expect(SYSTEM_PROMPT).toMatch(/prep/);
    expect(SYSTEM_PROMPT).toContain('finely diced');
    // The reason, kept next to the rule. The old prompt said to drop
    // preparation notes outright; if that sentence ever comes back the field
    // stops being filled and nothing else in this suite would notice.
    expect(SYSTEM_PROMPT).not.toMatch(/Drop amounts, units, and preparation notes/);
    expect(SYSTEM_PROMPT).toMatch(/search/i);
  });
});

// ── Malformed preparations ───────────────────────────────────────────────────

describe('MEAL-102 — a malformed preparation degrades to no preparation', () => {
  it('drops a preparation longer than the cap rather than truncating it', () => {
    // Truncating picks a cut point nobody wrote and renders half a sentence as
    // though it were the instruction. Dropping falls back exactly to how the
    // row read before the field existed.
    const row = canonicalizeIngredient(ing({ prep: 'x'.repeat(MAX_PREP_CHARS + 1) }))!;

    expect('prep' in row).toBe(false);
  });

  it('keeps a preparation exactly at the cap', () => {
    const row = canonicalizeIngredient(ing({ prep: 'y'.repeat(MAX_PREP_CHARS) }))!;

    expect(row.prep).toHaveLength(MAX_PREP_CHARS);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty', ''],
    ['whitespace', '   \n\t '],
    ['a bare comma', ','],
    ['punctuation only', ' ,;: '],
  ])('treats %s as no preparation', (_label, value) => {
    expect(canonicalPrep(value as any)).toEqual({});
  });

  it.each([
    ['a number', 42],
    ['an object', { prep: 'diced' }],
    ['an array', ['diced']],
    ['a boolean', true],
  ])('refuses %s instead of stringifying it', (_label, value) => {
    // `String({})` is "[object Object]", which would render on a public meal
    // page. A non-string is not a preparation.
    expect(canonicalPrep(value as any)).toEqual({});
  });

  it('strips the joining comma the source wrote, so the renderer can add its own', () => {
    // "1 onion, finely diced" — if the comma were carried in the data the line
    // would read "1 onion, , finely diced" once the renderer joined them.
    expect(canonicalPrep(', finely diced')).toEqual({ prep: 'finely diced' });
    expect(canonicalPrep('  finely   diced  ')).toEqual({ prep: 'finely diced' });
    expect(canonicalPrep('finely diced,')).toEqual({ prep: 'finely diced' });
  });

  it('keeps a comma that is doing real work inside the phrase', () => {
    // Only the joining comma goes. "drained, rinsed and patted dry" is one
    // instruction that happens to contain a comma.
    expect(canonicalPrep('drained, rinsed and patted dry'))
      .toEqual({ prep: 'drained, rinsed and patted dry' });
  });

  it('reads prep off a row whatever else that row is missing', () => {
    expect(readPrep({ prep: 'diced' })).toBe('diced');
    expect(readPrep({})).toBeNull();
    expect(readPrep(null)).toBeNull();
    expect(readPrep(undefined)).toBeNull();
    // A single-word key is spelled the same in camelCase and snake_case, which
    // is why this needs none of the four-way tolerance the *name* needs.
    expect(readPrep({ prep_note: 'diced' } as any)).toBeNull();
  });
});

// ── Round trips: a prep must survive being edited ────────────────────────────

describe('MEAL-102 — preparation survives the edit round trips', () => {
  it('carries prep into the publish form', () => {
    // The import fills this form and the form is what gets POSTed, so a prep
    // dropped here never reaches the meal however well extraction did.
    const row = canonicalizeIngredient(ing({ prep: 'finely diced' }))!;

    expect(draftIngredientToForm(row).prep).toBe('finely diced');
  });

  it('omits prep from a form row that has none', () => {
    const row = canonicalizeIngredient(ing({ prep: null }))!;

    expect('prep' in draftIngredientToForm(row)).toBe(false);
  });

  it('preserves prep when a reviewer saves an unrelated edit', () => {
    // `editableDraft` re-canonicalises every row on every save from the review
    // queue's edit form. Before this, correcting one row's typo deleted the
    // preparation on all twelve.
    const result = editableDraft({
      name: 'Guacamole',
      ingredients: [{ ingredientName: 'onion', qty: 1, unit: 'qty', measure: '1', prep: 'finely diced' }],
      recipe: 'Mash it.',
      source: 'https://example.test/guac',
      story: null,
      photoUrl: null,
      difficulty: 1,
      tags: [],
      serves: '4',
    });

    expect(result.ok).toBe(true);
    expect(result.ok && result.draft.ingredients[0].prep).toBe('finely diced');
    // And still nowhere near the cart's fields.
    expect(result.ok && result.draft.ingredients[0].ingredientName).toBe('onion');
    expect(result.ok && result.draft.ingredients[0].searchTerm).toBeNull();
  });
});
