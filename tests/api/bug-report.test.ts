import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeDb } from '../helpers/supabase-mock';
import { jsonRequest } from '../helpers/request';

vi.mock('@/lib/supabase', async () =>
  (await import('../helpers/supabase-mock')).mockSupabaseModule());
vi.mock('@/lib/logger', () => ({ log: vi.fn() }));
vi.mock('@/lib/email', () => ({ sendBugReportEmail: vi.fn().mockResolvedValue(undefined) }));

import { POST } from '@/app/api/bug-report/route';
import { sendBugReportEmail } from '@/lib/email';
import { clearRevocationCache, createAccessToken } from '@/lib/tokens';

/**
 * Filing a bug report.
 *
 * The email **is** the report: nothing else stores it, so this route has two
 * jobs and both of them are about not lying. It must not answer `ok` for a send
 * that did not happen — a reporter told their report went in does not file it
 * again — and it must not carry a secret off-platform on the way, because the
 * logs a person attaches are whatever their app had in memory.
 */

const report = { description: 'the cart is empty after add-to-cart' };

function bugRequest(body: unknown, token?: string) {
  return jsonRequest('/api/bug-report', { body, token });
}

/** The single argument `sendBugReportEmail` was called with. */
function sent() {
  return vi.mocked(sendBugReportEmail).mock.calls.at(-1)![0];
}

beforeEach(() => {
  fakeDb.reset();
  clearRevocationCache();
  vi.mocked(sendBugReportEmail).mockReset();
  vi.mocked(sendBugReportEmail).mockResolvedValue(undefined);
});

describe('POST /api/bug-report', () => {
  it('emails the report and says so', async () => {
    const res = await POST(bugRequest(report));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(sent()).toMatchObject({ description: report.description, source: 'app' });
  });

  it('refuses a description too short to act on, and sends nothing', async () => {
    const res = await POST(bugRequest({ description: 'hm' }));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('description is required');
    expect(sendBugReportEmail).not.toHaveBeenCalled();
  });

  it('answers 500 when the send is refused, because nothing else keeps the report', async () => {
    // Resend reports a refusal in `{ error }` rather than by throwing, so this
    // used to be a 200 for a report that never left the building. `ok: true`
    // here means the reporter closes the form and the bug is gone.
    vi.mocked(sendBugReportEmail).mockRejectedValue(
      new Error('Resend refused the bug report email: The domain is not verified.'),
    );

    const res = await POST(bugRequest(report));

    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('Could not submit report');
  });

  // ── What must not leave with it ────────────────────────────────────────────

  it('strips tokens, credentials and addresses out of attached logs', async () => {
    const logs = [
      'GET /api/meals sent with Bearer sk_live_abcdef123456',
      'authorization: eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl',
      'body: {"password":"hunter22","access_token":"abc123"}',
      'signed in as stephen@mealio.co',
    ].join('\n');

    await POST(bugRequest({ ...report, logs }));

    const carried = sent().logs as string;
    expect(carried).not.toMatch(/sk_live_abcdef123456/);
    expect(carried).not.toMatch(/eyJhbGciOi/);
    expect(carried).not.toMatch(/hunter22/);
    expect(carried).not.toMatch(/abc123/);
    expect(carried).not.toMatch(/stephen@mealio\.co/);
    // Redacted, not dropped: the shape of the log line is what makes it useful.
    expect(carried).toMatch(/Bearer ‹secret›/);
    expect(carried).toMatch(/‹email›/);
    // The client redacts too. This is the server not trusting it.
    expect(carried).toMatch(/GET \/api\/meals/);
  });

  it('trusts the token for who is reporting, not the body', async () => {
    fakeDb.seed('user_profiles', [{ id: 'user-1', tokens_invalidated_at: null }]);
    const token = await createAccessToken('user-1', 'a@b.test');

    await POST(bugRequest({ ...report, context: { userId: 'somebody-else', screen: 'Cart' } }, token));

    expect(sent().context).toMatchObject({ userId: 'user-1', screen: 'Cart' });
  });

  it('takes a report from someone who is not signed in', async () => {
    // Auth is optional on purpose: "I cannot log in" is a bug report.
    const res = await POST(bugRequest({ ...report, source: 'web' }));

    expect(res.status).toBe(200);
    expect(sent()).toMatchObject({ source: 'web' });
    expect(sent().context).not.toHaveProperty('userId');
  });

  it('caps a description rather than mailing an essay', async () => {
    await POST(bugRequest({ description: 'x'.repeat(9000) }));
    expect((sent().description as string).length).toBe(4000);
  });
});
