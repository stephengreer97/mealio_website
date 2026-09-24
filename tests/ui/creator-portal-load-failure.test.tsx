// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';

// The page pulls in server-only modules at import time; none of them is
// reached by these tests, so they are mocked away.
vi.mock('@/lib/supabase', () => ({ createServerSupabaseClient: () => ({}) }));
vi.mock('@/lib/logger', () => ({ log: vi.fn() }));
const pushed: string[] = [];
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: (p: string) => { pushed.push(p); } }) }));
vi.mock('@/components/AppHeader', () => ({ default: () => null }));
vi.mock('@/components/AppFooter', () => ({ default: () => null }));


const CreatorPortal = (await import('@/app/creator/page')).default;

/**
 * WHAT THE PORTAL DOES WHEN IT CANNOT LOAD.
 *
 * It used to do nothing at all: neither fetch was wrapped, so a dropped
 * connection threw out of the loader with `loading` still true, and the
 * spinner it leaves on screen has no text. The page was blank white, with no
 * error, no retry and no way back but a manual reload. Seen for real on
 * 2026-09-24, when the network blipped as Instagram redirected back from the
 * connect flow.
 *
 * The other half is who gets sent where: a server error is not the same as
 * "you are not a creator", and used to be treated as one.
 */

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  pushed.length = 0;
  localStorage.clear();
  localStorage.setItem('accessToken', 'test-token');
  window.history.replaceState(null, '', window.location.pathname);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

/** The portal with `fetch` behaving however a test says. */
function portalWith(handler: (url: string) => Promise<Response>) {
  vi.stubGlobal('fetch', ((input: RequestInfo | URL) => handler(String(input))) as typeof fetch);
  render(<CreatorPortal />);
}

describe('when the portal cannot be loaded', () => {
  it('says so and offers a retry, instead of spinning for ever', async () => {
    // The connection dropping mid-load: seen on 2026-09-24 when the network
    // blipped as Instagram redirected back, leaving a blank white page.
    let attempt = 0;
    portalWith(async (url) => {
      if (url.includes('/api/auth/verify')) return json({ ok: true });
      attempt += 1;
      if (attempt === 1) throw new TypeError('Failed to fetch');
      return json({ creator: { id: 'c1', display_name: 'Chef Sarah', handle: null, primary_source: 'website', import_opt_in: true }, meals: [], stats: null });
    });

    const msg = await screen.findByTestId('portal-load-error');
    expect(msg.textContent).toMatch(/could not load your Creator Portal/i);
    expect(pushed).toEqual([]);

    // And the retry actually loads it.
    fireEvent.click(screen.getByRole('button', { name: /Try again/i }));
    await waitFor(() => expect(screen.queryByTestId('portal-load-error')).toBeNull());
    await screen.findByRole('tab', { name: /Meals/i });
  });

  it('does not tell an approved creator to go and apply when the server errors', async () => {
    // A 500 used to redirect to /creator/apply, which reads as "you are not a
    // creator" for a problem that has nothing to do with them.
    portalWith(async (url) => {
      if (url.includes('/api/auth/verify')) return json({ ok: true });
      return json({ error: 'boom' }, 500);
    });

    await screen.findByTestId('portal-load-error');
    expect(pushed).toEqual([]);
  });

  it('still sends someone who is not a creator to the application page', async () => {
    portalWith(async (url) => {
      if (url.includes('/api/auth/verify')) return json({ ok: true });
      return json({ error: 'Not a creator' }, 403);
    });

    await waitFor(() => expect(pushed).toContain('/creator/apply'));
    expect(screen.queryByTestId('portal-load-error')).toBeNull();
  });

  it('still sends a signed-out visitor to sign in', async () => {
    portalWith(async () => json({ error: 'Unauthorized' }, 401));
    await waitFor(() => expect(pushed).toContain('/signin'));
  });
});
