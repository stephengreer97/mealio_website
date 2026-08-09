import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeDb } from '../helpers/supabase-mock';
import { jsonRequest } from '../helpers/request';

vi.mock('@/lib/supabase', async () =>
  (await import('../helpers/supabase-mock')).mockSupabaseModule());
vi.mock('@/lib/logger', () => ({ log: vi.fn() }));

import { GET } from '@/app/api/stores/route';
import { createAccessToken } from '@/lib/tokens';

// The store catalog (MEAL-23). Its whole point is that a store can be added
// without an app release, so the tests pin the properties that make the app safe
// to point at it: the payload is display data only, the order is stable, the
// version never labels data it did not come with, and every failure mode leaves
// the client on its bundled list rather than on a half-catalog.

/** Two rows, in the order the endpoint should return them. */
const ROWS = [
  {
    id: 'aldi', name: 'ALDI', color: '#02205F', slug: 'aldi',
    banner_group: 'ALDI', platform: 'instacart', host: 'aldi.us',
    serving_area: null, is_listed: true,
  },
  {
    id: 'heb', name: 'H-E-B', color: '#dd0031', slug: 'heb',
    banner_group: 'H-E-B', platform: 'heb', host: 'heb.com',
    serving_area: 'Texas', is_listed: true,
  },
];

/** The catalog in its normal state: a version row and some listed stores. */
function seedCatalog(rows: any[] = ROWS, version = 12) {
  fakeDb.seed('store_catalog_version', [
    { id: 1, version, updated_at: '2026-08-08T00:00:00Z' },
  ]);
  fakeDb.seed('stores', rows);
}

const get = (headers?: Record<string, string>, token?: string) =>
  GET(jsonRequest('/api/stores', { method: 'GET', ...(headers ? { headers } : {}), ...(token ? { token } : {}) }));

