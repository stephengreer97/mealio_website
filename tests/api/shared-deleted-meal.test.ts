import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { fakeDb } from '../helpers/supabase-mock';
import { jsonRequest } from '../helpers/request';

vi.mock('@/lib/supabase', async () =>
  (await import('../helpers/supabase-mock')).mockSupabaseModule());
vi.mock('@/lib/logger', () => ({ log: vi.fn() }));
vi.mock('@/lib/photos', () => ({
  resolvePhotoUrl: vi.fn(async (url: string | undefined) => url ?? null),
}));

import { GET as getShared } from '@/app/api/shared/[token]/route';
import { POST as saveShared } from '@/app/api/shared/[token]/save/route';
import { DELETE as deleteMeal } from '@/app/api/meals/[id]/route';
import { createAccessToken } from '@/lib/tokens';

/**
 * A deleted meal's share link kept working.
 *
 * Deleting is a soft delete (`is_active = false`), and neither shared route
 * looked at `is_active`, so the link still served the meal and still let
 * anyone save a copy. Both routes now filter on it, and a soft delete clears
 * `share_token` too, so the link is dead in two independent ways.
 */

const params = Promise.resolve({ token: 'share-abc' });

function seed(isActive: boolean) {
  fakeDb.seed('meals', [{
    id: 'm1', user_id: 'owner', share_token: 'share-abc', is_active: isActive,
    name: 'Chili', ingredients: [], tags: null, store_id: 'heb',
  }]);
  fakeDb.seed('user_profiles', [
    { id: 'owner', subscription_tier: 'paid', tokens_invalidated_at: null },
    { id: 'saver', subscription_tier: 'paid', tokens_invalidated_at: null },
  ]);
}

beforeEach(() => fakeDb.reset());

describe('a deleted meal is no longer shared', () => {
  it('GET serves a live shared meal', async () => {
    seed(true);
    const res = await getShared(new NextRequest('http://localhost/api/shared/share-abc'), { params });
    expect(res.status).toBe(200);
  });

  it('GET 404s once the meal is deleted', async () => {
    seed(false);
    const res = await getShared(new NextRequest('http://localhost/api/shared/share-abc'), { params });
    expect(res.status).toBe(404);
  });

  it('save 404s once the meal is deleted, and copies nothing', async () => {
    seed(false);
    const token = await createAccessToken('saver', 's@b.test');

    const res = await saveShared(
      jsonRequest('/api/shared/share-abc/save', { token, body: { storeId: 'heb' } }),
      { params },
    );

    expect(res.status).toBe(404);
    expect(fakeDb.rows('meals')).toHaveLength(1);
  });

  it('a soft delete clears the share token', async () => {
    seed(true);
    const token = await createAccessToken('owner', 'o@b.test');

    const res = await deleteMeal(
      jsonRequest('/api/meals/m1', { method: 'DELETE', token }),
      { params: Promise.resolve({ id: 'm1' }) },
    );

    expect(res.status).toBe(200);
    expect(fakeDb.row('meals', 'm1')).toMatchObject({ is_active: false, share_token: null });
  });
});
