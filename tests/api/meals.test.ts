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
