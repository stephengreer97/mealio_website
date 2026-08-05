import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * The one thing about a send that cannot be inferred from the code above it:
 * **resend-node does not throw on an API refusal.** It resolves with
 * `{ data: null, error }`, so `await send(...)` returning normally is not
 * evidence that anything was delivered. Every caller that counts what it sent —
 * the poller counts `emailsSent` per pass — is counting attempts unless the
 * error is read.
 *
 * The drafts this email is about are already recorded `imported`, which means
 * they will never be new again and no later pass will mention them. A send that
 * silently did not happen is therefore permanent.
 */

const send = vi.fn();
vi.mock('resend', () => ({
  Resend: class {
    emails = { send: (...args: unknown[]) => send(...args) };
  },
}));

import {
  DIGEST_ROWS,
  sendCreatorDraftsReadyEmail,
  sendPollHealthAlertEmail,
  type DraftedRecipe,
  type UnhealthySourceLine,
} from '@/lib/email';

const DRAFT: DraftedRecipe = {
  draftId: 'draft-1',
  name: 'Best Guacamole',
  sourceUrl: 'https://chefsarah.test/post-0',
  photoUrl: null,
  ingredientCount: 6,
  needALook: 2,
};

beforeEach(() => {
  send.mockReset();
});

describe('the drafts-ready email (MEAL-76)', () => {
  it('fails loudly when Resend refuses it, rather than reporting a send that never happened', async () => {
    send.mockResolvedValue({ data: null, error: { name: 'validation_error', message: 'Domain is not verified' } });

    await expect(sendCreatorDraftsReadyEmail('sarah@chefsarah.test', 'Chef Sarah', [DRAFT])).rejects.toThrow(
      /Domain is not verified/,
    );
  });

  it('says what it is about, so a flagged batch reads as a job before it is opened', async () => {
    send.mockResolvedValue({ data: { id: 'msg-1' }, error: null });

    await sendCreatorDraftsReadyEmail('sarah@chefsarah.test', 'Chef Sarah', [DRAFT]);

    const sent = send.mock.calls[0][0] as { to: string; subject: string; html: string };
    expect(sent.to).toBe('sarah@chefsarah.test');
    expect(sent.subject).toContain('2 fields need a look');
    expect(sent.html).toContain('Best Guacamole');
  });

  it('points its only button at the drafts, not at the portal’s default tab', async () => {
    // "Review and publish" landed on /creator, which opens on Meals: a creator
    // asked to review the recipes we had just read arrived at the page for
    // publishing new ones and had to go and find the tab.
    send.mockResolvedValue({ data: { id: 'msg-1' }, error: null });

    await sendCreatorDraftsReadyEmail('sarah@chefsarah.test', 'Chef Sarah', [DRAFT]);

    const { html } = send.mock.calls[0][0] as { html: string };
    expect(html).toMatch(/href="[^"]*\/creator#drafts"[^>]*>Review and publish</);
    // The footer's "Creator Portal" is a general way in and stays one.
    expect(html).toMatch(/href="[^"]*\/creator"[^>]*>Creator Portal</);
  });

  it('sends nothing at all for an empty batch', async () => {
    await sendCreatorDraftsReadyEmail('sarah@chefsarah.test', 'Chef Sarah', []);

    expect(send).not.toHaveBeenCalled();
  });
});

/**
 * The poll health digest (MEAL-109).
 *
 * What is being pinned is the wording, because the wording is the feature: this
 * email is read on a phone by somebody who was not looking for it, and it has to
 * say which creator, what is wrong and how long it has been wrong before they
 * decide whether to open anything.
 */
const NOW = Date.parse('2026-03-01T12:00:00.000Z');
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(NOW - n * DAY).toISOString();

const SILENT: UnhealthySourceLine = {
  creatorName: 'Chef Sarah',
  handle: '@sarah',
  sourceLabel: 'Website',
  status: 'silent',
  quietDays: 45,
  lastNewItemAt: daysAgo(45),
  lastPolledAt: daysAgo(0),
  consecutiveFailures: 0,
  lastFailedAt: null,
  lastError: null,
};

