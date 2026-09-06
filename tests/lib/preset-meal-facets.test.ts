// What the filter panel can offer, over the whole catalogue.
//
// These lists used to be derived from the meals already loaded, which is the
// same defect the filters had and quieter: an author on page 4 was never
// suggested, but typing the name by hand still worked, so it degraded rather
// than failed and nobody would report it.
import { describe, it, expect } from 'vitest';
import { buildFacets, MAX_FACET_VALUES } from '@/lib/preset-meal-facets';

describe('tags', () => {
  it('reports every tag IN USE, including ones outside the fixed vocabulary', () => {
    // A creator can publish a tag ALL_TAGS has never heard of. Before this
    // there was no way to filter by one from the app: it was not in the list,
    // and the list is the only way to select a tag.
    const f = buildFacets([{ tags: ['quick', 'air-fryer'] }, { tags: ['quick'] }]);
    expect(f.tags).toContain('air-fryer');
  });

  it('ranks by how many meals carry the tag', () => {
    // An autocomplete is a ranking problem. Alphabetical would put the busiest
    // tag behind anything beginning with "a".
    const f = buildFacets([
      { tags: ['zucchini'] }, { tags: ['zucchini'] }, { tags: ['zucchini'] },
      { tags: ['apple'] },
    ]);
    expect(f.tags[0]).toBe('zucchini');
  });

  it('breaks ties alphabetically, so the order is stable', () => {
    const f = buildFacets([{ tags: ['beta'] }, { tags: ['alpha'] }]);
    expect(f.tags).toEqual(['alpha', 'beta']);
  });

  it('ignores blanks and non-strings rather than offering them', () => {
    const f = buildFacets([{ tags: ['   ', '', 'real'] as string[] }]);
    expect(f.tags).toEqual(['real']);
  });
});

describe('authors', () => {
  it('collects the author field and the creator display name', () => {
    const f = buildFacets([
      { author: 'Sarah Lane', creator_name: null },
      { author: null, creator_name: 'Priya' },
    ]);
    expect(f.authors).toContain('Sarah Lane');
    expect(f.authors).toContain('Priya');
  });

  it('counts a meal ONCE when both names are the same person', () => {
    // A self-published creator has both fields filled with the same name.
    // Counting twice would rank them above a busier creator on nothing but
    // having filled in an extra field.
    const f = buildFacets([
      { author: 'Sarah Lane', creator_name: 'Sarah Lane' },
      { author: 'Priya', creator_name: 'Priya' },
      { author: 'Priya', creator_name: 'Priya' },
    ]);
    expect(f.authors).toEqual(['Priya', 'Sarah Lane']);
  });

  it('trims, so " Priya" and "Priya" are one person', () => {
    const f = buildFacets([{ author: ' Priya ' }, { author: 'Priya' }]);
    expect(f.authors).toEqual(['Priya']);
  });

  it('drops empty names instead of offering a blank suggestion', () => {
    const f = buildFacets([{ author: '   ', creator_name: null }, { author: 'Priya' }]);
    expect(f.authors).toEqual(['Priya']);
  });
});

describe('the ceiling', () => {
  it('truncates rather than returning an unbounded list', () => {
    // Not expected to bite. It is here so a catalogue that grows by an order of
    // magnitude gives a shorter dropdown rather than an enormous page.
    const many = Array.from({ length: MAX_FACET_VALUES + 50 }, (_, i) => ({ tags: [`t${i}`] }));
    expect(buildFacets(many).tags).toHaveLength(MAX_FACET_VALUES);
  });

  it('keeps the MOST USED when it truncates, not the first it happened to see', () => {
    const many = Array.from({ length: MAX_FACET_VALUES + 10 }, (_, i) => ({ tags: [`t${i}`] }));
    // One tag on many meals; it must survive the cut.
    const popular = Array.from({ length: 5 }, () => ({ tags: ['zzz-popular'] }));
    expect(buildFacets([...many, ...popular]).tags).toContain('zzz-popular');
  });
});

describe('an empty catalogue', () => {
  it('answers with empty lists rather than throwing', () => {
    expect(buildFacets([])).toEqual({ tags: [], authors: [] });
  });
});
