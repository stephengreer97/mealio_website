import { describe, it, expect } from 'vitest';
import {
  EVIDENCE_MAX_CHARS,
  FIELD_LABELS,
  appendIngredientState,
  clearIngredientState,
  clearScalarState,
  draftIngredientToForm,
  fieldStatesFor,
  hostLabel,
  importedFormValues,
  noticeFor,
  noticesFor,
  pathLabel,
  rejectionCopy,
  removeIngredientState,
  summarise,
  summaryLine,
  tagsTrimmedNote,
  transportRejection,
  truncateEvidence,
  type FieldState,
  type ImportField,
  type FormFieldStates,
  type ImportedFormValues,
  type ScalarField,
} from '@/lib/import/draft-form';
import type { FieldConfidence, ImportConfidence, ImportRejection } from '@/lib/import/types';
import { importedGuacamole } from '../helpers/import-ui-fixtures';

/**
 * The rules behind what a creator sees. Pure functions, no DOM, no key.
 */

/** Every field written, i.e. the whole-import case. */
const ALL: Partial<Record<ImportField, boolean>> = Object.fromEntries(
  (Object.keys(FIELD_LABELS) as ImportField[]).map(f => [f, true]),
);

/** A form nobody has typed in yet — the first-import case. */
const EMPTY: Record<ScalarField, boolean> = {
  name: true, recipe: true, story: true, photoUrl: true, difficulty: true, tags: true, serves: true,
};

/** `fieldStatesFor` for a first import into an untouched form. */
function statesForFirstImport(
  confidence: ImportConfidence,
  values: ImportedFormValues,
  written: Partial<Record<ImportField, boolean>>,
  empty: Record<ScalarField, boolean> = EMPTY,
) {
  return fieldStatesFor({ confidence, values, written, empty, previous: null });
}

function state(overrides: Partial<FieldConfidence> = {}, written = true): FieldState {
  return {
    written,
    confidence: {
      level: 'green',
      derivation: 'json-ld',
      match: 'exact',
      score: 1,
      evidence: 'four ripe avocados',
      reason: 'Taken from the page’s structured recipe data.',
      ...overrides,
    },
  };
}

describe('draft-form — notices flag only the exceptions', () => {
  it('says nothing at all about a verified field', () => {
    // Silence is the signal. The summary line is what makes silence readable
    // as "checked" rather than "skipped".
    expect(noticeFor(state({ level: 'green' }))).toBeNull();
  });

  it('says nothing about a field the creator was editing', () => {
    expect(noticeFor(null)).toBeNull();
  });

  it('quotes the source span for an adjusted field, and nothing else', () => {
    const notice = noticeFor(state({ level: 'amber', derivation: 'normalized', evidence: 'juice of 1 lime' }));
    expect(notice).toEqual({ kind: 'adjusted', text: '', evidence: 'juice of 1 lime' });
  });

  it('falls back to the pipeline’s reason when an adjusted field has no span to quote', () => {
    const notice = noticeFor(state({
      level: 'amber', derivation: 'inferred', evidence: null,
      reason: 'Inferred from the source as a whole, not stated outright.',
    }));
    // An empty notice would be worse than none.
    expect(notice!.text).toBe('Inferred from the source as a whole, not stated outright.');
    expect(notice!.evidence).toBeNull();
  });

  it('tells a creator to add a field the source did not have', () => {
    expect(noticeFor(state({ level: 'red', derivation: 'absent', evidence: null }, false))).toEqual({
      kind: 'absent',
      text: 'Not found in the source. Add this',
      evidence: null,
    });
  });

  it('keeps an unverified value on screen and asks for a check', () => {
    // Red does not mean deleted. The value stays editable and publishable —
    // silently removing it would be its own kind of wrong.
    const notice = noticeFor(state({
      level: 'red', derivation: 'page-text', match: 'none', score: 0,
      evidence: '1 teaspoon smoked paprika',
    }));
    expect(notice!.kind).toBe('unverified');
    expect(notice!.text).toMatch(/couldn’t find this in the source/);
    expect(notice!.evidence).toBe('1 teaspoon smoked paprika');
  });

  it('shows the pipeline’s own reason for a photo we generated rather than read', () => {
    // A Pixabay stand-in was not judged from the source, so there is no span
    // and no quote that could honestly be shown.
    const notice = noticeFor(state({
      level: 'amber',
      derivation: 'generated',
      evidence: null,
      reason: 'No usable image on the page, so this is a stock photo we picked.',
    }));
    expect(notice).toEqual({
      kind: 'generated',
      text: 'No usable image on the page, so this is a stock photo we picked.',
      evidence: null,
    });
  });

  it('still says a value was ours even if it somehow arrives green', () => {
    // Unreachable today — `confidence.ts` pins `generated` to amber or red —
    // but the green shortcut used to run first, so a green stand-in would have
    // lost its "we picked this" warning *and* been counted as verified. The
    // level is not what makes a value we chose worth mentioning.
    const notice = noticeFor(state({
      level: 'green',
      derivation: 'generated',
      evidence: null,
      reason: 'No usable image on the page, so this is a stock photo we picked.',
    }));
    expect(notice?.kind).toBe('generated');
    expect(summarise({
      name: null, recipe: null, story: null, difficulty: null, tags: null, serves: null,
      photoUrl: state({ level: 'green', derivation: 'generated', evidence: null }),
      ingredients: [],
    })).toEqual({ total: 1, verified: 0, needALook: 1 });
  });
});

