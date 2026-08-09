// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { PITCH_HEADLINE, PITCH_STORES, PITCH_STEPS, PITCH_NOTHING_ORDERED } from '@/lib/pitch';

/**
 * Discover, seen by someone who is not signed in (MEAL-86).
 *
 * `/` is a `permanentRedirect` to `/discover`, so this page is the front door.
 * It used to show a signed-out visitor a grid of recipe photos and never say
 * that Mealio fills a grocery cart — the word did not appear on the page once.
 *
 * The signed-out/signed-in split is the part most likely to regress: the pitch
 * is keyed off auth state, and auth state on this page arrives from a fetch
 * that resolves after the first render. So these assert both directions, and
 * the expired-token path separately, because that is the one where `token` and
 * `user` could plausibly disagree.
 *
 * They assert against the exported constants rather than pasted strings, so
 * the copy can be reworded in `lib/pitch.ts` without touching this file — but
 * the claim itself ("cart") is asserted literally, because that word going
 * missing is the bug.
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
  id: 'p1',
  name: 'Sheet Pan Chicken Thighs',
  ingredients: [{ name: 'chicken thighs' }],
  photo_url: null,
};

/** `verifyOk: false` is the expired-token path — a stored token the API rejects. */
function stubApi({ verifyOk = true }: { verifyOk?: boolean } = {}) {
  const impl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/auth/verify')) {
      return verifyOk ? json({ user: { id: 'u1', email: 'a@b.co' } }) : json({ error: 'expired' }, 401);
    }
    if (url.includes('/api/creator/me')) return json({}, 404);
    if (url.includes('/api/creators/featured')) return json({ creators: [] });
    if (url.includes('/api/preset-meals')) return json({ presetMeals: [MEAL], hasMore: false });
    if (url.includes('/api/meals')) return json({ meals: [] });
    return json({});
  }) as unknown as typeof fetch;
  vi.stubGlobal('fetch', vi.fn(impl));
}

beforeEach(() => {
  push.mockClear();
  // jsdom has no IntersectionObserver, and the meal grid's infinite scroll
  // builds one on mount. Never fires here — one page of meals is enough.
  vi.stubGlobal('IntersectionObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() { return []; }
  });
  stubApi();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

const pageText = () => document.body.textContent ?? '';

describe('Discover — the pitch a signed-out visitor sees', () => {
  it('says Mealio puts the ingredients in your grocery cart', async () => {
    render(<DiscoverPage />);

    await screen.findByText(PITCH_HEADLINE);
    const text = pageText();
    // The claim, not just the branding. This is the assertion the ticket is
    // about: before MEAL-86 "cart" appeared zero times on this page.
    expect(text).toMatch(/cart/i);
    // The step points at the picker instead of reciting a list. The property
    // this replaces still holds and is the one that matters: cart automation for
    // everything except Kroger runs in the mobile app, so this surface must not
    // promise a signed-out visitor the product-wide list.
    expect(text).toContain(PITCH_STEPS[1].body);
    expect(text).not.toContain(PITCH_STORES);
    // People assume "fills your cart" means "spends your money". Say otherwise.
    expect(text).toContain(PITCH_NOTHING_ORDERED);
  });

  it('states the pitch before the visitor taps anything', async () => {
    render(<DiscoverPage />);

    const heading = await screen.findByRole('heading', { level: 1, name: PITCH_HEADLINE });
    // Ahead of the grid in document order, so it is read and seen first. The
    // grid renders its mobile and desktop columns into the same DOM here —
    // jsdom applies no Tailwind breakpoints — so every copy has to be after it.
    const cards = await screen.findAllByText(MEAL.name);
    for (const card of cards) {
      expect(heading.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it('explains without gating — a guest still browses the whole grid', async () => {
    render(<DiscoverPage />);

    await screen.findAllByText(MEAL.name);
    expect(screen.getAllByRole('button', { name: /Save to My Meals/ }).length).toBeGreaterThan(0);
    // Sign-up is offered as a link, not imposed as a wall — and asked once.
    const signup = screen.getAllByRole('link', { name: /Create a free account/ });
    expect(signup).toHaveLength(1);
    expect(signup[0].getAttribute('href')).toBe('/signin?tab=signup');
  });

  it('shows it to a visitor whose stored token has expired', async () => {
    // `verifyAuth` clears localStorage and falls through to guest mode. `token`
    // and `user` are both empty by the time the page renders, and this visitor
    // needs the pitch as much as one who never had a token.
    localStorage.setItem('accessToken', 'stale');
    stubApi({ verifyOk: false });

    render(<DiscoverPage />);

    await screen.findByText(PITCH_HEADLINE);
    expect(pageText()).toMatch(/cart/i);
  });
});

describe('Discover — a signed-in user is not pitched to', () => {
  it('renders no pitch once auth resolves', async () => {
    localStorage.setItem('accessToken', 'tok');

    render(<DiscoverPage />);

    // Wait for the page proper, so this is not passing on the loading spinner.
    await screen.findAllByText(MEAL.name);
    expect(screen.queryByText(PITCH_HEADLINE)).toBeNull();
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
    expect(screen.queryByRole('link', { name: /Create a free account/ })).toBeNull();
    // They converted; the three steps are noise between them and their meals.
    expect(pageText()).not.toContain(PITCH_NOTHING_ORDERED);
  });

  it('never flashes the pitch on the way to resolving auth', async () => {
    // A stored token means the page renders its loading spinner until
    // /api/auth/verify answers. If the pitch were keyed off anything that is
    // falsy during that window, a returning user would see it blink past.
    localStorage.setItem('accessToken', 'tok');

    let seen = false;
    const observer = new MutationObserver(() => {
      if ((document.body.textContent ?? '').includes(PITCH_HEADLINE)) seen = true;
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });

    render(<DiscoverPage />);
    await screen.findAllByText(MEAL.name);
    await waitFor(() => expect(seen).toBe(false));
    observer.disconnect();
  });
});
