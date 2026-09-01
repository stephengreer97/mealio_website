import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeDb } from '../helpers/supabase-mock';
import { jsonRequest } from '../helpers/request';

vi.mock('@/lib/supabase', async () =>
  (await import('../helpers/supabase-mock')).mockSupabaseModule());
vi.mock('@/lib/logger', () => ({ log: vi.fn() }));

import { POST } from '@/app/api/shared/[token]/save/route';
import { createAccessToken } from '@/lib/tokens';

/**
 * Saving somebody else's shared meal, and the one place the tag cap **trims**.
 *
 * Every other writer refuses an over-cap list, because trimming throws away a
 * choice somebody made and says nothing about it. Here the choice was not made
 * by the person pressing the button: they tapped Save on a meal a friend wrote,
 * and a 400 would be a refusal they cannot act on — the tags are not theirs to
 * edit until the copy exists, and the card they are looking at never showed them
 * the fourth one anyway.
 *
 * So the copy keeps the first three, which is exactly what the card renders, and
 * from that moment the meal is inside the cap that `PUT /api/meals/:id` enforces
 * on every later edit.
 */

const params = Promise.resolve({ token: 'share-abc' });

let token: string;

function seedShared(tags: string[] | null) {
  fakeDb.seed('meals', [{
    id: 'origin',
    share_token: 'share-abc',
    name: 'Nine Tag Chili',
    ingredients: [{ ingredientName: 'beans', qty: 1, unit: 'qty', productName: 'Store brand beans' }],
    author: 'A Friend',
    difficulty: 2,
    serves: '4',
    website: null,
    recipe: 'Simmer.',
    photo_url: null,
    story: null,
    tags,
  }]);
  fakeDb.queue('user_profiles', { data: { subscription_tier: 'full' } });
}

/** The row this save created, which is never the shared one it copied. */
function saved() {
  return fakeDb.rows('meals').find((row) => row.user_id === 'user-2');
}

beforeEach(async () => {
  fakeDb.reset();
  token = await createAccessToken('user-2', 'saver@test.test');
});

function save() {
  return POST(jsonRequest('/api/shared/share-abc/save', { token, body: { storeId: 'heb' } }), { params });
}

describe('POST /api/shared/:token/save — the tag cap on a copy', () => {
  it('keeps the three the card showed rather than refusing the save', async () => {
    seedShared(['Mexican', 'No Cook', 'Vegan', 'Healthy', 'Snack']);

    const res = await save();

    expect(res.status).toBe(201);
    expect(saved()!.tags).toEqual(['Mexican', 'No Cook', 'Vegan']);
    // The meal they copied is untouched — trimming applies to the copy only.
    expect(fakeDb.row('meals', 'origin')!.tags).toHaveLength(5);
  });

  it('copies a list already inside the cap unchanged', async () => {
    seedShared(['Mexican', 'No Cook']);

    await save();

    expect(saved()!.tags).toEqual(['Mexican', 'No Cook']);
  });

  it('writes no tags column at all when the shared meal has none', async () => {
    seedShared(null);

    await save();

    expect(saved()!.tags).toBeUndefined();
  });

  it('still strips store-specific product data, which is the older rule here', async () => {
    seedShared(['Mexican']);

    await save();

    expect(saved()!.ingredients).toEqual([
      { ingredientName: 'beans', qty: 1, unit: 'qty' },
    ]);
  });

  it('does not hand the saver the sharer’s chosen product identifier (MEAL-19)', async () => {
    // The copy is an allow-list, so `storeProducts` is stripped by construction
    // rather than by a rule anyone wrote. Pinned here because of what would
    // happen if the list ever grew a spread: an inherited UPC resolves, comes
    // back `exact`, and the saver's first cart run adds the SHARER's chosen
    // product with no review screen — a product they never picked, from a
    // store that may not even be theirs.
    fakeDb.seed('meals', [{
      id: 'origin',
      share_token: 'share-abc',
      name: 'Chili',
      ingredients: [{
        ingredientName: 'beans',
        qty: 1,
        unit: 'qty',
        searchTerm: 'Kroger Black Beans, 15 oz',
        storeProducts: { kroger: { upc: '0001111041700', name: 'Kroger Black Beans, 15 oz' } },
      }],
      tags: [],
    }]);

    await save();

    const [row] = saved()!.ingredients as any[];
    expect('storeProducts' in row).toBe(false);
    expect(JSON.stringify(saved()!.ingredients)).not.toContain('storeProducts');
  });

  /**
   * MEAL-102 — the preparation comes with the meal.
   *
   * This route deliberately drops store-specific product data, and preparation
   * looks superficially like more of it. It is the opposite: it is the
   * creator's own cooking instruction, and it is on the card the saver was
   * looking at when they pressed Save. Dropping it would hand them a quieter
   * recipe than the one they chose.
   */
  it('carries a preparation onto the saved copy', async () => {
    fakeDb.seed('meals', [{
      id: 'origin',
      share_token: 'share-abc',
      name: 'Guacamole',
      ingredients: [
        { ingredientName: 'onion', qty: 1, unit: 'qty', measure: '1', prep: 'finely diced' },
        { ingredientName: 'salt', qty: 1, unit: 'qty' },
      ],
      author: 'A Friend', difficulty: 2, serves: '4', website: null,
      recipe: 'Mash.', photo_url: null, story: null, tags: [],
    }]);
    fakeDb.queue('user_profiles', { data: { subscription_tier: 'full' } });

    await save();

    expect(saved()!.ingredients).toEqual([
      { ingredientName: 'onion', qty: 1, unit: 'qty', measure: '1', prep: 'finely diced' },
      // And a row without one still copies without the key, so a saved meal is
      // shaped exactly like every meal saved before the field existed.
      { ingredientName: 'salt', qty: 1, unit: 'qty' },
    ]);
  });

  it('does not invent a searchTerm out of the preparation', async () => {
    // The saved copy is what the cart later reads. A prep that arrived as a
    // search term here would be a wrong term stored permanently.
    fakeDb.seed('meals', [{
      id: 'origin',
      share_token: 'share-abc',
      name: 'Guacamole',
      ingredients: [{ ingredientName: 'onion', qty: 1, unit: 'qty', prep: 'finely diced' }],
      author: 'A Friend', difficulty: 2, serves: '4', website: null,
      recipe: 'Mash.', photo_url: null, story: null, tags: [],
    }]);
    fakeDb.queue('user_profiles', { data: { subscription_tier: 'full' } });

    await save();

    const row = saved()!.ingredients[0];
    expect(row.searchTerm).toBeUndefined();
    expect(row.ingredientName).toBe('onion');
  });
});
