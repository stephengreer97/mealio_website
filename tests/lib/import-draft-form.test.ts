import { describe, it, expect } from 'vitest';
import {
  MARKER_COLORS,
  appendIngredientMarker,
  clearIngredientMarker,
  clearScalarMarker,
  draftIngredientToForm,
  hostLabel,
  importedFormValues,
  markerLabel,
  markersFrom,
  pathLabel,
  rejectionCopy,
  removeIngredientMarker,
  servesForForm,
  summarise,
  summaryLine,
  transportRejection,
} from '@/lib/import/draft-form';
import type { FieldConfidence, ImportRejection } from '@/lib/import/types';
import { importedGuacamole } from '../helpers/import-ui-fixtures';

/**
 * The rules behind what a creator sees. Pure functions, no DOM, no key.
 */

function level(overrides: Partial<FieldConfidence> = {}): FieldConfidence {
  return {
    level: 'green',
    derivation: 'json-ld',
    match: 'exact',
    score: 1,
    evidence: 'four ripe avocados',
    reason: 'Taken from the page’s structured recipe data.',
    ...overrides,
  };
}

describe('draft-form — colour', () => {
  it('never uses the brand red for a bad-confidence marker', () => {
    // The Two Reds Rule: #DD0031 means "act"; a marker is status, not an action.
    for (const entry of Object.values(MARKER_COLORS)) {
      for (const value of Object.values(entry)) {
        expect(value.toUpperCase()).not.toBe('#DD0031');
      }
    }
  });

  it('uses DESIGN.md’s semantic tokens for green and red', () => {
    expect(MARKER_COLORS.green.dot).toBe('#16A34A');
    expect(MARKER_COLORS.red.dot).toBe('#DC2626');
  });

  it('gives every level a word, so the marker is not colour-only', () => {
    expect(markerLabel(level({ level: 'green' }))).toBe('From the source');
    expect(markerLabel(level({ level: 'amber' }))).toBe('Adjusted');
    expect(markerLabel(level({ level: 'red', derivation: 'page-text' }))).toBe('Unverified');
    expect(markerLabel(level({ level: 'red', derivation: 'absent' }))).toBe('Not found');
  });
});

describe('draft-form — serves', () => {
  it('takes the number out of a free-text yield', () => {
    // schema.org recipeYield is routinely a phrase, and the Serves box has
    // always validated ^\d+(-\d+)?$.
    expect(servesForForm('2 1/2 cups guacamole')).toBe('2');
    expect(servesForForm('4 large bowls')).toBe('4');
    expect(servesForForm('Serves 6')).toBe('6');
    expect(servesForForm('4')).toBe('4');
  });

  it('keeps a range as a range', () => {
    expect(servesForForm('4-6 servings')).toBe('4-6');
    expect(servesForForm('4 to 6')).toBe('4-6');
    expect(servesForForm('serves 2–3 people')).toBe('2-3');
  });

  it('returns null when there is no number to take', () => {
    expect(servesForForm('a crowd')).toBeNull();
    expect(servesForForm('')).toBeNull();
    expect(servesForForm(null)).toBeNull();
  });

  it('produces something the publish form’s own validation accepts', () => {
    const rule = /^\d+(-\d+)?$/;
    for (const raw of ['2 1/2 cups guacamole', '4 to 6', 'Serves 6', '12 muffins']) {
      expect(rule.test(servesForForm(raw)!)).toBe(true);
    }
  });
});

describe('draft-form — ingredients', () => {
  it('maps a countable ingredient onto the picker’s Qty option', () => {
    expect(draftIngredientToForm({
      ingredientName: 'avocados', qty: 4, productQty: 4, unit: 'qty', measure: null, searchTerm: null,
    })).toEqual({ ingredientName: 'avocados', measure: '4', unit: 'Qty', searchTerm: null, qty: 4 });
  });

  it('keeps a measured ingredient’s amount and unit', () => {
    expect(draftIngredientToForm({
      ingredientName: 'lime juice', qty: 1, productQty: 1, unit: 'tbsp', measure: '3', searchTerm: null,
    })).toEqual({ ingredientName: 'lime juice', measure: '3', unit: 'tbsp', searchTerm: null, qty: 1 });
  });
});

describe('draft-form — filling the form from a real import', () => {
  it('turns the pipeline’s draft into form values', async () => {
    const result = await importedGuacamole();
    const values = importedFormValues(result);

    expect(values.name).toBe('Best Guacamole');
    expect(values.source).toBe(result.url);
    expect(values.ingredients.map(i => i.ingredientName)).toEqual(['avocados', 'lime juice', 'smoked paprika']);
    expect(values.ingredients[0].unit).toBe('Qty');
    expect(values.serves).toBe('2');
  });

  it('caps tags at the three the form accepts', async () => {
    const result = await importedGuacamole();
    (result.draft as { tags: string[] }).tags = ['Mexican', 'No Cook', 'Appetizer', 'Healthy', 'Vegan'];
    expect(importedFormValues(result).tags).toEqual(['Mexican', 'No Cook', 'Appetizer']);
  });

  it('flags a shortened Serves so the marker can say so', async () => {
    const result = await importedGuacamole();
    (result.draft as { serves: string | null }).serves = '2 1/2 cups guacamole';
    const values = importedFormValues(result);
    expect(values.serves).toBe('2');
    expect(values.servesTrimmed).toBe(true);
  });
});

