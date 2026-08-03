import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeDb } from '../helpers/supabase-mock';
import { jsonRequest } from '../helpers/request';

// vi.mock is hoisted above imports, so the factory must import the helper
// dynamically rather than close over the static import.
vi.mock('@/lib/supabase', async () =>
  (await import('../helpers/supabase-mock')).mockSupabaseModule());
vi.mock('@/lib/logger', () => ({ log: vi.fn() }));
vi.mock('@/lib/photos', () => ({
  resolvePhotoUrl: vi.fn(async (url: string | undefined) => url ?? null),
}));

import { GET, POST } from '@/app/api/meals/route';
import { PUT } from '@/app/api/meals/[id]/route';
import { createAccessToken } from '@/lib/tokens';

const MEAL_BODY = {
  name: 'Tacos',
  storeId: 'heb',
  ingredients: [{ ingredientName: 'tortillas', qty: 1 }],
};

describe('/api/meals', () => {
  let token: string;

  beforeEach(async () => {
    fakeDb.reset();
    token = await createAccessToken('user-1', 'a@b.test');
  });

  it('GET 401 without a token', async () => {
    const res = await GET(jsonRequest('/api/meals', { method: 'GET' }));
    expect(res.status).toBe(401);
  });

  it('GET returns the user meal list', async () => {
    const meals = [{ id: 'm1', name: 'Tacos' }, { id: 'm2', name: 'Curry' }];
    fakeDb.queue('meals', { data: meals, error: null });

    const res = await GET(jsonRequest('/api/meals', { method: 'GET', token }));
    expect(res.status).toBe(200);
    expect((await res.json()).meals).toEqual(meals);
    // Must scope to the authenticated user, never trust client-provided ids.
    expect(fakeDb.calls).toContainEqual(
      expect.objectContaining({ table: 'meals', method: 'eq', args: ['user_id', 'user-1'] })
    );
  });

  it('POST 401 without a token', async () => {
    const res = await POST(jsonRequest('/api/meals', { body: MEAL_BODY }));
    expect(res.status).toBe(401);
  });

  it('POST 400 when required fields are missing', async () => {
    const res = await POST(jsonRequest('/api/meals', { token, body: { name: 'Tacos' } }));
    expect(res.status).toBe(400);
  });

  it('POST 403 with tierLimitReached when a free user already has 3 meals', async () => {
    fakeDb.queue('user_profiles', { data: { subscription_tier: 'free' } });
    fakeDb.queue('meals', { count: 3 });

    const res = await POST(jsonRequest('/api/meals', { token, body: MEAL_BODY }));
    expect(res.status).toBe(403);
    expect((await res.json()).tierLimitReached).toBe(true);
  });

  it('POST creates a meal for a free user under the limit', async () => {
    fakeDb.queue('user_profiles', { data: { subscription_tier: 'free' } });
    fakeDb.queue('meals', { count: 2 });
    fakeDb.queue('meals', { data: { id: 'm3', name: 'Tacos' }, error: null });

    const res = await POST(jsonRequest('/api/meals', { token, body: MEAL_BODY }));
    expect(res.status).toBe(201);
    expect((await res.json()).meal.id).toBe('m3');
  });

  it('POST skips the meal-count gate entirely for paid users', async () => {
    fakeDb.queue('user_profiles', { data: { subscription_tier: 'full' } });
    fakeDb.queue('meals', { data: { id: 'm4', name: 'Tacos' }, error: null });

    const res = await POST(jsonRequest('/api/meals', { token, body: MEAL_BODY }));
    expect(res.status).toBe(201);
    // One meals query (the insert), no count query.
    const headCounts = fakeDb.calls.filter(
      (c) => c.table === 'meals' && c.method === 'select' && c.args[1]?.head === true
    );
    expect(headCounts).toHaveLength(0);
  });

  it('POST 500 surfaces a database insert error', async () => {
    fakeDb.queue('user_profiles', { data: { subscription_tier: 'full' } });
    fakeDb.queue('meals', { data: null, error: { message: 'insert exploded' } });

    const res = await POST(jsonRequest('/api/meals', { token, body: MEAL_BODY }));
    expect(res.status).toBe(500);
  });
});

/**
 * The tag cap on personal meals.
 *
 * `meals` is a different table from `preset_meals` and the same bug: `my-meals`
 * renders `tags.slice(0, MAX_MEAL_TAGS)` on the card and filters against the
 * *whole* array, so a fourth tag is invisible on screen and still pulls the meal
 * up under a filter with nothing on it saying why — which is verbatim the harm
 * `lib/import/vocab.ts` cites as the reason the cap exists. Both mobile pickers
 * had no cap at all, so nine tags was a normal thing to arrive here.
 *
 * `serves` is deliberately not enforced on this table; the route says why.
 */
