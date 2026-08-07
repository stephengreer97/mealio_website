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

/** A creator who has told us they have a channel, but has not connected it yet. */
const NOT_CONNECTED = { hasChannel: true, connected: false, channel: null, brokenReason: null, canWriteDescriptions: false, canReadCaptions: false, appendOptIn: false };
/** No channel at all: no link, no grant. Nothing about YouTube is offered. */
const NO_CHANNEL = { ...NOT_CONNECTED, hasChannel: false };
const CONNECTED = {
  hasChannel: true,
  connected: true,
  channel: { id: 'UCabcdefghijklmnopqrstuv', title: 'Chef Sarah' },
  brokenReason: null,
  canWriteDescriptions: true,
  // The same `force-ssl` grant behind both, so in a fixture they move together —
  // a status that had one without the other could not come off a real row.
  canReadCaptions: true,
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

    expect(screen.getByRole('button', { name: /^Connect YouTube$/i })).toBeTruthy();
    // Unticked by default: reading their videos and editing their descriptions
    // are different permissions over different property.
    expect((box as HTMLInputElement).checked).toBe(false);

    fireEvent.click(box);
    expect(screen.getByRole('button', { name: /edit descriptions/i })).toBeTruthy();
  });

  it('sends the tick with the request that starts the round trip', async () => {
    const { calls } = harness(NOT_CONNECTED, (url) =>
      url.endsWith('/connect') ? json({ url: 'https://accounts.google.com/o/oauth2/v2/auth?x=1' }) : null,
    );
    fireEvent.click(await screen.findByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: /^Connect YouTube/i }));

    await waitFor(() => expect(calls.some((call) => call.url.endsWith('/connect'))).toBe(true));
    // The server stores what was on screen, rather than trusting a later call to
    // say what the creator agreed to.
    expect(calls.find((call) => call.url.endsWith('/connect'))?.body).toEqual({ appendOptIn: true });
  });

  it('no longer promises captions on a connection that cannot read them', async () => {
    harness(NOT_CONNECTED);
    await screen.findByRole('checkbox');

    // This paragraph used to read "and their captions, which YouTube only shares
    // with the channel owner". A creator read it, connected, and got a grant that
    // cannot read a caption — the copy was promising a capability that had moved
    // behind an incremental scope (MEAL-138).
    expect(screen.getByText(/titles and descriptions, so a recipe can be imported/i)).toBeTruthy();
    expect(screen.queryByText(/Connecting lets Mealio read.*captions/i)).toBeNull();
  });

  it('shows the callback failure rather than a card that looks connected', async () => {
    window.history.replaceState({}, '', '/creator?youtube=failed&reason=account');
    harness(NOT_CONNECTED);
    expect(await screen.findByText(/could not read a channel/i)).toBeTruthy();
  });

  it('renders its own sentence for a reason code, never the URL\u2019s prose', async () => {
    // Same argument as `PlatformConnectCard`: free text in the query string is
    // prose an attacker picks, rendered in our error styling on our domain.
    window.history.replaceState({}, '', '/creator?youtube=failed&detail=Call+1-800-555-0100+to+restore+access.');
    harness(NOT_CONNECTED);

    expect(await screen.findByText(/That connection did not complete\./)).toBeTruthy();
    expect(screen.queryByText(/1-800-555-0100/)).toBeNull();
  });
});

/**
 * The gate MEAL-78 asks for: hidden, not disabled.
 *
 * The append consent is a permission over property that is not ours. Offering it
 * about a channel that does not exist is a prompt a creator learns to click
 * past, which is what makes the next one worthless — so a creator with no
 * YouTube at all is shown nothing to click past.
 */
