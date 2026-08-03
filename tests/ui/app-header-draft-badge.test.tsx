// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
  usePathname: () => '/discover',
}));

import AppHeader from '@/components/AppHeader';

/**
 * The pending-draft badge on Creator Portal (MEAL-89).
 *
 * Two rules, and both of them are about a creator who did not come here to
 * review anything:
 *
 *   1. **A badge and nothing else.** No modal, no redirect, no interstitial.
 *      Someone who opened the site to add a meal to their cart gets to do that.
 *   2. **Both surfaces, or it does not count.** The desktop button AND the
 *      mobile menu entry, because a count only the desktop nav shows is
 *      invisible to every creator using the site on a phone.
 *
 * And the count itself, never a dot: "10" tells a creator to set an evening
 * aside, and a dot says the same thing for one draft as for twenty.
 */

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Answers the four endpoints the header talks to on mount. */
function harness({ waiting, isCreator = true }: { waiting: number; isCreator?: boolean }) {
  const seen: string[] = [];
  vi.stubGlobal('fetch', (async (input: RequestInfo | URL) => {
    const url = String(input);
    seen.push(url);
    if (url.includes('/api/creator/import-drafts')) return json({ waiting });
    if (url.includes('/api/creator/me')) return json({ creator: isCreator ? { id: 'c1' } : null });
    return json({ ok: true });
  }) as unknown as typeof fetch);
  render(<AppHeader />);
  return { seen };
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('accessToken', 'test-token');
  localStorage.setItem('user', JSON.stringify({ isCreator: true }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('the badge shows the count', () => {
  it('puts the number on the desktop Creator Portal button', async () => {
    harness({ waiting: 10 });
    const badges = await screen.findAllByTestId('creator-draft-badge');
    expect(badges[0].textContent).toBe('10');
  });

  it('puts it on the mobile menu entry too', async () => {
    // The entry a creator on a phone actually taps. A count only the desktop nav
    // carries is invisible to most of the people it is for.
    harness({ waiting: 3 });
    await screen.findAllByTestId('creator-draft-badge');

    fireEvent.click(screen.getByLabelText('Menu'));

    const badges = await screen.findAllByTestId('creator-draft-badge');
    expect(badges).toHaveLength(2);
    expect(badges.every((b) => b.textContent === '3')).toBe(true);
  });

  it('names what the number is, for a reader who cannot see where it sits', async () => {
    // "7" beside a button labelled "Creator Portal" is a number with no noun
    // attached to it.
    harness({ waiting: 7 });
    const badge = (await screen.findAllByTestId('creator-draft-badge'))[0];
    expect(badge.getAttribute('aria-label')).toMatch(/7 recipes waiting/i);
  });

  it('shows nothing at all when nothing is waiting', async () => {
    // Not a zero, and not a dot. Nothing.
    harness({ waiting: 0 });
    await waitFor(() => expect(screen.getByText('Creator Portal')).toBeTruthy());
    expect(screen.queryAllByTestId('creator-draft-badge')).toHaveLength(0);
  });

  it('caps the badge before it stops being a badge', async () => {
    harness({ waiting: 140 });
    const badge = (await screen.findAllByTestId('creator-draft-badge'))[0];
    expect(badge.textContent).toBe('99+');
  });
});

describe('the badge is all that happens', () => {
  it('never navigates a creator anywhere on its own', async () => {
    // The whole point of the revised design: a creator who opened the site to do
    // something else is not routed into a review flow by having drafts.
    harness({ waiting: 10 });
    await screen.findAllByTestId('creator-draft-badge');
    expect(push).not.toHaveBeenCalled();
  });

  it('asks for the count without waiting to learn whether they are a creator', async () => {
    // `isCreator` resolves from a round trip of its own, and gating the count on
    // it would make the badge flash in a beat after the button it sits on. The
    // endpoint answers 0 for anyone who is not a creator.
    const { seen } = harness({ waiting: 2, isCreator: false });
    await waitFor(() => expect(seen.some((u) => u.includes('import-drafts?count=1'))).toBe(true));
  });
});

describe('the count keeps up', () => {
  it('takes a new count from the queue when a draft is decided', async () => {
    // The queue on the portal and this header are siblings under a page neither
    // owns. Without the event a creator watches the queue empty while the header
    // keeps saying 3, in the one place they can see it be wrong.
    harness({ waiting: 3 });
    expect((await screen.findAllByTestId('creator-draft-badge'))[0].textContent).toBe('3');

    window.dispatchEvent(new CustomEvent('mealio:draft-queue-changed', { detail: { waiting: 1 } }));

    await waitFor(() => expect(screen.getAllByTestId('creator-draft-badge')[0].textContent).toBe('1'));
  });

  it('drops the badge when the queue is emptied', async () => {
    harness({ waiting: 1 });
    await screen.findAllByTestId('creator-draft-badge');

    window.dispatchEvent(new CustomEvent('mealio:draft-queue-changed', { detail: { waiting: 0 } }));

    await waitFor(() => expect(screen.queryAllByTestId('creator-draft-badge')).toHaveLength(0));
  });
});
