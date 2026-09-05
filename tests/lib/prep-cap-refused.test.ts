// AN OVER-CAP PREPARATION IS REFUSED, NOT DELETED (MEAL-171).
//
// The bug measured on the ticket: PATCH /api/creator/import-drafts with a prep
// longer than MAX_PREP_CHARS answered `ok: true`, and the row that came back had
// no `prep` key at all. `editableDraft` ran it through `canonicalPrep`, which
// DROPS an over-cap preparation rather than truncating it, and nothing between
// the request and the response said a sentence had gone.
//
// Dropping is the right call for the value itself. Truncating picks a cut point
// nobody wrote and renders half an instruction as though it were the whole one.
// What was wrong was doing it silently on a write.
//
// WHERE THE LINE IS, and it is the thing to keep straight: tidying is allowed,
// losing the whole value is not. A run of spaces collapsing, or a leading comma
// going, changes how the value is spelled and not what it says. Over the cap the
// entire sentence disappears, and that is a different act.
import { describe, it, expect } from 'vitest';
import { editableDraft } from '@/lib/import-drafts';
import { publishBlockers } from '@/lib/import/draft-form';
import { canonicalPrep, normalizePrep, prepCapError, MAX_PREP_CHARS } from '@/lib/import/ingredients';

const OVER = 'x'.repeat(MAX_PREP_CHARS + 1);
const AT_CAP = 'y'.repeat(MAX_PREP_CHARS);

const draftWithPrep = (prep: string) => ({
  name: 'Garlic butter shrimp',
  ingredients: [{ ingredientName: 'garlic', qty: 3, unit: 'qty', measure: null, prep }],
  tags: [],
  serves: '',
  recipe: null,
  source: '',
  story: null,
  photoUrl: null,
  difficulty: null,
});

describe('prepCapError', () => {
  it('says nothing about a preparation that fits', () => {
    expect(prepCapError(AT_CAP, 'garlic')).toBeNull();
    expect(prepCapError('finely diced', 'garlic')).toBeNull();
    expect(prepCapError(null)).toBeNull();
  });

  it('names the ingredient and both numbers, so the fix is obvious', () => {
    const message = prepCapError(OVER, 'garlic');
    expect(message).toContain('garlic');
    expect(message).toContain(String(MAX_PREP_CHARS + 1));
    expect(message).toContain(String(MAX_PREP_CHARS));
  });

  it('measures the STORED string, not the typed one', () => {
    // Padded to over the cap as typed, under it once collapsed. Refusing this
    // would refuse a preparation that fits.
    const padded = `  ${'z'.repeat(MAX_PREP_CHARS - 2)}${' '.repeat(20)}  `;
    expect(padded.length).toBeGreaterThan(MAX_PREP_CHARS);
    expect(normalizePrep(padded).length).toBeLessThanOrEqual(MAX_PREP_CHARS);
    expect(prepCapError(padded, 'garlic')).toBeNull();
    expect(canonicalPrep(padded).prep).toBeTruthy();
  });
});

describe('editableDraft, which is what both PATCH routes validate with', () => {
  it('REFUSES an over-cap preparation rather than answering ok with it gone', () => {
    const result = editableDraft(draftWithPrep(OVER));
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain('garlic');
  });

  it('the exact bug: it used to come back ok with no prep key', () => {
    // Pinning the old behaviour as the thing that must NOT happen. If this ever
    // passes as `ok: true`, the row it returns has quietly lost a sentence.
    const result = editableDraft(draftWithPrep(OVER));
    expect(result.ok).toBe(false);
    if (result.ok) expect(result.draft.ingredients[0]).toHaveProperty('prep');
  });

  it('accepts a preparation exactly at the cap', () => {
    const result = editableDraft(draftWithPrep(AT_CAP));
    expect(result.ok).toBe(true);
    expect(result.ok === true && (result.draft.ingredients[0] as { prep?: string }).prep).toBe(AT_CAP);
  });

  it('still TIDIES rather than refusing, because that loses nothing', () => {
    // A lone comma is not a preparation somebody lost. It canonicalises to
    // nothing and the save succeeds, which is the documented split.
    const result = editableDraft(draftWithPrep(' , '));
    expect(result.ok).toBe(true);
    expect(result.ok === true && result.draft.ingredients[0]).not.toHaveProperty('prep');
  });

  it('tidies a leading comma off a real preparation and keeps the words', () => {
    const result = editableDraft(draftWithPrep(', finely   diced'));
    expect(result.ok).toBe(true);
    expect(result.ok === true && (result.draft.ingredients[0] as { prep?: string }).prep).toBe('finely diced');
  });
});

describe('publishBlockers says it too, so the preview cannot disagree with the save', () => {
  it('blocks a draft whose preparation is over the cap', () => {
    const blockers = publishBlockers(draftWithPrep(OVER));
    expect(blockers.map((b) => b.field)).toContain('ingredients');
    expect(blockers.find((b) => b.message.includes('garlic'))).toBeTruthy();
  });

  it('does not block one that fits', () => {
    expect(publishBlockers(draftWithPrep('finely diced'))).toEqual([]);
  });

  it('reports the first offender only, not one sentence per row', () => {
    const blockers = publishBlockers({
      ...draftWithPrep(OVER),
      ingredients: [
        { ingredientName: 'garlic', qty: 1, unit: 'qty', measure: null, prep: OVER },
        { ingredientName: 'shallot', qty: 1, unit: 'qty', measure: null, prep: OVER },
      ],
    });
    expect(blockers.filter((b) => b.message.includes('preparation'))).toHaveLength(1);
  });
});
