import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeDb } from '../helpers/supabase-mock';
import { jsonRequest } from '../helpers/request';

// vi.mock is hoisted above imports, so the factory must import the helper
// dynamically rather than close over the static import.
vi.mock('@/lib/supabase', async () =>
  (await import('../helpers/supabase-mock')).mockSupabaseModule());
vi.mock('@/lib/logger', () => ({ log: vi.fn() }));

const runViabilityCheck = vi.fn();
vi.mock('@/lib/import/viability', () => ({
  runViabilityCheck: (...args: unknown[]) => runViabilityCheck(...args),
}));

import { GET, PATCH } from '@/app/api/admin/creators/route';
import { POST as VIABILITY } from '@/app/api/admin/creators/viability/route';
import { clearRevocationCache, createAccessToken } from '@/lib/tokens';

/** A creator with a website and a confirmed feed — the ready-to-poll shape. */
const READY = {
  id: 'c1',
  display_name: 'Chef Sarah',
  handle: 'chefsarah',
  website_url: 'https://chefsarah.test/',
  youtube_url: null,
  instagram_url: null,
  tiktok_url: 'https://tiktok.com/@chefsarah',
  primary_source: 'website',
  import_opt_in: false,
  feed_url: 'https://chefsarah.test/feed',
};

/**
 * Queues the two `user_profiles` reads one admin request makes: the token
 * revocation check (memoised for 30s, hence the cache clear) and `is_admin`.
 */
function asAdmin(isAdmin = true) {
  clearRevocationCache();
  fakeDb.queue('user_profiles', { data: { tokens_invalidated_at: null } });
  fakeDb.queue('user_profiles', { data: { is_admin: isAdmin } });
}

describe('/api/admin/creators', () => {
  let token: string;

  beforeEach(async () => {
    fakeDb.reset();
    runViabilityCheck.mockReset();
    token = await createAccessToken('admin-1', 'admin@mealio.co');
  });

  it('403 for a non-admin, on both verbs', async () => {
    asAdmin(false);
    expect((await GET(jsonRequest('/api/admin/creators', { method: 'GET', token }))).status).toBe(403);
    asAdmin(false);
    expect((await PATCH(jsonRequest('/api/admin/creators', { method: 'PATCH', token, body: { id: 'c1' } }))).status).toBe(403);
  });

  it('lists creators with their four links and polling settings', async () => {
    asAdmin();
    fakeDb.queue('creators', { data: [READY] });
    const res = await GET(jsonRequest('/api/admin/creators', { method: 'GET', token }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.creators[0]).toMatchObject({ website_url: 'https://chefsarah.test/', primary_source: 'website' });
  });

  it('sets the primary source', async () => {
    asAdmin();
    fakeDb.queue('creators', { data: { ...READY, primary_source: 'none' } });
    fakeDb.queue('creators', { data: null, error: null }); // the update
    const res = await PATCH(jsonRequest('/api/admin/creators', { method: 'PATCH', token, body: { id: 'c1', primarySource: 'tiktok' } }));
    expect(res.status).toBe(200);
    const update = fakeDb.calls.find((c) => c.method === 'update');
    expect(update?.args[0]).toMatchObject({ primary_source: 'tiktok' });
  });

  it('rejects a source outside the schema constraint', async () => {
    asAdmin();
    const res = await PATCH(jsonRequest('/api/admin/creators', { method: 'PATCH', token, body: { id: 'c1', primarySource: 'substack' } }));
    expect(res.status).toBe(400);
  });

  describe('nothing is polled until a source is chosen AND opt-in is true', () => {
    it('refuses opt-in while the source is none', async () => {
      asAdmin();
      fakeDb.queue('creators', { data: { ...READY, primary_source: 'none' } });
      const res = await PATCH(jsonRequest('/api/admin/creators', { method: 'PATCH', token, body: { id: 'c1', importOptIn: true } }));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/before turning import on/i);
      expect(fakeDb.calls.some((c) => c.method === 'update')).toBe(false);
    });

    it('refuses opt-in for a source the creator has no link for', async () => {
      asAdmin();
      fakeDb.queue('creators', { data: { ...READY, primary_source: 'youtube' } });
      const res = await PATCH(jsonRequest('/api/admin/creators', { method: 'PATCH', token, body: { id: 'c1', importOptIn: true } }));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/no YouTube link/i);
    });

    it('refuses opt-in for a website whose feed has not been confirmed', async () => {
      // The feed URL is what the poller reads, and a discovery nobody looked at
      // is exactly the silent-wrong-guess case.
      asAdmin();
      fakeDb.queue('creators', { data: { ...READY, feed_url: null } });
      const res = await PATCH(jsonRequest('/api/admin/creators', { method: 'PATCH', token, body: { id: 'c1', importOptIn: true } }));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/Confirm the discovered feed/i);
    });

    it('allows opt-in once source, link and feed are all in place', async () => {
      asAdmin();
      fakeDb.queue('creators', { data: READY });
      fakeDb.queue('creators', { data: null, error: null });
      const res = await PATCH(jsonRequest('/api/admin/creators', { method: 'PATCH', token, body: { id: 'c1', importOptIn: true } }));
      expect(res.status).toBe(200);
      expect(fakeDb.calls.find((c) => c.method === 'update')?.args[0]).toMatchObject({ import_opt_in: true });
    });

    it('clearing the source turns polling off with it', async () => {
      asAdmin();
      fakeDb.queue('creators', { data: { ...READY, import_opt_in: true } });
      fakeDb.queue('creators', { data: null, error: null });
      const res = await PATCH(jsonRequest('/api/admin/creators', { method: 'PATCH', token, body: { id: 'c1', primarySource: 'none' } }));
      expect(res.status).toBe(200);
      expect(fakeDb.calls.find((c) => c.method === 'update')?.args[0]).toMatchObject({
        primary_source: 'none',
        import_opt_in: false,
      });
    });
  });

  describe('feed_url', () => {
    it('stores a feed on the creator’s own host', async () => {
      asAdmin();
      fakeDb.queue('creators', { data: { ...READY, feed_url: null } });
      fakeDb.queue('creators', { data: null, error: null });
      const res = await PATCH(jsonRequest('/api/admin/creators', {
        method: 'PATCH', token, body: { id: 'c1', feedUrl: 'https://chefsarah.test/feed.xml' },
      }));
      expect(res.status).toBe(200);
      expect(fakeDb.calls.find((c) => c.method === 'update')?.args[0]).toMatchObject({
        feed_url: 'https://chefsarah.test/feed.xml',
      });
    });

    it('refuses a feed on somebody else’s host', async () => {
      // This field is read by the poller forever after. A cross-host value is
      // how a stranger's recipes get imported under a creator's name.
      asAdmin();
      fakeDb.queue('creators', { data: READY });
      const res = await PATCH(jsonRequest('/api/admin/creators', {
        method: 'PATCH', token, body: { id: 'c1', feedUrl: 'https://someoneelse.test/feed' },
      }));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/not on the creator's own site/i);
    });

    it('accepts a subdomain of the creator’s site', async () => {
      asAdmin();
      fakeDb.queue('creators', { data: READY });
      fakeDb.queue('creators', { data: null, error: null });
      const res = await PATCH(jsonRequest('/api/admin/creators', {
        method: 'PATCH', token, body: { id: 'c1', feedUrl: 'https://feeds.chefsarah.test/rss' },
      }));
      expect(res.status).toBe(200);
    });
  });
});