describe('draft-form — evidence length', () => {
  it('bounds a quoted span so a flagged row cannot become a wall', () => {
    const long = 'a'.repeat(400);
    expect(truncateEvidence(long).length).toBeLessThanOrEqual(EVIDENCE_MAX_CHARS + 1);
    expect(truncateEvidence(long).endsWith('…')).toBe(true);
  });

  it('drops a matched outer quote pair, because the UI adds its own', () => {
    // The notice wraps every span in quotation marks, so a span that already
    // carries them renders as ""…"". Straight and curly both.
    expect(truncateEvidence('"many grinds of black pepper"')).toBe('many grinds of black pepper');
    expect(truncateEvidence('“many grinds of black pepper”')).toBe('many grinds of black pepper');
  });

  it('leaves an unmatched quote alone rather than rebalancing it', () => {
    // A span that opens with a quote and closes without one is quoting
    // something. Stripping one side would misrepresent what the page said.
    expect(truncateEvidence('"a quote that runs on')).toBe('"a quote that runs on');
    expect(truncateEvidence('he said "hello"')).toBe('he said "hello"');
  });

  it('leaves a short span exactly as written', () => {
    expect(truncateEvidence('juice of 1 lime')).toBe('juice of 1 lime');
  });

  it('cuts on a word boundary and flattens whitespace', () => {
    const span = `${'word '.repeat(40)}end`;
    const cut = truncateEvidence(span);
    expect(cut).not.toMatch(/\s\S{0,3}…$/);
    expect(truncateEvidence('one\n\n  two')).toBe('one two');
  });
});

describe('draft-form — serves', () => {
  it('passes the pipeline’s value through untouched', async () => {
    // Deliberately no client-side coercion. Reading "2 1/2 cups guacamole" as
    // serves: 2 is wrong data, not a formatting fix; the pipeline owns this and
    // emits a people count or nothing.
    const result = await importedGuacamole();
    (result.draft as { serves: string | null }).serves = '4-6';
    expect(importedFormValues(result).serves).toBe('4-6');
  });

  it('leaves Serves blank and shows what it found there instead', async () => {
    const result = await importedGuacamole();
    (result.draft as { serves: string | null }).serves = null;
    const values = importedFormValues(result);
    const states = statesForFirstImport(result.confidence, values, { ...ALL, serves: false });

    expect(values.serves).toBe('');
    expect(values.provided.serves).toBe(false);
    // Never a verified claim about an empty box — that was the old bug.
    //
    // And "we found nothing" would be its own untruth here. The page's only
    // yield is "2 1/2 cups guacamole"; we read it, matched it exactly, and
    // rejected it as a volume rather than a head count. `extract.ts` keeps that
    // span deliberately, so the box explains itself instead of shrugging.
    expect(result.confidence.serves.evidence).toBe('2 1/2 cups guacamole');
    expect(noticeFor(states.serves)).toEqual({
      kind: 'absent',
      text: 'We found this but couldn’t use it. Add this.',
      evidence: '2 1/2 cups guacamole',
    });
  });
});