describe('draft-form — markers', () => {
  it('carries the levels the pipeline computed, per ingredient', async () => {
    const result = await importedGuacamole();
    const markers = markersFrom(result.confidence);

    expect(markers.name?.level).toBe('green');
    expect(markers.ingredients.map(i => i?.level)).toEqual(['green', 'amber', 'red']);
    // The hallucinated row is red because its span is not on the page — not
    // because anything here judged it.
    expect(markers.ingredients[2]?.match).toBe('none');
    expect(markers.story?.level).toBe('red');
  });

  it('drops a field’s marker once the creator edits it', async () => {
    const result = await importedGuacamole();
    const markers = markersFrom(result.confidence);

    const edited = clearScalarMarker(markers, 'name');
    expect(edited!.name).toBeNull();
    expect(edited!.serves).not.toBeNull();

    const rowEdited = clearIngredientMarker(markers, 1);
    expect(rowEdited!.ingredients[1]).toBeNull();
    expect(rowEdited!.ingredients[0]).not.toBeNull();
  });

  it('stays index-aligned when rows are added and removed', async () => {
    const result = await importedGuacamole();
    const markers = markersFrom(result.confidence);

    const removed = removeIngredientMarker(markers, 0);
    expect(removed!.ingredients.map(i => i?.level)).toEqual(['amber', 'red']);

    const added = appendIngredientMarker(removed);
    expect(added!.ingredients.map(i => i?.level ?? null)).toEqual(['amber', 'red', null]);
  });

  it('summarises the spread as counts, never a score', async () => {
    const result = await importedGuacamole();
    const summary = summarise(markersFrom(result.confidence));

    expect(summary.total).toBe(summary.green + summary.amber + summary.red);
    expect(summary.green).toBeGreaterThan(0);
    expect(summary.red).toBeGreaterThan(0);
    expect(summaryLine(summary)).toMatch(/from the source/);
    expect(summaryLine(summary)).toMatch(/to check/);
  });

  it('summarises nothing when there is no import', () => {
    expect(summarise(null)).toEqual({ green: 0, amber: 0, red: 0, total: 0 });
    expect(summaryLine(summarise(null))).toBe('');
  });
});

describe('draft-form — rejection copy', () => {
  function rejection(overrides: Partial<ImportRejection> = {}): ImportRejection {
    return {
      status: 'rejected',
      url: 'https://example.com/post',
      stage: 'extract',
      reason: 'extraction-failed',
      detail: 'ANTHROPIC_API_KEY is not set',
      meta: { cached: false },
      ...overrides,
    };
  }

  it('renders the pipeline’s own detail verbatim', () => {
    const copy = rejectionCopy(rejection({ detail: 'The site refused our request (HTTP 403).' }));
    expect(copy.detail).toBe('The site refused our request (HTTP 403).');
  });

  it('names the stage that stopped us in plain language', () => {
    expect(rejectionCopy(rejection({ stage: 'fetch' })).heading).toMatch(/couldn’t open that link/);
    expect(rejectionCopy(rejection({ stage: 'robots' })).heading).toMatch(/asks us not to read it/);
    expect(rejectionCopy(rejection({ stage: 'gate' })).heading).toMatch(/doesn’t look like a recipe/);
    expect(rejectionCopy(rejection({ stage: 'extract' })).heading).toMatch(/couldn’t pull a recipe/);
  });

  it('always offers a next step, and it is never a dead end', () => {
    for (const stage of ['fetch', 'robots', 'gate', 'extract'] as const) {
      expect(rejectionCopy(rejection({ stage })).next).toMatch(/fill the form in below/i);
    }
  });

  it('synthesises a rejection when the request itself fails, so there is one failure shape', () => {
    const synth = transportRejection('https://example.com', 'We couldn’t reach the import service.');
    expect(synth.status).toBe('rejected');
    expect(rejectionCopy(synth).detail).toBe('We couldn’t reach the import service.');
  });
});

describe('draft-form — provenance copy', () => {
  it('says which route the recipe was read by', async () => {
    const result = await importedGuacamole();
    expect(result.meta.path).toBe('json-ld');
    expect(pathLabel(result.meta)).toMatch(/structured recipe data/);
    expect(pathLabel({ ...result.meta, path: 'raw-html' })).toMatch(/page text/);
  });

  it('names the site in a form a creator recognises', () => {
    expect(hostLabel('https://www.cookieandkate.com/best-guacamole-recipe')).toBe('cookieandkate.com');
    expect(hostLabel('not a url')).toBe('not a url');
  });
});
