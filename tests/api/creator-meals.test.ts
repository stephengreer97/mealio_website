import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { fakeDb } from '../helpers/supabase-mock';
import { jsonRequest } from '../helpers/request';

vi.mock('@/lib/supabase', async () =>
  (await import('../helpers/supabase-mock')).mockSupabaseModule());
vi.mock('@/lib/logger', () => ({ log: vi.fn() }));
vi.mock('@/lib/photos', () => ({
  resolvePhotoUrl: vi.fn(async (url: string | undefined) => url ?? null),
}));

const revalidateTag = vi.fn();
vi.mock('next/cache', () => ({ revalidateTag: (...args: unknown[]) => revalidateTag(...args) }));

import { POST } from '@/app/api/creator/meals/route';
import { PUT } from '@/app/api/creator/meals/[id]/route';
import { publishCreatorMeal } from '@/lib/creator-meals';
import { createAccessToken } from '@/lib/tokens';

/**
 * What a creator meal is allowed to be, at the route that publishes it.
 *
 * This endpoint used to enforce neither of the two rules every other writer of
 * `preset_meals` applies. The consequences were invisible rather than loud:
 * `MealCard` renders `tags.slice(0, 3)`, so a fourth tag never appeared on the
 * card and still matched a Discover filter — a meal turning up under "Vegan"
 * with nothing on it saying why. And a `serves` of "2 1/2 cups" is a *volume*
 * printed on the card as a head count.
 *
 * So the assertions here are about the **stored row**, not the call: a 400 that
 * arrives after the insert would be a worse bug than no 400 at all.
 */

const CREATOR = { id: 'c1', display_name: 'Chef Sarah', user_id: 'user-1' };

const MEAL = {
  name: 'Guacamole',
  ingredients: [
    { ingredientName: 'avocados', qty: 4, productQty: 4, unit: 'qty', measure: null, searchTerm: null },
  ],
};

let token: string;

/** The creator lookup both routes start with, plus a real `preset_meals` table. */
function asCreator() {
  fakeDb.seed('creators', [CREATOR]);
  fakeDb.seed('preset_meals', []);
}

beforeEach(async () => {
  fakeDb.reset();
  revalidateTag.mockReset();
  token = await createAccessToken('user-1', 'sarah@chefsarah.test');
});

function post(body: Record<string, unknown>) {
  return POST(jsonRequest('/api/creator/meals', { token, body }));
}

// ── The tag cap ──────────────────────────────────────────────────────────────

describe('POST /api/creator/meals — the tag cap', () => {
  it('publishes a meal at the cap', async () => {
    asCreator();

    const res = await post({ ...MEAL, tags: ['Mexican', 'No Cook', 'Vegan'] });

    expect(res.status).toBe(201);
    expect(fakeDb.rows('preset_meals')).toHaveLength(1);
    expect(fakeDb.rows('preset_meals')[0].tags).toEqual(['Mexican', 'No Cook', 'Vegan']);
  });

  it('refuses a fourth tag, and writes nothing at all', async () => {
    asCreator();

    const res = await post({ ...MEAL, tags: ['Mexican', 'No Cook', 'Vegan', 'Healthy'] });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('That is 4 tags. A meal takes at most 3.');
    // The refusal is the whole point only if the row never lands. A truncating
    // route would have published three of the four and said nothing.
    expect(fakeDb.rows('preset_meals')).toEqual([]);
    expect(revalidateTag).not.toHaveBeenCalled();
  });

  it('is happy with no tags at all', async () => {
    asCreator();
    const res = await post(MEAL);
    expect(res.status).toBe(201);
    expect(fakeDb.rows('preset_meals')).toHaveLength(1);
  });
});

// ── The vocabulary, on the route that reaches Discover ───────────────────────

describe('POST /api/creator/meals — the cap counts tags, not strings', () => {
  /**
   * The count guard inherited an unchecked field. Three arbitrary strings are
   * three tags by `length` and zero tags by every other measure: they match no
   * Discover filter and read as typos on the card. Three copies of 'Vegan' are
   * one tag rendered three times, and passed a count of three.
   *
   * Canonicalise-then-count is the order the draft PATCH already used, so this
   * makes the two publish paths agree rather than inventing a third rule.
   */
  it('drops a tag no filter could ever match', async () => {
    asCreator();

    const res = await post({ ...MEAL, tags: ['aaa', 'bbb', 'Vegan'] });

    expect(res.status).toBe(201);
    expect(fakeDb.rows('preset_meals')[0].tags).toEqual(['Vegan']);
  });

  it('collapses duplicates instead of rendering the same chip three times', async () => {
    asCreator();

    const res = await post({ ...MEAL, tags: ['Vegan', 'vegan', 'VEGAN'] });

    expect(res.status).toBe(201);
    expect(fakeDb.rows('preset_meals')[0].tags).toEqual(['Vegan']);
  });

  it('still refuses four real tags — deduplicating is not a way past the cap', async () => {
    asCreator();

    const res = await post({ ...MEAL, tags: ['Mexican', 'No Cook', 'Vegan', 'Healthy', 'aaa'] });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('That is 4 tags. A meal takes at most 3.');
    expect(fakeDb.rows('preset_meals')).toEqual([]);
  });
});

