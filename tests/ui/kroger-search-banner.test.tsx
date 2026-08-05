// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';

/**
 * The banners that explain why an ingredient came back without a product.
 *
 * MEAL-19 added them, and added the way they go stale. They are rendered off
 * `reason` from the *automatic* search, which is a fact about a search the user
 * has since replaced: after typing a different term and getting products back,
 * "Kroger sells this, but not at the store you picked" kept rendering directly
 * above products this store can, in fact, fulfil, and "…search didn't respond"
 * kept rendering next to results it plainly did respond with.
 *
 * A banner that contradicts the list under it is worse than no banner: it is
 * the reason the user distrusts the list. These pin that a re-search which
 * produces something clears the explanation for the search it replaced.
 */

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/components/AppHeader', () => ({ default: () => null }));
vi.mock('@/components/AppFooter', () => ({ default: () => null }));
vi.mock('@/components/CreatorPopup', () => ({ default: () => null }));
vi.mock('@/components/KrogerStorePickerModal', () => ({ default: () => null }));

const MyMealsPage = (await import('@/app/my-meals/page')).default;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** One meal, one ingredient with no product chosen yet — what opens the flow. */
const MEAL = {
  id: 'm1',
  name: 'Chili',
  store_id: 'kroger',
  ingredients: [{ ingredientName: 'Ghost Pepper Jelly', searchTerm: null, qty: 1, unit: 'qty', measure: null }],
};

/** The same meal with a product already chosen — this one goes to the cart flow. */
const CHOSEN_MEAL = {
  ...MEAL,
  ingredients: [{ ingredientName: 'Ghost Pepper Jelly', searchTerm: 'Ghost Pepper Jelly, 12 oz', qty: 1, unit: 'qty', measure: null }],
};

const SUGGESTION = {
  upc: '0001111041700',
  description: 'Hot Pepper Jelly',
  imageUrl: null,
  stockLevel: 'HIGH',
  price: 4.99,
  size: '12 oz',
  soldBy: 'UNIT',
};

const SELLS_IT_ELSEWHERE = /sells this, but not at the store you picked/i;
const DID_NOT_RESPOND = /search didn't respond for this item/i;

/**
 * `searches` is consumed one per POST /api/kroger/search-products: the first is
 * the flow's automatic search, the second is whatever the user retyped.
 */
function stubApi(searches: Array<{ status?: number; body: unknown }>, meal: unknown = MEAL) {
  const queue = [...searches];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/api/auth/verify')) return json({ user: { id: 'u1', email: 'a@b.co' } });
    if (url.includes('/api/creator/me')) return json({}, 404);
    if (url.includes('/api/kroger/status')) {
      return json({ connected: true, locations: { kroger: { locationId: '01400376', locationName: 'Test Store' } } });
    }
    if (url.includes('/api/kroger/search-products')) {
      const next = queue.shift() ?? { body: { results: [] } };
      return json(next.body, next.status ?? 200);
    }
    if (url.includes('/api/meals')) return json({ meals: [meal] });
    return json({});
  }) as unknown as typeof fetch;
  vi.stubGlobal('fetch', vi.fn(impl));
}

/** The automatic search's answer for the one ingredient, with no products. */
function autoResult(reason: string) {
  return { body: { results: [{ term: 'Ghost Pepper Jelly', quantity: 1, upc: null, description: null, exact: false, reason, suggestions: [] }] } };
}

beforeEach(() => { localStorage.setItem('accessToken', 'tok'); });
afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); });

/** Opens Choose Products and waits for the flow to reach the picking step. */
async function openPicker() {
  render(<MyMealsPage />);
  fireEvent.click(await screen.findByRole('button', { name: 'Choose Products' }));
  await screen.findByText(/Choose Product \(1 of 1\)/);
}

/** Types `term` into the "Other…" box and submits the re-search. */
async function reSearch(term: string) {
  fireEvent.click(screen.getByRole('button', { name: /Other — type a product name/ }));
  fireEvent.change(screen.getByPlaceholderText(/e.g. Ground Beef/), { target: { value: term } });
  // The submit button is disabled at qty 0, which is the flow's default.
  fireEvent.click(screen.getByRole('button', { name: '+' }));
  fireEvent.click(screen.getByRole('button', { name: /Save Products/ }));
}

