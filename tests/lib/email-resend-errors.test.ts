import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * The Resend result, controlled per test. `send` resolves either way — that is
 * the whole point of this file.
 */
let result: { data: { id: string } | null; error: { name?: string; message: string } | null };
const send = vi.fn(async (_payload: unknown) => result);
vi.mock('resend', () => ({
  Resend: class { emails = { send: (payload: unknown) => send(payload) }; },
}));

import {
  sendBugReportEmail,
  sendCreatorAppliedEmail,
  sendCreatorApplicationEmail,
  sendCreatorApprovedEmail,
  sendCreatorRejectedEmail,
  sendCreatorSyncPublishedEmail,
  sendOtpEmail,
} from '@/lib/email';

/**
 * Every sender in `lib/email.ts`, and the failure they all shared.
 *
 * `resend-node` does not throw when the API refuses a send. A bad key, a
 * suppressed recipient, an unverified domain, a rate limit — all of them resolve
 * with `{ data: null, error: {...} }`, which is indistinguishable from a
 * successful send to any caller that drops the return value. So a login route
 * logged `AUTH:2FA_SENT` success and asked the browser for a code that was never
 * sent; an operator was told a creator had been emailed about recipes published
 * under their name.
 *
 * The assertion that matters here is the **refusal** one. A happy-path test
 * passes just as well against the bug, which is exactly how the bug survived
 * this long.
 */

/** Each sender, with arguments that reach the send call rather than an early return. */
const senders: Array<{ name: string; call: () => Promise<unknown> }> = [
  { name: 'sendOtpEmail', call: () => sendOtpEmail('a@b.test', '123456') },
  { name: 'sendCreatorAppliedEmail', call: () => sendCreatorAppliedEmail('a@b.test', 'Chef Sarah') },
  { name: 'sendCreatorApprovedEmail', call: () => sendCreatorApprovedEmail('a@b.test', 'Chef Sarah') },
  { name: 'sendCreatorRejectedEmail', call: () => sendCreatorRejectedEmail('a@b.test', 'Chef Sarah') },
  { name: 'sendCreatorApplicationEmail', call: () => sendCreatorApplicationEmail('Chef Sarah', 'a@b.test', ['admin@mealio.co']) },
  { name: 'sendBugReportEmail', call: () => sendBugReportEmail({ description: 'the cart is empty', context: {}, source: 'app' }) },
  {
    name: 'sendCreatorSyncPublishedEmail',
    call: () => sendCreatorSyncPublishedEmail('a@b.test', 'Chef Sarah', [{ id: 'm1', name: 'Guacamole' }]),
  },
];

beforeEach(() => {
  send.mockClear();
  result = { data: { id: 'email-1' }, error: null };
});

describe('every sender surfaces a refused send', () => {
  it('covers every sender in the module', async () => {
    // A sender added without an entry here is one that can go back to reporting
    // success on a send that never happened.
    const module = await import('@/lib/email');
    const exported = Object.keys(module).filter((key) => key.startsWith('send'));
    expect(exported.sort()).toEqual(senders.map((s) => s.name).sort());
  });

  for (const { name, call } of senders) {
    describe(name, () => {
      it('rejects when Resend answers with an error rather than throwing one', async () => {
        result = { data: null, error: { name: 'validation_error', message: 'The domain is not verified.' } };

        await expect(call()).rejects.toThrow(/domain is not verified/i);
        // It did try — this is a refusal being reported, not a guard that
        // stopped the send from being attempted.
        expect(send).toHaveBeenCalledTimes(1);
      });

      it('names the message even when Resend gives no `message`', async () => {
        // Whatever shape the refusal arrives in, the caller's log line has to
        // carry something more useful than "undefined".
        result = { data: null, error: { name: 'rate_limit_exceeded' } as { name: string; message: string } };

        await expect(call()).rejects.toThrow(/rate_limit_exceeded/);
      });

      it('resolves on a successful send', async () => {
        await expect(call()).resolves.toBeUndefined();
      });
    });
  }
});

describe('what a refusal is not', () => {
  it('does not reject on an `error: null` result', async () => {
    // The success shape is `{ data, error: null }` — a null must not be read as
    // a failure, or every send would look refused.
    result = { data: { id: 'email-1' }, error: null };
    await expect(sendOtpEmail('a@b.test', '123456')).resolves.toBeUndefined();
  });

  it('still sends nothing, and reports nothing, when there is nothing to send', async () => {
    // The early returns are before the send, so they cannot be refused.
    await expect(sendCreatorApplicationEmail('Chef Sarah', 'a@b.test', [])).resolves.toBeUndefined();
    await expect(sendCreatorSyncPublishedEmail('a@b.test', 'Chef Sarah', [])).resolves.toBeUndefined();
    expect(send).not.toHaveBeenCalled();
  });

  it('says which email was refused, so a log line is actionable', async () => {
    result = { data: null, error: { name: 'validation_error', message: 'Suppressed recipient.' } };
    await expect(sendOtpEmail('a@b.test', '123456')).rejects.toThrow(/login code/i);
    result = { data: null, error: { name: 'validation_error', message: 'Suppressed recipient.' } };
    await expect(sendBugReportEmail({ description: 'x'.repeat(10), context: {}, source: 'web' }))
      .rejects.toThrow(/bug report/i);
  });
});