describe('YouTubeConnectCard — no channel', () => {
  it('renders nothing at all for a creator with no YouTube', async () => {
    const { calls } = harness(NO_CHANNEL);

    await waitFor(() => expect(calls.some((call) => call.url.includes('/api/creator/youtube'))).toBe(true));
    // Not merely a disabled tick: no consent control, and no connect button
    // either, since there is nothing to connect.
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByRole('button', { name: /YouTube/i })).toBeNull();
    expect(screen.queryByText(/description/i)).toBeNull();
  });

  it('appears as soon as the creator adds a link, before anything is connected', async () => {
    // `hasChannel` is true on a link alone — the creator has told us the channel
    // exists, which is what MEAL-94's editor is for. The offer is then honest.
    harness(NOT_CONNECTED);
    expect(await screen.findByRole('checkbox')).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Connect YouTube/i })).toBeTruthy();
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

  it('leaves the toggle live on a grant that only has read', async () => {
    // Which is now every fresh connection. The write scope is asked for when
    // somebody ticks this box, so disabling it would disable the only way to
    // ask — and the standing "reconnect to allow it" notice went with it,
    // because it would have shown against every connected channel.
    harness({ ...CONNECTED, canWriteDescriptions: false, canReadCaptions: false });
    const box = await screen.findByRole('checkbox');
    expect((box as HTMLInputElement).disabled).toBe(false);
    expect(screen.queryByText(/without permission to edit descriptions/i)).toBeNull();
  });

  it('tells the creator when the connection has broken, and offers to reconnect', async () => {
    harness({ ...CONNECTED, brokenReason: 'Token has been expired or revoked.' });

    // A dead grant is indistinguishable from a quiet channel from the outside,
    // so it is stated to the one person who can fix it.
    expect(await screen.findByText(/expired or revoked/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Connect YouTube/i })).toBeTruthy();
  });

  it('shows a granted permission as granted, and revokes it, on a broken connection', async () => {
    // A broken connection used to fall into the connect branch, whose checkbox
    // was bound to local state seeded `false`: a creator who had granted
    // description edits was shown the box unticked, and had no way to withdraw
    // the permission or to remove the stored token. The PATCH route supported
    // both the whole time; nothing in the UI reached it.
    const { calls } = harness(
      { ...CONNECTED, brokenReason: 'Token has been expired or revoked.', appendOptIn: true },
      (_url, init) => (init?.method === 'PATCH' ? json({ ok: true, appendOptIn: false }) : null),
    );

    const box = (await screen.findByRole('checkbox')) as HTMLInputElement;
    expect(box.checked).toBe(true);

    fireEvent.click(box);

    await waitFor(() => expect(calls.some((call) => call.method === 'PATCH')).toBe(true));
    expect(calls.find((call) => call.method === 'PATCH')?.body).toEqual({ appendOptIn: false });
    expect(screen.getByRole('button', { name: /Disconnect YouTube/i })).toBeTruthy();
  });

  it('can always be switched off, even on a grant that lost the write scope', async () => {
    harness({ ...CONNECTED, canWriteDescriptions: false, canReadCaptions: false, appendOptIn: true });
    // Turning it on needs the scope; turning it off must work from every state
    // there is, or it is not revocation.
    expect(((await screen.findByRole('checkbox')) as HTMLInputElement).disabled).toBe(false);
  });

  /**
   * MEAL-138: the consequence has to be visible, and actionable where it is seen.
   *
   * A read-only grant cannot read a single caption, so every video whose
   * description runs under about 250 characters silently fails to import. Before
   * this the card said the opposite — "connecting lets Mealio read ... their
   * captions, which YouTube only shares with the channel owner" — which stopped
   * being true the moment the scope became incremental, and there was no control
   * anywhere that asked for it except the description-editing tick.
   */
  it('says so when it cannot read captions, and offers the permission that fixes it', async () => {
    harness({ ...CONNECTED, canWriteDescriptions: false, canReadCaptions: false });

    expect(await screen.findByText(/cannot read this channel’s captions/i)).toBeTruthy();
    // Named as a consequence, not as a scope: what a creator loses is videos.
    expect(screen.getByText(/gets skipped/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /read my captions/i })).toBeTruthy();
    // Google's screen will say "edit and permanently delete". A creator who was
    // told we want to read subtitles must have been warned, and told what still
    // governs the edit.
    expect(screen.getByText(/its screen will mention editing your videos/i)).toBeTruthy();
  });

  it('asks for captions without turning description editing on', async () => {
    const { calls } = harness(
      { ...CONNECTED, canWriteDescriptions: false, canReadCaptions: false },
      (url) => (url.endsWith('/connect') ? json({ url: 'https://accounts.google.com/o/oauth2/v2/auth?x=1' }) : null),
    );

    fireEvent.click(await screen.findByRole('button', { name: /read my captions/i }));

    await waitFor(() => expect(calls.some((call) => call.url.endsWith('/connect'))).toBe(true));
    // `captions` is its own reason and carries no consent to edit. The append
    // value travelling with it is whatever it already was — asking to have
    // captions read must not turn editing on, and must not turn it off either.
    expect(calls.find((call) => call.url.endsWith('/connect'))?.body).toEqual({
      appendOptIn: false,
      captions: true,
    });
  });

  it('carries a granted append consent through a captions trip rather than withdrawing it', async () => {
    // The callback withdraws append consent whenever the state cookie says
    // false, so a captions request that forgot to carry the creator's existing
    // `true` would silently revoke a permission they had granted.
    const { calls } = harness(
      { ...CONNECTED, canWriteDescriptions: false, canReadCaptions: false, appendOptIn: true },
      (url) => (url.endsWith('/connect') ? json({ url: 'https://accounts.google.com/o/oauth2/v2/auth?x=1' }) : null),
    );

    fireEvent.click(await screen.findByRole('button', { name: /read my captions/i }));

    await waitFor(() => expect(calls.some((call) => call.url.endsWith('/connect'))).toBe(true));
    expect(calls.find((call) => call.url.endsWith('/connect'))?.body).toEqual({
      appendOptIn: true,
      captions: true,
    });
  });

  it('says nothing about captions once the permission is there', async () => {
    harness(CONNECTED);
    await screen.findByRole('checkbox');
    // A standing notice about a permission already granted is the noise that
    // teaches people to ignore the next one.
    expect(screen.queryByText(/cannot read this channel’s captions/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /read my captions/i })).toBeNull();
    expect(screen.getByText(/can also read this channel’s captions/i)).toBeTruthy();
  });

  it('does not claim the channel was disconnected when the delete failed', async () => {
    harness(CONNECTED, (_url, init) =>
      init?.method === 'DELETE' ? json({ error: 'We could not disconnect that channel.' }, 500) : null,
    );

    fireEvent.click(await screen.findByRole('button', { name: /Disconnect YouTube/i }));

    // The card never inspected the response, so a failed revocation left the
    // grant live and the creator told it was gone.
    expect(await screen.findByText(/could not disconnect/i)).toBeTruthy();
  });
});