// ── Serves ───────────────────────────────────────────────────────────────────

describe('POST /api/creator/meals — serves is a head count', () => {
  it('takes a count and a range', async () => {
    asCreator();
    expect((await post({ ...MEAL, serves: '4' })).status).toBe(201);
    expect((await post({ ...MEAL, serves: '2-4' })).status).toBe(201);
    expect(fakeDb.rows('preset_meals').map((row) => row.serves)).toEqual(['4', '2-4']);
  });

  it('refuses a yield dressed up as a serving count', async () => {
    asCreator();

    const res = await post({ ...MEAL, serves: '2 1/2 cups' });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/number or a range/i);
    expect(fakeDb.rows('preset_meals')).toEqual([]);
  });

  it('treats an empty serves as no serves rather than a malformed one', async () => {
    asCreator();
    const res = await post({ ...MEAL, serves: '  ' });
    expect(res.status).toBe(201);
    expect(fakeDb.rows('preset_meals')[0].serves).toBeNull();
  });
});

// ── The edit route, which the same form posts to ─────────────────────────────

describe('PUT /api/creator/meals/:id — the same two rules', () => {
  const params = Promise.resolve({ id: 'm1' });

  function seedPublished() {
    fakeDb.seed('creators', [CREATOR]);
    fakeDb.seed('preset_meals', [
      { id: 'm1', creator_id: 'c1', name: 'Guacamole', tags: ['Mexican'], serves: '4' },
    ]);
  }

  function put(body: Record<string, unknown>) {
    return PUT(jsonRequest('/api/creator/meals/m1', { method: 'PUT', token, body }), { params });
  }

  it('refuses an edit that pushes a published meal over the cap', async () => {
    seedPublished();

    const res = await put({ tags: ['Mexican', 'No Cook', 'Vegan', 'Healthy'] });

    expect(res.status).toBe(400);
    // Save Meal on the mobile portal is a create or an update depending only on
    // which button opened the form; a cap on one of them is no cap.
    expect(fakeDb.row('preset_meals', 'm1')!.tags).toEqual(['Mexican']);
  });

  it('refuses an edit whose serves is a volume', async () => {
    seedPublished();

    const res = await put({ serves: '2 1/2 cups' });

    expect(res.status).toBe(400);
    expect(fakeDb.row('preset_meals', 'm1')!.serves).toBe('4');
  });

  it('still saves a well-formed edit', async () => {
    seedPublished();

    const res = await put({ tags: ['Mexican', 'Vegan'], serves: '6' });

    expect(res.status).toBe(200);
    expect(fakeDb.row('preset_meals', 'm1')).toMatchObject({ tags: ['Mexican', 'Vegan'], serves: '6' });
  });

  // ── Meals that predate the rules ───────────────────────────────────────────

  /**
   * Sixteen published meals carry more than three tags. Every one of them was
   * legal when it was written, and both editors post `tags` and `serves` on
   * every save whether or not the creator opened either field — so a cap on
   * "what arrived" is a cap on *editing those meals at all*. The creator opens
   * one to fix a typo in the name, presses Save, and gets a 400 about tags.
   *
   * The fix is grandfathering, not a migration: an unchanged value saves, and
   * any change to it must land inside the rule.
   */
  const LEGACY = ['Mexican', 'No Cook', 'Vegan', 'Healthy', 'Snack'];

  function seedLegacy() {
    fakeDb.seed('creators', [CREATOR]);
    fakeDb.seed('preset_meals', [
      { id: 'm1', creator_id: 'c1', name: 'Guacamol', tags: LEGACY, serves: '2 1/2 cups' },
    ]);
  }

  it('saves a name-only edit to a meal that predates both rules', async () => {
    seedLegacy();

    // Exactly what `EditPresetMealModal` posts: the whole form, every save.
    const res = await put({ name: 'Guacamole', tags: LEGACY, serves: '2 1/2 cups' });

    expect(res.status).toBe(200);
    const row = fakeDb.row('preset_meals', 'm1')!;
    expect(row.name).toBe('Guacamole');
    // Untouched, and not rewritten by a route that only meant to read them.
    expect(row.tags).toEqual(LEGACY);
    expect(row.serves).toBe('2 1/2 cups');
  });

  it('refuses a change to an over-cap list that is still over the cap', async () => {
    seedLegacy();

    const res = await put({ tags: ['Mexican', 'No Cook', 'Vegan', 'Healthy'] });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('That is 4 tags. A meal takes at most 3.');
    expect(fakeDb.row('preset_meals', 'm1')!.tags).toEqual(LEGACY);
  });

  it('lets the creator bring a legacy meal down to the cap', async () => {
    seedLegacy();

    const res = await put({ tags: ['Mexican', 'No Cook', 'Vegan'] });

    expect(res.status).toBe(200);
    expect(fakeDb.row('preset_meals', 'm1')!.tags).toEqual(['Mexican', 'No Cook', 'Vegan']);
  });

  it('refuses a legacy serves the creator is actually changing', async () => {
    seedLegacy();

    const res = await put({ serves: '3 loaves' });

    expect(res.status).toBe(400);
    expect(fakeDb.row('preset_meals', 'm1')!.serves).toBe('2 1/2 cups');
  });

  it('lets them replace a legacy serves with a head count', async () => {
    seedLegacy();

    const res = await put({ serves: '4' });

    expect(res.status).toBe(200);
    expect(fakeDb.row('preset_meals', 'm1')!.serves).toBe('4');
  });
});

