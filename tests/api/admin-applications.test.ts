import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeDb } from '../helpers/supabase-mock';
import { jsonRequest } from '../helpers/request';

// vi.mock is hoisted above imports, so the factory must import the helper
// dynamically rather than close over the static import.
vi.mock('@/lib/supabase', async () =>
  (await import('../helpers/supabase-mock')).mockSupabaseModule());
vi.mock('@/lib/logger', () => ({ log: vi.fn() }));
vi.mock('@/lib/email', () => ({
  sendCreatorApprovedEmail: vi.fn(async () => {}),
  sendCreatorRejectedEmail: vi.fn(async () => {}),
}));

import { PATCH } from '@/app/api/admin/applications/route';
import { clearRevocationCache, createAccessToken } from '@/lib/tokens';

const APPLICATION = {
  user_id: 'user-1',
  display_name: 'Chef Sarah',
  photo_url: 'https://cdn.test/photo.jpg',
  handle: 'chefsarah',
  website_url: 'https://chefsarah.test/',
  youtube_url: null,
  instagram_url: 'https://instagram.com/chefsarah',
  tiktok_url: null,
  user_profiles: { email: 'sarah@test.co' },
};

describe('/api/admin/applications — approval carries the platform links', () => {
  let token: string;

  beforeEach(async () => {
    fakeDb.reset();
    token = await createAccessToken('admin-1', 'admin@mealio.co');
    // Two `user_profiles` reads per admin request: the token revocation check
    // (memoised for 30s, hence the cache clear) and `is_admin`.
    clearRevocationCache();
    fakeDb.queue('user_profiles', { data: { tokens_invalidated_at: null } });
    fakeDb.queue('user_profiles', { data: { is_admin: true } });
    fakeDb.queue('creator_applications', { data: APPLICATION });
  });

  it('copies all four links onto the creator row', async () => {
    const res = await PATCH(jsonRequest('/api/admin/applications', {
      method: 'PATCH', token, body: { id: 'app-1', action: 'approve' },
    }));

    expect(res.status).toBe(200);
    const insert = fakeDb.calls.find((c) => c.table === 'creators' && c.method === 'insert')?.args[0];
    expect(insert).toMatchObject({
      website_url: 'https://chefsarah.test/',
      youtube_url: null,
      instagram_url: 'https://instagram.com/chefsarah',
      tiktok_url: null,
    });
  });

  it('does not start polling anyone', async () => {
    // Approval collects links; choosing which one to poll is a separate,
    // deliberate decision made after a viability check. The schema defaults
    // (`none` / false) must survive the insert untouched.
    await PATCH(jsonRequest('/api/admin/applications', {
      method: 'PATCH', token, body: { id: 'app-1', action: 'approve' },
    }));

    const insert = fakeDb.calls.find((c) => c.table === 'creators' && c.method === 'insert')?.args[0] as Record<string, unknown>;
    expect(insert).not.toHaveProperty('primary_source');
    expect(insert).not.toHaveProperty('import_opt_in');
    expect(insert).not.toHaveProperty('feed_url');
  });
});
