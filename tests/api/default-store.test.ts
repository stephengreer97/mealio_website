import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeDb } from '../helpers/supabase-mock';
import { jsonRequest } from '../helpers/request';

vi.mock('@/lib/supabase', async () =>
  (await import('../helpers/supabase-mock')).mockSupabaseModule());
vi.mock('@/lib/logger', () => ({ log: vi.fn() }));
vi.mock('@/lib/photos', () => ({ resolvePhotoUrl: vi.fn(async (url: string | undefined) => url ?? null) }));

import { GET, POST } from '@/app/api/meals/route';
import { PUT } from '@/app/api/meals/[id]/route';
import { PATCH as SWITCH } from '@/app/api/account/default-store/route';
import { POST as SAVE_SHARED } from '@/app/api/shared/[token]/save/route';
import { createAccessToken } from '@/lib/tokens';

/**
 * One store per account. Every meal is saved at the default; product choices
 * are kept per store, so a switch leaves the new store productless and a switch
 * back restores what was there. Old app versions still send a store per meal,
 * and their choices are filed under it.
 */

let token: string;

const profile = (fields: Record<string, unknown>) =>
  fakeDb.seed('user_profiles', [{ id: 'user-1', subscription_tier: 'full', tokens_invalidated_at: null, ...fields }]);

const milk = {
  ingredientName: 'milk',
  qty: 1,
  unit: 'qty',
  searchTerm: 'H-E-B Whole Milk',
  storeSearchTerms: { heb: 'H-E-B Whole Milk' },
  storeProducts: { heb: { upc: 'h-1', name: 'H-E-B Whole Milk' } },
};

beforeEach(async () => {
  fakeDb.reset();
  token = await createAccessToken('user-1', 'a@b.test');
});

describe('GET /api/meals', () => {
  it('returns the default store with the meals', async () => {
    profile({ default_store_id: 'heb' });
    fakeDb.seed('meals', [{ id: 'm1', user_id: 'user-1', is_active: true, store_id: 'heb', ingredients: [] }]);

    const body = await (await GET(jsonRequest('/api/meals', { method: 'GET', token }))).json();

    expect(body.defaultStoreId).toBe('heb');
    expect(body.meals).toHaveLength(1);
  });

  it('is null for an account that has no default yet', async () => {
    profile({ default_store_id: null });
    fakeDb.seed('meals', []);
    expect((await (await GET(jsonRequest('/api/meals', { method: 'GET', token }))).json()).defaultStoreId).toBeNull();
  });
});

