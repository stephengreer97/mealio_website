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

const PAGE_BODY =
  "Best Guacamole\nThis is the guacamole I make when friends come over. Add a knob of butter to " +
  "the pan first — it's the one shortcut I keep. Ready in about 15 minutes and it never lasts.";

/** Reader comments: on the page, but not the recipe. */
const COMMENT_BODY =
  'Comments\nJenna says: Add two diced roma tomatoes, seeds removed, and stir. ' +
  'Marcus says: I always throw in a big pinch of cayenne. ' +
  'Disclosure: this post contains affiliate links.';

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
  recipeText: PAGE_BODY,
  // The whole page — recipe plus the comment thread underneath it.
  pageText: `${PAGE_BODY}\n${COMMENT_BODY}`,
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
    const result = assessField('avocados', '3 medium ripe avocados, halved and pitted', 'json-ld', source);
    expect(result.level).toBe('green');
    expect(result.match).toBe('exact');
  });

  it('reads green for a value quoted verbatim from the page', () => {
    const result = assessField('a knob of butter', 'a knob of butter', 'page-text', source);
    expect(result.level).toBe('green');
  });

  it('reads amber for a unit conversion, even though the span is verbatim', () => {
    // "a knob of butter" became "2 tbsp butter". The span checks out and the
    // product name is drawn from it; the value is still a restatement, so it
    // must never read green.
    const result = assessField('butter', 'a knob of butter', 'normalized', source);
    expect(result.level).toBe('amber');
    expect(result.match).toBe('exact');
    expect(result.reason).toMatch(/restated/i);
  });

  it('reads amber for an inferred field with a supporting span', () => {
    const result = assessField(3, 'Ready in about 15 minutes', 'inferred', source);
    expect(result.level).toBe('amber');
  });

  it('reads red for a deliberately hallucinated field, with no special-casing', () => {
    // Nothing about paprika appears anywhere in the source.
    const result = assessField('smoked paprika', '2 tablespoons smoked paprika, toasted', 'page-text', source);
    expect(result.level).toBe('red');
    expect(result.match).toBe('none');
    expect(result.reason).toMatch(/not found/i);
  });

  it('reads red when the model offers no span at all', () => {
    expect(assessField('x', null, 'inferred', source).level).toBe('red');
    expect(assessField('x', '', 'page-text', source).level).toBe('red');
    expect(assessField('x', 'anything', 'absent', source).level).toBe('red');
  });

  it('downgrades a fabricated json-ld provenance instead of believing the label', () => {
    // The value is real page text, but the model claimed it came from structured
    // data. Nothing in the response is taken on trust.
    const result = assessField('butter', 'a knob of butter', 'json-ld', source);
    expect(result.level).toBe('red');
  });

  it('reads red for a json-ld claim on a page that publishes none', () => {
    const noStructured = { jsonLd: null, recipeText: source.recipeText, pageText: source.pageText };
    expect(assessField('avocados', '3 medium ripe avocados', 'json-ld', noStructured).level).toBe('red');
  });

  it('reads amber when a structured-data span is close but not verbatim', () => {
    // Singular where the source is plural — the kind of slip a model makes when
    // it re-types a span instead of copying it.
    const result = assessField('avocado', '3 medium ripe avocado, halved and pitted', 'json-ld', source);
    expect(result.match).toBe('fuzzy');
    expect(result.level).toBe('amber');
  });
});

/**
 * The hole a span-only check leaves open, and the reason `assessField` verifies
 * the whole chain: **value ⊆ span ⊆ source**.
 *
 * Every case here pairs a fabricated value with a span that is *genuinely* on
 * the page. A check that only asks "is the span real?" waves all of them
 * through as green. The extraction prompt interpolates page text the site
 * controls, so "the model won't think to quote a real sentence" is not an
 * assumption worth resting the indicator on.
 */
