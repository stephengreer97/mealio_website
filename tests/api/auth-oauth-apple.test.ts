import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeDb } from '../helpers/supabase-mock';
import { jsonRequest } from '../helpers/request';

vi.mock('@/lib/supabase', async () =>
  (await import('../helpers/supabase-mock')).mockSupabaseModule());
vi.mock('@/lib/logger', () => ({ log: vi.fn(), abbreviateUa: () => '' }));
vi.mock('@/lib/oauth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/oauth')>()),
  verifyAppleIdentityToken: vi.fn(),
}));

import { NextRequest } from 'next/server';
import { POST } from '@/app/api/auth/oauth/apple/route';
import { POST as webCallback } from '@/app/api/auth/callback/apple/route';
import { verifyAppleIdentityToken } from '@/lib/oauth';
import { verifyAccessToken } from '@/lib/tokens';

/**
 * Sign in with Apple, from the app.
 *
 * Apple's identity token does not always carry an email, and the route used to
 * make up the difference with `user.email` from the request body, which the
 * client writes. That address then created an account (already confirmed) or
 * linked this Apple ID to the existing account holding it. The email must come
 * from the verified token or not at all.
 */

const createUser = vi.fn();
(fakeDb.auth.admin as unknown as { createUser: typeof createUser }).createUser = createUser;

const signIn = (user?: unknown) =>
  POST(jsonRequest('/api/auth/oauth/apple', { body: { identityToken: 'apple-jwt', user } }));

beforeEach(() => {
  fakeDb.reset();
  createUser.mockReset();
  createUser.mockResolvedValue({ data: { user: { id: 'new-user' } }, error: null });
  vi.mocked(verifyAppleIdentityToken).mockReset();
  fakeDb.seed('user_profiles', [
    { id: 'victim', email: 'victim@b.test', apple_id: null, subscription_tier: 'full', is_admin: true },
    { id: 'linked', email: 'relay@privaterelay.appleid.com', apple_id: 'apple-sub-linked', subscription_tier: 'free', is_admin: false },
  ]);
});

describe('POST /api/auth/oauth/apple', () => {
  it('never links an account by a client-supplied email', async () => {
    vi.mocked(verifyAppleIdentityToken).mockResolvedValue({ sub: 'attacker-sub', email: undefined, email_verified: false });

    const res = await signIn({ email: 'victim@b.test' });

    expect(res.status).toBe(400);
    expect((await res.json()).accessToken).toBeUndefined();
    expect(fakeDb.row('user_profiles', 'victim').apple_id).toBeNull();
  });

  it('never creates an account from a client-supplied email', async () => {
    vi.mocked(verifyAppleIdentityToken).mockResolvedValue({ sub: 'attacker-sub', email: undefined, email_verified: false });

    const res = await signIn({ email: 'someone-new@b.test' });

    expect(res.status).toBe(400);
    expect(createUser).not.toHaveBeenCalled();
    expect((await res.json()).error).toMatch(/sign in with your email/i);
  });

  it('with no email in the token, still signs in the account already linked to that Apple ID', async () => {
    vi.mocked(verifyAppleIdentityToken).mockResolvedValue({ sub: 'apple-sub-linked', email: undefined, email_verified: false });

    const res = await signIn();

    expect(res.status).toBe(200);
    expect(await verifyAccessToken((await res.json()).accessToken)).toMatchObject({ userId: 'linked' });
  });

  it('creates a new account from the email in the verified token', async () => {
    vi.mocked(verifyAppleIdentityToken).mockResolvedValue({ sub: 'new-sub', email: 'new@b.test', email_verified: true });

    const res = await signIn({ email: 'ignored@b.test' });

    expect(res.status).toBe(200);
    expect(createUser).toHaveBeenCalledWith(expect.objectContaining({ email: 'new@b.test' }));
  });
});

describe('POST /api/auth/callback/apple (web form_post)', () => {
  function formPost(user: unknown) {
    const state = Buffer.from(JSON.stringify({ redirect: '/discover', nonce: 'n1' })).toString('base64url');
    const body = new URLSearchParams({ code: 'c', id_token: 'apple-jwt', state, user: JSON.stringify(user) });
    return new NextRequest('http://localhost/api/auth/callback/apple', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: 'mealio_oauth_state=n1' },
      body: body.toString(),
    });
  }

  it('does not link the account named in the unsigned user field', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}')));
    vi.mocked(verifyAppleIdentityToken).mockResolvedValue({ sub: 'attacker-sub', email: undefined, email_verified: false });

    const res = await webCallback(formPost({ email: 'victim@b.test' }));

    expect(res.headers.get('location')).toContain('/signin?error=');
    expect(res.headers.get('set-cookie') ?? '').not.toContain('mealio_session=');
    expect(fakeDb.row('user_profiles', 'victim').apple_id).toBeNull();
    vi.unstubAllGlobals();
  });

  it('does not create an account from the unsigned user field', async () => {
    // The link case above is also stopped by email_verified being false; this
    // one is not, so it is the test that pins the rule itself.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}')));
    vi.mocked(verifyAppleIdentityToken).mockResolvedValue({ sub: 'attacker-sub', email: undefined, email_verified: false });

    const res = await webCallback(formPost({ email: 'someone-new@b.test' }));

    expect(res.headers.get('location')).toContain('/signin?error=');
    expect(createUser).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
