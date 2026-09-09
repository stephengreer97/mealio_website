// The Discover filters, now that there is one definition of them.
//
// These used to live three times over: once in the browser, once in the app,
// and nowhere on the server. Each copy was correct in isolation and they could
// disagree without anything failing, which is the worst shape a rule can have.
import { describe, it, expect } from 'vitest';
import {
  matchesPresetMeal, parsePresetMealFilters, ingredientName, isEmpty, NO_FILTERS,
} from '@/lib/preset-meal-filters';

const meal = (over: Record<string, unknown> = {}) => ({
  name: 'Garlic butter shrimp',
  author: 'Sarah Lane',
  creator_name: 'Sarah Lane',
  source: 'sarahcooks.com',
  difficulty: 2,
  tags: ['quick', 'seafood'],
  ingredients: [{ ingredientName: 'Shrimp' }, { ingredientName: 'Garlic' }, { ingredientName: 'Butter' }],
  ...over,
});

const filters = (over: Record<string, unknown> = {}) => ({ ...NO_FILTERS, ...over });

describe('the ingredient key, which has four spellings', () => {
  it('reads all four, because rows were written by seeds, the app and the API', () => {
    // This is why the filter could not simply become a jsonb path in SQL:
    // there is no single path to try.
    expect(ingredientName({ ingredientName: 'Shrimp' })).toBe('shrimp');
    expect(ingredientName({ productName: 'Shrimp' })).toBe('shrimp');
    expect(ingredientName({ product_name: 'Shrimp' })).toBe('shrimp');
    expect(ingredientName({ name: 'Shrimp' })).toBe('shrimp');
  });

  it('is not confused by a row with none of them', () => {
    expect(ingredientName({ qty: 2 })).toBe('');
    expect(ingredientName(null)).toBe('');
    expect(ingredientName('shrimp')).toBe('');
  });
});

describe('tags', () => {
  it('are ANY-of', () => {
    expect(matchesPresetMeal(meal(), filters({ tags: ['seafood'] }))).toBe(true);
    expect(matchesPresetMeal(meal(), filters({ tags: ['vegan', 'seafood'] }))).toBe(true);
    expect(matchesPresetMeal(meal(), filters({ tags: ['vegan'] }))).toBe(false);
  });

  it('does not match a meal with no tags at all', () => {
    expect(matchesPresetMeal(meal({ tags: null }), filters({ tags: ['quick'] }))).toBe(false);
  });
});

describe('ingredients', () => {
  it('are ALL-of, not any-of', () => {
    // "chicken and rice" has to mean both, or the filter cannot narrow to what
    // is actually in someone's kitchen.
    expect(matchesPresetMeal(meal(), filters({ ingredients: ['shrimp', 'garlic'] }))).toBe(true);
    expect(matchesPresetMeal(meal(), filters({ ingredients: ['shrimp', 'chicken'] }))).toBe(false);
  });

  it('matches on substring, so "garlic" finds "Garlic powder"', () => {
    const m = meal({ ingredients: [{ productName: 'Garlic powder' }] });
    expect(matchesPresetMeal(m, filters({ ingredients: ['garlic'] }))).toBe(true);
  });
});

describe('excluded ingredients', () => {
  it('are NONE-of', () => {
    expect(matchesPresetMeal(meal(), filters({ excludeIngredients: ['peanut'] }))).toBe(true);
    expect(matchesPresetMeal(meal(), filters({ excludeIngredients: ['butter'] }))).toBe(false);
  });

  it('beats an include on the same meal, because an allergy is not a preference', () => {
    const f = filters({ ingredients: ['shrimp'], excludeIngredients: ['butter'] });
    expect(matchesPresetMeal(meal(), f)).toBe(false);
  });
});

describe('difficulty', () => {
  it('is any-of', () => {
    expect(matchesPresetMeal(meal(), filters({ difficulty: [1, 2] }))).toBe(true);
    expect(matchesPresetMeal(meal(), filters({ difficulty: [3] }))).toBe(false);
  });

  it('never sweeps in a meal that has no difficulty set', () => {
    // `?? -1`, and -1 is not a value the picker can produce.
    expect(matchesPresetMeal(meal({ difficulty: null }), filters({ difficulty: [1, 2, 3] }))).toBe(false);
  });
});

