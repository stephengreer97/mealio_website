import { describe, it, expect, beforeEach, vi } from 'vitest';
import { jsonRequest } from '../helpers/request';

vi.mock('@/lib/supabase', async () =>
  (await import('../helpers/supabase-mock')).mockSupabaseModule());
vi.mock('@/lib/logger', () => ({ log: vi.fn() }));

const runPollPass = vi.fn();
vi.mock('@/lib/creator-poller', async () => {
  const actual = await vi.importActual<typeof import('@/lib/creator-poller')>('@/lib/creator-poller');
  return { ...actual, runPollPass: () => runPollPass() };
});

import { GET } from '@/app/api/cron/poll/route';

/**
 * The poller's cron door.
 *
 * This endpoint spends money per invocation — a fetch and two model calls per
 * new item — and emails partners under our name, so the only behaviour worth
 * testing here is that it cannot be opened by anyone else and that what it found
 * comes back in the response rather than only in a log file nobody is reading.
 */

const PASS = {
  eligible: 3, polled: 2, notModified: 1, baselined: 0, drafted: 4,
  rejected: 1, failed: 0, deferred: 0, blocked: 0, emailsSent: 2, skipped: 0, signals: [],
};

function cronRequest(secret = 'cron-secret') {
  return jsonRequest('/api/cron/poll', { method: 'GET', headers: { authorization: `Bearer ${secret}` } });
}

beforeEach(() => {
  process.env.CRON_SECRET = 'cron-secret';
  runPollPass.mockReset();
  runPollPass.mockResolvedValue(PASS);
});

describe('/api/cron/poll', () => {
  it('runs a pass and reports what it found, interval included', async () => {
    const body = await (await GET(cronRequest())).json();

    // `intervalMinutes` in the body because the deployed schedule is the one
    // thing about this feature that cannot be checked from inside it.
    expect(body).toMatchObject({ ok: true, intervalMinutes: 1440, drafted: 4, emailsSent: 2 });
  });

  it('does not poll unauthenticated', async () => {
    expect((await GET(cronRequest('wrong'))).status).toBe(401);
    expect(runPollPass).not.toHaveBeenCalled();
  });

  it('fails closed when no cron secret is configured', async () => {
    // Never a degraded mode this may run in: an open door here is an open door
    // into an LLM pipeline that emails creators under our name.
    delete process.env.CRON_SECRET;
    expect((await GET(cronRequest())).status).toBe(500);
    expect(runPollPass).not.toHaveBeenCalled();
  });

  it('surfaces operator signals in the response body', async () => {
    runPollPass.mockResolvedValue({ ...PASS, blocked: 1, signals: ['chefsarah.test has started refusing us'] });

    const body = await (await GET(cronRequest())).json();

    // A source that has started blocking us must not present as a creator who
    // stopped publishing, and a log line at `error` is where that goes to die.
    expect(body.signals).toEqual(['chefsarah.test has started refusing us']);
  });

  it('reports a thrown pass as a failure rather than a quiet 200', async () => {
    runPollPass.mockRejectedValue(new Error('supabase unreachable'));

    const res = await GET(cronRequest());

    // Unlike the push sweep, there is no partial success to preserve here: every
    // creator this pass did not reach is untouched and first in the next one.
    expect(res.status).toBe(500);
  });
});
