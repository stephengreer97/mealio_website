import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeDb, signInWithPassword } from '../helpers/supabase-mock';
import { jsonRequest } from '../helpers/request';

vi.mock('@/lib/supabase', async () =>
  (await import('../helpers/supabase-mock')).mockSupabaseModule());
vi.mock('@/lib/logger', () => ({ log: vi.fn() }));
vi.mock('@/lib/email', () => ({ sendOtpEmail: vi.fn().mockResolvedValue(undefined) }));

import { POST } from '@/app/api/auth/login/route';
import { loginThrottled, MAX_PER_EMAIL, MAX_PER_IP } from '@/lib/login-throttle';

/**
 * NOTHING LIMITED THE LOGIN ENDPOINT.
 *
 * middleware.ts matches page paths only — its matcher is
 * '/((?!api|_next|.*\\..*).*)' — vercel.json carries no firewall rules, and the
 * route counted nothing. 2FA means a guessed password alone lets nobody in, but
 * it does not stop the guessing, and a CORRECT password sends an OTP email on
 * every attempt, so anyone holding one could fill a customer's inbox for free.
 *
 * Two keys, because the two attacks are different shapes: many passwords against
 * ONE account (credential stuffing, caught by the email key) and one password
 * against MANY accounts (spraying, which only the IP key can see — each account
 * looks untouched).
 */
const RPC = 'rpc:record_login_attempt';

const req = (email = 'a@b.test') =>
  jsonRequest('/api/auth/login', { body: { email, password: 'hunter22' } });

describe('the login throttle, as the route uses it', () => {
  beforeEach(() => {
    fakeDb.reset();
    signInWithPassword.mockReset();
  });

  it('refuses with 429 once a key is over its limit', async () => {
    fakeDb.queue(RPC, { data: MAX_PER_EMAIL + 1 } as never);
    const res = await POST(req());
    expect(res.status).toBe(429);
    expect((await res.json()).error).toMatch(/too many/i);
  });

  it('and never checks the password when it refuses', async () => {
    // THE POINT OF COUNTING FIRST. If the refusal came after the credential
    // check, an attacker would still learn whether each guess was right, and the
    // OTP email would still have been sent before we said no.
    fakeDb.queue(RPC, { data: MAX_PER_EMAIL + 1 } as never);
    await POST(req());
    expect(signInWithPassword).not.toHaveBeenCalled();
  });

  it('lets an ordinary attempt straight through', async () => {
    // The control. Without it "refuses" could be satisfied by refusing always.
    fakeDb.queue(RPC, { data: 1 } as never);
    fakeDb.queue(RPC, { data: 1 } as never);
    signInWithPassword.mockResolvedValue({ data: { user: null }, error: { message: 'Invalid login credentials' } });
    const res = await POST(req());
    expect(res.status).toBe(401);
    expect(signInWithPassword).toHaveBeenCalled();
  });
});

describe('the throttle itself', () => {
  /** A client that answers the RPC however the test says, and counts the keys. */
  const client = (answer: (key: string) => { data: unknown; error: unknown }) => {
    const keys: string[] = [];
    return {
      keys,
      rpc: vi.fn(async (_fn: string, args: Record<string, unknown>) => {
        keys.push(String(args.p_key));
        return answer(String(args.p_key));
      }),
    };
  };

  it('counts the email and the IP separately', async () => {
    const c = client(() => ({ data: 1, error: null }));
    await loginThrottled(c as never, 'A@B.test', '1.2.3.4');
    expect(c.keys).toEqual(['email:a@b.test', 'ip:1.2.3.4']);
  });

  it('trips on the email key at its own, lower limit', async () => {
    // The IP limit is higher, so an email count above MAX_PER_EMAIL but below
    // MAX_PER_IP must still refuse — otherwise one account could be attacked at
    // the IP allowance.
    expect(MAX_PER_EMAIL).toBeLessThan(MAX_PER_IP);
    const c = client((k) => ({ data: k.startsWith('email:') ? MAX_PER_EMAIL + 1 : 1, error: null }));
    expect(await loginThrottled(c as never, 'a@b.test', '1.2.3.4')).toBe(true);
  });

  it('trips on the IP key even when no single account looks busy', async () => {
    // Spraying: one password across many accounts. Every email key reads 1.
    const c = client((k) => ({ data: k.startsWith('ip:') ? MAX_PER_IP + 1 : 1, error: null }));
    expect(await loginThrottled(c as never, 'a@b.test', '1.2.3.4')).toBe(true);
  });

  it('FAILS OPEN when the table or function is missing', async () => {
    // The deliberate decision. This ships before the migration is applied, and a
    // throttle that cannot read its own state must not lock every real customer
    // out of the product. An attacker guessing passwords is survivable for the
    // minutes it takes to notice; a total outage is not.
    const c = client(() => ({ data: null, error: { message: 'relation "login_attempts" does not exist' } }));
    expect(await loginThrottled(c as never, 'a@b.test', '1.2.3.4')).toBe(false);
  });

  it('fails open on a non-numeric answer too', async () => {
    // The Supabase test double models set-returning RPCs and hands back an
    // array; a scalar function that started returning one would otherwise be
    // read as "0 attempts" and silently disable the limit.
    const c = client(() => ({ data: [{ count: 99 }], error: null }));
    expect(await loginThrottled(c as never, 'a@b.test', '1.2.3.4')).toBe(false);
  });
});
