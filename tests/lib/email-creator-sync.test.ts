import { describe, it, expect, beforeEach, vi } from 'vitest';

/** What Resend was asked to send. The only seam this file needs. */
const send = vi.fn(async (payload: { subject: string; html: string }) => ({ data: { id: 'email-1' }, error: null, payload }));
vi.mock('resend', () => ({
  Resend: class { emails = { send: (payload: { subject: string; html: string }) => send(payload) }; },
}));

import { sendCreatorSourceMovedEmail, sendCreatorSyncPublishedEmail } from '@/lib/email';

/**
 * The message that makes the bargain honest.
 *
 * An operator approves a synced recipe and it goes live under the creator's
 * name without the creator having approved anything. The model is *notify and
 * correct*, so what this email says has to be true of every path that sends it —
 * including the one-link path, which is deliberately not host-checked.
 */

beforeEach(() => { send.mockClear(); });

const sent = () => send.mock.calls[0]![0];

describe('sendCreatorSyncPublishedEmail', () => {
  it('does not claim the recipe came from the creator’s own site', async () => {
    // Catalog mode is host-checked; a pasted link is not, on purpose — an
    // operator can sync a recipe of theirs that lives on a magazine's site. The
    // sentence was therefore false in exactly the case where a creator most
    // needs to look at what went out under their name.
    await sendCreatorSyncPublishedEmail('sarah@chefsarah.test', 'Chef Sarah', [{ id: 'm1', name: 'Guacamole' }]);

    expect(sent().html).not.toMatch(/from your own site/i);
    // What is true either way, and still says where it came from.
    expect(sent().html).toMatch(/recipe you published/i);
  });

  it('lists everything in the batch in one message', async () => {
    // One email per creator per batch is what the queue's multi-select exists
    // for: approving forty drafts one request at a time sent forty emails.
    await sendCreatorSyncPublishedEmail('sarah@chefsarah.test', 'Chef Sarah', [
      { id: 'm1', name: 'Guacamole' },
      { id: 'm2', name: 'Black bean soup' },
    ]);

    expect(send).toHaveBeenCalledTimes(1);
    expect(sent().html).toMatch(/Guacamole/);
    expect(sent().html).toMatch(/Black bean soup/);
    expect(sent().subject).toMatch(/2 of your recipes/);
  });

  it('sends nothing when nothing published', async () => {
    await sendCreatorSyncPublishedEmail('sarah@chefsarah.test', 'Chef Sarah', []);
    expect(send).not.toHaveBeenCalled();
  });

  it('escapes a display name rather than pasting it into the markup', async () => {
    await sendCreatorSyncPublishedEmail('x@test', '<script>alert(1)</script>', [{ id: 'm1', name: 'Guacamole' }]);
    expect(sent().html).not.toMatch(/<script>/);
  });
});

/**
 * The alert a creator's own link edit raises.
 *
 * It exists because the pause it describes reverses an operator's decision on
 * somebody else's request. Since removing the polled link takes the same path as
 * moving it, the mail has to say which of the two happened: one is waiting for a
 * link to be checked, the other for a link to exist at all, and an operator who
 * cannot tell them apart cannot act on either.
 */
describe('sendCreatorSourceMovedEmail', () => {
  const MOVED = {
    adminEmails: ['admin@mealio.co'],
    creatorName: 'Chef Sarah',
    handle: 'chefsarah',
    sourceLabel: 'Website',
    previousUrl: 'https://chefsarah.test/',
    newUrl: 'https://sarahcooks.test/',
  };

  it('names the link it moved to', async () => {
    await sendCreatorSourceMovedEmail(MOVED);

    expect(sent().subject).toMatch(/moved their Website link/i);
    expect(sent().html).toContain('https://sarahcooks.test/');
  });

  it('says a removal was a removal, rather than leaving an empty cell', async () => {
    await sendCreatorSourceMovedEmail({ ...MOVED, newUrl: '' });

    // "Now: (blank)" reads as a rendering bug, and an operator would go looking
    // for the new link instead of for the creator.
    expect(sent().subject).toMatch(/removed their Website link/i);
    expect(sent().html).toMatch(/nothing left to poll/i);
    expect(sent().html).toMatch(/removed/i);
  });

  it('sends nothing when there is nobody to tell', async () => {
    await sendCreatorSourceMovedEmail({ ...MOVED, adminEmails: [] });
    expect(send).not.toHaveBeenCalled();
  });
});