describe('draft-form — ingredients', () => {
  it('maps a countable ingredient onto the picker’s Qty option', () => {
    expect(draftIngredientToForm({
      ingredientName: 'avocados', qty: 4, productQty: 4, unit: 'qty', measure: null, searchTerm: null,
    })).toEqual({ ingredientName: 'avocados', measure: '4', unit: 'qty', searchTerm: null, qty: 4 });
  });

  it('keeps a measured ingredient’s amount and unit', () => {
    expect(draftIngredientToForm({
      ingredientName: 'lime juice', qty: 1, productQty: 1, unit: 'tbsp', measure: '3', searchTerm: null,
    })).toEqual({ ingredientName: 'lime juice', measure: '3', unit: 'tbsp', searchTerm: null, qty: 1 });
  });

  it('leaves the amount blank for a line the source never quantified', () => {
    // "many grinds of black pepper" reaches canonicalisation with no number, so
    // it becomes a countable 1 — indistinguishable from "1 lemon" by the time it
    // gets here. Typing "1" into the box states a quantity we never read; blank
    // is what a creator would have left, and it round-trips back to 1 on save.
    expect(draftIngredientToForm({
      ingredientName: 'black pepper', qty: 1, productQty: 1, unit: 'qty', measure: null, searchTerm: null,
    })).toEqual({ ingredientName: 'black pepper', measure: '', unit: 'qty', searchTerm: null, qty: 1 });
  });
});

describe('draft-form — filling the form from a real import', () => {
  it('turns the pipeline’s draft into form values', async () => {
    const result = await importedGuacamole();
    const values = importedFormValues(result);

    expect(values.name).toBe('Best Guacamole');
    expect(values.source).toBe(result.url);
    expect(values.ingredients.map(i => i.ingredientName)).toEqual(['avocados', 'lime juice', 'smoked paprika']);
    expect(values.ingredients[0].unit).toBe('qty');
    // The recorded page publishes only "2 1/2 cups guacamole" — a volume, not a
    // head count — so the pipeline emits no serves and the box stays empty.
    expect(values.serves).toBe('');
    expect(values.provided.serves).toBe(false);
    // The photo is our stored copy, never the third-party URL.
    expect(values.photoUrl).toBe('https://storage.mealio.co/meal-photos/cookieandkate-guacamole.jpg');
  });

  it('caps tags at the three the form accepts, and says it did', async () => {
    const result = await importedGuacamole();
    (result.draft as { tags: string[] }).tags = ['Mexican', 'No Cook', 'Appetizer', 'Healthy', 'Vegan'];
    const values = importedFormValues(result);

    expect(values.tags).toEqual(['Mexican', 'No Cook', 'Appetizer']);
    // Dropping two silently would read as the import having missed them.
    expect(values.tagsNote).toBe('We found 5 tags and kept the first 3. The form takes 3.');
  });

  it('says nothing about tags when none were dropped', () => {
    expect(tagsTrimmedNote(3, 3)).toBeNull();
    expect(tagsTrimmedNote(1, 3)).toBeNull();
  });

  it('reports which fields it had no value for', async () => {
    const result = await importedGuacamole();
    const values = importedFormValues(result);

    // The fixture's story is absent, so the form must not claim anything there.
    expect(values.provided.story).toBe(false);
    expect(values.provided.name).toBe(true);
  });
});

