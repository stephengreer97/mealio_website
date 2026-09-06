// GET /api/preset-meals. The endpoint behind Discover, which had no test.
//
// THE BUG THIS EXISTS FOR, stated plainly: filtering ran in the browser and the
// phone, over the meals already loaded, 20 at a time. So "vegetarian" meant
// "vegetarian among the 20 we happen to be holding", and scrolling revealed
// more. The server decided which rows existed and the client decided which of
// those to show, which is filtering and pagination on opposite sides of the
// network.
//
// Every test below is really one assertion in different clothes: A MATCH ON
// PAGE 5 MUST APPEAR ON PAGE 1 OF A FILTERED REQUEST.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeDb } from '../helpers/supabase-mock';
import { jsonRequest } from '../helpers/request';

vi.mock('@/lib/supabase', async () =>
  (await import('../helpers/supabase-mock')).mockSupabaseModule());
vi.mock('@/lib/logger', () => ({ log: vi.fn() }));

// The two cached readers are the seam. Mocking them keeps this test about the
// route's filter-then-paginate contract rather than about `unstable_cache`.
const trending = vi.fn();
const allMeals = vi.fn();
vi.mock('@/lib/trending-cache', () => ({
  getCachedTrendingMeals: () => trending(),
  getCachedAllPresetMeals: () => allMeals(),
}));

import { GET } from '@/app/api/preset-meals/route';
import { clearRevocationCache, createAccessToken } from '@/lib/tokens';

/** 100 meals. Exactly one is vegetarian, and it is deliberately last. */
function catalogue() {
  return Array.from({ length: 100 }, (_, i) => ({
    id: `m${i}`,
    name: i === 99 ? 'Lentil dal' : `Chicken dish ${i}`,
    author: i === 99 ? 'Priya' : 'Sarah Lane',
    creator_name: i === 99 ? 'Priya' : 'Sarah Lane',
    creator_id: i === 99 ? 'c-priya' : 'c-sarah',
    source: 'example.com',
    difficulty: i === 99 ? 1 : 3,
    tags: i === 99 ? ['vegetarian'] : ['chicken'],
    ingredients: i === 99
      ? [{ ingredientName: 'Lentils' }, { ingredientName: 'Onion' }]
      : [{ ingredientName: 'Chicken' }, { ingredientName: 'Butter' }],
  }));
}

const call = (qs: string, token?: string) =>
  GET(jsonRequest(`/api/preset-meals${qs}`, { method: 'GET', ...(token ? { token } : {}) }) as never);

beforeEach(() => {
  fakeDb.reset();
  clearRevocationCache();
  trending.mockResolvedValue(catalogue());
  allMeals.mockResolvedValue(catalogue());
});

describe('trending: the filter sees every meal, not just the first page', () => {
  it('finds the one vegetarian meal, which is the 100th row', async () => {
    // Unfiltered, it is nowhere near page one.
    const unfiltered = await (await call('?limit=20&offset=0')).json();
    expect(unfiltered.presetMeals.map((m: { id: string }) => m.id)).not.toContain('m99');

    // Filtered, it IS page one. This is the whole ticket.
    const res = await call('?limit=20&offset=0&tags=vegetarian');
    const body = await res.json();
    expect(body.presetMeals).toHaveLength(1);
    expect(body.presetMeals[0].id).toBe('m99');
  });

  it('says hasMore FALSE once the filter has narrowed it, not "there are 100 rows"', async () => {
    // hasMore computed before filtering is how an empty page 2 appears under a
    // spinner that never resolves.
    const body = await (await call('?limit=20&offset=0&tags=vegetarian')).json();
    expect(body.hasMore).toBe(false);
    expect(body.matched).toBe(1);
  });

  it('still pages correctly when nothing is filtered', async () => {
    const first = await (await call('?limit=20&offset=0')).json();
    const second = await (await call('?limit=20&offset=20')).json();
    expect(first.presetMeals).toHaveLength(20);
    expect(second.presetMeals).toHaveLength(20);
    expect(first.presetMeals[0].id).not.toBe(second.presetMeals[0].id);
    expect(first.hasMore).toBe(true);
    expect(first.matched).toBe(100);
  });
});

describe('every filter reaches the server, not only tags', () => {
  it('difficulty', async () => {
    const body = await (await call('?difficulty=1')).json();
    expect(body.matched).toBe(1);
    expect(body.presetMeals[0].id).toBe('m99');
  });

  it('author', async () => {
    const body = await (await call('?authors=priya')).json();
    expect(body.matched).toBe(1);
  });

  it('ingredients, ALL-of', async () => {
    expect((await (await call('?ingredients=lentils')).json()).matched).toBe(1);
    // Nothing has both, so all-of must return nothing.
    expect((await (await call('?ingredients=lentils,chicken')).json()).matched).toBe(0);
  });

  it('excluded ingredients', async () => {
    // 99 chicken dishes carry butter; the dal does not.
    const body = await (await call('?excludeIngredients=butter')).json();
    expect(body.matched).toBe(1);
    expect(body.presetMeals[0].id).toBe('m99');
  });

  it('the search box', async () => {
    expect((await (await call('?q=lentil')).json()).matched).toBe(1);
  });

  it('combines them, narrowing rather than widening', async () => {
    expect((await (await call('?tags=vegetarian&difficulty=1')).json()).matched).toBe(1);
    expect((await (await call('?tags=vegetarian&difficulty=3')).json()).matched).toBe(0);
  });
});

describe('the New feed filters across everything too', () => {
  it('finds the 100th meal on page one', async () => {
    const body = await (await call('?sort=new&limit=20&tags=vegetarian')).json();
    expect(body.presetMeals).toHaveLength(1);
    expect(body.presetMeals[0].id).toBe('m99');
    expect(allMeals).toHaveBeenCalled();
  });
});

describe('the Following feed', () => {
  let token: string;
  beforeEach(async () => { token = await createAccessToken('u1', 'u@b.co'); });

  it('refuses a guest', async () => {
    expect((await call('?followed=true')).status).toBe(401);
  });

  it('scopes to followed creators AND filters across all of their meals', async () => {
    fakeDb.seed('creator_follows', [{ user_id: 'u1', creator_id: 'c-priya' }]);
    const body = await (await call('?followed=true&tags=vegetarian', token)).json();
    expect(body.matched).toBe(1);
    expect(body.presetMeals[0].id).toBe('m99');
  });

  it('answers an empty feed when the user follows nobody', async () => {
    fakeDb.seed('creator_follows', []);
    const body = await (await call('?followed=true', token)).json();
    expect(body.presetMeals).toEqual([]);
    expect(body.hasMore).toBe(false);
  });

  it('does not put the followed ids in a query string, whatever the count', async () => {
    // The old query built `creator_id=in.(…)`, which is 15 + 37n bytes. At 222
    // follows that is an 8 KB URI, PostgREST answers 414, supabase-js hands
    // back `data: null`, and the feed renders empty with nothing to explain it
    // (MEAL-112 class). Scoping in memory has no URI to overflow.
    const many = Array.from({ length: 400 }, (_, i) => ({
      user_id: 'u1', creator_id: i === 0 ? 'c-priya' : `c-${i}`,
    }));
    fakeDb.seed('creator_follows', many);
    const body = await (await call('?followed=true&tags=vegetarian', token)).json();
    expect(body.matched).toBe(1);
  });
});

describe('when the catalogue cannot be read', () => {
  it('answers 500 rather than an empty feed that looks like no meals exist', async () => {
    trending.mockRejectedValue(new Error('rpc exploded'));
    const res = await call('');
    expect(res.status).toBe(500);
  });
});
