import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeDb } from '../helpers/supabase-mock';
import { jsonRequest } from '../helpers/request';

vi.mock('@/lib/supabase', async () =>
  (await import('../helpers/supabase-mock')).mockSupabaseModule());
vi.mock('@/lib/logger', () => ({ log: vi.fn() }));

import { POST } from '@/app/api/usage/automation/steps/route';
import { createAccessToken } from '@/lib/tokens';

// Step-telemetry ingest. Two properties matter beyond the usual auth checks:
//   • store_id comes from the RUN, never the request body, so the funnel can't be
//     skewed by a client reporting the wrong store.
//   • An unrecognized step name skips that ROW, not the batch — a newer client may
//     emit a step this deploy predates, and losing one row beats losing the run.

const OWNED_RUN = { data: { id: 'run-1', store_id: 'heb', user_id: 'user-1' }, error: null };

const body = (steps: unknown[], extra: Record<string, unknown> = {}) => ({
  runId: 'run-1', steps, ...extra,
});

const step = (over: Record<string, unknown> = {}) => ({
  seq: 0, step: 'add_click', outcome: 'ok', ...over,
});

/** The rows the route handed to upsert(). */
function upsertedRows(): any[] {
  const call = fakeDb.calls.find((c) => c.table === 'automation_steps' && c.method === 'upsert');
  return call ? call.args[0] : [];
}