describe('draft-form — field states', () => {
  /**
   * The real path: the form writes exactly the fields the import provided,
   * minus any the caller marks as skipped.
   */
  async function statesFrom(skip: Partial<Record<ImportField, boolean>> = {}) {
    const result = await importedGuacamole();
    const values = importedFormValues(result);
    const written = Object.fromEntries(
      (Object.keys(FIELD_LABELS) as ImportField[])
        .map(f => [f, values.provided[f] && !skip[f]]),
    );
    return { result, values, states: statesForFirstImport(result.confidence, values, written) };
  }

  it('carries the levels the pipeline computed, per ingredient', async () => {
    const { states } = await statesFrom();

    expect(states.name?.confidence.level).toBe('green');
    expect(states.ingredients.map(s => s?.confidence.level)).toEqual(['green', 'amber', 'red']);
    // The hallucinated row is red because its span is not on the page — not
    // because anything here judged it.
    expect(states.ingredients[2]?.confidence.match).toBe('none');
  });

  it('flags only the exceptions', async () => {
    const { states } = await statesFrom();
    const notices = noticesFor(states);

    // Verified — nothing at all.
    expect(notices.name).toBeNull();
    expect(notices.ingredients[0]).toBeNull();
    // Adjusted and unverified — flagged.
    expect(notices.ingredients[1]?.kind).toBe('adjusted');
    expect(notices.ingredients[2]?.kind).toBe('unverified');
    // The absent story asks to be filled in.
    expect(notices.story?.kind).toBe('absent');
  });

  it('says nothing about a field the creator was editing while the import ran', async () => {
    const { states } = await statesFrom({ name: true });
    // `name` was provided by the import but not written, so it is theirs.
    expect(states.name).toBeNull();
    expect(noticesFor(states).name).toBeNull();
  });

  it('leaves ingredient states empty when the rows were not written and there is no history', async () => {
    const { states } = await statesFrom({ ingredients: true });
    expect(states.ingredients).toEqual([]);
  });

  it('flags a row the confidence list has no entry for', async () => {
    // `confidence.ingredients` is index-aligned when it leaves the pipeline,
    // but results are persisted, so a cached entry from an older build can come
    // back short. Silence means "we checked this", so a row we cannot account
    // for has to say so rather than pass as verified.
    const result = await importedGuacamole();
    const values = importedFormValues(result);
    const intact = summarise(statesForFirstImport(result.confidence, values, ALL));

    result.confidence.ingredients = result.confidence.ingredients.slice(0, 2);
    const states = statesForFirstImport(result.confidence, values, ALL);

    expect(values.ingredients).toHaveLength(3);
    expect(states.ingredients).toHaveLength(3);
    expect(noticesFor(states).ingredients[2]?.kind).toBe('unverified');
    // The row is still counted, so the summary describes the form on screen
    // rather than a shorter list nobody can see.
    expect(summarise(states).total).toBe(intact.total);
    expect(summarise(states).verified).toBe(intact.verified);
  });

  it('drops a field’s state once the creator edits it', async () => {
    const { states } = await statesFrom();

    const edited = clearScalarState(states, 'name');
    expect(edited!.name).toBeNull();
    expect(edited!.serves).not.toBeNull();

    const rowEdited = clearIngredientState(states, 1);
    expect(rowEdited!.ingredients[1]).toBeNull();
    expect(noticesFor(rowEdited).ingredients[1]).toBeNull();
    expect(rowEdited!.ingredients[0]).not.toBeNull();
  });

  it('stays index-aligned when rows are added and removed', async () => {
    const { states } = await statesFrom();

    const removed = removeIngredientState(states, 0);
    expect(removed!.ingredients.map(s => s?.confidence.level)).toEqual(['amber', 'red']);

    const added = appendIngredientState(removed);
    expect(added!.ingredients.map(s => s?.confidence.level ?? null)).toEqual(['amber', 'red', null]);
  });
});

