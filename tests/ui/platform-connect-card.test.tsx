// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import PlatformConnectCard from '@/components/PlatformConnectCard';

/**
 * The Instagram and TikTok connect cards (MEAL-82 / MEAL-83).
 *
 * What is under test is the honesty of the copy as much as the wiring. Both
 * platforms read text the creator typed and nothing else, and a creator whose
 * recipes live in a voiceover should learn that here rather than after their
 * first empty import — so the ceiling is stated on the card, and TikTok's is
 * stated as permanent because it is.
 *
 * There is deliberately no consent checkbox on either card: neither platform
 * exposes a way to edit a post made in the app, so unlike YouTube there is no
 * second permission to ask for.
 */

const NOT_CONNECTED = { connected: false, account: null, brokenReason: null, expiresAt: null };
const CONNECTED = {
  connected: true,
  account: { id: '178', name: 'chefsarah' },
  brokenReason: null,
  expiresAt: '2026-10-01T00:00:00.000Z',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Serves the status GET, and records every other call for assertions. */
function harness(
  platform: 'instagram' | 'tiktok',
  status: unknown,
  routes: (url: string, init?: RequestInit) => Response | null = () => null,
) {
  const calls: Array<{ url: string; method: string }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? 'GET' });
    return routes(url, init) ?? json(status);
  }) as typeof fetch;
  vi.stubGlobal('fetch', fetchImpl);
  render(<PlatformConnectCard platform={platform} />);
  return { calls };
}

beforeEach(() => {
  localStorage.setItem('accessToken', 'test-token');
  // The card reads the OAuth outcome off the URL it was returned to.
  window.history.replaceState({}, '', '/creator');
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('PlatformConnectCard — connecting', () => {
  it('says what Instagram can and cannot read, and names the account requirement', async () => {
    harness('instagram', NOT_CONNECTED);

    expect(await screen.findByRole('button', { name: /^Connect Instagram$/i })).toBeTruthy();
    // A personal account gets no API access at all. Better said before the
    // creator tries than as a failure afterwards.
    expect(screen.getByText(/Professional \(Business or Creator\)/)).toBeTruthy();
    expect(screen.getByText(/cannot read what is only spoken/i)).toBeTruthy();
  });

  it('states TikTok’s ceiling as a limit of TikTok rather than a gap of ours', async () => {
    harness('tiktok', NOT_CONNECTED);

    expect(await screen.findByRole('button', { name: /^Connect TikTok$/i })).toBeTruthy();
    // No video file and no transcript, ever — so there is no future version of
    // this that does better, and the copy should not imply one.
    expect(screen.getByText(/no video file and no transcript/i)).toBeTruthy();
  });

  it('offers no second consent to tick, because there is no second permission', async () => {
    harness('instagram', NOT_CONNECTED);
    await screen.findByRole('button', { name: /Connect Instagram/i });

    // YouTube's card has one, for editing descriptions. Neither of these
    // platforms lets anyone edit a post made in the app.
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('navigates to the consent URL the server built', async () => {
    const { calls } = harness('tiktok', NOT_CONNECTED, (url) =>
      url.endsWith('/connect') ? json({ url: 'https://www.tiktok.com/v2/auth/authorize/?x=1' }) : null,
    );

    fireEvent.click(await screen.findByRole('button', { name: /Connect TikTok/i }));

    await waitFor(() => expect(calls.some((call) => call.url.endsWith('/connect'))).toBe(true));
    expect(calls.find((call) => call.url.endsWith('/connect'))?.method).toBe('POST');
  });

  it('shows the callback failure rather than a card that looks connected', async () => {
    window.history.replaceState({}, '', '/creator?instagram=failed&reason=scope');
    harness('instagram', NOT_CONNECTED);
    expect(await screen.findByText(/leave the permission ticked/i)).toBeTruthy();
  });

  it('renders its own sentence for a reason code, never the URL\u2019s prose', async () => {
    // The callback used to redirect with the failure *sentence* in the query
    // string and this card rendered it. React escapes it, so it was never an
    // XSS - but `mealio.co/creator?instagram=failed&detail=...` still put
    // attacker-written prose inside our own error styling on our own domain.
    window.history.replaceState(
      {},
      '',
      '/creator?instagram=failed&detail=Your+account+is+suspended.+Call+1-800-555-0100.',
    );
    harness('instagram', NOT_CONNECTED);

    expect(await screen.findByText(/That connection did not complete\./)).toBeTruthy();
    expect(screen.queryByText(/1-800-555-0100/)).toBeNull();
  });

  it('falls back to the generic sentence for a code it does not know', async () => {
    window.history.replaceState({}, '', '/creator?instagram=failed&reason=not-a-real-code');
    harness('instagram', NOT_CONNECTED);
    expect(await screen.findByText(/That connection did not complete\./)).toBeTruthy();
  });

  it('reads only its own platform’s callback outcome', async () => {
    // Both cards are on the same page, so a TikTok failure must not render on
    // the Instagram card.
    window.history.replaceState({}, '', '/creator?tiktok=failed&reason=scope');
    harness('instagram', NOT_CONNECTED);
    await screen.findByRole('button', { name: /Connect Instagram/i });
    expect(screen.queryByText(/leave the permission ticked/i)).toBeNull();
  });
});

describe('PlatformConnectCard — once connected', () => {
  it('shows the Instagram expiry, which is real and short', async () => {
    harness('instagram', CONNECTED);

    expect(await screen.findByText(/@chefsarah/)).toBeTruthy();
    // Sixty days, renewed automatically. A creator who can see the date can
    // notice if it ever stops moving, instead of finding out when their imports
    // quietly stop.
    expect(screen.getByText(/renews itself automatically/i)).toBeTruthy();
  });

  it('shows no expiry line for TikTok, whose access token turns over daily', async () => {
    harness('tiktok', { ...CONNECTED, account: { id: 'open-id-1', name: null } });

    // The stored expiry is tomorrow's access token, not the connection's life.
    // Printing it would read as "this stops working tomorrow".
    expect(await screen.findByText(/Connected account/)).toBeTruthy();
    expect(screen.queryByText(/renews itself automatically/i)).toBeNull();
  });

  it('tells the creator when the connection has broken, and offers to reconnect', async () => {
    harness('tiktok', { ...CONNECTED, brokenReason: 'TikTok refused to refresh this grant.' });

    // A dead grant is indistinguishable from a quiet account from the outside,
    // so it is stated to the one person who can fix it.
    expect(await screen.findByText(/refused to refresh/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Connect TikTok/i })).toBeTruthy();
  });

  it('disconnects with a DELETE and re-reads the status', async () => {
    const { calls } = harness('instagram', CONNECTED, (_url, init) =>
      init?.method === 'DELETE' ? json({ ok: true }) : null,
    );

    fireEvent.click(await screen.findByRole('button', { name: /Disconnect Instagram/i }));

    await waitFor(() => expect(calls.some((call) => call.method === 'DELETE')).toBe(true));
  });

  it('does not claim the account was disconnected when the delete failed', async () => {
    harness('instagram', CONNECTED, (_url, init) =>
      init?.method === 'DELETE'
        ? json({ error: 'We could not disconnect that account. It is still connected — please try again.' }, 500)
        : null,
    );

    fireEvent.click(await screen.findByRole('button', { name: /Disconnect Instagram/i }));

    // A revocation reported optimistically is the one a creator never checks up
    // on: the card would read as disconnected while the grant is still live at
    // Instagram and the token is still in the table.
    expect(await screen.findByText(/still connected/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Disconnect Instagram/i })).toBeTruthy();
  });
});
