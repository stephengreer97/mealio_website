import { describe, it, expect } from 'vitest';
import {
  DUPLICATE_THRESHOLD,
  duplicateNotice,
  findDuplicates,
  jaccard,
  ingredientKeys,
  type DuplicateCandidate,
} from '@/lib/import/duplicates';

/**
 * Flagging a recipe a creator has already published (MEAL-98).
 *
 * The case this exists for: a full-length video and a 45-second Short of the
 * same dish. Two post ids, so `creator_source_items` does not catch it, and two
 * drafts arrive. The titles diverge exactly here — one is `GARLIC BUTTER SHRIMP
 * 🔥 #shorts` — while the ingredients barely move, which is why the comparison
 * is on ingredients.
 */

const SHRIMP = ['shrimp', 'butter', 'garlic', 'lemon', 'parsley', 'olive oil'];

const candidate = (over: Partial<DuplicateCandidate> = {}): DuplicateCandidate => ({
  id: 'm1',
  name: 'Weeknight Garlic Butter Shrimp in 15 Minutes',
  kind: 'published',
  ingredientNames: SHRIMP,
  ...over,
});

const named = (names: string[]) => names.map(ingredientName => ({ ingredientName }));

describe('findDuplicates', () => {
  it('catches a Short of a recipe already published', () => {
    // The Short drops the garnish and renames nothing that matters.
    const short = named(['shrimp', 'butter', 'garlic', 'lemon', 'olive oil']);

    const [match] = findDuplicates(short, [candidate()]);

    expect(match?.name).toMatch(/Garlic Butter Shrimp/);
    expect(match.overlap).toBeGreaterThanOrEqual(DUPLICATE_THRESHOLD);
  });

  it('leaves two different recipes alone, however much pantry they share', () => {
    // Both use oil, salt, garlic and onion. That is a kitchen, not a duplicate,
    // and flagging it is how a reviewer learns to ignore the flag.
    const curry = named(['chickpeas', 'coconut milk', 'curry powder', 'onion', 'garlic', 'olive oil', 'spinach']);
    const pasta = named(['spaghetti', 'parmesan', 'egg', 'pancetta', 'onion', 'garlic', 'olive oil']);

    expect(findDuplicates(curry, [candidate({ ingredientNames: pasta.map(p => p.ingredientName) })])).toEqual([]);
  });

  it('refuses to judge a list too short to judge', () => {
    // Two three-ingredient recipes sharing salt, butter and garlic score 1.0 and
    // are not the same dish. "Cannot tell" is a false negative, which is the
    // side this is built to fail on.
    const toast = named(['bread', 'butter', 'salt']);
    expect(findDuplicates(toast, [candidate({ ingredientNames: ['bread', 'butter', 'salt'] })])).toEqual([]);
  });

  it('says what the repeat is a repeat of', () => {
    // "Possible duplicate" alone sends the reviewer hunting through their own
    // back catalogue, which is the work this is meant to save.
    const matches = findDuplicates(named(SHRIMP), [candidate()]);
    const notice = duplicateNotice(matches);

    expect(notice).toContain('Garlic Butter Shrimp');
    expect(notice).toMatch(/already published/);
  });

  it('reads a draft still in the queue differently from a published meal', () => {
    const matches = findDuplicates(named(SHRIMP), [candidate({ kind: 'draft', name: 'Shrimp, again' })]);
    expect(duplicateNotice(matches)).toMatch(/also waiting in this queue/);
  });

  it('says nothing when nothing matches', () => {
    expect(duplicateNotice([])).toBeNull();
  });
});

describe('the comparison itself', () => {
  it('meets differently-written forms of one ingredient', () => {
    // The pipeline's own normalisation, not a second one invented here.
    const keys = ingredientKeys(['Unsalted Butter', 'unsalted butter']);
    expect(keys.size).toBe(1);
  });

  it('scores identical sets 1 and disjoint sets 0', () => {
    expect(jaccard(new Set(['a', 'b']), new Set(['a', 'b']))).toBe(1);
    expect(jaccard(new Set(['a']), new Set(['b']))).toBe(0);
    expect(jaccard(new Set(), new Set(['a']))).toBe(0);
  });
});
