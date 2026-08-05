import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { fakeDb } from '../helpers/supabase-mock';
import { jsonRequest } from '../helpers/request';

vi.mock('@/lib/supabase', async () =>
  (await import('../helpers/supabase-mock')).mockSupabaseModule());

const log = vi.fn();
vi.mock('@/lib/logger', () => ({ log: (...args: unknown[]) => log(...args) }));
vi.mock('@/lib/flags', () => ({ getFlag: async () => false }));

process.env.KROGER_CLIENT_ID = 'test-client-id';
process.env.KROGER_CLIENT_SECRET = 'test-client-secret';
process.env.KROGER_TOKEN_ENCRYPTION_KEY = '0'.repeat(64);

import { POST } from '@/app/api/kroger/search-products/route';
import { createAccessToken, clearRevocationCache } from '@/lib/tokens';
import { encryptKrogerToken, krogerSearchProducts } from '@/lib/kroger';

/**
 * MEAL-19 — "Kroger sometimes returns no results".
 *
 * The reported symptom had five possible causes and exactly one observable
 * outcome, because `krogerSearchProducts` mapped every non-2xx response to `[]`
 * and the route reported any empty list as `no_results` ("No products found for
 * this search"). A 429 against the daily product quota, an expired grant, a 5xx,
 * a store that cannot fulfil what Kroger listed, and a genuinely unknown term
 * were one message and one unremarkable log line.
 *
 * These tests pin the distinction, and pin the request *count*, because the
 * old fallback ladder answered an upstream failure by asking the same failing
 * API three more times — ten ingredients at a time.
 */

const LOCATION = '01400376';

/** A product shaped the way Kroger returns one for a located search. */
function product(description: string, opts: { fulfillable?: boolean; stockLevel?: string } = {}) {
  const { fulfillable = true, stockLevel = 'HIGH' } = opts;
  return {
    productId: '0001111041700',
    upc: '0001111041700',
    description,
    images: [],
    items: [{
      itemId: '0001111041700',
      size: '1 gal',
      soldBy: 'UNIT',
      price: { regular: 3.49 },
      inventory: { stockLevel },
      fulfillment: fulfillable
        ? { curbside: true, delivery: true, inStore: true, shipToHome: false }
        : { curbside: false, delivery: false, inStore: false, shipToHome: true },
    }],
  };
}

type ProductReply = { status: number; products?: unknown[] };

/**
 * Stubs the two Kroger endpoints the route touches. `replies` is consumed one
 * per /products call so a test can say "throttled, then throttled again".
 * Returns the recorded product-search URLs — the amplification assertions read
 * their length.
 */
function stubKroger(replies: ProductReply[] | ProductReply) {
  const queue = Array.isArray(replies) ? [...replies] : null;
  const constant = Array.isArray(replies) ? null : replies;
  const productCalls: string[] = [];

  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/connect/oauth2/token')) {
      return new Response(JSON.stringify({ access_token: 'kroger-access', refresh_token: null }), { status: 200 });
    }
    productCalls.push(url);
    const reply = constant ?? queue!.shift() ?? { status: 200, products: [] };
    if (reply.status !== 200) return new Response('{"errors":{"reason":"throttled"}}', { status: reply.status });
    return new Response(JSON.stringify({ data: reply.products ?? [] }), { status: 200 });
  }));

  return productCalls;
}

async function search(body: Record<string, unknown>) {
  const token = await createAccessToken('user-1', 'a@b.test');
  const res = await POST(jsonRequest('/api/kroger/search-products', { token, body }));
  return { res, json: await res.json() };
}

const MILK = { productName: 'Whole Milk', searchTerm: 'Kroger Whole Milk, 1 gal', unit: 'cup', measure: '2', quantity: 1 };

beforeEach(() => {
  fakeDb.reset();
  clearRevocationCache();
  log.mockClear();
  fakeDb.seed('user_profiles', [{
    id: 'user-1',
    kroger_refresh_token: encryptKrogerToken('refresh-token-plaintext'),
    kroger_location_id: null,
  }]);
});

afterAll(() => { vi.unstubAllGlobals(); });

