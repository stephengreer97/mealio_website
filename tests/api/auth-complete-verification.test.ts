import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeDb } from '../helpers/supabase-mock';
import { jsonRequest } from '../helpers/request';

vi.mock('@/lib/supabase', async () =>
  (await import('../helpers/supabase-mock')).mockSupabaseModule());
vi.mock('@/lib/logger', () => ({ log: vi.fn() }));

import { POST } from '@/app/api/auth/complete-verification/route';
import { verifyAccessToken } from '@/lib/tokens';

/**
 * /verify-email hands this route the Supabase token from a confirmation link.
 *
 * It used to accept ANY valid Supabase token for a confirmed user. The anon key
 * is public, so an attacker holding only an admin's or creator's password could
 * call signInWithPassword on Supabase directly, post the token here, and get a
 * 90-day Mealio session with no 2FA and no login throttle. These tests pin the
 * two rules that close it, and the control that a real signup still works.
 */

const getUser = vi.fn();
(fakeDb.auth as unknown as { getUser: typeof getUser }).getUser = getUser;

function confirmedUser(confirmedAgoMs: number) {
  return {
    data: {
      user: {
        id: 'user-1',
        email: 'a@b.test',
        email_confirmed_at: new Date(Date.now() - confirmedAgoMs).toISOString(),
      },
    },
    error: null,
  };
}

const post = () =>
  POST(jsonRequest('/api/auth/complete-verification', { body: { supabaseAccessToken: 'sb-token' } }));

beforeEach(() => {
  fakeDb.reset();
  getUser.mockReset();
  vi.unstubAllEnvs();
  fakeDb.seed('user_profiles', [{ id: 'user-1', email: 'a@b.test', is_admin: false }]);
  fakeDb.seed('creators', []);
});

describe('POST /api/auth/complete-verification', () => {
  it('signs in a signup confirmed moments ago', async () => {
    getUser.mockResolvedValue(confirmedUser(5_000));

    const res = await post();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(await verifyAccessToken(body.accessToken)).toMatchObject({ userId: 'user-1' });
    expect(res.headers.get('set-cookie') ?? '').toContain('mealio_session=');
  });

  it('refuses a token for an account confirmed long ago', async () => {
    // What signInWithPassword against the anon key hands an attacker: a valid
    // token for a user whose email was confirmed at signup, months back.
    getUser.mockResolvedValue(confirmedUser(60 * 24 * 60 * 60 * 1000));

    const res = await post();

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.accessToken).toBeUndefined();
    expect(body.error).toMatch(/sign in/i);
    expect(res.headers.get('set-cookie') ?? '').not.toContain('mealio_session=');
  });

  it('refuses an admin even inside the window, so 2FA cannot be skipped', async () => {
    fakeDb.seed('user_profiles', [{ id: 'user-1', email: 'a@b.test', is_admin: true }]);
    getUser.mockResolvedValue(confirmedUser(5_000));

    const res = await post();

    expect(res.status).toBe(403);
    expect((await res.json()).accessToken).toBeUndefined();
  });

  it('refuses an approved creator inside the window', async () => {
    fakeDb.seed('creators', [{ id: 'creator-1', user_id: 'user-1' }]);
    getUser.mockResolvedValue(confirmedUser(5_000));

    const res = await post();

    expect(res.status).toBe(403);
    expect((await res.json()).accessToken).toBeUndefined();
  });

  it('lets a creator on MFA_EXEMPT_EMAILS through, as login does', async () => {
    vi.stubEnv('MFA_EXEMPT_EMAILS', 'a@b.test');
    fakeDb.seed('creators', [{ id: 'creator-1', user_id: 'user-1' }]);
    getUser.mockResolvedValue(confirmedUser(5_000));

    expect((await post()).status).toBe(200);
  });

  it('401s on a token Supabase does not accept', async () => {
    getUser.mockResolvedValue({ data: { user: null }, error: { message: 'bad jwt' } });
    expect((await post()).status).toBe(401);
  });
});
