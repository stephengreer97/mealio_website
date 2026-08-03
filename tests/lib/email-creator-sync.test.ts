import { describe, it, expect, beforeEach, vi } from 'vitest';

/** What Resend was asked to send. The only seam this file needs. */
const send = vi.fn(async (payload: { subject: string; html: string }) => ({ data: { id: 'email-1' }, error: null, payload }));
vi.mock('resend', () => ({
  Resend: class { emails = { send: (payload: { subject: string; html: string }) => send(payload) }; },
}));

import { sendCreatorSyncPublishedEmail } from '@/lib/email';

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
