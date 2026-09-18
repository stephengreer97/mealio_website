import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeDb } from '../helpers/supabase-mock';
import { jsonRequest } from '../helpers/request';

vi.mock('@/lib/supabase', async () =>
  (await import('../helpers/supabase-mock')).mockSupabaseModule());
vi.mock('@/lib/logger', () => ({ log: vi.fn() }));
vi.mock('@/lib/email', () => ({ sendOtpEmail: vi.fn().mockResolvedValue(undefined) }));

import { POST as verify } from '@/app/api/auth/2fa/verify/route';
import { POST as resend } from '@/app/api/auth/2fa/resend/route';
import { createTwoFactorToken } from '@/lib/tokens';
import { hashOtp } from '@/lib/otp';
import { sendOtpEmail } from '@/lib/email';
import { MAX_OTP_FAILURES, OTP_LOCKED_MESSAGE, OTP_WINDOW_SECONDS } from '@/lib/login-throttle';

/**
 * A cap on wrong 2FA codes ACROSS codes.
 *
 * Each code allows five tries, but every resend (one a minute) and every login
 * issues a fresh code with five more, so the per-code limit alone let a guesser
 * keep going for as long as they kept asking. Wrong codes are now also counted
 * per account in `login_attempts` under `otp:<userId>`, and once that count
 * reaches MAX_OTP_FAILURES in the window, verify and resend both stop.
 */

const USER = 'user-1';
const RECORD = 'rpc:record_login_attempt';
const INCREMENT = 'rpc:increment_otp_attempts';

const attempts = (n: number, agoMs = 60_000) =>
  Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    key: `otp:${USER}`,
    created_at: new Date(Date.now() - agoMs).toISOString(),
  }));

async function verifyWith(code: string) {
  return verify(jsonRequest('/api/auth/2fa/verify', {
    body: { twoFactorToken: await createTwoFactorToken(USER), code },
  }));
}

beforeEach(() => {
  fakeDb.reset();
  vi.mocked(sendOtpEmail).mockClear();
  fakeDb.seed('user_profiles', [{ id: USER, email: 'a@b.test', subscription_tier: 'free', is_admin: false }]);
  fakeDb.seed('otp_codes', [{
    id: 'otp-1', user_id: USER, code_hash: hashOtp('123456'), used: false,
    expires_at: '2999-01-01T00:00:00.000Z', created_at: '2020-01-01T00:00:00.000Z',
  }]);
  fakeDb.seed('login_attempts', []);
});

describe('2FA lockout across codes', () => {
  it('a locked account cannot verify, even with the right code', async () => {
    fakeDb.seed('login_attempts', attempts(MAX_OTP_FAILURES));

    const res = await verifyWith('123456');

    expect(res.status).toBe(429);
    expect((await res.json()).error).toBe(OTP_LOCKED_MESSAGE);
    // Refused before the code was looked at, so it stays usable once the window passes.
    expect(fakeDb.row('otp_codes', 'otp-1').used).toBe(false);
  });

  it('a locked account is sent no new code', async () => {
    fakeDb.seed('login_attempts', attempts(MAX_OTP_FAILURES));

    const res = await resend(jsonRequest('/api/auth/2fa/resend', {
      body: { twoFactorToken: await createTwoFactorToken(USER) },
    }));

    expect(res.status).toBe(429);
    expect((await res.json()).error).toBe(OTP_LOCKED_MESSAGE);
    expect(sendOtpEmail).not.toHaveBeenCalled();
  });

  it('failures older than the window do not count', async () => {
    fakeDb.seed('login_attempts', attempts(MAX_OTP_FAILURES, (OTP_WINDOW_SECONDS + 60) * 1000));
    fakeDb.queue(INCREMENT, { data: 1 } as never);

    const res = await verifyWith('123456');

    expect(res.status).toBe(200);
  });

  it('a wrong code is counted against the account', async () => {
    fakeDb.queue(INCREMENT, { data: 1 } as never);
    fakeDb.queue(RECORD, { data: 1 } as never);

    const res = await verifyWith('000000');

    expect(res.status).toBe(401);
    expect((await res.json()).error).toMatch(/Incorrect code/);
    const recorded = fakeDb.calls.find((c) => c.table === RECORD && c.method === 'rpc');
    expect(recorded?.args[0]).toEqual({ p_key: `otp:${USER}`, p_window_seconds: OTP_WINDOW_SECONDS });
  });

  it('the wrong code that reaches the cap says locked, not "attempts remaining"', async () => {
    fakeDb.queue(INCREMENT, { data: 1 } as never);
    fakeDb.queue(RECORD, { data: MAX_OTP_FAILURES } as never);

    const res = await verifyWith('000000');

    expect(res.status).toBe(429);
    expect((await res.json()).error).toBe(OTP_LOCKED_MESSAGE);
  });

  it('fails open when the throttle cannot count', async () => {
    fakeDb.queue('login_attempts', { data: null, error: { message: 'relation does not exist' } });
    fakeDb.queue(INCREMENT, { data: 1 } as never);

    expect((await verifyWith('123456')).status).toBe(200);
  });
});