describe('GET /api/stores', () => {
  beforeEach(() => {
    fakeDb.reset();
  });

  // ── The payload ───────────────────────────────────────────────────────────

  it('returns the catalog with its version', async () => {
    seedCatalog();
    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.version).toBe(12);
    expect(body.updatedAt).toBe('2026-08-08T00:00:00Z');
    expect(body.stores).toHaveLength(2);
  });

  it('maps snake_case columns to the camelCase contract the app builds against', async () => {
    // The other half of MEAL-23 is written against these exact key names.
    seedCatalog();
    const body = await (await get()).json();
    expect(body.stores[1]).toEqual({
      id: 'heb',
      name: 'H-E-B',
      color: '#dd0031',
      slug: 'heb',
      bannerGroup: 'H-E-B',
      platform: 'heb',
      host: 'heb.com',
      servingArea: 'Texas',
    });
  });

  it('serves display data only — no field claims a store can be automated', async () => {
    // Capability lives in the app's KROGER_BRAND_IDS / WEBVIEW_STORE_IDS,
    // because those assert what code the BINARY contains and no row can make
    // that true. A boolean here would be a promise the server cannot keep, so
    // the shape is pinned exactly and nothing may quietly join it.
    seedCatalog();
    const body = await (await get()).json();
    expect(Object.keys(body.stores[0]).sort()).toEqual([
      'bannerGroup', 'color', 'host', 'id', 'name', 'platform', 'servingArea', 'slug',
    ]);
  });

  it('nulls an absent optional field rather than dropping the key', async () => {
    seedCatalog([{ ...ROWS[0], banner_group: null, platform: null, host: null, serving_area: null }]);
    const body = await (await get()).json();
    expect(body.stores[0]).toMatchObject({
      bannerGroup: null, platform: null, host: null, servingArea: null,
    });
  });

  // ── Auth ──────────────────────────────────────────────────────────────────

  it('is public — no token required', async () => {
    // The public shared-meal page renders a store picker for visitors with no
    // account, and the app needs its picker before it has a token at cold start.
    seedCatalog();
    expect((await get()).status).toBe(200);
  });

  it('returns the same catalog to an authenticated caller', async () => {
    seedCatalog();
    const token = await createAccessToken('user-1', 'a@b.test');
    const anon = await (await get()).json();
    fakeDb.reset();
    seedCatalog();
    const authed = await (await get(undefined, token)).json();
    expect(authed).toEqual(anon);
  });

  it('does not reject a garbage token, because it never reads one', async () => {
    seedCatalog();
    expect((await get(undefined, 'not-a-jwt')).status).toBe(200);
  });

  // ── Ordering ──────────────────────────────────────────────────────────────

  it('orders by id, so the picker cannot reshuffle between fetches', async () => {
    seedCatalog([
      { ...ROWS[1], id: 'walmart', slug: 'walmart' },
      { ...ROWS[0], id: 'acme', slug: 'acme' },
      { ...ROWS[0], id: 'kroger', slug: 'kroger' },
    ]);
    const body = await (await get()).json();
    expect(body.stores.map((s: any) => s.id)).toEqual(['acme', 'kroger', 'walmart']);
  });

  it('asks the database for that order rather than sorting afterwards', async () => {
    // The `.order()` is also what makes the paged walk total: an OFFSET walk
    // with no ORDER BY may repeat one row and skip another.
    seedCatalog();
    await get();
    const orders = fakeDb.calls.filter((c) => c.table === 'stores' && c.method === 'order');
    expect(orders).toEqual([expect.objectContaining({ args: ['id', { ascending: true }] })]);
  });

  // ── The row ceiling ───────────────────────────────────────────────────────

  it('pages the read, so it stays correct past db-max-rows', async () => {
    // 36 rows is nowhere near 1000 — but an unbounded select truncates silently,
    // and the symptom here would be stores missing from the picker with nothing
    // on screen to say why.
    seedCatalog();
    await get();
    const ranges = fakeDb.calls.filter((c) => c.table === 'stores' && c.method === 'range');
    expect(ranges.length).toBeGreaterThanOrEqual(1);
    expect(ranges[0].args).toEqual([0, 999]);
  });

  it('reads a catalog larger than one page in full', async () => {
    const many = Array.from({ length: 1400 }, (_, i) => ({
      ...ROWS[0],
      id: `store_${String(i).padStart(4, '0')}`,
      slug: `store-${String(i).padStart(4, '0')}`,
    }));
    seedCatalog(many);
    const body = await (await get()).json();
    expect(body.stores).toHaveLength(1400);
    expect(body.stores[0].id).toBe('store_0000');
    expect(body.stores[1399].id).toBe('store_1399');
  });

  it('only lists rows flagged listed', async () => {
    seedCatalog([ROWS[0], { ...ROWS[1], is_listed: false }]);
    const body = await (await get()).json();
    expect(body.stores.map((s: any) => s.id)).toEqual(['aldi']);
    const eqs = fakeDb.calls.filter((c) => c.table === 'stores' && c.method === 'eq');
    expect(eqs).toEqual([expect.objectContaining({ args: ['is_listed', true] })]);
  });

  // ── Malformed rows ────────────────────────────────────────────────────────

  it('omits a row with no colour instead of serving an invisible tile', async () => {
    seedCatalog([{ ...ROWS[0] }, { ...ROWS[1], color: null }]);
    const body = await (await get()).json();
    expect(body.stores.map((s: any) => s.id)).toEqual(['aldi']);
  });

  it('omits a row whose colour is not a six-digit hex', async () => {
    seedCatalog([{ ...ROWS[0] }, { ...ROWS[1], color: 'red' }]);
    expect((await (await get()).json()).stores).toHaveLength(1);
  });

  it('omits a row with a blank name instead of an unnamed tap target', async () => {
    seedCatalog([{ ...ROWS[0] }, { ...ROWS[1], name: '   ' }]);
    expect((await (await get()).json()).stores).toHaveLength(1);
  });

  it('omits a row with no slug', async () => {
    seedCatalog([{ ...ROWS[0] }, { ...ROWS[1], slug: null }]);
    expect((await (await get()).json()).stores).toHaveLength(1);
  });

  it('still serves every good row when one is malformed', async () => {
    // One bad row must not take the store picker down for every other store.
    seedCatalog([ROWS[0], { ...ROWS[1], color: null }, { ...ROWS[0], id: 'walmart', slug: 'walmart' }]);
    const res = await get();
    expect(res.status).toBe(200);
    expect((await res.json()).stores.map((s: any) => s.id)).toEqual(['aldi', 'walmart']);
  });

  // ── The version ───────────────────────────────────────────────────────────

  it('sets an ETag derived from the version', async () => {
    seedCatalog();
    expect((await get()).headers.get('etag')).toBe('"store-catalog-v12"');
  });

  it('304s when If-None-Match matches', async () => {
    seedCatalog();
    const res = await get({ 'if-none-match': '"store-catalog-v12"' });
    expect(res.status).toBe(304);
  });

  it('does not even read the rows on a 304', async () => {
    // The app polls on every cold start; the unchanged case must cost nothing.
    seedCatalog();
    await get({ 'if-none-match': '"store-catalog-v12"' });
    expect(fakeDb.calls.filter((c) => c.table === 'stores')).toEqual([]);
  });

  it('200s when If-None-Match is for an older version', async () => {
    seedCatalog(ROWS, 13);
    const res = await get({ 'if-none-match': '"store-catalog-v12"' });
    expect(res.status).toBe(200);
    expect((await res.json()).version).toBe(13);
  });

  it('reads the version BEFORE the rows', async () => {
    // Load-bearing. A write between the two reads gives rows from V+1 labelled
    // V: the client caches them and converges on the next fetch. Reading rows
    // first inverts it — rows from V labelled V+1 — and the client's own
    // "never go backwards" rule then makes it refuse the correction forever.
    seedCatalog();
    await get();
    const tables = fakeDb.calls.map((c) => c.table);
    expect(tables.indexOf('store_catalog_version')).toBeLessThan(tables.indexOf('stores'));
  });

  it('marks the response publicly cacheable', async () => {
    seedCatalog();
    expect((await get()).headers.get('cache-control')).toContain('public');
  });

  // ── Failure modes: every one leaves the client on its bundled list ────────

  it('503s when the version row is missing, rather than inventing a version', async () => {
    fakeDb.seed('store_catalog_version', []);
    fakeDb.seed('stores', ROWS);
    expect((await get()).status).toBe(503);
  });

  it('503s on an empty catalog rather than a 200 the app could apply', async () => {
    // A 200 with `stores: []` would need the client to carry its own "an empty
    // list is not an answer" rule, and any client that forgot it would render
    // an empty store picker.
    seedCatalog([]);
    const res = await get();
    expect(res.status).toBe(503);
  });

  it('503s when every row is malformed', async () => {
    seedCatalog([{ ...ROWS[0], color: null }]);
    expect((await get()).status).toBe(503);
  });

  it('500s on a database error reading the rows', async () => {
    seedCatalog();
    fakeDb.queue('stores', { data: null, error: { message: 'boom' } });
    expect((await get()).status).toBe(500);
  });

  it('500s on a database error reading the version', async () => {
    seedCatalog();
    fakeDb.queue('store_catalog_version', { data: null, error: { message: 'boom' } });
    expect((await get()).status).toBe(500);
  });

  it('500s when the paged walk runs out of pages before the end of the table', async () => {
    // The OTHER way a read comes back short: no error at all, just MAX_PAGES
    // (20 × 1000 rows) exhausted. `fetchAllPages` reports that as
    // `complete: false` with `error: null`, so the `read.error` branch does not
    // see it — and without its own check the endpoint would serve 20,000 stores
    // as if that were the whole catalog. Twenty full pages, every one a success.
    const page = Array.from({ length: 1000 }, (_, i) => ({
      ...ROWS[0], id: `store_${i}`, slug: `store-${i}`,
    }));
    seedCatalog([]);
    for (let i = 0; i < 20; i++) fakeDb.queue('stores', { data: page, error: null });
    const res = await get();
    expect(res.status).toBe(500);
    expect((await res.json()).stores).toBeUndefined();
  });

  it('500s rather than serving a partial catalog when a page fails', async () => {
    // A truncated catalog silently unlists real stores. A client that fell back
    // to its bundled list instead would be strictly better off, so fail.
    const many = Array.from({ length: 1400 }, (_, i) => ({
      ...ROWS[0], id: `store_${String(i).padStart(4, '0')}`, slug: `store-${String(i).padStart(4, '0')}`,
    }));
    seedCatalog(many);
    // First page succeeds off the seeded table; the second is forced to fail.
    fakeDb.queue('stores', { data: many.slice(0, 1000), error: null });
    fakeDb.queue('stores', { data: null, error: { message: 'boom' } });
    const res = await get();
    expect(res.status).toBe(500);
    expect((await res.json()).stores).toBeUndefined();
  });
});
