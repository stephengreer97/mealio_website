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
import { encryptKrogerToken, krogerSearchProducts, krogerLookupProductsByUpc } from '@/lib/kroger';

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

/**
 * A product shaped the way Kroger returns one for a located search.
 *
 * `omitFulfillment` drops the block entirely, which Kroger does: that is a
 * different fact from "this store cannot fulfil it" and must not be reported
 * as one.
 */
function product(description: string, opts: { fulfillable?: boolean; stockLevel?: string; omitFulfillment?: boolean } = {}) {
  const { fulfillable = true, stockLevel = 'HIGH', omitFulfillment = false } = opts;
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
      ...(omitFulfillment ? {} : {
        fulfillment: fulfillable
          ? { curbside: true, delivery: true, inStore: true, shipToHome: false }
          : { curbside: false, delivery: false, inStore: false, shipToHome: true },
      }),
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
/** A niche term. Kroger's `filter.term` answers it with something adjacent. */
const JELLY = { productName: 'Ghost Pepper Jelly', searchTerm: 'Ghost Pepper Jelly, 12 oz', unit: 'tbsp', measure: '2', quantity: 1 };
/** The same row after the user has picked a product once — `upc` is what Kroger
 *  handed us then, and `product()` below echoes it back. */
const MILK_WITH_UPC = { ...MILK, upc: '0001111041700' };

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
    // Named, not just counted — a count cannot be checked for relevance.
    expect(outcome.ok && outcome.unfulfillable).toEqual(['Kroger Whole Milk']);
  });

  it('separates "this store cannot fulfil it" from "Kroger said nothing about fulfillment"', async () => {
    stubKroger({ status: 200, products: [product('Kroger Whole Milk', { omitFulfillment: true })] });

    const outcome = await krogerSearchProducts('access', 'whole milk', LOCATION, 10);

    // Dropped, so it counts as filtered — but it is not evidence of anything.
    expect(outcome).toMatchObject({ ok: true, filteredOut: 1, unfulfillable: [] });
  });

  it('does not report a refused UPC lookup as an absence', async () => {
    // The caller's fallback for "not found" is to search, which is also the
    // right response to a refusal — so a refusal must not arrive disguised as
    // an empty result that a caller could mistake for "Kroger has no such
    // product". It arrives as a status, and nothing else.
    stubKroger({ status: 429 });

    const lookup = await krogerLookupProductsByUpc('access', ['0001111041700'], LOCATION);

    expect(lookup.found.size).toBe(0);
    expect(lookup.statuses).toEqual([429]);
  });

  it('keys a resolved product under every identifier Kroger echoed for it', async () => {
    stubKroger({ status: 200, products: [product('Kroger Whole Milk, 1 gal')] });

    const lookup = await krogerLookupProductsByUpc('access', ['0001111041700'], LOCATION);

    expect(lookup.found.get('0001111041700')).toMatchObject({
      fulfillable: true,
      product: { upc: '0001111041700', description: 'Kroger Whole Milk, 1 gal' },
    });
  });

  it('reports a product this store refuses as unfulfillable rather than as missing', async () => {
    // The lookup deliberately omits filter.fulfillment so this case is visible.
    // Erased, it would be indistinguishable from a discontinued UPC.
    stubKroger({ status: 200, products: [product('Kroger Whole Milk, 1 gal', { fulfillable: false })] });

    const lookup = await krogerLookupProductsByUpc('access', ['0001111041700'], LOCATION);

    expect(lookup.found.get('0001111041700')).toMatchObject({ fulfillable: false });
  });

  it('says "unknown" rather than "refused" when Kroger sent no fulfillment block', async () => {
    stubKroger({ status: 200, products: [product('Kroger Whole Milk, 1 gal', { omitFulfillment: true })] });

    const lookup = await krogerLookupProductsByUpc('access', ['0001111041700'], LOCATION);

    expect(lookup.found.get('0001111041700')?.fulfillable).toBeNull();
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
    // The ladder is searchTerm -> bare name. Walking it against an API that is
    // already refusing us multiplies one throttled request, ten ingredients at
    // a time, which is how a soft quota becomes a hard outage.
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
    // Two ladder rungs, each retried once inside krogerSearchProducts on a
    // genuinely empty response. It was three rungs and six calls until the
    // measure+unit rung was deleted.
    expect(calls).toHaveLength(4);
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

  /**
   * "Kroger sells this, but not at the store you picked" is a claim about a
   * product, made from evidence the route never looked at: a count. These pin
   * the three ways the count lied.
   */
  describe('the "sells this, not here" claim', () => {
    it('does not claim it from an irrelevant product the fulfillment filter dropped', async () => {
      // Kroger answers a niche term with an adjacent one. If the hot sauce were
      // fulfillable this is `low_confidence` — "No exact match found", which is
      // honest. The same irrelevant result must not become a confident claim
      // about the jelly merely because the store cannot deliver the sauce.
      const calls = stubKroger([{ status: 200, products: [product('Ghost Pepper Hot Sauce', { fulfillable: false })] }]);

      const { json } = await search({ ingredients: [JELLY], locationId: LOCATION });

      expect(json.results[0].reason).not.toBe('unavailable_at_store');
      expect(json.results[0].reason).toBe('no_results');
      // And the rung-1 leftover did not decide a verdict the later rungs
      // reached on their own: the ladder was walked to the end.
      expect(calls.length).toBeGreaterThan(1);
    });

    it('does not claim it when Kroger returned no fulfillment block at all', async () => {
      // The filter drops these too, but Kroger saying nothing about a store is
      // not Kroger saying the store cannot fulfil it.
      stubKroger({ status: 200, products: [product('Kroger Whole Milk', { omitFulfillment: true })] });

      const { json } = await search({ ingredients: [MILK], locationId: LOCATION });

      expect(json.results[0].reason).toBe('no_results');
    });

    it('still claims it when the dropped product really is the ingredient', async () => {
      stubKroger({ status: 200, products: [product('Kroger Whole Milk', { fulfillable: false })] });

      const { json } = await search({ ingredients: [MILK], locationId: LOCATION });

      expect(json.results[0].reason).toBe('unavailable_at_store');
    });
  });

  describe('a rung that flakes is not the whole ladder', () => {
    it('recovers an exact match from the bare-name rung when rung 1 returns a transient 500', async () => {
      // Measured regression: this used to cost 2 calls and yield the UPC. After
      // the blanket break it cost 1 call and yielded `search_error` and no UPC,
      // for a failure the very next request was going to answer.
      const calls = stubKroger([
        { status: 500 },
        { status: 200, products: [product('Kroger Whole Milk, 1 gal')] },
      ]);

      const { json } = await search({ ingredients: [MILK], locationId: LOCATION });

      expect(json.results[0]).toMatchObject({ reason: 'matched', exact: true, upc: '0001111041700' });
      expect(calls).toHaveLength(2);
    });

    it('still caps a total 5xx outage at one request per rung', async () => {
      // Continuing on 5xx must not resurrect the amplification MEAL-19 fixed.
      // Two rungs, one call each — half the four the original ladder made.
      const calls = stubKroger({ status: 503 });

      const { json } = await search({ ingredients: [MILK], locationId: LOCATION });

      expect(calls).toHaveLength(2);
      expect(json.results[0].reason).toBe('search_error');
    });

    it('still stops dead on a 401, where a different term cannot help', async () => {
      const calls = stubKroger({ status: 401 });

      const { json } = await search({ ingredients: [MILK], locationId: LOCATION });

      expect(calls).toHaveLength(1);
      expect(json.results[0].reason).toBe('search_error');
    });
  });

  it('breaks down the outcomes in the success log', async () => {
    stubKroger({ status: 200, products: [product('Kroger Whole Milk, 1 gal')] });

    await search({ ingredients: [MILK], locationId: LOCATION, storeId: 'kroger' });

    const successLog = log.mock.calls.map(c => c[0]).find(e => e.status === 'success');
    expect(successLog.detail).toContain('found=1 total=1');
    expect(successLog.detail).toContain('errored=0');
  });

  /**
   * MEAL-102 — a preparation must never become part of what we search for.
   *
   * This is the exact address of the risk. `scoreTarget` here is
   * `searchTerm ?? productName`, and the add gate is exact equality after
   * normalisation, so prep reaching either field does not fetch a worse
   * product — it matches nothing and the item drops into review looking like a
   * matching bug. `WebViewCartSheet.tsx` in the app computes the same term the
   * same way; this is the half of it that lives on this side.
   *
   * Asserted against the URLs actually sent upstream rather than against the
   * body we passed in, because the query string is the thing that is really
   * true about what we asked Kroger for.
   */

  /**
   * MEAL-19 — the measure+unit rung, deleted.
   *
   * It sat between the saved display name and the bare product name and could
   * not reach anything the bare name misses: it is strictly narrower. What it
   * could do is spend a request from the same quota whose 429s the rest of this
   * file is about, and ask a product catalogue questions in recipe vocabulary.
   */
  describe('the measure and the unit never reach Kroger', () => {
    it('never puts the recipe amount in a query, on any rung', async () => {
      // MILK is "2 cup Whole Milk" with a saved display name — the exact shape
      // that used to build "Whole Milk 2 cup". Answer every rung with nothing
      // so the whole ladder is walked.
      const calls = stubKroger({ status: 200, products: [] });

      await search({ ingredients: [MILK], locationId: LOCATION });

      expect(calls.length).toBeGreaterThan(0);
      for (const url of calls) {
        const query = decodeURIComponent(url).toLowerCase();
        expect(query).not.toContain('cup');
        expect(query).not.toContain('whole milk 2');
      }
    });

    it('asks the same question at most once per run', async () => {
      // A product name of 8+ words made the middle rung byte-identical to the
      // bare-name rung, because the 8-word cap trims the tail. Two rungs, two
      // distinct questions, forever.
      const LONG = {
        productName: 'Organic Grass Fed Boneless Skinless Chicken Breast Fillets Family Pack',
        searchTerm: 'Simple Truth Organic Grass Fed Boneless Skinless Chicken Breast',
        unit: 'lb',
        measure: '2',
        quantity: 1,
      };
      const calls = stubKroger({ status: 200, products: [] });

      await search({ ingredients: [LONG], locationId: LOCATION });

      const terms = calls.map(u => new URL(u).searchParams.get('filter.term'));
      expect(new Set(terms).size).toBe(terms.length / 2); // each rung retried once, no rung repeated
    });
  });

  /**
   * MEAL-19 — the chosen product, remembered by identifier.
   *
   * The cart used to persist a display string and re-derive the product from it
   * by relevance search on every later run, so a choice made once was re-decided
   * by `filter.term` every time. The stored UPC is an ACCELERATOR: it ends the
   * work only where the answer is unambiguous, and every other case falls
   * through to the ladder that ran before it existed. These pin both halves —
   * that it short-circuits, and that it never silently swallows a case.
   */
  describe('a product chosen once is looked up, not re-searched', () => {
    it('resolves a stored UPC in one request and runs no search at all', async () => {
      const calls = stubKroger([{ status: 200, products: [product('Kroger Whole Milk, 1 gal')] }]);

      const { json } = await search({ ingredients: [MILK_WITH_UPC], locationId: LOCATION });

      expect(json.results[0]).toMatchObject({ reason: 'matched', exact: true, upc: '0001111041700' });
      expect(calls).toHaveLength(1);
      const params = new URL(calls[0]).searchParams;
      expect(params.get('filter.productId')).toBe('0001111041700');
      expect(params.get('filter.locationId')).toBe(LOCATION);
      expect(params.get('filter.term')).toBeNull();
      // Omitted on purpose: it would erase "this store will not fulfil the
      // product you chose", which is the case below.
      expect(params.get('filter.fulfillment')).toBeNull();
    });

    it('looks up a whole run in one request, not one per ingredient', async () => {
      const calls = stubKroger({ status: 200, products: [] });

      await search({
        ingredients: [{ ...MILK, upc: '111' }, { ...JELLY, upc: '222' }],
        locationId: LOCATION,
      });

      const lookups = calls.filter(u => u.includes('filter.productId'));
      expect(lookups).toHaveLength(1);
      expect(new URL(lookups[0]).searchParams.get('filter.productId')).toBe('111,222');
    });

    it('looks nothing up when no ingredient carries a stored UPC', async () => {
      const calls = stubKroger({ status: 200, products: [product('Kroger Whole Milk, 1 gal')] });

      await search({ ingredients: [MILK], locationId: LOCATION });

      expect(calls.some(u => u.includes('filter.productId'))).toBe(false);
    });

    it('falls back to the ladder when this store will not fulfil the stored product', async () => {
      const calls = stubKroger([
        { status: 200, products: [product('Kroger Whole Milk, 1 gal', { fulfillable: false })] },
        { status: 200, products: [product('Kroger Whole Milk, 1 gal')] },
      ]);

      const { json } = await search({ ingredients: [MILK_WITH_UPC], locationId: LOCATION });

      expect(calls).toHaveLength(2);
      expect(new URL(calls[1]).searchParams.get('filter.term')).toBe('Kroger Whole Milk, 1 gal');
      expect(json.results[0]).toMatchObject({ reason: 'matched', exact: true });
    });

    it('falls back to the ladder when the stored product is out of stock here', async () => {
      // Out of stock is the case where the user most needs a substitute in front
      // of them, so ending the run on the stored UPC would be the wrong answer
      // even though it is the "right" product.
      const calls = stubKroger([
        { status: 200, products: [product('Kroger Whole Milk, 1 gal', { stockLevel: 'TEMPORARILY_OUT_OF_STOCK' })] },
        { status: 200, products: [product('Kroger Whole Milk, 1 gal')] },
      ]);

      const { json } = await search({ ingredients: [MILK_WITH_UPC], locationId: LOCATION });

      expect(calls).toHaveLength(2);
      expect(json.results[0]).toMatchObject({ reason: 'matched', exact: true });
    });

    it('falls back to the ladder when Kroger no longer knows the UPC', async () => {
      // A UPC is not permanent — Kroger discontinues items and re-issues ids.
      // The text ladder is the fallback, which is what keeps this an
      // accelerator rather than a replacement.
      const calls = stubKroger([
        { status: 200, products: [] },
        { status: 200, products: [product('Kroger Whole Milk, 1 gal')] },
      ]);

      const { json } = await search({ ingredients: [MILK_WITH_UPC], locationId: LOCATION });

      expect(calls).toHaveLength(2);
      expect(json.results[0]).toMatchObject({ reason: 'matched', exact: true });
    });

    it('a refused lookup costs a request and changes no verdict', async () => {
      const calls = stubKroger([
        { status: 429 },
        { status: 200, products: [product('Kroger Whole Milk, 1 gal')] },
      ]);

      const { json } = await search({ ingredients: [MILK_WITH_UPC], locationId: LOCATION });

      expect(calls).toHaveLength(2);
      expect(json.results[0]).toMatchObject({ reason: 'matched', exact: true });
      const errorLog = log.mock.calls.map(c => c[0]).find(e => e.status === 'error');
      // Counted as a request, never as a failed ingredient — the asymmetry the
      // route's log comment names.
      expect(errorLog.detail).toContain('statuses=429');
      expect(errorLog.detail).toContain('failed=0/1');
    });

    it('counts the shortcut in the success log', async () => {
      stubKroger([{ status: 200, products: [product('Kroger Whole Milk, 1 gal')] }]);

      await search({ ingredients: [MILK_WITH_UPC], locationId: LOCATION, storeId: 'kroger' });

      const successLog = log.mock.calls.map(c => c[0]).find(e => e.status === 'success');
      expect(successLog.detail).toContain('viaUpc=1');
    });
  });

  describe('preparation never reaches the store (MEAL-102)', () => {
    /** An onion the recipe wants diced. The prep is present, and irrelevant. */
    const DICED_ONION = {
      productName: 'Onion',
      searchTerm: null,
      unit: 'qty',
      measure: '1',
      quantity: 1,
      prep: 'finely diced',
    };

    it('searches the bare product for a row carrying a preparation', async () => {
      const calls = stubKroger({ status: 200, products: [product('Onion')] });

      const { json } = await search({ ingredients: [DICED_ONION], locationId: LOCATION });

      // The term went up bare, and the onion matched.
      expect(calls).toHaveLength(1);
      expect(decodeURIComponent(calls[0])).toContain('Onion');
      for (const word of ['finely', 'diced']) {
        expect(decodeURIComponent(calls[0]).toLowerCase()).not.toContain(word);
      }
      expect(json.results[0]).toMatchObject({ term: 'Onion', reason: 'matched', exact: true });
    });

    it('keeps prep out of every rung of the fallback ladder', async () => {
      // The ladder is searchTerm -> bare name. Force both rungs by answering
      // each with nothing. (Until MEAL-19 there was a middle rung that *built*
      // a term by concatenation — the one place prep would most plausibly have
      // been spliced in. It is gone; the assertion stays, because the risk it
      // guards is a future writer re-introducing one.)
      const calls = stubKroger({ status: 200, products: [] });

      await search({
        ingredients: [{ ...DICED_ONION, searchTerm: 'Onion, 1 ct', unit: 'cups', measure: '2' }],
        locationId: LOCATION,
      });

      expect(calls.length).toBeGreaterThan(1);
      for (const url of calls) {
        for (const word of ['finely', 'diced', 'prep']) {
          expect(decodeURIComponent(url).toLowerCase()).not.toContain(word);
        }
      }
    });

    it('scores the product against the bare term, so a prepped row still matches exactly', async () => {
      // The gate is `score === 100`. If prep had joined the scoring target,
      // "Onion" would score short of 100 against it and this exact match would
      // silently become a review item.
      stubKroger({ status: 200, products: [product('Onion')] });

      const { json } = await search({ ingredients: [DICED_ONION], locationId: LOCATION });

      expect(json.results[0].exact).toBe(true);
      expect(json.results[0].upc).toBe('0001111041700');
    });
  });
});

