import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeDb } from '../helpers/supabase-mock';
import { jsonRequest } from '../helpers/request';

// vi.mock is hoisted above imports, so the factory must import the helper
// dynamically rather than close over the static import.
vi.mock('@/lib/supabase', async () =>
  (await import('../helpers/supabase-mock')).mockSupabaseModule());
vi.mock('@/lib/logger', () => ({ log: vi.fn() }));

import { POST } from '@/app/api/auth/renew/route';
import { createAccessToken, verifyAccessToken, createSessionToken } from '@/lib/tokens';

describe('POST /api/auth/renew', () => {
  beforeEach(() => fakeDb.reset());

  it('401 without an Authorization header', async () => {
    const res = await POST(jsonRequest('/api/auth/renew'));
    expect(res.status).toBe(401);
  });

  it('401 for a malformed token', async () => {
    const res = await POST(jsonRequest('/api/auth/renew', { token: 'not-a-jwt' }));
    expect(res.status).toBe(401);
  });

  it('401 for a valid JWT of the wrong type (session token is not an access token)', async () => {
    const sessionToken = await createSessionToken('user-1', 'a@b.test');
    const res = await POST(jsonRequest('/api/auth/renew', { token: sessionToken }));
    expect(res.status).toBe(401);
  });

  it('returns a fresh access token plus current tier and admin flag', async () => {
    const token = await createAccessToken('user-1', 'a@b.test');
    fakeDb.queue('user_profiles', { data: { subscription_tier: 'full', is_admin: true } });

    const res = await POST(jsonRequest('/api/auth/renew', { token }));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.user).toEqual({ id: 'user-1', email: 'a@b.test', tier: 'full', isAdmin: true });
    const decoded = await verifyAccessToken(body.accessToken);
    expect(decoded).toMatchObject({ userId: 'user-1', email: 'a@b.test' });
  });

  it('defaults to free tier / non-admin when the profile row is missing', async () => {
    const token = await createAccessToken('user-2', 'b@b.test');
    // No queued profile → fake resolves { data: null }.
    const res = await POST(jsonRequest('/api/auth/renew', { token }));
    const body = await res.json();
    expect(body.user.tier).toBe('free');
    expect(body.user.isAdmin).toBe(false);
  });
});
