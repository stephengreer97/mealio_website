import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeDb, signInWithPassword } from '../helpers/supabase-mock';
import { jsonRequest } from '../helpers/request';

// vi.mock is hoisted above imports, so the factory must import the helper
// dynamically rather than close over the static import.
vi.mock('@/lib/supabase', async () =>
  (await import('../helpers/supabase-mock')).mockSupabaseModule());
vi.mock('@/lib/logger', () => ({ log: vi.fn() }));
vi.mock('@/lib/email', () => ({ sendOtpEmail: vi.fn().mockResolvedValue(undefined) }));

import { POST } from '@/app/api/auth/login/route';
import { verifyAccessToken, verifyTwoFactorToken, createSessionToken, hashToken } from '@/lib/tokens';
import { sendOtpEmail } from '@/lib/email';

const CONFIRMED_USER = {
  data: { user: { id: 'user-1', email: 'a@b.test', email_confirmed_at: '2026-01-01T00:00:00Z' } },
  error: null,
};

function loginRequest(cookies?: Record<string, string>) {
  return jsonRequest('/api/auth/login', {
    body: { email: 'a@b.test', password: 'hunter22' },
    cookies,
  });
}

describe('POST /api/auth/login', () => {
  beforeEach(() => {
    fakeDb.reset();
    signInWithPassword.mockReset();
    vi.mocked(sendOtpEmail).mockClear();
    vi.unstubAllEnvs(); // an allowlist must never leak into the next test
  });

  it('400 when email or password is missing', async () => {
    const res = await POST(jsonRequest('/api/auth/login', { body: { email: 'a@b.test' } }));
    expect(res.status).toBe(400);
  });

  it('401 on bad credentials', async () => {
    signInWithPassword.mockResolvedValue({ data: { user: null }, error: { message: 'Invalid login credentials' } });
    const res = await POST(loginRequest());
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('Invalid credentials');
  });

  it('asks for verification when the email is unconfirmed', async () => {
    signInWithPassword.mockResolvedValue({
      data: { user: { id: 'user-1', email: 'a@b.test', email_confirmed_at: null } },
      error: null,
    });
    const body = await (await POST(loginRequest())).json();
    expect(body.requiresVerification).toBe(true);
  });

  it('normal login issues an access token and the session cookie', async () => {
    signInWithPassword.mockResolvedValue(CONFIRMED_USER);
    fakeDb.queue('user_profiles', { data: { subscription_tier: 'full', is_admin: false } });
    fakeDb.queue('creators', { data: null }); // not a creator → no 2FA

    const res = await POST(loginRequest());
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.user).toEqual({ id: 'user-1', email: 'a@b.test', tier: 'full', isAdmin: false });
    expect(await verifyAccessToken(body.accessToken)).toMatchObject({ userId: 'user-1' });

    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('mealio_session=');
    expect(setCookie).toContain('HttpOnly');
  });

  it('gates creators behind email OTP 2FA', async () => {
    signInWithPassword.mockResolvedValue(CONFIRMED_USER);
    fakeDb.queue('user_profiles', { data: { subscription_tier: 'free', is_admin: false } });
    fakeDb.queue('creators', { data: { id: 'creator-1' } }); // approved creator
    fakeDb.queue('otp_codes', { error: null }); // invalidate old OTPs
    fakeDb.queue('otp_codes', { error: null }); // insert new OTP

    const res = await POST(loginRequest());
    const body = await res.json();

    expect(body.requiresTwoFactor).toBe(true);
    expect(body.accessToken).toBeUndefined();
    expect(await verifyTwoFactorToken(body.twoFactorToken)).toEqual({ userId: 'user-1' });
    expect(sendOtpEmail).toHaveBeenCalledWith('a@b.test', expect.stringMatching(/^\d+$/));
  });

  it('admin with a trusted device cookie skips 2FA', async () => {
    signInWithPassword.mockResolvedValue(CONFIRMED_USER);
    fakeDb.queue('user_profiles', { data: { subscription_tier: 'full', is_admin: true } });
    fakeDb.queue('creators', { data: null });
    fakeDb.queue('remembered_devices', { data: { id: 'device-1' } }); // trusted

    const res = await POST(loginRequest({ mealio_device: 'device-token' }));
    const body = await res.json();

    expect(body.success).toBe(true);
    expect(body.user.isAdmin).toBe(true);
    expect(body.requiresTwoFactor).toBeUndefined();
    expect(sendOtpEmail).not.toHaveBeenCalled();
    // Device lookup must compare the HASH of the cookie, never the raw value.
    const lookup = fakeDb.calls.find(
      (c) => c.table === 'remembered_devices' && c.method === 'eq' && c.args[0] === 'token_hash'
    );
    expect(lookup?.args[1]).toBe(hashToken('device-token'));
  });

  it('creator on the MFA_EXEMPT_EMAILS allowlist logs straight in', async () => {
    // App-review teams (Google Play data safety) sign in as a creator and have
    // no way to read the OTP inbox, so the gate is an unopenable door for them.
    vi.stubEnv('MFA_EXEMPT_EMAILS', 'reviewer@play.test, A@B.TEST');
    signInWithPassword.mockResolvedValue(CONFIRMED_USER);
    fakeDb.queue('user_profiles', { data: { subscription_tier: 'full', is_admin: false } });
    fakeDb.queue('creators', { data: { id: 'creator-1' } });

    const res = await POST(loginRequest());
    const body = await res.json();

    // Listed case-insensitively and with stray whitespace — still a match.
    expect(body.requiresTwoFactor).toBeUndefined();
    expect(sendOtpEmail).not.toHaveBeenCalled();
    expect(await verifyAccessToken(body.accessToken)).toMatchObject({ userId: 'user-1' });
  });

  it('allowlist exempts only the accounts named on it', async () => {
    vi.stubEnv('MFA_EXEMPT_EMAILS', 'reviewer@play.test');
    signInWithPassword.mockResolvedValue(CONFIRMED_USER); // a@b.test, not listed
    fakeDb.queue('user_profiles', { data: { subscription_tier: 'free', is_admin: false } });
    fakeDb.queue('creators', { data: { id: 'creator-1' } });
    fakeDb.queue('otp_codes', { error: null });
    fakeDb.queue('otp_codes', { error: null });

    const body = await (await POST(loginRequest())).json();

    expect(body.requiresTwoFactor).toBe(true);
    expect(body.accessToken).toBeUndefined();
  });

  it('an empty allowlist exempts nobody, rather than everybody', async () => {
    // `''.split(',')` is `['']`, so an unfiltered allowlist would match the
    // empty string — and every account whose email normalized to it.
    vi.stubEnv('MFA_EXEMPT_EMAILS', '');
    signInWithPassword.mockResolvedValue({
      data: { user: { id: 'user-1', email: '', email_confirmed_at: '2026-01-01T00:00:00Z' } },
      error: null,
    });
    fakeDb.queue('user_profiles', { data: { subscription_tier: 'free', is_admin: true } });
    fakeDb.queue('creators', { data: null });
    fakeDb.queue('otp_codes', { error: null });
    fakeDb.queue('otp_codes', { error: null });

    const body = await (await POST(loginRequest())).json();

    expect(body.requiresTwoFactor).toBe(true);
    expect(body.accessToken).toBeUndefined();
  });

  it('500 when the code could not be sent, rather than a prompt for a code nobody has', async () => {
    // Resend does not throw on a refusal, it resolves with `{ error }`, so an
    // unchecked send made a bad key look exactly like a delivered message: the
    // route logged `AUTH:2FA_SENT` success and the browser asked for a code that
    // was never sent, which no amount of retrying could produce. `lib/email.ts`
    // now throws on that, and this is where the throw has to land.
    signInWithPassword.mockResolvedValue(CONFIRMED_USER);
    fakeDb.queue('user_profiles', { data: { subscription_tier: 'free', is_admin: false } });
    fakeDb.queue('creators', { data: { id: 'creator-1' } });
    fakeDb.queue('otp_codes', { error: null });
    fakeDb.queue('otp_codes', { error: null });
    vi.mocked(sendOtpEmail).mockRejectedValueOnce(
      new Error('Resend refused the login code email: The domain is not verified.'));

    const res = await POST(loginRequest());

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.requiresTwoFactor).toBeUndefined();
    expect(body.twoFactorToken).toBeUndefined();
    // And no session either — a failed send must not become a way in.
    expect(body.accessToken).toBeUndefined();
    expect(res.headers.get('set-cookie') ?? '').not.toContain('mealio_session=');
  });

  it('500 when the OTP insert fails (no silent 2FA bypass)', async () => {
    signInWithPassword.mockResolvedValue(CONFIRMED_USER);
    fakeDb.queue('user_profiles', { data: { subscription_tier: 'free', is_admin: true } });
    fakeDb.queue('creators', { data: null });
    fakeDb.queue('otp_codes', { error: null }); // invalidate old OTPs
    fakeDb.queue('otp_codes', { error: { message: 'insert failed' } });

    const res = await POST(loginRequest());
    expect(res.status).toBe(500);
    expect(sendOtpEmail).not.toHaveBeenCalled();
  });
});