describe('turning on description editing', () => {
  it('goes straight to Google when the connection only has read', async () => {
    // The ordinary case now: the write scope is asked for when somebody ticks
    // this box, not when they connect. Reporting a refusal and making them find
    // the reconnect button would be answering a request with an error.
    const calls: string[] = [];
    let redirected = '';
    vi.stubGlobal('fetch', (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${init?.method ?? 'GET'} ${new URL(url, 'http://localhost').pathname}`);
      if (url.includes('/connect')) return json({ url: 'https://accounts.google.com/o/oauth2/v2/auth?scope=write' });
      if (init?.method === 'PATCH') return json({ error: 'not granted yet', needsConsent: true }, 409);
      return json({
        hasChannel: true, connected: true, channel: { title: 'Chef Sarah' },
        brokenReason: null, canWriteDescriptions: false, appendOptIn: false,
      });
    }) as unknown as typeof fetch);
    const location = { href: '' };
    Object.defineProperty(window, 'location', { value: location, writable: true });

    render(<YouTubeConnectCard />);
    fireEvent.click(await screen.findByRole('checkbox'));

    // The consent trip is started, not an error shown.
    await waitFor(() => expect(calls).toContain('POST /api/creator/youtube/connect'));
    await waitFor(() => expect(location.href).toMatch(/accounts\.google\.com/));
    redirected = location.href;
    expect(redirected).toBeTruthy();
  });
});
