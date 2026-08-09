import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  sendCreatorDraftsReadyEmail,
  sendCreatorSourceMovedEmail,
  sendFunnelAlertEmail,
  sendOtpEmail,
  sendPollHealthAlertEmail,
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
  {
    name: 'sendCreatorDraftsReadyEmail',
    call: () =>
      sendCreatorDraftsReadyEmail('a@b.test', 'Chef Sarah', [
        {
          draftId: 'd1',
          name: 'Guacamole',
          sourceUrl: 'https://chefsarah.test/guac',
          photoUrl: null,
          ingredientCount: 7,
          needALook: 1,
        },
      ]),
  },
  {
    // Both branches of this one send: `newUrl` empty means the link was removed
    // rather than moved. Either way a refusal has to surface.
    name: 'sendCreatorSourceMovedEmail',
    call: () =>
      sendCreatorSourceMovedEmail({
        adminEmails: ['admin@mealio.co'],
        creatorName: 'Chef Sarah',
        handle: '@sarah',
        sourceLabel: 'website',
        previousUrl: 'https://chefsarah.test/feed',
        newUrl: 'https://sarahcooks.test/feed',
      }),
  },
  {
    // The one where a swallowed refusal is durable rather than momentary: the
    // sweep marks the source as reported only once this returns, and the mark is
    // cleared by nothing but a recovery. A refusal read as a send would retire
    // that source from the alert permanently.
    name: 'sendPollHealthAlertEmail',
    call: () =>
      sendPollHealthAlertEmail({
        adminEmails: ['admin@mealio.co'],
        sources: [{
          creatorName: 'Chef Sarah',
          handle: '@sarah',
          sourceLabel: 'Website',
          status: 'silent',
          quietDays: 45,
          lastNewItemAt: '2026-01-15T00:00:00.000Z',
          lastPolledAt: '2026-03-01T00:00:00.000Z',
          consecutiveFailures: 0,
          lastFailedAt: null,
          lastError: null,
        }],
      }),
  },
  {
    // Durable in exactly the same way as the poll-health digest above: the
    // MEAL-6 sweep records a store as reported only once this returns, and
    // nothing but a full recovery clears that. A refusal read as a send retires
    // the store from the alert until it happens to come good and break again.
    name: 'sendFunnelAlertEmail',
    call: () =>
      sendFunnelAlertEmail({
        adminEmails: ['admin@mealio.co'],
        stores: [{
          storeId: 'heb',
          storeLabel: 'H-E-B',
          reasons: ['success_drop'],
          newReasons: ['success_drop'],
          runs: 12,
          itemsRequested: 120,
          itemsAdded: 48,
          itemSuccessRecent: 0.4,
          itemSuccessMedian: 0.98,
          confirmRate: 0.41,
          blockedRate: 0,
          blockedRuns: 0,
          failureCodes: [{ code: 'selector_miss', count: 30 }],
        }],
      }),
  },
];

beforeEach(() => {
  send.mockClear();
  result = { data: { id: 'email-1' }, error: null };
});

const LIB = fileURLToPath(new URL('../../lib', import.meta.url));

/** Every `.ts` under `lib/`, recursively. */
function libSources(dir = LIB): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return libSources(path);
    return entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
  });
}

/**
 * Blanks comments while keeping every line where it was.
 *
 * `throwIfRefused`'s own doc comment quotes `resend.emails.send(...)`, and a
 * guard that reads prose as code reports a call site nobody can fix.
 */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/.*$/gm, (line, before: string) => before + ' '.repeat(line.length - before.length));
}

/**
 * Every `resend.emails.send(` in `lib/`, with the code that follows the call.
 *
 * Located in the source rather than by importing anything, because the failure
 * being guarded against is a call site that exists — the module's own exports
 * cannot tell you whether a new function reaches Resend, and a naming convention
 * certainly cannot.
 *
 * The window is taken from the line that closes the call, which is `});` at the
 * statement's own indentation. The payload in between is a page of inline HTML,
 * so scanning forward a fixed number of lines from the call itself would land in
 * the middle of an email template.
 */
function resendCallSites() {
  const sites: Array<{ file: string; line: number; assigns: boolean; after: string }> = [];
  for (const file of libSources()) {
    const lines = withoutComments(readFileSync(file, 'utf8')).split('\n');
    lines.forEach((text, index) => {
      if (!text.includes('emails.send(')) return;
      const closing = lines.findIndex((l, i) => i > index && /^\s*\}\);\s*$/.test(l));
      sites.push({
        file: file.slice(LIB.length + 1),
        line: index + 1,
        // A result that is never bound cannot be checked by anybody.
        assigns: /=\s*await\s+[\w.]*emails\.send\(/.test(text),
        after: closing === -1 ? '' : lines.slice(closing + 1, closing + 9).join('\n'),
      });
    });
  }
  return sites;
}

describe('every sender surfaces a refused send', () => {
  /**
   * The backstop, and it has to be about Resend calls rather than about names.
   *
   * The previous version listed the module's exports beginning with `send` and
   * compared them to the table below. Adding `sendBrandNewThing` without a
   * refusal check failed it; adding `notifyBrandNewThing` doing exactly the same
   * passed — and neither version could see `lib/marketing-email.ts`, which is
   * where the eighth sender already lived.
   */
  it('checks the result of every Resend call under lib/', () => {
    const sites = resendCallSites();

    // If this ever reads zero the guard has stopped guarding — a moved import,
    // a renamed client — and everything below it would pass vacuously.
    expect(sites.length).toBeGreaterThanOrEqual(8);

    const unchecked = sites.filter(
      (site) => !site.assigns || !/throwIfRefused\(|if\s*\(\s*error\s*\)/.test(site.after),
    );
    expect(unchecked.map((site) => `${site.file}:${site.line}`)).toEqual([]);
  });

  it('exercises every function in lib/email.ts that reaches Resend', () => {
    // Named from the source, not from a convention: a sender called anything at
    // all is one that can go back to reporting success on a send that never
    // happened, and the rejection tests below are what stop that.
    const source = withoutComments(readFileSync(join(LIB, 'email.ts'), 'utf8'));
    const declarations = [...source.matchAll(/^export (?:async )?function (\w+)/gm)];
    const reachesResend = declarations.filter((match, i) => {
      const end = declarations[i + 1]?.index ?? source.length;
      return source.slice(match.index!, end).includes('emails.send(');
    }).map((match) => match[1]);

    expect(reachesResend.sort()).toEqual(senders.map((s) => s.name).sort());
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
