import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeDb } from '../helpers/supabase-mock';
import { jsonRequest } from '../helpers/request';

vi.mock('@/lib/supabase', async () =>
  (await import('../helpers/supabase-mock')).mockSupabaseModule());
vi.mock('@/lib/logger', () => ({ log: vi.fn() }));

import { GET } from '@/app/api/automation/config/route';
import { createAccessToken } from '@/lib/tokens';

// The client-facing config endpoint. Its contract is what makes remote config safe
// to push without gating on app version, so the tests pin: auth is required, an
// absent config is a valid 200 (not a 404 the client must special-case), and the
// ETag lets a cold start cost no body.

describe('GET /api/automation/config', () => {
  let token: string;

  beforeEach(async () => {
    fakeDb.reset();
    token = await createAccessToken('user-1', 'a@b.test');
  });

  it('401 without a token', async () => {
    const res = await GET(jsonRequest('/api/automation/config', { method: 'GET' }));
    expect(res.status).toBe(401);
  });

  it('401 with a garbage token', async () => {
    const res = await GET(jsonRequest('/api/automation/config', { method: 'GET', token: 'not-a-jwt' }));
    expect(res.status).toBe(401);
  });

  it('returns the active config with its version', async () => {
    fakeDb.queue('automation_config', {
      data: { version: 7, config: { timeouts: { addMs: 20000 } }, created_at: '2026-07-01T00:00:00Z' },
      error: null,
    });
    const res = await GET(jsonRequest('/api/automation/config', { method: 'GET', token }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.version).toBe(7);
    expect(body.config).toEqual({ timeouts: { addMs: 20000 } });
  });

  it('returns version 0 and empty overrides when no row is active', async () => {
    // NOT a 404: the client treats this exactly like the bundled default, so a
    // fresh install with no published config needs no special case.
    fakeDb.queue('automation_config', { data: null, error: null });
    const res = await GET(jsonRequest('/api/automation/config', { method: 'GET', token }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.version).toBe(0);
    expect(body.config).toEqual({});
  });

  it('coerces a non-object config to {} rather than passing it through', async () => {
    fakeDb.queue('automation_config', { data: { version: 3, config: 'garbage', created_at: null }, error: null });
    const body = await (await GET(jsonRequest('/api/automation/config', { method: 'GET', token }))).json();
    expect(body.config).toEqual({});
  });

  it('500s on a database error', async () => {
    fakeDb.queue('automation_config', { data: null, error: { message: 'boom' } });
    const res = await GET(jsonRequest('/api/automation/config', { method: 'GET', token }));
    expect(res.status).toBe(500);
  });

  it('sets an ETag derived from the version', async () => {
    fakeDb.queue('automation_config', { data: { version: 7, config: {}, created_at: null }, error: null });
    const res = await GET(jsonRequest('/api/automation/config', { method: 'GET', token }));
    expect(res.headers.get('etag')).toBe('"automation-config-v7"');
  });

  it('304s when If-None-Match matches', async () => {
    // The app polls on every cold start; the common case must cost no body.
    fakeDb.queue('automation_config', { data: { version: 7, config: {}, created_at: null }, error: null });
    const res = await GET(jsonRequest('/api/automation/config', {
      method: 'GET', token, headers: { 'if-none-match': '"automation-config-v7"' },
    }));
    expect(res.status).toBe(304);
  });

  it('200s when If-None-Match is for an older version', async () => {
    fakeDb.queue('automation_config', { data: { version: 8, config: { a: 1 }, created_at: null }, error: null });
    const res = await GET(jsonRequest('/api/automation/config', {
      method: 'GET', token, headers: { 'if-none-match': '"automation-config-v7"' },
    }));
    expect(res.status).toBe(200);
    expect((await res.json()).version).toBe(8);
  });

  it('only ever reads the active row', async () => {
    fakeDb.queue('automation_config', { data: { version: 1, config: {}, created_at: null }, error: null });
    await GET(jsonRequest('/api/automation/config', { method: 'GET', token }));
    const eqCalls = fakeDb.calls.filter((c) => c.table === 'automation_config' && c.method === 'eq');
    expect(eqCalls).toEqual([expect.objectContaining({ args: ['is_active', true] })]);
  });
});
