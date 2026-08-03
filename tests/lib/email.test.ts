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

import { sendCreatorDraftsReadyEmail, type DraftedRecipe } from '@/lib/email';

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

  it('sends nothing at all for an empty batch', async () => {
    await sendCreatorDraftsReadyEmail('sarah@chefsarah.test', 'Chef Sarah', []);

    expect(send).not.toHaveBeenCalled();
  });
});
