import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

vi.mock('@/lib/supabase', () => ({ createServerSupabaseClient: () => ({}) }));
vi.mock('@/lib/logger', () => ({ log: vi.fn() }));

import { publishBlockers } from '@/lib/import/draft-form';
import { publishCreatorMeal } from '@/lib/creator-meals';
import { editableDraft } from '@/lib/import-drafts';

/**
 * What the review preview says would stop a publish, against what actually does.
 *
 * The creator queue used to have exactly one way to discover a draft could not
 * be published: press Approve and lose. The real case is a row written before
 * the tag cap shipped — eight tags, `publishCreatorMeal` throws, `approveDraft`
 * rolls the draft back to `pending_review`, and the creator is holding a recipe
 * with no way to see why it will not go out.
 *
 * `publishBlockers` answers that up front, and the only way it is worth
 * anything is if it says the same thing the server says. A preview that is
 * *nearly* right about publishability is worse than none, because it is trusted:
 * a creator told "this is fine" who then watches Approve fail has learnt to
 * ignore the preview.
 *
 * So these tests do not check wording against a literal. They run the same draft
 * through the real refusal — `publishCreatorMeal` for the two rules it enforces,
 * `editableDraft` for the two the editor refuses first — and assert the
 * sentences are the same sentence. Reword either end and this fails.
 */

/** The nine fields, minimally filled, in the shape both refusals take. */
const draft = (overrides: Record<string, unknown> = {}) => ({
  name: 'Best Guacamole',
  ingredients: [{ ingredientName: 'avocados', qty: 4, productQty: 4, unit: 'qty', measure: null, searchTerm: null }],
  recipe: 'Mash it.',
  story: null,
  photoUrl: null,
  difficulty: 2,
  tags: ['Mexican'],
  serves: '4',
  source: 'https://chefsarah.test/guacamole',
  ...overrides,
});

const creator = { id: 'c1', display_name: 'Chef Sarah', user_id: 'u1' };

/**
 * A client that would fail loudly if it were reached.
 *
 * Both rules below throw before the insert, which is the point — they are
 * refusals about the recipe, not about the database. If a rule ever moves after
 * the insert this stops being a valid stand-in and says so.
 */
const unreachableDb = new Proxy({}, {
  get() { throw new Error('publishCreatorMeal reached the database on a draft it should have refused'); },
}) as unknown as SupabaseClient;

describe('the preview and the publish agree on what is publishable', () => {
  it('says the same thing about too many tags', async () => {
    // The production row: eight tags from an extraction that predates the cap.
    const eight = draft({
      tags: ['Mexican', 'No Cook', 'Appetizer', 'Snack', 'Vegan', 'Healthy', 'Dinner', 'Lunch'],
    });

    const [blocker, ...rest] = publishBlockers(eight as never);
    expect(rest).toHaveLength(0);
    expect(blocker.field).toBe('tags');

    await expect(publishCreatorMeal(unreachableDb, creator, eight as never))
      .rejects.toThrow(blocker.message);
  });

  it('counts the tags the way the publish counts them', async () => {
    // Canonicalised first, at both ends. Eight strings that fold to three is a
    // draft that publishes, and a preview counting raw strings would refuse it.
    const dupes = draft({ tags: ['Mexican', 'mexican', 'MEXICAN', 'No Cook', 'no cook', 'Appetizer'] });
    expect(publishBlockers(dupes as never)).toHaveLength(0);
  });

  it('says the same thing about a Serves that is not a head count', async () => {
    // The guacamole page's only yield is "2 1/2 cups guacamole" — a volume.
    const volume = draft({ serves: '2 1/2 cups' });

    const [blocker] = publishBlockers(volume as never);
    expect(blocker.field).toBe('serves');

    await expect(publishCreatorMeal(unreachableDb, creator, volume as never))
      .rejects.toThrow(blocker.message);
  });

  it('says the same thing as the editor about a missing name', () => {
    // Not reachable through `publishCreatorMeal` — the insert would take an
    // empty name — but `editableDraft` refuses it and a nameless meal on
    // Discover is not something to allow on that technicality.
    const [blocker] = publishBlockers(draft({ name: '  ' }) as never);
    expect(blocker.field).toBe('name');

    const refused = editableDraft(draft({ name: '  ' }));
    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.error).toBe(blocker.message);
  });

  it('says the same thing as the editor about a recipe with nothing in it', () => {
    const [blocker] = publishBlockers(draft({ ingredients: [] }) as never);
    expect(blocker.field).toBe('ingredients');

    const refused = editableDraft(draft({ ingredients: [] }));
    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.error).toBe(blocker.message);
  });

  it('has nothing to say about a draft that publishes', () => {
    expect(publishBlockers(draft() as never)).toEqual([]);
    // And nothing to say about the fields it does not police: a missing photo,
    // story or difficulty is a thinner meal, not an unpublishable one.
    expect(publishBlockers(draft({ photoUrl: null, story: null, difficulty: null, serves: '' }) as never)).toEqual([]);
  });

  it('reads down the card, so a list of blockers reads in the card’s order', () => {
    const broken = draft({ name: '', tags: ['Mexican', 'Vegan', 'Healthy', 'Dinner'], serves: 'a lot', ingredients: [] });
    expect(publishBlockers(broken as never).map((blocker) => blocker.field))
      .toEqual(['name', 'tags', 'serves', 'ingredients']);
  });
});