describe('draft-form — a state describes the value that is on screen', () => {
  /**
   * A second import writes only the fields it has values for, so the boxes it
   * has nothing for keep the *first* import's values. Replacing the whole state
   * object meant those boxes kept a value and lost the sentence explaining it.
   */
  async function secondImportOver(previous: FormFieldStates | null, empty: Partial<Record<ScalarField, boolean>> = {}) {
    const result = await importedGuacamole();
    // A draft with nothing in it. Reachable: `canonicalizeIngredients` drops
    // every row with no product name, and a page can carry no title.
    result.draft.name = '';
    result.draft.ingredients = [];
    const values = importedFormValues(result);

    return fieldStatesFor({
      confidence: result.confidence,
      values,
      written: {},
      empty: { ...EMPTY, name: false, ...empty },
      previous,
    });
  }

  it('keeps the first import’s ingredient flags when a second import has no rows', async () => {
    const result = await importedGuacamole();
    const first = statesForFirstImport(result.confidence, importedFormValues(result), ALL);
    expect(noticesFor(first).ingredients[2]?.kind).toBe('unverified');

    const second = await secondImportOver(first);

    // The rows are still on screen, so what we said about them still stands.
    expect(second.ingredients).toHaveLength(3);
    expect(noticesFor(second).ingredients[2]?.kind).toBe('unverified');
    expect(summarise(second).total).toBeGreaterThanOrEqual(3);
  });

  it('does not hang “not found” on a box still showing the last import’s value', async () => {
    const result = await importedGuacamole();
    const first = statesForFirstImport(result.confidence, importedFormValues(result), ALL);
    expect(first.name?.confidence.level).toBe('green');

    const second = await secondImportOver(first);

    // The box still reads "Best Guacamole", verified, from the first import.
    expect(second.name).toEqual(first.name);
    expect(noticesFor(second).name).toBeNull();
  });

  it('says nothing about a box the creator filled in themselves', async () => {
    // No import wrote this box and none had a value for it, so "Not found in
    // the source — add this" is a claim about someone else's typing.
    const second = await secondImportOver(null);
    expect(second.name).toBeNull();
    expect(noticesFor(second).name).toBeNull();
  });

  it('still asks for a field the source had nothing for and nobody has filled', async () => {
    const second = await secondImportOver(null, { name: true });
    expect(noticesFor(second).name?.kind).toBe('absent');
  });
});

describe('draft-form — summary', () => {
  it('counts verified as “we checked this value”, never “we filled it in”', async () => {
    const result = await importedGuacamole();
    const values = importedFormValues(result);
    const summary = summarise(statesForFirstImport(result.confidence, values, ALL));

    expect(summary.verified).toBeGreaterThan(0);
    expect(summary.needALook).toBeGreaterThan(0);
  });

  it('puts every field in exactly one bucket, so the counts add up', async () => {
    // The old line reported how many fields were *populated* alongside these
    // two, which is a second axis and made the arithmetic look broken.
    const result = await importedGuacamole();
    const values = importedFormValues(result);
    const summary = summarise(statesForFirstImport(result.confidence, values, ALL));

    expect(summary.verified + summary.needALook).toBe(summary.total);
    expect(summaryLine(summary))
      .toBe(`${summary.verified} of ${summary.total} fields verified. ${summary.needALook} need a look.`);
  });

  it('does not count a generated stand-in photo as verified', () => {
    const states = {
      name: state({ level: 'green' }),
      recipe: null, story: null, difficulty: null, tags: null, serves: null,
      photoUrl: state({ level: 'amber', derivation: 'generated', evidence: null, reason: 'A stock photo we picked.' }),
      ingredients: [],
    };
    const summary = summarise(states);

    expect(summary.total).toBe(2);
    expect(summary.verified).toBe(1);
    expect(summary.needALook).toBe(1);
  });

  it('says so plainly when nothing is left to check', () => {
    const summary = summarise({
      name: state({ level: 'green' }),
      recipe: null, story: null, photoUrl: null, difficulty: null, tags: null, serves: null,
      ingredients: [],
    });
    expect(summaryLine(summary)).toBe('1 of 1 field verified.');
  });

  it('gets the grammar right for a single flagged field', () => {
    const summary = summarise({
      name: state({ level: 'green' }),
      recipe: state({ level: 'amber', derivation: 'normalized' }),
      story: null, photoUrl: null, difficulty: null, tags: null, serves: null,
      ingredients: [],
    });
    expect(summaryLine(summary)).toBe('1 of 2 fields verified. 1 needs a look.');
  });

  it('summarises nothing when there is no import', () => {
    expect(summarise(null)).toEqual({ total: 0, verified: 0, needALook: 0 });
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

  it('does not blame the creator’s link for a failure of our own endpoint', () => {
    // A 403 from `/api/creator/import` never touched their URL. `stage` has to
    // be one of the pipeline's four to satisfy the shared shape, and reading it
    // literally put "We couldn't open that link" above "Creator account
    // required" — sending them off to check a URL that is fine.
    const synth = transportRejection('https://cookieandkate.com/best-guacamole-recipe', 'Creator account required');
    const copy = rejectionCopy(synth);

    expect(copy.heading).toBe('We couldn’t complete that import');
    expect(copy.heading).not.toMatch(/open that link/);
    expect(copy.next).toMatch(/try again/i);
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