describe('POST /api/usage/automation/steps', () => {
  let token: string;

  beforeEach(async () => {
    fakeDb.reset();
    token = await createAccessToken('user-1', 'a@b.test');
  });

  it('401 without a token', async () => {
    const res = await POST(jsonRequest('/api/usage/automation/steps', { body: body([step()]) }));
    expect(res.status).toBe(401);
  });

  it('400 without runId or steps', async () => {
    for (const bad of [{}, { runId: 'run-1' }, { steps: [] as unknown[] }]) {
      const res = await POST(jsonRequest('/api/usage/automation/steps', { token, body: bad }));
      expect(res.status).toBe(400);
    }
  });

  it('accepts an empty steps array as a no-op', async () => {
    const res = await POST(jsonRequest('/api/usage/automation/steps', { token, body: body([]) }));
    expect(res.status).toBe(200);
    expect((await res.json()).inserted).toBe(0);
  });

  it('400 on an oversized batch', async () => {
    const res = await POST(jsonRequest('/api/usage/automation/steps', {
      token, body: body(Array.from({ length: 201 }, (_, i) => step({ seq: i }))),
    }));
    expect(res.status).toBe(400);
  });

  it("404 when the run isn't the caller's", async () => {
    fakeDb.queue('automation_runs', { data: null, error: null });
    const res = await POST(jsonRequest('/api/usage/automation/steps', { token, body: body([step()]) }));
    expect(res.status).toBe(404);
  });

  it('inserts valid steps', async () => {
    fakeDb.queue('automation_runs', OWNED_RUN);
    fakeDb.queue('automation_steps', { error: null });
    const res = await POST(jsonRequest('/api/usage/automation/steps', {
      token,
      body: body([
        step({ seq: 0, step: 'search', outcome: 'ok', durationMs: 1200, itemIndex: 0 }),
        step({ seq: 1, step: 'confirm', outcome: 'timeout', detail: { attempt: 2 } }),
      ]),
    }));
    expect(res.status).toBe(200);
    expect((await res.json()).inserted).toBe(2);
    const rows = upsertedRows();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ step: 'search', outcome: 'ok', duration_ms: 1200, item_index: 0, seq: 0 });
    expect(rows[1]).toMatchObject({ step: 'confirm', outcome: 'timeout', detail: { attempt: 2 } });
  });

  it('takes store_id from the run, ignoring any storeId in the body', async () => {
    fakeDb.queue('automation_runs', OWNED_RUN);
    fakeDb.queue('automation_steps', { error: null });
    await POST(jsonRequest('/api/usage/automation/steps', {
      token, body: body([step()], { storeId: 'walmart' }),
    }));
    expect(upsertedRows()[0].store_id).toBe('heb');
  });

  it('stamps user_id from the token, not the body', async () => {
    fakeDb.queue('automation_runs', OWNED_RUN);
    fakeDb.queue('automation_steps', { error: null });
    await POST(jsonRequest('/api/usage/automation/steps', {
      token, body: body([step()], { userId: 'someone-else' }),
    }));
    expect(upsertedRows()[0].user_id).toBe('user-1');
  });

  it('upserts idempotently on (run_id, seq)', async () => {
    // The client retries failed batches, so a redelivery must be a no-op rather
    // than double-counting the funnel.
    fakeDb.queue('automation_runs', OWNED_RUN);
    fakeDb.queue('automation_steps', { error: null });
    await POST(jsonRequest('/api/usage/automation/steps', { token, body: body([step()]) }));
    const call = fakeDb.calls.find((c) => c.table === 'automation_steps' && c.method === 'upsert')!;
    expect(call.args[1]).toEqual({ onConflict: 'run_id,seq', ignoreDuplicates: true });
  });

  it('skips unrecognized step names but keeps the valid rows', async () => {
    fakeDb.queue('automation_runs', OWNED_RUN);
    fakeDb.queue('automation_steps', { error: null });
    const res = await POST(jsonRequest('/api/usage/automation/steps', {
      token,
      body: body([
        step({ seq: 0, step: 'search' }),
        step({ seq: 1, step: 'a_step_from_the_future' }),
        step({ seq: 2, step: 'confirm' }),
      ]),
    }));
    expect((await res.json()).inserted).toBe(2);
    expect(upsertedRows().map((r) => r.step)).toEqual(['search', 'confirm']);
  });

  it('skips unrecognized outcomes', async () => {
    fakeDb.queue('automation_runs', OWNED_RUN);
    fakeDb.queue('automation_steps', { error: null });
    const res = await POST(jsonRequest('/api/usage/automation/steps', {
      token, body: body([step({ outcome: 'weird' })]),
    }));
    expect((await res.json()).inserted).toBe(0);
  });

  it('skips rows missing seq', async () => {
    // seq is the idempotency key; a row without one can't be deduped.
    fakeDb.queue('automation_runs', OWNED_RUN);
    fakeDb.queue('automation_steps', { error: null });
    const res = await POST(jsonRequest('/api/usage/automation/steps', {
      token, body: body([{ step: 'search', outcome: 'ok' }]),
    }));
    expect((await res.json()).inserted).toBe(0);
  });

  it('accepts seq 0 (not treated as missing)', async () => {
    fakeDb.queue('automation_runs', OWNED_RUN);
    fakeDb.queue('automation_steps', { error: null });
    const res = await POST(jsonRequest('/api/usage/automation/steps', {
      token, body: body([step({ seq: 0 })]),
    }));
    expect((await res.json()).inserted).toBe(1);
  });

  it('replaces an oversized detail payload with a marker', async () => {
    fakeDb.queue('automation_runs', OWNED_RUN);
    fakeDb.queue('automation_steps', { error: null });
    await POST(jsonRequest('/api/usage/automation/steps', {
      token, body: body([step({ detail: { blob: 'x'.repeat(5000) } })]),
    }));
    expect(upsertedRows()[0].detail).toMatchObject({ truncated: true });
  });

  it('nulls a non-numeric durationMs instead of storing garbage', async () => {
    fakeDb.queue('automation_runs', OWNED_RUN);
    fakeDb.queue('automation_steps', { error: null });
    await POST(jsonRequest('/api/usage/automation/steps', {
      token, body: body([step({ durationMs: 'fast' })]),
    }));
    expect(upsertedRows()[0].duration_ms).toBeNull();
  });

  it('records config/app/platform attribution', async () => {
    fakeDb.queue('automation_runs', OWNED_RUN);
    fakeDb.queue('automation_steps', { error: null });
    await POST(jsonRequest('/api/usage/automation/steps', {
      token, body: body([step()], { configVersion: 7, appVersion: '1.2.3', platform: 'android' }),
    }));
    expect(upsertedRows()[0]).toMatchObject({ config_version: 7, app_version: '1.2.3', platform: 'android' });
  });

  it('rejects a bogus platform value', async () => {
    fakeDb.queue('automation_runs', OWNED_RUN);
    fakeDb.queue('automation_steps', { error: null });
    await POST(jsonRequest('/api/usage/automation/steps', {
      token, body: body([step()], { platform: 'windows-phone' }),
    }));
    expect(upsertedRows()[0].platform).toBeNull();
  });

  // ── MEAL-4's failure taxonomy ─────────────────────────────────────────────
  // `code` is a TOP-LEVEL field on the step record, not something inside detail,
  // and it is the field that turns "add_click is at 60%" into a thing someone can
  // act on. The rule it must obey: an unknown code costs you the code, never the
  // row — the guard above `continue`s, so validating `code` there would delete a
  // whole step from the funnel the first time a ninth code shipped.

  it('stores a recognized failure code as a top-level column', async () => {
    fakeDb.queue('automation_runs', OWNED_RUN);
    fakeDb.queue('automation_steps', { error: null });
    await POST(jsonRequest('/api/usage/automation/steps', {
      token, body: body([step({ outcome: 'error', code: 'selector_miss' })]),
    }));
    expect(upsertedRows()[0].code).toBe('selector_miss');
  });

  it('does not look for the code inside detail', async () => {
    // MEAL-4 moved it out of detail deliberately; reading it from there would
    // quietly report every new-client failure as uncoded.
    fakeDb.queue('automation_runs', OWNED_RUN);
    fakeDb.queue('automation_steps', { error: null });
    await POST(jsonRequest('/api/usage/automation/steps', {
      token, body: body([step({ outcome: 'error', detail: { code: 'waf_block' } })]),
    }));
    expect(upsertedRows()[0].code).toBeNull();
  });

  it('KEEPS the row when the code is one this deploy has never heard of', async () => {
    // The whole point. A newer client's ninth code must cost us the attribution,
    // not the step: dropping the row hides the failure mode we just learned about
    // at exactly the moment it starts happening.
    fakeDb.queue('automation_runs', OWNED_RUN);
    fakeDb.queue('automation_steps', { error: null });
    const res = await POST(jsonRequest('/api/usage/automation/steps', {
      token, body: body([step({ seq: 0, outcome: 'error', code: 'captcha_wall' }), step({ seq: 1 })]),
    }));
    expect((await res.json()).inserted).toBe(2);
    expect(upsertedRows().map((r) => r.code)).toEqual(['captcha_wall', null]);
  });

  it('nulls a non-string code rather than storing garbage', async () => {
    fakeDb.queue('automation_runs', OWNED_RUN);
    fakeDb.queue('automation_steps', { error: null });
    await POST(jsonRequest('/api/usage/automation/steps', {
      token, body: body([step({ outcome: 'error', code: { evil: true } })]),
    }));
    expect(upsertedRows()[0].code).toBeNull();
  });

  it('clamps an absurdly long code instead of rejecting the row', async () => {
    fakeDb.queue('automation_runs', OWNED_RUN);
    fakeDb.queue('automation_steps', { error: null });
    const res = await POST(jsonRequest('/api/usage/automation/steps', {
      token, body: body([step({ outcome: 'error', code: 'x'.repeat(500) })]),
    }));
    expect((await res.json()).inserted).toBe(1);
    expect(upsertedRows()[0].code).toHaveLength(40);
  });

  it('leaves code null on an ok row that sends none', async () => {
    // The permanent NULL case: a code describes a failure, so most rows in the
    // table will never have one and the dashboard must not read that as zero.
    fakeDb.queue('automation_runs', OWNED_RUN);
    fakeDb.queue('automation_steps', { error: null });
    await POST(jsonRequest('/api/usage/automation/steps', { token, body: body([step()]) }));
    expect(upsertedRows()[0].code).toBeNull();
  });

  it('500s when the insert fails so the client retries', async () => {
    fakeDb.queue('automation_runs', OWNED_RUN);
    fakeDb.queue('automation_steps', { error: { message: 'db down' } });
    const res = await POST(jsonRequest('/api/usage/automation/steps', { token, body: body([step()]) }));
    expect(res.status).toBe(500);
  });
});

