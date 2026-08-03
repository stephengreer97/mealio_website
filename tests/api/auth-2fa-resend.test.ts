import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeDb } from '../helpers/supabase-mock';
import { jsonRequest } from '../helpers/request';

vi.mock('@/lib/supabase', async () =>
  (await import('../helpers/supabase-mock')).mockSupabaseModule());
vi.mock('@/lib/logger', () => ({ log: vi.fn() }));
vi.mock('@/lib/email', () => ({ sendOtpEmail: vi.fn().mockResolvedValue(undefined) }));

import { POST } from '@/app/api/auth/2fa/resend/route';
import { createTwoFactorToken } from '@/lib/tokens';
import { sendOtpEmail } from '@/lib/email';
import { hashOtp } from '@/lib/otp';

/**
 * Resending a login code (MEAL-91's Resend audit).
 *
 * The property this file exists for is an ORDERING one: the person clicking
 * *Resend code* is usually holding a working code already. They are impatient,
 * not locked out. So a send that Resend refuses — a suppressed address after a
 * bounce, a burst that trips `rate_limit_exceeded` — must leave them exactly as
 * able to log in as they were before they clicked.
 *
 * Before, the route invalidated every unused code, inserted a new one, and only
 * then sent. A refusal at that last step killed the delivered code, never
 * delivered its replacement, and left the 60-second cooldown — keyed on the
 * `otp_codes.created_at` the insert had just written — blocking the retry. One
 * click and the only way in was gone for a minute.
 *
 * Two of these tests would pass against that version. The ones that matter are
 * the refusal ones.
 */

const USER = 'user-1';

function otpRow(over: Record<string, unknown> = {}) {
  return {
    id: 'otp-old',
    user_id: USER,
    code_hash: hashOtp('111111'),
    used: false,
    expires_at: '2999-01-01T00:00:00.000Z',
    created_at: '2020-01-01T00:00:00.000Z',
    ...over,
  };
}

async function resend(token?: string) {
  return POST(jsonRequest('/api/auth/2fa/resend', {
    body: { twoFactorToken: token ?? (await createTwoFactorToken(USER)) },
  }));
}

/** The code that was actually put in front of the person, as the mail carried it. */
function sentCode(): string {
  return vi.mocked(sendOtpEmail).mock.calls.at(-1)![1] as string;
}

beforeEach(() => {
  fakeDb.reset();
  vi.mocked(sendOtpEmail).mockReset();
  vi.mocked(sendOtpEmail).mockResolvedValue(undefined);
  fakeDb.seed('user_profiles', [{ id: USER, email: 'a@b.test' }]);
  fakeDb.seed('otp_codes', []);
});

describe('POST /api/auth/2fa/resend', () => {
  it('emails a fresh code and stores exactly that code', async () => {
    const res = await resend();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(sendOtpEmail).toHaveBeenCalledWith('a@b.test', expect.stringMatching(/^\d{6}$/));

    const rows = fakeDb.rows('otp_codes');
    expect(rows).toHaveLength(1);
    // Stored as a hash, and the hash of the code that was sent — a stored code
    // the mail did not carry is a prompt nobody can satisfy.
    expect(rows[0].code_hash).toBe(hashOtp(sentCode()));
    expect(rows[0].user_id).toBe(USER);
  });

  it('retires the previous code once the new one is on its way', async () => {
    fakeDb.seed('otp_codes', [otpRow()]);

    await resend();

    const rows = fakeDb.rows('otp_codes');
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id === 'otp-old')!.used).toBe(true);
    // The sweep runs before the insert, so it cannot catch the row it is making
    // room for. A new code marked `used` on arrival verifies against nothing.
    expect(rows.find((r) => r.code_hash === hashOtp(sentCode()))!.used).not.toBe(true);
  });

  // ── The ordering, which is the point ───────────────────────────────────────

  describe('when Resend refuses the send', () => {
    beforeEach(() => {
      vi.mocked(sendOtpEmail).mockRejectedValue(new Error('Resend refused the login code email: Suppressed recipient.'));
    });

    it('leaves the code the person already has working', async () => {
      fakeDb.seed('otp_codes', [otpRow()]);

      const res = await resend();

      expect(res.status).toBe(500);
      // Still valid, still unused: the code in their inbox is the one they will
      // type, and nothing about a failed send makes it wrong.
      expect(fakeDb.row('otp_codes', 'otp-old')!.used).toBe(false);
    });

    it('writes no replacement for a code that was never delivered', async () => {
      fakeDb.seed('otp_codes', [otpRow()]);

      await resend();

      // A code nobody received is not a code. Storing one only means the next
      // real send has something else to invalidate.
      expect(fakeDb.rows('otp_codes')).toHaveLength(1);
    });

    it('does not start the cooldown, so the retry is not blocked by the failure', async () => {
      // The 60-second window is keyed on `otp_codes.created_at`. A row written
      // for an undelivered code locks the person out of asking again.
      await resend();
      expect(fakeDb.rows('otp_codes')).toHaveLength(0);

      vi.mocked(sendOtpEmail).mockResolvedValue(undefined);
      const second = await resend();

      expect(second.status).toBe(200);
      expect(sendOtpEmail).toHaveBeenCalledTimes(2);
    });

    it('says so rather than reporting a code that is on its way', async () => {
      const res = await resend();
      expect(res.status).toBe(500);
      expect((await res.json()).error).toBe('Internal server error');
    });
  });

  // ── The guards around it ───────────────────────────────────────────────────

  it('refuses a code within the cooldown window, and sends nothing', async () => {
    fakeDb.seed('otp_codes', [otpRow({ created_at: new Date().toISOString() })]);

    const res = await resend();

    expect(res.status).toBe(429);
    expect(sendOtpEmail).not.toHaveBeenCalled();
    // And the code that was just sent stays usable — the cooldown is not a
    // reason to invalidate anything.
    expect(fakeDb.row('otp_codes', 'otp-old')!.used).toBe(false);
    expect(fakeDb.rows('otp_codes')).toHaveLength(1);
  });

  it('401s on a token that is not a pending-2FA one, before touching any code', async () => {
    fakeDb.seed('otp_codes', [otpRow()]);

    const res = await POST(jsonRequest('/api/auth/2fa/resend', { body: { twoFactorToken: 'not-a-jwt' } }));

    expect(res.status).toBe(401);
    expect(sendOtpEmail).not.toHaveBeenCalled();
    expect(fakeDb.row('otp_codes', 'otp-old')!.used).toBe(false);
  });

  it('404s on a user with no profile without destroying their codes', async () => {
    fakeDb.seed('user_profiles', []);
    fakeDb.seed('otp_codes', [otpRow()]);

    const res = await resend();

    expect(res.status).toBe(404);
    expect(sendOtpEmail).not.toHaveBeenCalled();
    expect(fakeDb.row('otp_codes', 'otp-old')!.used).toBe(false);
    expect(fakeDb.rows('otp_codes')).toHaveLength(1);
  });
});
