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
});