describe('authors and the search box', () => {
  it('matches an author by substring, case-insensitively', () => {
    expect(matchesPresetMeal(meal(), filters({ authors: ['sarah'] }))).toBe(true);
    expect(matchesPresetMeal(meal(), filters({ authors: ['dave'] }))).toBe(false);
  });

  it('finds the creator name when the author field is empty', () => {
    const m = meal({ author: null, creator_name: 'Sarah Lane' });
    expect(matchesPresetMeal(m, filters({ authors: ['sarah'] }))).toBe(true);
  });

  it('searches name, author, creator and source', () => {
    expect(matchesPresetMeal(meal(), filters({ q: 'shrimp' }))).toBe(true);
    expect(matchesPresetMeal(meal(), filters({ q: 'sarahcooks' }))).toBe(true);
    expect(matchesPresetMeal(meal(), filters({ q: 'lasagne' }))).toBe(false);
  });

  it('treats a whitespace-only search as no search', () => {
    expect(matchesPresetMeal(meal(), filters({ q: '   ' }))).toBe(true);
  });

  // Stephen, 2026-09-09: "If I search Mexican, I should see meals with Mexican
  // tags." The tags were filterable from the Filter sheet and invisible to the
  // search box, so the obvious way to look for a cuisine found nothing.
  //
  // One change covers both surfaces: the app sends `q` to this same endpoint and
  // does no client-side filtering of its own.
  it('searches the tags too', () => {
    const m = meal({ name: 'Weeknight bowl', tags: ['Mexican', 'Under 30 Min'] });
    expect(matchesPresetMeal(m, filters({ q: 'Mexican' }))).toBe(true);
  });

  it('matches a tag case-insensitively, the way every other field does', () => {
    // Tags are stored as display strings ("Mexican", "Tex-Mex", "Under 30 Min")
    // and nobody types the capital.
    const m = meal({ name: 'Weeknight bowl', tags: ['Mexican'] });
    expect(matchesPresetMeal(m, filters({ q: 'mexican' }))).toBe(true);
    expect(matchesPresetMeal(m, filters({ q: 'MEXICAN' }))).toBe(true);
  });

  it('matches a tag by substring, so a partial word still finds it', () => {
    const m = meal({ name: 'Weeknight bowl', tags: ['Under 30 Min'] });
    expect(matchesPresetMeal(m, filters({ q: '30 min' }))).toBe(true);
  });

  it('still says no when nothing matches, tags included', () => {
    // The guard against "add the field and everything matches": a meal with
    // tags must still be excluded by a term none of them contain.
    const m = meal({ name: 'Weeknight bowl', tags: ['Mexican'] });
    expect(matchesPresetMeal(m, filters({ q: 'thai' }))).toBe(false);
  });

  it('survives a meal with no tags at all', () => {
    // `tags` is nullable on the row and absent on plenty of seeded meals.
    expect(matchesPresetMeal(meal({ tags: null }), filters({ q: 'shrimp' }))).toBe(true);
    expect(matchesPresetMeal(meal({ tags: null }), filters({ q: 'mexican' }))).toBe(false);
  });
});

describe('reading them off a request', () => {
  it('parses every filter', () => {
    const p = new URLSearchParams(
      'tags=quick,seafood&difficulty=1,3&authors=Sarah&ingredients=Shrimp,Garlic'
      + '&excludeIngredients=Peanut&q=curry',
    );
    expect(parsePresetMealFilters(p)).toEqual({
      tags: ['quick', 'seafood'],
      difficulty: [1, 3],
      authors: ['sarah'],
      ingredients: ['shrimp', 'garlic'],
      excludeIngredients: ['peanut'],
      q: 'curry',
    });
  });

  it('lowercases what is matched case-insensitively, and leaves tags exactly as sent', () => {
    // Tags come from a fixed vocabulary and are compared exactly. Lowercasing
    // them would break any tag that is not already lowercase.
    const p = new URLSearchParams('tags=Quick&authors=SARAH');
    const f = parsePresetMealFilters(p);
    expect(f.tags).toEqual(['Quick']);
    expect(f.authors).toEqual(['sarah']);
  });

  it('drops empties from a trailing comma rather than filtering on ""', () => {
    // An empty string as an ingredient matches EVERY meal, which would make a
    // stray comma silently disable the filter.
    const f = parsePresetMealFilters(new URLSearchParams('ingredients=chicken,,'));
    expect(f.ingredients).toEqual(['chicken']);
  });

  it('ignores a non-numeric difficulty instead of matching nothing', () => {
    const f = parsePresetMealFilters(new URLSearchParams('difficulty=easy'));
    expect(f.difficulty).toEqual([]);
  });

  it('reads an absent query string as no filters', () => {
    expect(isEmpty(parsePresetMealFilters(new URLSearchParams()))).toBe(true);
  });
});