describe('POST /api/meals', () => {
  it('saves at the default store when no store is sent', async () => {
    profile({ default_store_id: 'kroger' });
    fakeDb.seed('meals', []);

    const res = await POST(jsonRequest('/api/meals', { token, body: { name: 'Tacos', ingredients: [{ ingredientName: 'tortillas', qty: 1 }] } }));

    expect(res.status).toBe(201);
    expect(fakeDb.rows('meals')[0].store_id).toBe('kroger');
  });

  it('files an old app’s choice under the store it picked, and saves the meal at the default', async () => {
    profile({ default_store_id: 'kroger' });
    fakeDb.seed('meals', []);

    await POST(jsonRequest('/api/meals', {
      token,
      body: { name: 'Cereal', storeId: 'heb', ingredients: [{ ingredientName: 'milk', qty: 1, searchTerm: 'H-E-B Whole Milk' }] },
    }));

    const row = fakeDb.rows('meals')[0];
    expect(row.store_id).toBe('kroger');
    expect(row.ingredients[0].storeSearchTerms).toEqual({ heb: 'H-E-B Whole Milk' });
    expect(row.ingredients[0].searchTerm).toBeUndefined();
  });

  it('adopts the sent store as the default for an account with none and no meals', async () => {
    profile({ default_store_id: null });
    fakeDb.seed('meals', []);

    await POST(jsonRequest('/api/meals', { token, body: { name: 'Tacos', storeId: 'aldi', ingredients: [] } }));

    expect(fakeDb.rows('user_profiles')[0].default_store_id).toBe('aldi');
    expect(fakeDb.rows('meals')[0].store_id).toBe('aldi');
  });

  it('adopts the store with most meals for an account the backfill has not reached, and moves the rest', async () => {
    profile({ default_store_id: null });
    fakeDb.seed('meals', [
      { id: 'a', user_id: 'user-1', store_id: 'heb', ingredients: [milk], is_active: true },
      { id: 'b', user_id: 'user-1', store_id: 'heb', ingredients: [], is_active: true },
      { id: 'c', user_id: 'user-1', store_id: 'kroger', ingredients: [], is_active: true },
    ]);

    await POST(jsonRequest('/api/meals', { token, body: { name: 'New', storeId: 'kroger', ingredients: [] } }));

    expect(fakeDb.rows('user_profiles')[0].default_store_id).toBe('heb');
    expect(fakeDb.rows('meals').every((m) => m.store_id === 'heb')).toBe(true);
  });

  it('asks for a store when there is nothing to go on', async () => {
    profile({ default_store_id: null });
    fakeDb.seed('meals', []);

    const res = await POST(jsonRequest('/api/meals', { token, body: { name: 'Tacos', ingredients: [] } }));

    expect(res.status).toBe(400);
    expect((await res.json()).status).toBe('store-required');
  });
});

describe('PUT /api/meals/[id]', () => {
  const params = Promise.resolve({ id: 'm1' });

  it('keeps other stores’ choices when an old app rewrites the ingredient list', async () => {
    profile({ default_store_id: 'kroger' });
    fakeDb.seed('meals', [{
      id: 'm1', user_id: 'user-1', store_id: 'kroger', tags: [],
      ingredients: [{ ...milk, searchTerm: 'Kroger Milk', storeSearchTerms: { heb: 'H-E-B Whole Milk', kroger: 'Kroger Milk' } }],
    }]);

    // An old app re-chose at Kroger and sent the row without the fields it does not know.
    const res = await PUT(
      jsonRequest('/api/meals/m1', { method: 'PUT', token, body: { ingredients: [{ ingredientName: 'milk', qty: 1, unit: 'qty', searchTerm: 'Kroger 2% Milk' }] } }),
      { params },
    );

    expect(res.status).toBe(200);
    const [row] = fakeDb.rows('meals')[0].ingredients;
    expect(row.searchTerm).toBe('Kroger 2% Milk');
    expect(row.storeSearchTerms).toEqual({ heb: 'H-E-B Whole Milk', kroger: 'Kroger 2% Milk' });
    expect(row.storeProducts).toEqual({ heb: { upc: 'h-1', name: 'H-E-B Whole Milk' } });
  });

  it('keeps the meal at the default when an old app moves just this meal', async () => {
    profile({ default_store_id: 'kroger' });
    fakeDb.seed('meals', [{ id: 'm1', user_id: 'user-1', store_id: 'kroger', tags: [], ingredients: [] }]);

    await PUT(jsonRequest('/api/meals/m1', { method: 'PUT', token, body: { storeId: 'heb' } }), { params });

    expect(fakeDb.rows('meals')[0].store_id).toBe('kroger');
  });
});