/**
 * MEAL-208 — the 8-word cap, MEASURED against the live Kroger Products API
 * rather than inferred from one failure.
 *
 * Two sweeps thirty minutes apart, /v1/products at a real locationId, agreed
 * on every value:
 *
 *   <= 8 whitespace terms  -> HTTP 200 with products
 *      9 terms and beyond  -> HTTP 400, code PRODUCT-2019
 *      "Field 'term' allows for a maximum of 8 individual terms per search"
 *
 * The boundary is therefore a REJECTION, not a 200 carrying an empty list —
 * which matters, because those two are the same thing to a caller that only
 * reads the array. 8 is exactly right: 9 is refused, and the full real title of
 * a product this store stocks ("Pacific Foods Organic Free Range Chicken Broth
 * 32 oz Carton", ten words) is refused at its natural length.
 *
 * A SECOND limit exists at the same endpoint and nothing here guards it:
 *
 *   3..128 characters -> HTTP 200
 *   129 characters    -> HTTP 400, code PRODUCT-2017
 *   1..2 characters   -> the same 400
 *   "Field 'term' must have three or more characters and less than 128
 *    characters"        (the message is off by one; 128 itself is accepted)
 *
 * Eight words do not bound a string to 128 characters, so a long-token name
 * can still be refused. That gap is pinned below rather than quietly fixed —
 * adding a second truncation is a behaviour change, not a measurement.
 *
 * Terms are counted on WHITESPACE alone. Commas and hyphens do not split one
 * ("Mahatma, Basmati, Rice, Long, Grain, Uncooked, Rice, 32oz" is eight and
 * passes); an attached trademark mark does not add one ("Simple(R) Truth(R)
 * Organic Low Sodium Free Range Chicken" is eight and passes); a mark standing
 * alone between spaces does. So the [TM][R][C] strip in krogerSearchProducts
 * changes the count only in the bare-symbol case, never in the attached case
 * its commit message described.
 */