describe('import/confidence — a fabricated value riding a genuine span', () => {
  const genuineSpan = 'Ready in about 15 minutes and it never lasts';

  it('does not read green for a serving count that is nowhere in its own span', () => {
    const result = assessField('48', genuineSpan, 'page-text', source);
    expect(result.level).not.toBe('green');
    expect(result.level).toBe('red');
    // The span really did match — the value is what failed.
    expect(result.match).toBe('exact');
    expect(result.reason).toMatch(/does not contain or support/i);
  });

  it('does not read green for an ingredient that is nowhere in its own span', () => {
    const result = assessField('saffron threads', genuineSpan, 'json-ld', {
      jsonLd: `${source.jsonLd}\n${genuineSpan}`,
      recipeText: source.recipeText,
      pageText: source.pageText,
    });
    expect(result.level).toBe('red');
    expect(result.match).toBe('exact');
  });

  it('rejects the same trick on a normalized or inferred derivation', () => {
    expect(assessField('saffron threads', genuineSpan, 'normalized', source).level).toBe('red');
    expect(assessField('saffron threads', genuineSpan, 'inferred', source).level).toBe('red');
  });

  it('demotes a verbatim claim whose value is only related to its span', () => {
    // "guacamole I make" is on the page; "guacamole dip" is not in that span but
    // shares its vocabulary. That is a restatement mislabelled as a quotation.
    const result = assessField('guacamole dip', 'This is the guacamole I make when friends come over', 'page-text', source);
    expect(result.level).toBe('amber');
    expect(result.reason).toMatch(/not verbatim within its evidence span/i);
  });

  it('still accepts an honest value drawn from its span', () => {
    expect(assessField('avocados', '3 medium ripe avocados, halved and pitted', 'json-ld', source).level).toBe('green');
    expect(assessField('butter', 'a knob of butter', 'normalized', source).level).toBe('amber');
  });

  it('reads red when a value is empty but a span was supplied', () => {
    expect(assessField('', 'a knob of butter', 'page-text', source).level).toBe('red');
    expect(assessField(null, 'a knob of butter', 'page-text', source).level).toBe('red');
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
    expect(assessField('avocados', line, 'json-ld', realSource).level).toBe('green');
  });

  it('verifies the photo URL, which lives in a meta tag the text cleaner drops', () => {
    expect(assessField(document.imageUrl!, document.imageUrl!, 'json-ld', realSource).level).toBe('green');
  });

  it('sends an invented ingredient on a real page to red', () => {
    const result = assessField('unicorn horn', '4 cups of powdered unicorn horn, sifted', 'json-ld', realSource);
    expect(result.level).toBe('red');
  });

  it('sends an invented ingredient paired with a real page sentence to red', () => {
    // The span is lifted verbatim out of the recorded page; only the value lies.
    const realSentence = document.jsonLd!.recipeIngredient![0];
    const result = assessField('saffron threads', realSentence, 'json-ld', realSource);
    expect(result.match).toBe('exact');
    expect(result.level).toBe('red');
  });
});

/**
 * A Pixabay stand-in is a value we chose, not one we found. It is deliberately
 * not labelled `inferred` — nothing about the source implied it — and it is
 * never green, because the creator needs to know we picked it.
 */
describe('import/confidence — generated values', () => {
  it('reads amber with an explanation, never green', () => {
    const result = assessField(
      'https://storage.mealio.co/meal-photos/u1/123.jpg',
      'The page has no photo, so this is a stock photo we picked.',
      'generated',
      source,
    );
    expect(result.level).toBe('amber');
    expect(result.derivation).toBe('generated');
    // No span to verify — the provenance is a fact about our pipeline.
    expect(result.match).toBe('none');
    expect(result.evidence).toBeNull();
    expect(result.reason).toMatch(/stock photo/i);
  });

  it('reads red when there is no generated value either', () => {
    expect(assessField(null, 'nothing found', 'generated', source).level).toBe('red');
    expect(assessField('', 'nothing found', 'generated', source).level).toBe('red');
  });

  it('does not require the generated value to appear in the page', () => {
    // The whole point: this URL is ours and is nowhere in the source.
    const result = assessField('https://storage.mealio.co/x.jpg', 'picked by us', 'generated', source);
    expect(result.level).toBe('amber');
  });
});

/**
 * The corpus question: "is this span on the page?" is the wrong test, because a
 * recipe page is mostly not the recipe. Reader comments mention every
 * ingredient there is, so while they counted as the source a hallucination
 * could always find a home in one — and green renders as no marker at all.
 */
describe('import/confidence — comments are on the page but are not the recipe', () => {
  it('does not read green for a value quoted from a reader comment', () => {
    const result = assessField(
      'roma tomatoes',
      'Add two diced roma tomatoes, seeds removed, and stir',
      'page-text',
      source,
    );
    // The span is genuinely on the page and matched exactly — it is *where* it
    // matched that stops it being green.
    expect(result.match).toBe('exact');
    expect(result.level).toBe('amber');
    expect(result.reason).toMatch(/outside the recipe/i);
  });

  it('does not read green for a value quoted from a disclosure block', () => {
    const result = assessField(
      'affiliate links',
      'Disclosure: this post contains affiliate links.',
      'page-text',
      source,
    );
    expect(result.level).toBe('amber');
  });

  it('still reads green for a value quoted from the recipe itself', () => {
    expect(assessField('a knob of butter', 'a knob of butter', 'page-text', source).level).toBe('green');
  });
});

describe('import/confidence — an unchecked value is never promoted', () => {
  it('does not let a number claim to be a quotation', () => {
    // `derivation` is the model's free choice. A number cannot be checked for
    // containment, so claiming `page-text` must not buy it a green.
    const result = assessField(5, 'Ready in about 15 minutes', 'page-text', source);
    expect(result.match).toBe('exact');
    expect(result.level).toBe('amber');
  });

  it('does not let a tag array claim to be a quotation', () => {
    const result = assessField(['Vegan', 'Mexican'], 'a knob of butter', 'json-ld', source);
    expect(result.level).not.toBe('green');
  });

  it('caps difficulty at amber however good the span', () => {
    // Verbatim in the JSON-LD block, so the span itself is beyond doubt.
    const span = '3 medium ripe avocados, halved and pitted';
    expect(assessField(3, span, 'json-ld', source).level).toBe('amber');
    expect(assessField(3, span, 'inferred', source).level).toBe('amber');
  });
});