// ── The shared insert ────────────────────────────────────────────────────────

describe('publishCreatorMeal — the last line before the row lands', () => {
  /**
   * Approve is the other caller, and it does not validate: it publishes a draft
   * row that an older build may have written, or that an import filled with up
   * to the eight tags the extraction prompt allows. Throwing is what
   * `approveDraft` already handles — it puts the draft back in the queue with
   * this sentence attached — so the operator can deselect and approve again.
   */
  it('refuses an over-cap draft rather than publishing three of six', async () => {
    fakeDb.seed('preset_meals', []);

    await expect(
      publishCreatorMeal(fakeDb as unknown as SupabaseClient, CREATOR, {
        ...MEAL,
        tags: ['Mexican', 'No Cook', 'Vegan', 'Healthy', 'Snack'],
      }),
    ).rejects.toThrow('That is 5 tags. A meal takes at most 3.');

    expect(fakeDb.rows('preset_meals')).toEqual([]);
  });

  it('refuses a serves the form would never have produced', async () => {
    fakeDb.seed('preset_meals', []);

    await expect(
      publishCreatorMeal(fakeDb as unknown as SupabaseClient, CREATOR, { ...MEAL, serves: '12 pancakes' }),
    ).rejects.toThrow(/number or a range/i);

    expect(fakeDb.rows('preset_meals')).toEqual([]);
  });

  /**
   * The vocabulary half of the same guard, asserted *here* rather than only on
   * the route.
   *
   * `POST /api/creator/meals` canonicalises before it calls this function, so a
   * test that goes in through the route cannot tell whether this function does
   * it too — and `approveDraft` is the other caller, which hands over whatever
   * the draft row holds. Today `extract.ts` canonicalises before a draft is
   * stored, so the two are in step; nothing was checking that they stay that
   * way. Removing the canonicalisation here left the whole suite green.
   */
  it('drops a tag no vocabulary knows, rather than putting it on Discover', async () => {
    fakeDb.seed('preset_meals', []);

    await publishCreatorMeal(fakeDb as unknown as SupabaseClient, CREATOR, {
      ...MEAL,
      tags: ['aaa', 'Mexican', 'bbb'],
    });

    // 'aaa' and 'bbb' match no Discover filter and read as typos on the card.
    expect(fakeDb.rows('preset_meals')[0].tags).toEqual(['Mexican']);
  });

  it('collapses duplicates before counting, so three chips are three tags', async () => {
    fakeDb.seed('preset_meals', []);

    await publishCreatorMeal(fakeDb as unknown as SupabaseClient, CREATOR, {
      ...MEAL,
      tags: ['Vegan', 'vegan', 'VEGAN'],
    });

    // Counted raw this passed the cap and rendered the same chip three times.
    expect(fakeDb.rows('preset_meals')[0].tags).toEqual(['Vegan']);
  });

  it('counts what survives canonicalising, not the strings it was handed', async () => {
    fakeDb.seed('preset_meals', []);

    // Five strings, three real tags: the cap is about what reaches Discover.
    await publishCreatorMeal(fakeDb as unknown as SupabaseClient, CREATOR, {
      ...MEAL,
      tags: ['Mexican', 'Artisanal', 'No Cook', 'Farm To Table', 'Vegan'],
    });

    expect(fakeDb.rows('preset_meals')[0].tags).toEqual(['Mexican', 'No Cook', 'Vegan']);
  });
});
