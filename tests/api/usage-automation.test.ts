import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeDb } from '../helpers/supabase-mock';
import { jsonRequest } from '../helpers/request';

vi.mock('@/lib/supabase', async () =>
  (await import('../helpers/supabase-mock')).mockSupabaseModule());
vi.mock('@/lib/logger', () => ({ log: vi.fn() }));

import { POST } from '@/app/api/usage/automation/route';
import { createAccessToken } from '@/lib/tokens';

// Run-level ingest. The property under test here is the OUTCOME VOCABULARY.
//
// `automation_runs.outcome` is a plain text column with no CHECK constraint, so
// this route's allowlist is the only thing keeping it to a set of values — and a
// value it does not recognise is written as NULL rather than rejected. That makes
// the allowlist a release-ordering constraint and not a formality: an app build
// that reports an outcome this deploy predates does not degrade to a near-enough
// one, it loses the fact and the row reads as "finished, reported nothing".

/** The payload the route handed to update(). */
function updatedRow(): Record<string, unknown> {
  const call = fakeDb.calls.find((c) => c.table === 'automation_runs' && c.method === 'update');
  return call ? call.args[0] : {};
}

const complete = (outcome: unknown) => ({ phase: 'complete', runId: 'run-1', outcome });

describe('POST /api/usage/automation, phase complete', () => {
  let token: string;

  beforeEach(async () => {
    fakeDb.reset();
    token = await createAccessToken('user-1', 'a@b.test');
  });

  it('401 without a token', async () => {
    const res = await POST(jsonRequest('/api/usage/automation', { body: complete('success') }));
    expect(res.status).toBe(401);
  });

  it('400 without a runId', async () => {
    const res = await POST(jsonRequest('/api/usage/automation', {
      token, body: { phase: 'complete', outcome: 'success' },
    }));
    expect(res.status).toBe(400);
  });

  it.each(['success', 'partial', 'failed', 'unverified'])('stores the %s outcome', async (outcome) => {
    const res = await POST(jsonRequest('/api/usage/automation', { token, body: complete(outcome) }));
    expect(res.status).toBe(200);
    expect(updatedRow().outcome).toBe(outcome);
  });

  it('records an unverified run as completed, not failed', async () => {
    // MEAL-190. The run finished and did what it was asked; what is missing is the
    // cart reading that would have checked it. `status` is the column the run list
    // reads as "this run ended badly", and an unread cart is not that.
    await POST(jsonRequest('/api/usage/automation', { token, body: complete('unverified') }));
    expect(updatedRow().status).toBe('completed');

    fakeDb.reset();
    await POST(jsonRequest('/api/usage/automation', { token, body: complete('failed') }));
    expect(updatedRow().status).toBe('failed');
  });

  it('writes null for an outcome it does not recognise', async () => {
    // The failure mode the allowlist has, stated so it is not discovered in the
    // data: an unknown value is not a 400, it is a run with no outcome at all. So
    // this route has to learn a new outcome BEFORE the app that sends it ships.
    const res = await POST(jsonRequest('/api/usage/automation', { token, body: complete('unverifiable') }));
    expect(res.status).toBe(200);
    expect(updatedRow().outcome).toBeNull();
  });
});
