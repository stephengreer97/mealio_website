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

  it('lists connected platforms without carrying a token into the response', async () => {
    asAdmin();
    fakeDb.queue('creators', { data: [READY] });
    fakeDb.queue('creator_platform_accounts', {
      data: [
        {
          creator_id: 'c1',
          platform: 'youtube',
          external_id: 'UCabcdefghijklmnopqrstuv',
          external_name: 'Chef Sarah',
          broken_reason: 'Token has been expired or revoked.',
          broken_at: '2026-08-01T00:00:00.000Z',
        },
      ],
    });

    const body = await (await GET(jsonRequest('/api/admin/creators', { method: 'GET', token }))).json();

    // A broken grant is otherwise indistinguishable from a creator who published
    // nothing, so it belongs on the list an operator already reads.
    expect(body.creators[0].connections).toEqual([
      {
        platform: 'youtube',
        externalId: 'UCabcdefghijklmnopqrstuv',
        externalName: 'Chef Sarah',
        brokenReason: 'Token has been expired or revoked.',
        brokenAt: '2026-08-01T00:00:00.000Z',
      },
    ]);
    // Column-by-column selection, not `select *`: this table holds refresh tokens.
    const select = fakeDb.calls.find((call) => call.table === 'creator_platform_accounts' && call.method === 'select');
    expect(select?.args[0]).not.toContain('refresh_token');
    expect(select?.args[0]).not.toContain('access_token');
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

    /**
     * The guards are about a *combination* of columns, so they have to be
     * judged against the row the request would leave behind. Judging only the
     * fields a request happened to send judges nothing: both buttons in the
     * admin UI send exactly one field.
     */
    describe('judged against the resulting row, whatever the request contained', () => {
      const OPTED_IN = { ...READY, import_opt_in: true };

      it('refuses a source switch that would leave an opted-in creator with no link', async () => {
        // The radio button sends `{primarySource}` alone. Without this the card
        // reads "Polling YouTube" for a creator who has no YouTube link at all.
        asAdmin();
        fakeDb.queue('creators', { data: OPTED_IN });
        const res = await PATCH(jsonRequest('/api/admin/creators', {
          method: 'PATCH', token, body: { id: 'c1', primarySource: 'youtube' },
        }));
        expect(res.status).toBe(400);
        expect((await res.json()).error).toMatch(/no YouTube link/i);
        expect(fakeDb.calls.some((c) => c.method === 'update')).toBe(false);
      });

      it('refuses clearing the feed of a creator already polling their website', async () => {
        // *Confirm this feed* sends `{feedUrl}` alone, and a blank one
        // normalises to null — leaving import on against a website with nothing
        // to poll, the state the confirm step exists to prevent.
        asAdmin();
        fakeDb.queue('creators', { data: OPTED_IN });
        const res = await PATCH(jsonRequest('/api/admin/creators', {
          method: 'PATCH', token, body: { id: 'c1', feedUrl: '' },
        }));
        expect(res.status).toBe(400);
        expect((await res.json()).error).toMatch(/Confirm the discovered feed/i);
        expect(fakeDb.calls.some((c) => c.method === 'update')).toBe(false);
      });

      it('allows a source switch to a link the creator actually has', async () => {
        asAdmin();
        fakeDb.queue('creators', { data: OPTED_IN });
        fakeDb.queue('creators', { data: null, error: null });
        const res = await PATCH(jsonRequest('/api/admin/creators', {
          method: 'PATCH', token, body: { id: 'c1', primarySource: 'tiktok' },
        }));
        expect(res.status).toBe(200);
      });
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

    it('refuses the hosting platform’s own root for a creator on a subdomain of it', async () => {
      // "Shares a parent domain" is not "same site" without a public suffix
      // list: sarah.wordpress.com and wordpress.com share one, and a feed on
      // the platform root is every other tenant's posts.
      asAdmin();
      fakeDb.queue('creators', { data: { ...READY, website_url: 'https://sarah.wordpress.com/' } });
      const res = await PATCH(jsonRequest('/api/admin/creators', {
        method: 'PATCH', token, body: { id: 'c1', feedUrl: 'https://wordpress.com/feed' },
      }));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/not on the creator's own site/i);
    });

    it('still accepts the apex feed of a www. site', async () => {
      // The one parent-direction match that happens in real life, and the
      // reason the branch above exists at all.
      asAdmin();
      fakeDb.queue('creators', { data: { ...READY, website_url: 'https://www.chefsarah.test/' } });
      fakeDb.queue('creators', { data: null, error: null });
      const res = await PATCH(jsonRequest('/api/admin/creators', {
        method: 'PATCH', token, body: { id: 'c1', feedUrl: 'https://chefsarah.test/feed' },
      }));
      expect(res.status).toBe(200);
    });

    it('refuses turning import on against a feed the website has since moved away from', async () => {
      // The pairing was confirmed once, against the website as it stood then.
      // Checking it only when the *feed* is submitted holds the two together
      // only while the website link never moves — and a creator can move theirs
      // (MEAL-94). So the rule is judged on the row, from either side: the
      // stored feed here is on a host this creator's site no longer is.
      asAdmin();
      fakeDb.queue('creators', {
        data: { ...READY, website_url: 'https://sarahcooks.test/', feed_url: 'https://chefsarah.test/feed' },
      });
      const res = await PATCH(jsonRequest('/api/admin/creators', {
        method: 'PATCH', token, body: { id: 'c1', importOptIn: true },
      }));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/not on the creator's own site/i);
      // Nothing written: an operator re-confirms the feed for the new host, and
      // only then is there something coherent to poll.
      expect(fakeDb.calls.some((c) => c.method === 'update')).toBe(false);
    });

    it.each([
      ['a trailing dot on the feed', 'https://chefsarah.test/', 'https://chefsarah.test./feed'],
      ['a trailing dot on the site', 'https://chefsarah.test./', 'https://chefsarah.test/feed'],
    ])('treats %s as the same host', async (_label, website, feedUrl) => {
      // The DNS root's trailing dot names the same host. Rejecting it made such
      // a creator permanently unconfirmable in both directions, so they could
      // never be opted in at all.
      asAdmin();
      fakeDb.queue('creators', { data: { ...READY, website_url: website } });
      fakeDb.queue('creators', { data: null, error: null });
      const res = await PATCH(jsonRequest('/api/admin/creators', {
        method: 'PATCH', token, body: { id: 'c1', feedUrl },
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

    // `feedUrl` is the field the route actually reads and hands to the fetcher.
    // This test used to send `link`, a key the route has never looked at, and
    // passed because nothing happened — while the one body field that *is*
    // fetched went untested.
    const res = await VIABILITY(jsonRequest('/api/admin/creators/viability', {
      token,
      body: { id: 'c1', source: 'website', feedUrl: 'https://chefsarah.test/other.xml' },
    }));

    expect(res.status).toBe(200);
    expect((await res.json()).report.outcome).toBe('viable');
    expect(runViabilityCheck).toHaveBeenCalledWith('website', 'https://chefsarah.test/', expect.anything());
  });

  it('refuses a feed URL in the body that is on somebody else’s host', async () => {
    // This endpoint makes our server fetch a URL, parse it, and fetch every
    // entry it lists. A body field doing that has to clear the same host rule
    // PATCH applies before storing one — a rule enforced on the endpoint that
    // writes the value and not on the one that acts on it does not exist.
    asAdmin();
    fakeDb.queue('creators', { data: READY });

    const res = await VIABILITY(jsonRequest('/api/admin/creators/viability', {
      token,
      body: { id: 'c1', source: 'website', feedUrl: 'https://attacker.test/feed' },
    }));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/not on the creator's own site/i);
    expect(runViabilityCheck).not.toHaveBeenCalled();
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
