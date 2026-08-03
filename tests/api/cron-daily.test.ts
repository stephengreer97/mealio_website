import { describe, it, expect, beforeEach, vi } from 'vitest';
import { jsonRequest } from '../helpers/request';

vi.mock('@/lib/supabase', async () =>
  (await import('../helpers/supabase-mock')).mockSupabaseModule());
vi.mock('@/lib/logger', () => ({ log: vi.fn() }));

const runCreatorReminders = vi.fn(async () => 0);
const runUserUpsellDrip = vi.fn(async () => 0);
vi.mock('@/lib/email-campaigns', () => ({
  runCreatorReminders: () => runCreatorReminders(),
  runUserUpsellDrip: () => runUserUpsellDrip(),
}));

const resumeStalledSyncRuns = vi.fn(async () => 0);
vi.mock('@/lib/admin-sync', () => ({ resumeStalledSyncRuns: () => resumeStalledSyncRuns() }));

const refreshExpiringTokens = vi.fn();
vi.mock('@/lib/platform-tokens', () => ({ refreshExpiringTokens: () => refreshExpiringTokens() }));

import { GET } from '@/app/api/cron/daily/route';

/**
 * The daily cron, and the token sweep MEAL-74 adds to it.
 *
 * The sweep is the only thing standing between a revoked grant and a poller that
 * quietly finds nothing, so what matters here is that it runs on every pass and
 * that a failure in it does not take the other passes down with it.
 */

function cronRequest(secret = 'cron-secret') {
  return jsonRequest('/api/cron/daily', { method: 'GET', headers: { authorization: `Bearer ${secret}` } });
}

beforeEach(() => {
  process.env.CRON_SECRET = 'cron-secret';
  refreshExpiringTokens.mockReset();
  refreshExpiringTokens.mockResolvedValue({ checked: 3, refreshed: 2, broken: 1, skipped: 0, deferred: 1 });
});

describe('/api/cron/daily', () => {
  it('sweeps creator platform grants and reports what it found', async () => {
    const body = await (await GET(cronRequest())).json();

    expect(refreshExpiringTokens).toHaveBeenCalledTimes(1);
    // Reported rather than only logged: a run that broke a connection is the one
    // an operator needs to look at.
    // `tokensDeferred` is reported beside them: a provider that was unreachable
    // leaves its grants alone for tomorrow, and a run where that number jumps is
    // an outage rather than a set of creators to email (MEAL-82 / MEAL-83).
    expect(body).toMatchObject({ ok: true, tokensRefreshed: 2, tokensBroken: 1, tokensDeferred: 1 });
  });

  it('does not run the sweep unauthenticated', async () => {
    expect((await GET(cronRequest('wrong'))).status).toBe(401);
    expect(refreshExpiringTokens).not.toHaveBeenCalled();
  });

  it('keeps the other passes when the sweep throws', async () => {
    refreshExpiringTokens.mockRejectedValue(new Error('supabase unreachable'));

    const res = await GET(cronRequest());

    expect(res.status).toBe(200);
    expect(resumeStalledSyncRuns).toHaveBeenCalled();
  });
});
