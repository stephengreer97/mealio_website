// MEAL-219. The endpoint behind the Requests panel.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeDb } from '../helpers/supabase-mock';
import { jsonRequest } from '../helpers/request';

vi.mock('@/lib/supabase', async () =>
  (await import('../helpers/supabase-mock')).mockSupabaseModule());
vi.mock('@/lib/logger', () => ({ log: vi.fn() }));
vi.mock('@/lib/requireAdmin', () => ({
  requireAdmin: vi.fn(async () => ({ userId: 'admin-1', email: 'a@b.test' })),
}));

import { GET } from '@/app/api/admin/automation-requests/route';
import { requireAdmin } from '@/lib/requireAdmin';

const URL_ = '/api/admin/automation-requests';

const row = (over: Record<string, unknown> = {}) => ({
  store_id: 'heb', rail: 'heb', phase: 'search', outcome: 'ok',
  code: null, http_status: 200, attempts: 1, duration_ms: 120, ...over,
});

describe('GET /api/admin/automation-requests', () => {
  beforeEach(() => {
    fakeDb.reset();
    vi.mocked(requireAdmin).mockResolvedValue({ userId: 'admin-1', email: 'a@b.test' } as never);
  });

  it('403 for a non-admin', async () => {
    vi.mocked(requireAdmin).mockResolvedValue(null as never);
    expect((await GET(jsonRequest(URL_, {}) as never)).status).toBe(403);
  });

  it('aggregates the rows it read', async () => {
    fakeDb.queue('automation_steps', {
      data: [row(), row({ http_status: 500, outcome: 'error', code: 'confirm_failed', attempts: 3 })],
      error: null,
    });
    const json = await (await GET(jsonRequest(`${URL_}?days=7`, {}) as never)).json();
    expect(json.stores).toHaveLength(1);
    expect(json.stores[0].requests).toBe(2);
    expect(json.stores[0].okRate).toBe(0.5);
    expect(json.days).toBe(7);
  });

  it('SAYS WHICH MIGRATION when the columns are not there yet', async () => {
    // The columns arrive by a migration someone runs by hand, so "not run yet"
    // is a normal state for this endpoint to meet. Rendering it as a 500 would
    // tell the admin something broke; the answer is one SQL file away and the
    // message should name it.
    fakeDb.queue('automation_steps', {
      data: null,
      error: { code: '42703', message: 'column "phase" does not exist' },
    });
    const res = await GET(jsonRequest(URL_, {}) as never);
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.needsMigration).toBe(true);
    expect(json.error).toContain('20260905000001');
  });

  it('still 500s on a real failure', async () => {
    fakeDb.queue('automation_steps', { data: null, error: { code: '08006', message: 'connection failure' } });
    expect((await GET(jsonRequest(URL_, {}) as never)).status).toBe(500);
  });

  it('caps the window rather than trusting the query string', async () => {
    fakeDb.queue('automation_steps', { data: [], error: null });
    const json = await (await GET(jsonRequest(`${URL_}?days=99999`, {}) as never)).json();
    expect(json.days).toBe(90);
  });

  it('falls back to a sane window for rubbish', async () => {
    fakeDb.queue('automation_steps', { data: [], error: null });
    const json = await (await GET(jsonRequest(`${URL_}?days=abc`, {}) as never)).json();
    expect(json.days).toBe(7);
  });
});