// ── MEAL-219: the store's own answer, stored as a fact ──────────────────────
//
// Every rail computes an HTTP status and, until this ticket, dropped it at the
// WebView boundary. These pin what the ingest does with the four new fields —
// and, more importantly, what it refuses to do: reject a row over one of them.
describe('POST /api/usage/automation/steps — request telemetry', () => {
  let token: string;

  beforeEach(async () => {
    fakeDb.reset();
    token = await createAccessToken('user-1', 'a@b.test');
  });

  const send = async (over: Record<string, unknown>) => {
    fakeDb.queue('automation_runs', OWNED_RUN);
    return POST(jsonRequest('/api/usage/automation/steps', {
      token, body: body([step({ step: 'search', outcome: 'error', ...over })]),
    }));
  };

  it('stores status, phase, attempts and rail as columns', async () => {
    await send({ httpStatus: 503, phase: 'search', attempts: 3, rail: 'heb' });
    expect(upsertedRows()[0]).toMatchObject({
      http_status: 503, phase: 'search', attempts: 3, rail: 'heb',
    });
  });

  it('keeps NULL distinct from a 5xx', async () => {
    // A request that got no answer at all — dropped, aborted — is a different
    // fact from one the store answered badly, and folding them together is how
    // "the store is down" and "we did not wait long enough" become one bar.
    await send({ phase: 'search', attempts: 1 });
    expect(upsertedRows()[0].http_status).toBeNull();
  });

  it('refuses a status that is not one', async () => {
    // The column is smallint. A number past 32767 would be rejected by Postgres
    // and fail the WHOLE batch rather than one field, losing the run's funnel.
    for (const bad of [0, -1, 99, 600, 99999, 'x', null]) {
      await send({ httpStatus: bad });
      expect(upsertedRows()[0].http_status).toBeNull();
      fakeDb.reset();
      token = await createAccessToken('user-1', 'a@b.test');
    }
  });

  it('clamps attempts rather than passing an unbounded number through', async () => {
    // This arrives from a script running in a page we do not control.
    await send({ attempts: 100000 });
    expect(upsertedRows()[0].attempts).toBe(99);
  });

  it('stores a phase it has never heard of instead of dropping the row', async () => {
    // The rule the `code` field already follows, for the same reason: a newer
    // client shipping a fifth phase must not have its rows silently deleted by
    // an older deploy. That loses the rows most worth having at exactly the
    // moment something new is happening.
    const res = await send({ phase: 'checkout', httpStatus: 500 });
    expect(res.status).toBe(200);
    expect(upsertedRows()).toHaveLength(1);
    expect(upsertedRows()[0].phase).toBe('checkout');
    expect(upsertedRows()[0].http_status).toBe(500);
  });

  it('still stores a row that carries none of them', async () => {
    // Every row written before this ticket, and every row from an older client.
    fakeDb.queue('automation_runs', OWNED_RUN);
    const res = await POST(jsonRequest('/api/usage/automation/steps', {
      token, body: body([step()]),
    }));
    expect(res.status).toBe(200);
    expect(upsertedRows()).toHaveLength(1);
    expect(upsertedRows()[0]).toMatchObject({ http_status: null, phase: null, attempts: null, rail: null });
  });
});
