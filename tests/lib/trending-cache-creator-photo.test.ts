// The creator's face has to reach the card, and the two feeds get it from two
// different places.
//
// Trending comes from an RPC whose signature has no photo column in it, so the
// photo is joined on afterwards from `creators`. New and Following come from a
// select that already embeds the creator, so the photo rides along on the embed.
// Two paths, one field name: if they ever disagree, half the feeds lose the face
// and nothing errors, so both are asserted here by name.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeDb } from '../helpers/supabase-mock';

vi.mock('@/lib/supabase', async () =>
  (await import('../helpers/supabase-mock')).mockSupabaseModule());

// The cache wrapper is not what is under test; unwrap it so the reader runs.
vi.mock('next/cache', () => ({
  unstable_cache: (fn: (...a: unknown[]) => unknown) => fn,
  revalidateTag: vi.fn(),
}));

import { getCachedTrendingMeals, getCachedAllPresetMeals } from '@/lib/trending-cache';

beforeEach(() => {
  fakeDb.reset();
  fakeDb.seed('creators', [
    { id: 'c-sarah', photo_url: 'https://img/sarah.jpg' },
    { id: 'c-priya', photo_url: null },
  ]);
});

describe('trending feed', () => {
  beforeEach(() => {
    fakeDb.seed('rpc:get_preset_meals_with_trending', [
      { id: 'm1', name: 'Shrimp', creator_id: 'c-sarah', creator_name: 'Sarah' },
      { id: 'm2', name: 'Dal',    creator_id: 'c-priya', creator_name: 'Priya' },
      { id: 'm3', name: 'Toast',  creator_id: null,      author: 'A cookbook' },
    ]);
  });

  it('attaches each creator photo to their meals', async () => {
    const meals = await getCachedTrendingMeals();
    expect(meals.find((m) => m.id === 'm1')?.creator_photo).toBe('https://img/sarah.jpg');
  });

  it('leaves a creator who has not uploaded one as null, not undefined', async () => {
    const meals = await getCachedTrendingMeals();
    const dal = meals.find((m) => m.id === 'm2')!;
    expect('creator_photo' in dal).toBe(true);
    expect(dal.creator_photo).toBeNull();
  });

  it('leaves an author-only meal with no face', async () => {
    const meals = await getCachedTrendingMeals();
    expect(meals.find((m) => m.id === 'm3')?.creator_photo).toBeNull();
  });

  it('reads creators once for the whole feed, not once per meal', async () => {
    await getCachedTrendingMeals();
    // One `.range()` is one round trip; the builder records its other links too.
    const pages = fakeDb.calls.filter((c) => c.table === 'creators' && c.method === 'range');
    expect(pages.length).toBe(1);
  });

  it('does not read creators at all when no meal has one', async () => {
    fakeDb.seed('rpc:get_preset_meals_with_trending', [
      { id: 'm3', name: 'Toast', creator_id: null, author: 'A cookbook' },
    ]);
    await getCachedTrendingMeals();
    expect(fakeDb.calls.filter((c) => c.table === 'creators').length).toBe(0);
  });
});

describe('new / following feed', () => {
  it('carries the photo off the embedded creator', async () => {
    fakeDb.seed('preset_meals', [
      {
        id: 'm1',
        name: 'Shrimp',
        creator_id: 'c-sarah',
        created_at: '2026-09-01',
        creators: { display_name: 'Sarah', social_handle: '@sarah', photo_url: 'https://img/sarah.jpg' },
      },
      {
        id: 'm2',
        name: 'Dal',
        creator_id: 'c-priya',
        created_at: '2026-08-01',
        creators: { display_name: 'Priya', social_handle: '@priya' },
      },
    ]);
    const meals = await getCachedAllPresetMeals();
    expect(meals.find((m) => m.id === 'm1')?.creator_photo).toBe('https://img/sarah.jpg');
    expect(meals.find((m) => m.id === 'm2')?.creator_photo).toBeNull();
  });
});