describe('lib/kroger krogerSearchProducts', () => {
  it('reports an upstream failure as a failure, not as an empty shelf', async () => {
    stubKroger({ status: 429 });

    const outcome = await krogerSearchProducts('access', 'whole milk', LOCATION, 10);

    expect(outcome.ok).toBe(false);
    // The status is the whole point: 429 and 401 need different operator
    // responses, and `[]` supported neither.
    expect(outcome).toMatchObject({ ok: false, status: 429 });
  });

  it('counts products this store cannot fulfil instead of dropping them silently', async () => {
    stubKroger({ status: 200, products: [product('Kroger Whole Milk', { fulfillable: false })] });

    const outcome = await krogerSearchProducts('access', 'whole milk', LOCATION, 10);

    expect(outcome).toMatchObject({ ok: true, filteredOut: 1 });
    expect(outcome.ok && outcome.products).toHaveLength(0);
  });
});

describe('POST /api/kroger/search-products', () => {
  it('calls an item search_error when Kroger throttles, and does not call it no_results', async () => {
    stubKroger({ status: 429 });

    const { json } = await search({ ingredients: [MILK], locationId: LOCATION });

    expect(json.results[0].reason).toBe('search_error');
    expect(json.results[0].reason).not.toBe('no_results');
  });

  it('stops the fallback ladder on an upstream failure instead of quadrupling the load', async () => {
    // The ladder is searchTerm -> name+measure+unit -> bare name. Walking it
    // against an API that is already refusing us turns one throttled request
    // into four, ten ingredients at a time, which is how a soft quota becomes
    // a hard outage.
    const calls = stubKroger({ status: 429 });

    await search({ ingredients: [MILK], locationId: LOCATION });

    expect(calls).toHaveLength(1);
  });

  it('logs the upstream status so the next occurrence is diagnosable from production', async () => {
    stubKroger({ status: 429 });

    await search({ ingredients: [MILK], locationId: LOCATION });

    const errorLog = log.mock.calls.map(c => c[0]).find(e => e.status === 'error');
    expect(errorLog).toMatchObject({ event: 'KROGER:SEARCH_PRODUCTS', reason: 'upstream_error' });
    expect(errorLog.detail).toContain('statuses=429');
  });

  it('says the store cannot fulfil it when Kroger listed the product but the filter dropped it', async () => {
    // Correct behaviour, wrong message: Kroger knows this product, our store
    // just cannot pick it up, deliver it, or shelve it.
    stubKroger({ status: 200, products: [product('Kroger Whole Milk', { fulfillable: false })] });

    const { json } = await search({ ingredients: [MILK], locationId: LOCATION });

    expect(json.results[0].reason).toBe('unavailable_at_store');
  });

  it('still says no_results when Kroger genuinely returns nothing for every term tried', async () => {
    const calls = stubKroger({ status: 200, products: [] });

    const { json } = await search({ ingredients: [MILK], locationId: LOCATION });

    expect(json.results[0].reason).toBe('no_results');
    // Three ladder rungs, each retried once inside krogerSearchProducts on a
    // genuinely empty response. The old route added a fourth, identical rung.
    expect(calls).toHaveLength(6);
  });

  it('matches on the first ladder rung without walking the rest', async () => {
    const calls = stubKroger({ status: 200, products: [product('Kroger Whole Milk, 1 gal')] });

    const { json } = await search({ ingredients: [MILK], locationId: LOCATION });

    expect(json.results[0]).toMatchObject({ reason: 'matched', exact: true, upc: '0001111041700' });
    expect(calls).toHaveLength(1);
  });

  it('reports everything-out-of-stock as out of stock rather than as nothing found', async () => {
    stubKroger({ status: 200, products: [product('Store Brand Milk', { stockLevel: 'TEMPORARILY_OUT_OF_STOCK' })] });

    const { json } = await search({ ingredients: [MILK], locationId: LOCATION });

    expect(json.results[0].reason).toBe('out_of_stock');
  });

  it('breaks down the outcomes in the success log', async () => {
    stubKroger({ status: 200, products: [product('Kroger Whole Milk, 1 gal')] });

    await search({ ingredients: [MILK], locationId: LOCATION, storeId: 'kroger' });

    const successLog = log.mock.calls.map(c => c[0]).find(e => e.status === 'success');
    expect(successLog.detail).toContain('found=1 total=1');
    expect(successLog.detail).toContain('errored=0');
  });
});
