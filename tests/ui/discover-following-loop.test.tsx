// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

/**
 * Following, which spun forever (Stephen, 2026-09-09: "on the website, when I
 * click following, it just spins").
 *
 * The feed effect depends on `selectedCreatorIds`, and inside it — only on the
 * Following branch — it called `setSelectedCreatorIds(new Set())`. A fresh Set
 * is a fresh reference, so the state always "changed", so the effect always
 * re-ran. That alone would be a render loop; what made it a permanent spinner
 * is that every pass bumps `fetchGenRef`, and both the success path and the
 * `finally` are gated on the generation still matching. So every request in
 * flight was discarded before it could clear `fetching` — the meals never
 * arrived and the spinner never stopped.
 *
 * Trending and New never touched that setter, which is exactly why only
 * Following span.
 *
 * The assertion is on the REQUEST COUNT rather than on a spinner class: the
 * loop is the defect, and it would still be a defect if it happened to render
 * something. A bounded number of calls is the property.
 */

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));
vi.mock('@/components/AppHeader', () => ({ default: () => null }));
vi.mock('@/components/AppFooter', () => ({ default: () => null }));
vi.mock('@/components/CreatorPopup', () => ({ default: () => null }));

const DiscoverPage = (await import('@/app/discover/page')).default;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const MEAL = {
  id: 'p1', name: 'Sheet Pan Chicken Thighs',
  ingredients: [{ name: 'chicken thighs' }], photo_url: null,
  creator_id: 'c1', author: 'Chef Sarah',
};

const CREATOR = { id: 'c1', display_name: 'Chef Sarah', handle: 'sarah', photo_url: null };

let feedCalls: string[] = [];

beforeEach(() => {
  push.mockClear();
  feedCalls = [];
  localStorage.setItem('accessToken', 'tok');
  vi.stubGlobal('IntersectionObserver', class {
    observe() {} unobserve() {} disconnect() {} takeRecords() { return []; }
  });
  vi.stubGlobal('fetch', vi.fn((async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/auth/verify')) return json({ user: { id: 'u1', email: 'a@b.co' } });
    if (url.includes('/api/creator/me')) return json({}, 404);
    if (url.includes('/api/creators/featured')) return json({ creators: [] });
    if (url.includes('/api/creators/following')) return json({ creators: [CREATOR] });
    if (url.includes('/api/preset-meals/facets')) return json({ tags: [], authors: [] });
    if (url.includes('/api/preset-meals')) {
      feedCalls.push(url);
      return json({ presetMeals: [MEAL], hasMore: false, matched: 1 });
    }
    if (url.includes('/api/meals')) return json({ meals: [] });
    return json({});
  }) as unknown as typeof fetch));
});

afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); });

describe('Discover — the Following feed settles', () => {
  it('does not re-fetch itself forever', async () => {
    render(<DiscoverPage />);
    // Wait for auth + the first (trending) load to settle.
    await waitFor(() => expect(feedCalls.length).toBeGreaterThan(0));

    // Two tab strips render (mobile and desktop); either drives the same state.
    fireEvent.click((await screen.findAllByRole('button', { name: /^following$/i }))[0]);
    await waitFor(() => expect(feedCalls.some((u) => u.includes('followed=true'))).toBe(true));

    // Let anything self-perpetuating perpetuate.
    const settled = feedCalls.length;
    await new Promise((r) => setTimeout(r, 250));

    // Before the fix this climbed without bound — a new Set per pass, a new
    // effect run per Set. A couple more in flight is fine; a runaway is not.
    expect(feedCalls.length - settled).toBeLessThanOrEqual(2);
  });

  it('renders the meals rather than spinning on them', async () => {
    render(<DiscoverPage />);
    await waitFor(() => expect(feedCalls.length).toBeGreaterThan(0));

    fireEvent.click((await screen.findAllByRole('button', { name: /^following$/i }))[0]);

    // The user-visible half of the same bug: every request was discarded by the
    // generation check before it could paint, so the grid stayed empty.
    await waitFor(
      () => expect(screen.getAllByText(MEAL.name).length).toBeGreaterThan(0),
      { timeout: 3000 },
    );
  });
});