describe('/api/meals — the tag cap', () => {
  let token: string;

  /** A paid account, so the tier gate is not what any of these assert. */
  function asUser() {
    fakeDb.queue('user_profiles', { data: { subscription_tier: 'full' } });
    fakeDb.seed('meals', []);
  }

  beforeEach(async () => {
    fakeDb.reset();
    token = await createAccessToken('user-1', 'a@b.test');
  });

  it('POST creates a meal at the cap', async () => {
    asUser();

    const res = await POST(jsonRequest('/api/meals', {
      token,
      body: { ...MEAL_BODY, tags: ['Mexican', 'No Cook', 'Vegan'] },
    }));

    expect(res.status).toBe(201);
    expect(fakeDb.rows('meals')[0].tags).toEqual(['Mexican', 'No Cook', 'Vegan']);
  });

  it('POST refuses a fourth tag, and writes nothing at all', async () => {
    asUser();

    const res = await POST(jsonRequest('/api/meals', {
      token,
      body: { ...MEAL_BODY, tags: ['Mexican', 'No Cook', 'Vegan', 'Healthy'] },
    }));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('That is 4 tags. A meal takes at most 3.');
    expect(fakeDb.rows('meals')).toEqual([]);
  });

  it('POST keeps a custom tag — the cap is a count, not a vocabulary', async () => {
    // This picker offers "+ Add" for a tag no vocabulary knows, and these tags
    // are private to the one account that wrote them. Canonicalising here would
    // silently delete a tag the user typed on purpose.
    asUser();

    const res = await POST(jsonRequest('/api/meals', {
      token,
      body: { ...MEAL_BODY, tags: ["Grandma's", 'Tuesday'] },
    }));

    expect(res.status).toBe(201);
    expect(fakeDb.rows('meals')[0].tags).toEqual(["Grandma's", 'Tuesday']);
  });

  describe('PUT /api/meals/:id', () => {
    const params = Promise.resolve({ id: 'm1' });
    const LEGACY = ['Mexican', 'No Cook', 'Vegan', 'Healthy', 'Snack', 'Soup', 'Salad'];

    function seedLegacy() {
      fakeDb.seed('meals', [
        { id: 'm1', user_id: 'user-1', name: 'Tacos', tags: LEGACY, serves: '4' },
      ]);
    }

    function put(body: Record<string, unknown>) {
      return PUT(jsonRequest('/api/meals/m1', { method: 'PUT', token, body }), { params });
    }

    it('saves a name-only edit to a meal that predates the cap', async () => {
      // The edit modal posts every field on every save, so a check on "what
      // arrived" would make a seven-tag meal permanently uneditable.
      seedLegacy();

      const res = await put({ name: 'Tacos al pastor', tags: LEGACY });

      expect(res.status).toBe(200);
      const row = fakeDb.row('meals', 'm1')!;
      expect(row.name).toBe('Tacos al pastor');
      expect(row.tags).toEqual(LEGACY);
    });

    it('refuses a change that is still over the cap, and keeps the stored list', async () => {
      seedLegacy();

      const res = await put({ tags: ['Mexican', 'No Cook', 'Vegan', 'Healthy'] });

      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe('That is 4 tags. A meal takes at most 3.');
      expect(fakeDb.row('meals', 'm1')!.tags).toEqual(LEGACY);
    });

    it('lets the owner bring a legacy meal down to the cap', async () => {
      seedLegacy();

      const res = await put({ tags: ['Mexican', 'No Cook', 'Vegan'] });

      expect(res.status).toBe(200);
      expect(fakeDb.row('meals', 'm1')!.tags).toEqual(['Mexican', 'No Cook', 'Vegan']);
    });

    it('refuses a fourth tag on a meal that was inside the cap', async () => {
      fakeDb.seed('meals', [{ id: 'm1', user_id: 'user-1', name: 'Tacos', tags: ['Mexican'] }]);

      const res = await put({ tags: ['Mexican', 'No Cook', 'Vegan', 'Healthy'] });

      expect(res.status).toBe(400);
      expect(fakeDb.row('meals', 'm1')!.tags).toEqual(['Mexican']);
    });

    it('404s on somebody else\'s meal without saying whether it exists', async () => {
      fakeDb.seed('meals', [{ id: 'm1', user_id: 'someone-else', name: 'Tacos', tags: [] }]);

      const res = await put({ name: 'Mine now', tags: ['Mexican'] });

      expect(res.status).toBe(404);
      expect(fakeDb.row('meals', 'm1')!.name).toBe('Tacos');
    });
  });
});