describe('/api/admin/creators/viability', () => {
  let token: string;

  beforeEach(async () => {
    fakeDb.reset();
    runViabilityCheck.mockReset();
    token = await createAccessToken('admin-1', 'admin@mealio.co');
  });

  it('403 for a non-admin, and nothing is fetched', async () => {
    asAdmin(false);
    const res = await VIABILITY(jsonRequest('/api/admin/creators/viability', { token, body: { id: 'c1', source: 'website' } }));
    expect(res.status).toBe(403);
    // This endpoint makes our server fetch a URL; it must never run for an
    // unauthorised caller.
    expect(runViabilityCheck).not.toHaveBeenCalled();
  });

  it('400 for a source outside the four', async () => {
    asAdmin();
    const res = await VIABILITY(jsonRequest('/api/admin/creators/viability', { token, body: { id: 'c1', source: 'substack' } }));
    expect(res.status).toBe(400);
    expect(runViabilityCheck).not.toHaveBeenCalled();
  });

  it('400 when the creator has no link for that source', async () => {
    asAdmin();
    fakeDb.queue('creators', { data: { ...READY, youtube_url: null } });
    const res = await VIABILITY(jsonRequest('/api/admin/creators/viability', { token, body: { id: 'c1', source: 'youtube' } }));
    expect(res.status).toBe(400);
    expect(runViabilityCheck).not.toHaveBeenCalled();
  });

  it('checks the link stored on the creator, never one from the request body', async () => {
    asAdmin();
    fakeDb.queue('creators', { data: READY });
    runViabilityCheck.mockResolvedValue({ outcome: 'viable', passed: 3, checked: 4, costUsd: 0.001, items: [], feed: null });

    const res = await VIABILITY(jsonRequest('/api/admin/creators/viability', {
      token,
      body: { id: 'c1', source: 'website', link: 'https://attacker.test/' },
    }));

    expect(res.status).toBe(200);
    expect((await res.json()).report.outcome).toBe('viable');
    expect(runViabilityCheck).toHaveBeenCalledWith('website', 'https://chefsarah.test/', expect.anything());
  });

  it('re-reads a confirmed feed rather than re-discovering it', async () => {
    asAdmin();
    fakeDb.queue('creators', { data: READY });
    runViabilityCheck.mockResolvedValue({ outcome: 'viable', passed: 3, checked: 4, costUsd: 0, items: [], feed: null });

    await VIABILITY(jsonRequest('/api/admin/creators/viability', { token, body: { id: 'c1', source: 'website' } }));

    expect(runViabilityCheck).toHaveBeenCalledWith(
      'website',
      'https://chefsarah.test/',
      expect.objectContaining({ feedUrl: 'https://chefsarah.test/feed' }),
    );
  });

  it('writes nothing — the operator commits the result themselves', async () => {
    asAdmin();
    fakeDb.queue('creators', { data: READY });
    runViabilityCheck.mockResolvedValue({
      outcome: 'not-viable', passed: 0, checked: 5, costUsd: 0.002, items: [],
      feed: { url: 'https://chefsarah.test/feed', kind: 'rss', via: 'well-known', entries: [] },
    });

    await VIABILITY(jsonRequest('/api/admin/creators/viability', { token, body: { id: 'c1', source: 'website' } }));

    expect(fakeDb.calls.some((c) => ['update', 'insert', 'upsert', 'delete'].includes(c.method))).toBe(false);
  });
});
