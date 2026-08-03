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
});