describe('an explanation for a search the user has replaced', () => {
  it('stops claiming the store cannot fulfil it once a re-search finds products it can', async () => {
    stubApi([
      autoResult('unavailable_at_store'),
      { body: { results: [{ term: 'pepper jelly', quantity: 1, upc: null, description: null, exact: false, reason: 'low_confidence', suggestions: [SUGGESTION] }] } },
    ]);

    await openPicker();
    expect(screen.getByText(SELLS_IT_ELSEWHERE)).toBeTruthy();

    await reSearch('pepper jelly');

    await waitFor(() => expect(screen.getByText(/Hot Pepper Jelly/)).toBeTruthy());
    expect(screen.queryByText(SELLS_IT_ELSEWHERE)).toBeNull();
  });

  it('stops saying the search did not respond once a re-search gets a response', async () => {
    stubApi([
      autoResult('search_error'),
      { body: { results: [{ term: 'pepper jelly', quantity: 1, upc: null, description: null, exact: false, reason: 'low_confidence', suggestions: [SUGGESTION] }] } },
    ]);

    await openPicker();
    expect(screen.getByText(DID_NOT_RESPOND)).toBeTruthy();

    await reSearch('pepper jelly');

    await waitFor(() => expect(screen.getByText(/Hot Pepper Jelly/)).toBeTruthy());
    expect(screen.queryByText(DID_NOT_RESPOND)).toBeNull();
  });

  it('shows one error, not two, when the re-search fails as well', async () => {
    stubApi([
      autoResult('search_error'),
      { status: 429, body: { error: 'Kroger is rate limiting us. Try again in a moment.' } },
    ]);

    await openPicker();
    expect(screen.getByText(DID_NOT_RESPOND)).toBeTruthy();

    await reSearch('pepper jelly');

    await waitFor(() => expect(screen.getByText(/rate limiting us/)).toBeTruthy());
    expect(screen.queryByText(DID_NOT_RESPOND)).toBeNull();
  });
});

/**
 * The same banners on the cart-flow review screen. That copy is a sentence
 * longer and, unlike the picker's, was not even guarded against the re-search's
 * own error — so a failed re-search rendered "search didn't respond" and "Kroger
 * search failed" one above the other, about two different requests.
 */
describe('the same explanation on the cart review screen', () => {
  const SELLS_IT_ELSEWHERE_LONG = /sells this, but not at the store you picked — try another store/i;
  const DID_NOT_RESPOND_LONG = /this isn't a sign the product is missing/i;

  /** Selects the meal, runs the cart search, and lands on the review screen. */
  async function openReview() {
    render(<MyMealsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Kroger (1)' }));
    fireEvent.click(screen.getByText('Chili'));
    fireEvent.click(await screen.findByRole('button', { name: /Add 1 meal to Kroger Cart/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Add Ingredients to Kroger Cart/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Review 1 Item/ }));
  }

  /** Types `term` into the "Other…" box and submits the re-search. */
  async function reSearchInReview(term: string) {
    fireEvent.click(screen.getByRole('button', { name: /Other — type a product name/ }));
    fireEvent.change(screen.getByPlaceholderText(/e.g. Ground Beef/), { target: { value: term } });
    fireEvent.click(screen.getByRole('button', { name: 'Add to Cart Only' }));
  }

  const withSuggestion = {
    body: { results: [{ term: 'pepper jelly', quantity: 1, upc: null, description: null, exact: false, reason: 'low_confidence', suggestions: [SUGGESTION] }] },
  };

  it('stops claiming the store cannot fulfil it once a re-search finds products it can', async () => {
    stubApi([autoResult('unavailable_at_store'), withSuggestion], CHOSEN_MEAL);

    await openReview();
    expect(screen.getByText(SELLS_IT_ELSEWHERE_LONG)).toBeTruthy();

    await reSearchInReview('pepper jelly');

    await waitFor(() => expect(screen.getByText(/Hot Pepper Jelly/)).toBeTruthy());
    expect(screen.queryByText(SELLS_IT_ELSEWHERE_LONG)).toBeNull();
  });

  it('stops saying the search did not respond once a re-search gets a response', async () => {
    stubApi([autoResult('search_error'), withSuggestion], CHOSEN_MEAL);

    await openReview();
    expect(screen.getByText(DID_NOT_RESPOND_LONG)).toBeTruthy();

    await reSearchInReview('pepper jelly');

    await waitFor(() => expect(screen.getByText(/Hot Pepper Jelly/)).toBeTruthy());
    expect(screen.queryByText(DID_NOT_RESPOND_LONG)).toBeNull();
  });

  it('shows one error, not two, when the re-search fails as well', async () => {
    stubApi([
      autoResult('search_error'),
      { status: 429, body: { error: 'Kroger is rate limiting us. Try again in a moment.' } },
    ], CHOSEN_MEAL);

    await openReview();
    expect(screen.getByText(DID_NOT_RESPOND_LONG)).toBeTruthy();

    await reSearchInReview('pepper jelly');

    await waitFor(() => expect(screen.getByText(/rate limiting us/)).toBeTruthy());
    expect(screen.queryByText(DID_NOT_RESPOND_LONG)).toBeNull();
  });
});