describe('lib/kroger search term limits (MEAL-208, measured live 2026-09-05)', () => {
  /** Ten words — the length Kroger answers with 400 PRODUCT-2019 if sent whole. */
  const TEN_WORDS = 'Pacific Foods Organic Free Range Chicken Broth 32 oz Carton';

  it('never sends more than the 8 terms Kroger accepts', async () => {
    const calls = stubKroger({ status: 200, products: [] });

    await krogerSearchProducts('access', TEN_WORDS, LOCATION, 10);

    const term = new URL(calls[0]).searchParams.get('filter.term')!;
    expect(term.split(/\s+/)).toHaveLength(8);
  });

  it('drops the TAIL, so the size suffix is what is lost', async () => {
    const calls = stubKroger({ status: 200, products: [] });

    await krogerSearchProducts('access', TEN_WORDS, LOCATION, 10);

    const term = new URL(calls[0]).searchParams.get('filter.term');
    expect(term).toBe('Pacific Foods Organic Free Range Chicken Broth 32');
    expect(term).not.toContain('Carton');
  });

  it('leaves a term of 8 words or fewer exactly as it was given', async () => {
    const calls = stubKroger({ status: 200, products: [] });

    await krogerSearchProducts('access', 'Simple Truth Organic Low Sodium Free Range Chicken', LOCATION, 10);

    expect(new URL(calls[0]).searchParams.get('filter.term'))
      .toBe('Simple Truth Organic Low Sodium Free Range Chicken');
  });

  /**
   * The measured gap, asserted so it cannot close by accident and cannot be
   * forgotten. Eight words of long tokens exceed Kroger's 128-character limit
   * and go out whole, and Kroger answers 400 PRODUCT-2017.
   */
  it('does NOT bound the term to the 128 characters Kroger also enforces', async () => {
    const calls = stubKroger({ status: 200, products: [] });
    // Eight whitespace terms. Hyphens do not split a term at Kroger (measured),
    // so a name built from hyphenated tokens stays inside the word cap while
    // sailing past the character one — which is exactly how a real product
    // title gets refused today.
    const eightLongWords = ['Simple-Truth-Organic', 'Grass-Fed-Free-Range',
      'Boneless-Skinless-Chicken-Breast', 'Fillets', 'Family-Size-Value-Pack',
      'Refrigerated', 'Antibiotic-Free', 'Individually-Quick-Frozen'].join(' ');
    expect(eightLongWords.split(/\s+/)).toHaveLength(8);

    await krogerSearchProducts('access', eightLongWords, LOCATION, 10);

    const term = new URL(calls[0]).searchParams.get('filter.term')!;
    expect(term.split(/\s+/)).toHaveLength(8);
    // Over the live limit, and sent anyway.
    expect(term.length).toBeGreaterThan(128);
  });
});