describe('PATCH /api/account/default-store', () => {
  it('moves every meal, leaving the new store productless and the old store’s choices saved', async () => {
    profile({ default_store_id: 'heb' });
    fakeDb.seed('meals', [
      { id: 'a', user_id: 'user-1', store_id: 'heb', ingredients: [milk], is_active: true },
      { id: 'b', user_id: 'user-1', store_id: 'heb', ingredients: [], is_active: false },
    ]);

    const res = await SWITCH(jsonRequest('/api/account/default-store', { method: 'PATCH', token, body: { storeId: 'kroger' } }));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ defaultStoreId: 'kroger' });
    expect(fakeDb.rows('user_profiles')[0].default_store_id).toBe('kroger');
    // Deleted meals move too, so a restore lands at the same store as the rest.
    expect(fakeDb.rows('meals').map((m) => m.store_id)).toEqual(['kroger', 'kroger']);
    const [row] = fakeDb.rows('meals')[0].ingredients;
    expect(row.searchTerm).toBeUndefined();
    expect(row.storeSearchTerms).toEqual({ heb: 'H-E-B Whole Milk' });
    expect(row.storeProducts.heb.upc).toBe('h-1');
  });

  it('brings the choices back on switching back', async () => {
    profile({ default_store_id: 'heb' });
    fakeDb.seed('meals', [{ id: 'a', user_id: 'user-1', store_id: 'heb', ingredients: [milk], is_active: true }]);

    await SWITCH(jsonRequest('/api/account/default-store', { method: 'PATCH', token, body: { storeId: 'kroger' } }));
    await SWITCH(jsonRequest('/api/account/default-store', { method: 'PATCH', token, body: { storeId: 'heb' } }));

    const [row] = fakeDb.rows('meals')[0].ingredients;
    expect(row.searchTerm).toBe('H-E-B Whole Milk');
    expect(fakeDb.rows('meals')[0].store_id).toBe('heb');
  });

  it('refuses a store Mealio does not support, and moves nothing', async () => {
    profile({ default_store_id: 'heb' });
    fakeDb.seed('meals', [{ id: 'a', user_id: 'user-1', store_id: 'heb', ingredients: [milk], is_active: true }]);

    const res = await SWITCH(jsonRequest('/api/account/default-store', { method: 'PATCH', token, body: { storeId: 'amazon' } }));

    expect(res.status).toBe(400);
    expect(fakeDb.rows('meals')[0].store_id).toBe('heb');
  });

  it('401 without a token', async () => {
    const res = await SWITCH(jsonRequest('/api/account/default-store', { method: 'PATCH', body: { storeId: 'heb' } }));
    expect(res.status).toBe(401);
  });
});

describe('POST /api/shared/[token]/save', () => {
  const params = Promise.resolve({ token: 'share-1' });
  const sharedRow = (store: string) => ({
    id: 'origin', user_id: 'sharer', share_token: 'share-1', is_active: true, store_id: store, name: 'Cereal', tags: [],
    ingredients: [{ ingredientName: 'milk', qty: 1, unit: 'qty', searchTerm: 'H-E-B Whole Milk', storeProducts: { heb: { upc: 'h-1', name: 'x' } } }],
  });

  it('saves at the saver’s default, with no store sent', async () => {
    profile({ default_store_id: 'heb' });
    fakeDb.seed('meals', [sharedRow('heb')]);

    const res = await SAVE_SHARED(jsonRequest('/api/shared/share-1/save', { token, body: {} }), { params });

    expect(res.status).toBeLessThan(300);
    const copy = fakeDb.rows('meals').find((m) => m.user_id === 'user-1')!;
    expect(copy.store_id).toBe('heb');
    // Same store as the sharer: their product name comes along. Their product id never does.
    expect(copy.ingredients[0].searchTerm).toBe('H-E-B Whole Milk');
    expect(copy.ingredients[0].storeProducts).toBeUndefined();
  });

  it('is productless at a different store, keeping the sharer’s name under theirs', async () => {
    profile({ default_store_id: 'kroger' });
    fakeDb.seed('meals', [sharedRow('heb')]);

    await SAVE_SHARED(jsonRequest('/api/shared/share-1/save', { token, body: {} }), { params });

    const copy = fakeDb.rows('meals').find((m) => m.user_id === 'user-1')!;
    expect(copy.store_id).toBe('kroger');
    expect(copy.ingredients[0].searchTerm).toBeUndefined();
    expect(copy.ingredients[0].storeSearchTerms).toEqual({ heb: 'H-E-B Whole Milk' });
  });
});
