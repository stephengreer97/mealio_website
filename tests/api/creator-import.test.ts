import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeDb } from '../helpers/supabase-mock';
import { jsonRequest } from '../helpers/request';

// vi.mock is hoisted above imports, so the factory must import the helper
// dynamically rather than close over the static import.
vi.mock('@/lib/supabase', async () =>
  (await import('../helpers/supabase-mock')).mockSupabaseModule());
vi.mock('@/lib/logger', () => ({ log: vi.fn() }));

const runImport = vi.fn();
vi.mock('@/lib/import/pipeline', () => ({ runImport: (...args: unknown[]) => runImport(...args) }));

import { POST } from '@/app/api/creator/import/route';
import { createAccessToken } from '@/lib/tokens';

const OK_RESULT = {
  status: 'ok',
  url: 'https://blog.example.com/pasta',
  draft: { name: 'Pasta', ingredients: [], recipe: null, source: 'https://blog.example.com/pasta', story: null, photoUrl: null, difficulty: null, tags: [], serves: null },
  confidence: { name: { level: 'green' }, ingredients: [] },
  gate: { verdict: 'yes', reason: 'r', source: 'json-ld' },
  meta: { usedJsonLd: true, path: 'json-ld', platform: 'wordpress', cached: false, redirects: [], usage: null, gateUsage: null },
};

describe('/api/creator/import', () => {
  let token: string;

  beforeEach(async () => {
    fakeDb.reset();
    runImport.mockReset();
    token = await createAccessToken('user-1', 'a@b.test');
  });

  it('403 without a token', async () => {
    const res = await POST(jsonRequest('/api/creator/import', { body: { url: 'https://x.example.com/p' } }));
    expect(res.status).toBe(403);
    expect(runImport).not.toHaveBeenCalled();
  });

  it('403 when the authenticated user is not a creator', async () => {
    // No `creators` row queued — the mock resolves to null, i.e. not found.
    const res = await POST(
      jsonRequest('/api/creator/import', { token, body: { url: 'https://x.example.com/p' } }),
    );
    expect(res.status).toBe(403);
    // Never fetch a user-supplied URL on behalf of an unauthorised caller.
    expect(runImport).not.toHaveBeenCalled();
  });

  it('400 when url is missing', async () => {
    fakeDb.queue('creators', { data: { id: 'c1', display_name: 'Ruth' } });
    const res = await POST(jsonRequest('/api/creator/import', { token, body: {} }));
    expect(res.status).toBe(400);
    expect(runImport).not.toHaveBeenCalled();
  });

  it('200 with the draft on success, in manual gate mode', async () => {
    fakeDb.queue('creators', { data: { id: 'c1', display_name: 'Ruth' } });
    runImport.mockResolvedValue(OK_RESULT);

    const res = await POST(
      jsonRequest('/api/creator/import', { token, body: { url: 'https://blog.example.com/pasta' } }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.draft.name).toBe('Pasta');
    // A creator pasted this link and is watching, so unsure means attempt.
    expect(runImport).toHaveBeenCalledWith(
      'https://blog.example.com/pasta',
      expect.objectContaining({ mode: 'manual' }),
    );
  });

  it('422 with the rejection body when the pipeline stops', async () => {
    fakeDb.queue('creators', { data: { id: 'c1', display_name: 'Ruth' } });
    runImport.mockResolvedValue({
      status: 'rejected',
      url: 'https://blog.example.com/about',
      stage: 'gate',
      reason: 'gate-no',
      detail: 'Not a recipe: About page.',
      meta: { cached: false },
    });

    const res = await POST(
      jsonRequest('/api/creator/import', { token, body: { url: 'https://blog.example.com/about' } }),
    );

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.stage).toBe('gate');
    expect(body.detail).toContain('About page');
  });
});
