import { describe, it, expect } from 'vitest';
import { assessField, findSpan, normalizeForMatch, verificationSourceFor } from '@/lib/import/confidence';
import { toSourceDocument } from '@/lib/import/html';
import { readHtmlFixture } from '../helpers/import-stubs';
import type { VerificationSource } from '@/lib/import/confidence';

/**
 * MEAL-72. The property under test is that confidence is computed *by us* from
 * provenance, never claimed by the model — and that a hallucinated value cannot
 * produce a matching span, so it goes red without anyone judging it.
 */

const source: VerificationSource = {
  jsonLd: JSON.stringify(
    {
      name: 'Best Guacamole',
      recipeIngredient: ['3 medium ripe avocados, halved and pitted', '¼ teaspoon fine sea salt'],
      recipeYield: '2 1/2 cups guacamole',
    },
    null,
    2,
  ),
  pageText:
    "Best Guacamole\nThis is the guacamole I make when friends come over. Add a knob of butter to " +
    "the pan first — it's the one shortcut I keep. Ready in about 15 minutes and it never lasts.",
};

describe('import/confidence — normalisation', () => {
  it('folds case, whitespace and the punctuation a model re-types', () => {
    expect(normalizeForMatch('  It’s  “Best”\nGuacamole ')).toBe('it\'s "best" guacamole');
    expect(normalizeForMatch('a knob of butter')).toBe('a knob of butter');
  });
});

describe('import/confidence — span matching', () => {
  it('matches verbatim text exactly', () => {
    expect(findSpan('a knob of butter', source.pageText)).toEqual({ kind: 'exact', score: 1 });
  });

  it('matches across a re-typed apostrophe as fuzzy, not exact', () => {
    // The model wrote a straight apostrophe where the page has a curly one, and
    // normalisation folds those — so this one is genuinely exact.
    expect(findSpan("it's the one shortcut I keep", source.pageText).kind).toBe('exact');
    // A genuinely reworded span is near, not verbatim.
    const near = findSpan('Add a knob of butter to the pan', source.pageText);
    expect(near.kind).toBe('exact');
    const reworded = findSpan('Add a small knob of butter to the pan first', source.pageText);
    expect(reworded.kind).toBe('fuzzy');
    expect(reworded.score).toBeGreaterThan(0.85);
  });

  it('does not match text that is not in the source', () => {
    expect(findSpan('2 tablespoons of smoked paprika', source.pageText).kind).toBe('none');
  });

  it('ignores spans too short to be evidence of anything', () => {
    expect(findSpan('a', source.pageText).kind).toBe('none');
  });
});

describe('import/confidence — levels', () => {
  it('reads green for a field taken from structured data', () => {
    const result = assessField('3 medium ripe avocados, halved and pitted', 'json-ld', source);
    expect(result.level).toBe('green');
    expect(result.match).toBe('exact');
  });

  it('reads green for a value quoted verbatim from the page', () => {
    const result = assessField('a knob of butter', 'page-text', source);
    expect(result.level).toBe('green');
  });

  it('reads amber for a unit conversion, even though the span is verbatim', () => {
    // "a knob of butter" became "2 tbsp". The span checks out; the value is a
    // restatement of it, so it must never read green.
    const result = assessField('a knob of butter', 'normalized', source);
    expect(result.level).toBe('amber');
    expect(result.match).toBe('exact');
    expect(result.reason).toMatch(/restated/i);
  });

  it('reads amber for an inferred field with a supporting span', () => {
    const result = assessField('Ready in about 15 minutes', 'inferred', source);
    expect(result.level).toBe('amber');
  });

  it('reads red for a deliberately hallucinated field, with no special-casing', () => {
    // Nothing about paprika appears anywhere in the source.
    const result = assessField('2 tablespoons smoked paprika, toasted', 'page-text', source);
    expect(result.level).toBe('red');
    expect(result.match).toBe('none');
    expect(result.reason).toMatch(/not found/i);
  });

  it('reads red when the model offers no span at all', () => {
    expect(assessField(null, 'inferred', source).level).toBe('red');
    expect(assessField('', 'page-text', source).level).toBe('red');
    expect(assessField('anything', 'absent', source).level).toBe('red');
  });

  it('downgrades a fabricated json-ld provenance instead of believing the label', () => {
    // The value is real page text, but the model claimed it came from structured
    // data. Nothing in the response is taken on trust.
    const result = assessField('a knob of butter', 'json-ld', source);
    expect(result.level).toBe('red');
  });

  it('reads red for a json-ld claim on a page that publishes none', () => {
    const noStructured = { jsonLd: null, pageText: source.pageText };
    expect(assessField('3 medium ripe avocados', 'json-ld', noStructured).level).toBe('red');
  });

  it('reads amber when a structured-data span is close but not verbatim', () => {
    // Singular where the source is plural — the kind of slip a model makes when
    // it re-types a span instead of copying it.
    const result = assessField('3 medium ripe avocado, halved and pitted', 'json-ld', source);
    expect(result.match).toBe('fuzzy');
    expect(result.level).toBe('amber');
  });
});

describe('import/confidence — against a real recorded page', () => {
  const document = toSourceDocument(
    'https://cookieandkate.com/best-guacamole-recipe',
    readHtmlFixture('cookieandkate-guacamole.html'),
  );
  const realSource = verificationSourceFor(document);

  it('verifies a real JSON-LD ingredient line as green', () => {
    const line = document.jsonLd!.recipeIngredient![0];
    expect(assessField(line, 'json-ld', realSource).level).toBe('green');
  });

  it('verifies the photo URL, which lives in a meta tag the text cleaner drops', () => {
    expect(assessField(document.imageUrl!, 'json-ld', realSource).level).toBe('green');
  });

  it('sends an invented ingredient on a real page to red', () => {
    const result = assessField('4 cups of powdered unicorn horn, sifted', 'json-ld', realSource);
    expect(result.level).toBe('red');
  });
});
