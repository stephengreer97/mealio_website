// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import YouTubeConnectCard from '@/components/YouTubeConnectCard';

/**
 * The connect card (MEAL-74).
 *
 * The property under test is the consent split: connecting reads the channel,
 * and a *separate*, unticked-by-default box permits editing descriptions. A
 * "Connect YouTube" button that quietly acquires description-write access is the
 * thing MEAL-77 forbids, so the button says both and the tick is what decides.
 */

const NOT_CONNECTED = { connected: false, channel: null, brokenReason: null, canWriteDescriptions: false, appendOptIn: false };
const CONNECTED = {
  connected: true,
  channel: { id: 'UCabcdefghijklmnopqrstuv', title: 'Chef Sarah' },
  brokenReason: null,
  canWriteDescriptions: true,
  appendOptIn: false,
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Serves the status GET, and records every other call for assertions. */
function harness(status: unknown, routes: (url: string, init?: RequestInit) => Response | null = () => null) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const routed = routes(url, init);
    if (routed) return routed;
    return json(status);
  }) as typeof fetch;
  vi.stubGlobal('fetch', fetchImpl);
  render(<YouTubeConnectCard />);
  return { calls };
}

beforeEach(() => {
  localStorage.setItem('accessToken', 'test-token');
  // The card reads the OAuth outcome off the URL it was returned to.
  window.history.replaceState({}, '', '/creator');
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('YouTubeConnectCard — connecting', () => {
  it('names both uses on the button once the write box is ticked', async () => {
    harness(NOT_CONNECTED);
    const box = await screen.findByRole('checkbox');

    expect(screen.getByRole('button', { name: /read my videos/i })).toBeTruthy();
    // Unticked by default: reading their videos and editing their descriptions
    // are different permissions over different property.
    expect((box as HTMLInputElement).checked).toBe(false);

    fireEvent.click(box);
    expect(screen.getByRole('button', { name: /edit their descriptions/i })).toBeTruthy();
  });

  it('sends the tick with the request that starts the round trip', async () => {
    const { calls } = harness(NOT_CONNECTED, (url) =>
      url.endsWith('/connect') ? json({ url: 'https://accounts.google.com/o/oauth2/v2/auth?x=1' }) : null,
    );
    fireEvent.click(await screen.findByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: /Connect YouTube/i }));

    await waitFor(() => expect(calls.some((call) => call.url.endsWith('/connect'))).toBe(true));
    // The server stores what was on screen, rather than trusting a later call to
    // say what the creator agreed to.
    expect(calls.find((call) => call.url.endsWith('/connect'))?.body).toEqual({ appendOptIn: true });
  });

  it('shows the callback failure rather than a card that looks connected', async () => {
    window.history.replaceState({}, '', '/creator?youtube=failed&detail=That+account+has+no+channel.');
    harness(NOT_CONNECTED);
    expect(await screen.findByText(/no channel/i)).toBeTruthy();
  });
});

describe('YouTubeConnectCard — once connected', () => {
  it('offers the consent as a one-click toggle', async () => {
    const { calls } = harness(CONNECTED, (url, init) =>
      init?.method === 'PATCH' ? json({ ok: true, appendOptIn: true }) : null,
    );
    const box = await screen.findByRole('checkbox');
    expect((box as HTMLInputElement).checked).toBe(false);

    fireEvent.click(box);

    await waitFor(() => expect(calls.some((call) => call.method === 'PATCH')).toBe(true));
    expect(calls.find((call) => call.method === 'PATCH')?.body).toEqual({ appendOptIn: true });
  });

  it('disables the toggle on a grant that never got the write scope', async () => {
    harness({ ...CONNECTED, canWriteDescriptions: false });
    const box = await screen.findByRole('checkbox');
    expect((box as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(/without permission to edit descriptions/i)).toBeTruthy();
  });

  it('tells the creator when the connection has broken, and offers to reconnect', async () => {
    harness({ ...CONNECTED, brokenReason: 'Token has been expired or revoked.' });

    // A dead grant is indistinguishable from a quiet channel from the outside,
    // so it is stated to the one person who can fix it.
    expect(await screen.findByText(/expired or revoked/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Connect YouTube/i })).toBeTruthy();
  });
});
