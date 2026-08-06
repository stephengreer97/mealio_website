import { describe, it, expect } from 'vitest';
import {
  DUPLICATE_THRESHOLD,
  duplicateCandidates,
  duplicateNotice,
  findDuplicates,
  jaccard,
  ingredientKeys,
  type DuplicateCandidate,
} from '@/lib/import/duplicates';
import { FakeSupabase, DEFAULT_PAGE_ROWS } from '@/tests/helpers/supabase-mock';

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

const named = (names: string[], name = 'Some Dish') => ({ name, ingredients: names.map(ingredientName => ({ ingredientName })) });

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

    expect(findDuplicates(curry, [candidate({ ingredientNames: pasta.ingredients.map(p => p.ingredientName) })])).toEqual([]);
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

describe('an identical title is its own signal', () => {
  it('flags a repeat the ingredient lists would have missed', async () => {
    // The case Jaccard cannot reach: a Short whose description lists three
    // ingredients against the long form that lists nine. Few shared over many
    // combined scores badly, and both are plainly the same dish — which the
    // creator said by titling them the same.
    const short = { name: 'GARLIC BUTTER SHRIMP 🔥 #shorts', ingredients: named(['shrimp', 'butter', 'garlic']).ingredients };

    const [match] = findDuplicates(short, [candidate({ name: 'Garlic Butter Shrimp!' })]);

    expect(match?.sameTitle).toBe(true);
    // Reported honestly: the titles matched, the lists did not.
    expect(match.overlap).toBeLessThan(DUPLICATE_THRESHOLD);
  });

  it('reads a same-title match before a merely similar one', () => {
    const draft = named(SHRIMP, 'Garlic Butter Shrimp');
    const matches = findDuplicates(draft, [
      candidate({ id: 'similar', name: 'Buttery Shrimp Skillet' }),
      candidate({ id: 'titled', name: 'garlic butter shrimp', ingredientNames: ['shrimp', 'butter'] }),
    ]);

    // The more certain claim first, whatever the overlap says.
    expect(matches[0].id).toBe('titled');
  });

  it('says which of the two signals fired', () => {
    const matches = findDuplicates(named(SHRIMP, 'Garlic Butter Shrimp'), [candidate({ name: 'Garlic Butter Shrimp' })]);
    expect(duplicateNotice(matches)).toMatch(/same title/i);
  });

  it('does not call two untitled drafts the same dish', () => {
    // An empty title matching an empty title is not a creator telling us
    // anything, and every draft would flag every other.
    const matches = findDuplicates({ name: '', ingredients: named(['a', 'b', 'c', 'd']).ingredients },
      [candidate({ name: '', ingredientNames: ['w', 'x', 'y', 'z'] })]);
    expect(matches).toEqual([]);
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

describe('duplicateCandidates', () => {
  /**
   * The shared fake, not a bespoke chain object.
   *
   * This used to be a hand-rolled stub whose `.eq()` returned itself and which
   * answered every query with the same array. It passed while the two reads here
   * were unbounded, and it could not have done anything else: it ignored the
   * filters, so it could not tell a query scoped to one creator from one that
   * read the table, and it had no row ceiling, so it could not tell a paged read
   * from a truncated one. When those reads were paged it did not report a
   * behaviour change — it threw `.order is not a function`, which is the most
   * useful thing it ever said.
   *
   * `FakeSupabase` evaluates the filters and enforces `DEFAULT_PAGE_ROWS`, so
   * these tests now exercise the paging rather than stubbing it out.
   */
  const db = (published: any[], drafts: any[]) => {
    const fake = new FakeSupabase();
    fake.seed('preset_meals', published.map((row) => ({ creator_id: 'c1', ...row })));
    fake.seed('creator_import_drafts', drafts.map((row) => ({
      creator_id: 'c1', status: 'pending_review', ...row,
    })));
    return fake;
  };

  it('reads both published meals and drafts still in the queue', async () => {
    const out = await duplicateCandidates(
      db(
        [{ id: 'm1', name: 'Shrimp', ingredients: [{ ingredientName: 'shrimp' }] }],
        [{ id: 'd1', draft: { name: 'Shrimp Short', ingredients: [{ ingredientName: 'shrimp' }] } }],
      ),
      'c1',
    );

    expect(out.map(c => c.kind)).toEqual(['published', 'draft']);
    expect(out[1].name).toBe('Shrimp Short');
  });

  it('never offers a draft itself as its own duplicate', async () => {
    // It would match perfectly, which is the most confident wrong answer
    // available to this feature.
    const out = await duplicateCandidates(db([], [{ id: 'd1', draft: { name: 'Me' } }]), 'c1', 'd1');
    expect(out).toEqual([]);
  });

  it('reads an ingredient list however the row spells the name', async () => {
    // product_name / productName / name all appear in stored meals. Read under
    // the wrong key the list is empty, which scores zero and silently never
    // matches — a duplicate check that quietly always passes.
    const out = await duplicateCandidates(
      db([{ id: 'm1', name: 'Old', ingredients: [{ product_name: 'shrimp' }, { name: 'butter' }] }], []),
      'c1',
    );
    expect(out[0].ingredientNames).toEqual(['shrimp', 'butter']);
  });

  it('reads a creator’s whole back catalogue, past the 1000-row page ceiling', async () => {
    // The bug this read had (MEAL-130). A duplicate check proves a NEGATIVE, so a
    // truncated candidate list does not degrade the answer, it inverts it: the
    // meals past the ceiling are declared not to exist and the re-import is waved
    // through. The creator with the largest catalogue — the one most likely to
    // repeat themselves — was the only one it failed for.
    //
    // 1500 is deliberately just over DEFAULT_PAGE_ROWS: enough to need a second
    // page, and the fake truncates at exactly that boundary the way PostgREST
    // does, silently.
    const published = Array.from({ length: DEFAULT_PAGE_ROWS + 500 }, (_, i) => ({
      id: `m${String(i).padStart(5, '0')}`,
      name: `Meal ${i}`,
      ingredients: [{ ingredientName: 'shrimp' }],
    }));

    const out = await duplicateCandidates(db(published, []), 'c1');

    expect(out).toHaveLength(DEFAULT_PAGE_ROWS + 500);
    // The last meal in the catalogue is the one an unpaged read loses, so name it
    // rather than trusting the count alone.
    expect(out.some((c) => c.id === `m0${DEFAULT_PAGE_ROWS + 499}`)).toBe(true);
  });

  it('does not read another creator’s meals while paging', async () => {
    // The paging walk adds an `.order()` and a `.range()` to a filtered query, and
    // getting that wrong reads the whole table in creator order. The old stub
    // ignored filters entirely and could not have caught it.
    const fake = new FakeSupabase();
    fake.seed('preset_meals', [
      { id: 'm1', creator_id: 'c1', name: 'Mine', ingredients: [{ ingredientName: 'shrimp' }] },
      { id: 'm2', creator_id: 'c2', name: 'Theirs', ingredients: [{ ingredientName: 'shrimp' }] },
    ]);
    fake.seed('creator_import_drafts', []);

    const out = await duplicateCandidates(fake, 'c1');
    expect(out.map((c) => c.name)).toEqual(['Mine']);
  });
});