const FAILING: UnhealthySourceLine = {
  creatorName: 'Chef Luis',
  handle: null,
  sourceLabel: 'YouTube',
  status: 'failing',
  quietDays: 3,
  lastNewItemAt: daysAgo(3),
  lastPolledAt: daysAgo(6),
  consecutiveFailures: 7,
  lastFailedAt: daysAgo(2),
  lastError: 'HTTP 403 Forbidden',
};

function sentMail() {
  return send.mock.calls[0][0] as { to: string[]; subject: string; html: string };
}

describe('the poll health alert (MEAL-109)', () => {
  beforeEach(() => {
    send.mockResolvedValue({ data: { id: 'msg-1' }, error: null });
  });

  it('names the creator and the problem in the subject of a single-source alert', async () => {
    await sendPollHealthAlertEmail({ adminEmails: ['ops@mealio.co'], sources: [SILENT], now: NOW });

    const mail = sentMail();
    expect(mail.to).toEqual(['ops@mealio.co']);
    expect(mail.subject).toBe("Poll health: Chef Sarah's Website is producing nothing");
    // The number of days, not "producing nothing": a month and a year read the
    // same as a status word and only one of them is an emergency.
    expect(mail.html).toContain('Nothing new for 45 days');
    // "Polled today and still nothing" is the sentence that separates a dead
    // feed from a poller that has stopped running.
    expect(mail.html).toContain('Last polled');
    expect(mail.html).toMatch(/href="[^"]*\/admin"[^>]*>Open the Sources tab</);
  });

  it('carries the failure’s reason and how long it has been failing', async () => {
    await sendPollHealthAlertEmail({ adminEmails: ['ops@mealio.co'], sources: [FAILING], now: NOW });

    const mail = sentMail();
    expect(mail.subject).toBe("Poll health: Chef Luis's YouTube has stopped working");
    expect(mail.html).toContain('7 polls in a row');
    expect(mail.html).toContain('HTTP 403 Forbidden');
    expect(mail.html).toContain('2 days ago');
  });

  it('counts the sources in the subject when several changed at once', async () => {
    await sendPollHealthAlertEmail({ adminEmails: ['ops@mealio.co'], sources: [SILENT, FAILING], now: NOW });

    expect(sentMail().subject).toBe('Poll health: 2 creator sources need a look');
  });

  it('says how many it did not list rather than growing without limit', async () => {
    const many = Array.from({ length: DIGEST_ROWS + 3 }, (_, i) => ({ ...SILENT, creatorName: `Chef ${i}` }));

    await sendPollHealthAlertEmail({ adminEmails: ['ops@mealio.co'], sources: many, now: NOW });

    const { html } = sentMail();
    expect(html).toContain(`Chef ${DIGEST_ROWS - 1}`);
    expect(html).not.toContain(`Chef ${DIGEST_ROWS}<`);
    // The sweep still marks every one of them, so the ones past the cap have to
    // be accounted for somewhere the operator can follow.
    expect(html).toContain('…and 3 more');
  });

  it('escapes what a creator typed and what a remote server said', async () => {
    await sendPollHealthAlertEmail({
      adminEmails: ['ops@mealio.co'],
      // `last_error` is not our prose — it is whatever the source returned, and
      // an HTML error page arrives here verbatim on its way into an inbox.
      sources: [{ ...FAILING, creatorName: '<script>alert(1)</script>', lastError: '<img src=x onerror=alert(1)>' }],
      now: NOW,
    });

    const { html } = sentMail();
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;script&gt;');
  });

  it('sends nothing when there is nobody to tell, or nothing to tell them', async () => {
    await sendPollHealthAlertEmail({ adminEmails: [], sources: [SILENT], now: NOW });
    await sendPollHealthAlertEmail({ adminEmails: ['ops@mealio.co'], sources: [], now: NOW });

    expect(send).not.toHaveBeenCalled();
  });
});
