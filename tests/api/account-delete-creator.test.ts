import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeDb, deleteUser } from '../helpers/supabase-mock';
import { fakeStorage, STORAGE_BASE_URL } from '../helpers/storage-mock';
import { jsonRequest } from '../helpers/request';

vi.mock('@/lib/supabase', async () =>
  (await import('../helpers/storage-mock')).mockSupabaseWithStorage());
vi.mock('@/lib/logger', () => ({ log: vi.fn() }));
const revalidateTag = vi.fn();
vi.mock('next/cache', () => ({ revalidateTag: (...a: unknown[]) => revalidateTag(...a) }));

import { DELETE } from '@/app/api/account/delete/route';
import { clearRevocationCache, createAccessToken } from '@/lib/tokens';

/**
 * Deleting a CREATOR's account, which used to fail half-way.
 *
 * `meals.creator_id` REFERENCES creators(id) with no ON DELETE rule, and Discover
 * writes it onto OTHER users' saved copies of a creator's meals. So the creator
 * delete failed, nothing checked it, the profile delete then failed on the
 * creator row with a bare 500, and the creator's platform tokens stayed live for
 * the poller. The fake has no foreign keys, so what these tests pin is the ROUTE:
 * that it clears the reference, deletes the tokens by name, and stops on a failed
 * step instead of carrying on.
 */

const USER = 'u1';
const CREATOR = 'c1';

function seed() {
  clearRevocationCache();
  fakeDb.queue('user_profiles', { data: { tokens_invalidated_at: null } });
  fakeDb.seed('user_profiles', [{
    id: USER, email: 'chef@example.com', created_at: '2026-03-04T00:00:00.000Z',
    subscription_tier: 'free', acquisition_source: null, subscribed_at: null,
  }]);
  fakeDb.seed('creators', [{ id: CREATOR, user_id: USER, display_name: 'Chef' }]);
  fakeDb.seed('preset_meals', [
    { id: 'pm1', creator_id: CREATOR, photo_url: `${STORAGE_BASE_URL}${USER}/1.jpg` },
    { id: 'pm-other', creator_id: 'c2', photo_url: null },
  ]);
  fakeDb.seed('preset_meal_saves', [{ id: 's1', preset_meal_id: 'pm1', user_id: 'fan' }]);
  fakeDb.seed('creator_platform_accounts', [
    { id: 'pa1', creator_id: CREATOR, platform: 'youtube', access_token: 'secret' },
    { id: 'pa2', creator_id: 'c2', platform: 'youtube', access_token: 'theirs' },
  ]);
  fakeDb.seed('meals', [
    { id: 'mine', user_id: USER, creator_id: null, photo_url: `${STORAGE_BASE_URL}${USER}/2.jpg` },
    // A fan's saved copy of the creator's meal: stays, loses the creator link,
    // and keeps showing the creator's photo.
    { id: 'fans', user_id: 'fan', creator_id: CREATOR, photo_url: `${STORAGE_BASE_URL}${USER}/1.jpg` },
  ]);
  fakeDb.seed('creator_follows', [{ id: 'f1', creator_id: CREATOR, user_id: 'fan' }]);
  fakeDb.seed('deleted_users', []);
  fakeDb.seed('creator_import_drafts', []);
  fakeDb.seed('creator_applications', []);
  fakeDb.seed('photo_hashes', [{ hash: 'h1', url: `${STORAGE_BASE_URL}${USER}/1.jpg` }]);
  fakeStorage.objects = [
    { name: `${USER}/1.jpg`, size: 10 },
    { name: `${USER}/2.jpg`, size: 10 },
    { name: `${USER}/3.jpg`, size: 10 },
    { name: 'someone-else/9.jpg', size: 10 },
  ];
}

async function del() {
  const token = await createAccessToken(USER, 'chef@example.com');
  return DELETE(jsonRequest('/api/account/delete', { method: 'DELETE', token }));
}

beforeEach(() => {
  fakeDb.reset();
  fakeStorage.reset();
  revalidateTag.mockReset();
});

describe('DELETE /api/account/delete: a creator', () => {
  it('clears other users\' meals off the creator, deletes the tokens, and finishes', async () => {
    seed();

    const res = await del();

    expect(res.status).toBe(200);
    expect(fakeDb.rows('creators')).toHaveLength(0);
    expect(fakeDb.row('meals', 'fans')).toMatchObject({ user_id: 'fan', creator_id: null });
    expect(fakeDb.rows('creator_platform_accounts').map((r) => r.id)).toEqual(['pa2']);
    expect(fakeDb.rows('preset_meals').map((r) => r.id)).toEqual(['pm-other']);
    expect(fakeDb.rows('user_profiles')).toHaveLength(0);
    expect(deleteUser).toHaveBeenCalledWith(USER);
  });

  it('takes the creator\'s meals off Trending', async () => {
    seed();
    await del();
    expect(revalidateTag).toHaveBeenCalledWith('trending-meals', 'max');
  });

  it('stops at a failed step instead of carrying on half-deleted', async () => {
    seed();
    // First `creators` read is the lookup; the second is the delete.
    fakeDb.queue('creators', { data: { id: CREATOR } });
    fakeDb.queue('creators', { error: { message: 'violates foreign key constraint' } });

    const res = await del();

    expect(res.status).toBe(500);
    expect((await res.json()).error).not.toContain('—');
    // Nothing past the failed step ran.
    expect(fakeDb.rows('user_profiles')).toHaveLength(1);
    expect(fakeDb.rows('meals').map((r) => r.id).sort()).toEqual(['fans', 'mine']);
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it('deletes the user\'s own photos but keeps one another account still shows', async () => {
    seed();

    const res = await del();

    expect(res.status).toBe(200);
    // 2.jpg was only on their own meal, 3.jpg on nothing: both go. 1.jpg is the
    // picture on a fan's saved copy, so it stays. Other folders are untouched.
    expect(fakeStorage.names().sort()).toEqual(['someone-else/9.jpg', `${USER}/1.jpg`]);
    // The dedupe table is left alone; its read side repairs a dead row itself.
    expect(fakeDb.rows('photo_hashes')).toHaveLength(1);
  });

  it('stops, and removes nothing, when the photo folder cannot be read', async () => {
    seed();
    fakeStorage.listError = { message: 'storage down' };

    const res = await del();

    expect(res.status).toBe(500);
    expect(fakeStorage.removed).toHaveLength(0);
    expect(fakeDb.rows('user_profiles')).toHaveLength(1);
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it('is safe to retry after the last step failed, and keeps the first tombstone', async () => {
    seed();
    deleteUser.mockResolvedValueOnce({ error: { message: 'auth down' } });

    expect((await del()).status).toBe(500);
    expect(fakeDb.rows('user_profiles')).toHaveLength(0);

    clearRevocationCache();
    const res = await del();

    expect(res.status).toBe(200);
    expect(deleteUser).toHaveBeenCalledTimes(2);
    // The retry found no profile; it must not overwrite the anchor with nulls.
    expect(fakeDb.rows('deleted_users')).toHaveLength(1);
    expect(fakeDb.rows('deleted_users')[0].signed_up_at).toBe('2026-03-04T00:00:00.000Z');
  });
});
