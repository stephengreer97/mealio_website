// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import SyncSourceSection, { type SyncSectionCreator } from '@/components/SyncSourceSection';
import { CREATOR_SELECTION_MAX, CREATOR_SOURCE_OPTIONS } from '@/lib/creator-sources';

/**
 * "Sync your content with Mealio" (MEAL-101).
 *
 * One section in place of four cards, and the properties worth defending are
 * about what it *says* as much as what it does:
 *
 *  - **The promise is on the screen.** "Whatever you post from now on syncs
 *    automatically and comes back as a draft" is the whole product and it was
 *    nowhere on the creator's own page. A section that quietly loses that
 *    sentence in a redesign has lost the point of the ticket.
 *  - **The baseline is said where the list is.** Existing posts are marked seen,
 *    not imported, which is exactly why the checklist exists — unsaid, the
 *    creator connects a source, watches nothing arrive, and concludes it broke.
 *  - **Instagram is visible, unselectable, and says why.** A dead end reached
 *    after a decision is the worst order to put those two things in. TikTok was
 *    in that state until its credentials landed; it is selectable now, and what
 *    is left of its caveat belongs after the choice rather than on it.
 *  - **The cap is visible while they tick**, not sprung on them at the button.
 */

const CREATOR: SyncSectionCreator = {
  website_url: null,
  youtube_url: null,
  instagram_url: null,
  tiktok_url: null,
  feed_url: null,
  primary_source: 'none',
  import_opt_in: false,
};

/** A creator whose site has been read and found importable. */
const SYNCING: SyncSectionCreator = {
  ...CREATOR,
  website_url: 'https://chefsarah.test/',
  feed_url: 'https://chefsarah.test/feed',
  primary_source: 'website',
  import_opt_in: true,
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Entry {
  itemId: string;
  url: string;
  title: string;
  publishedAt: string;
  record: {
    status: string;
    detail: string | null;
    at: string | null;
    firstSeenAt: string | null;
    draftId?: string | null;
  } | null;
}

function entry(i: number): Entry {
  return {
    itemId: `chefsarah.test/post-${i}`,
    url: `https://chefsarah.test/post-${i}`,
    title: `Post ${i}`,
    publishedAt: '2026-01-01T00:00:00.000Z',
    record: null,
  };
}

interface HarnessOptions {
  creator?: SyncSectionCreator;
  entries?: Entry[];
  /**
   * Overrides for individual endpoints, matched on the URL.
   *
   * Given the request, because one path now answers differently by method:
   * `/api/creator/youtube` reports the connection on GET and revokes it on
   * DELETE, and a disconnect test needs the second to fail while the first
   * keeps working.
   */
  routes?: Record<string, (init?: RequestInit) => Response>;
}

let rerender: (ui: React.ReactElement) => void = () => {};

function harness({ creator = CREATOR, entries = [], routes = {} }: HarnessOptions = {}) {
  const calls: Array<{ url: string; method: string; body: any }> = [];
  const saved: Array<Record<string, unknown>> = [];

  vi.stubGlobal('fetch', (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    // Matched on the exact pathname. `includes` looked fine and quietly served
    // the run response to `/api/creator/sync/catalog`, because that path
    // contains `/api/creator/sync` — a harness that mis-routes is a test that
    // passes for the wrong reason.
    const path = new URL(url, 'http://localhost').pathname;
    const override = routes[path];
    if (override) return override(init);

    if (path === '/api/creator/youtube') {
      return json({ hasChannel: false, connected: false, channel: null, brokenReason: null, canWriteDescriptions: false, appendOptIn: false });
    }
    if (path === '/api/creator/tiktok') {
      return json({ connected: false, account: null, brokenReason: null, expiresAt: null, configured: true });
    }
    if (path === '/api/creator/sync/catalog') {
      return json({ catalog: { ok: true, source: 'website', feed: null, entries, truncated: false } });
    }
    if (path === '/api/creator/me') return json({ ok: true, notices: [] });
    return json({ ok: true });
  }) as typeof fetch);

  const view = render(<SyncSourceSection creator={creator} onSaved={changes => { saved.push(changes); }} />);
  rerender = view.rerender;
  return { calls, saved };
}

const picker = () => screen.getByLabelText('Where you publish') as HTMLSelectElement;

/**
 * jsdom has no IntersectionObserver, and the catalogue's infinite scroll is
 * built on one. This records every observer so a test can say "the creator
 * scrolled to the bottom" without pretending to lay anything out.
 */
const observers: Array<{ cb: IntersectionObserverCallback; targets: Element[] }> = [];
function stubIntersectionObserver() {
  observers.length = 0;
  vi.stubGlobal('IntersectionObserver', class {
    constructor(cb: IntersectionObserverCallback) { this.entry = { cb, targets: [] }; observers.push(this.entry); }
    entry: { cb: IntersectionObserverCallback; targets: Element[] };
    observe(node: Element) { this.entry.targets.push(node); }
    disconnect() { const i = observers.indexOf(this.entry); if (i >= 0) observers.splice(i, 1); }
    unobserve() {}
    takeRecords() { return []; }
    root = null; rootMargin = ''; thresholds = [];
  });
}

/** Scroll the sentinel into view, for whichever observer is watching it. */
function scrollToBottom() {
  for (const observer of [...observers]) {
    for (const target of observer.targets) {
      observer.cb([{ isIntersecting: true, target } as unknown as IntersectionObserverEntry],
        null as unknown as IntersectionObserver);
    }
  }
}

beforeEach(() => { localStorage.setItem('accessToken', 'test-token'); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

// ── The dropdown ─────────────────────────────────────────────────────────────

describe('the source picker', () => {
  it('offers exactly the four places, and no off position', () => {
    harness();
    const options = Array.from(picker().options);

    // Not a subset and not a superset. A source missing from here is a creator
    // who cannot be synced; one that should not be here is a promise we cannot
    // keep.
    //
    // Stopping is not among them. It was an option once, and it could only clear
    // the row — the grant behind it lives in another table and survived, which is
    // not what a creator who picked "nothing" meant. Disconnect does both.
    expect(options.map(o => o.value)).toEqual(['website', 'youtube', 'instagram', 'tiktok']);
  });

  it('opens on TikTok for a creator whose source is TikTok', () => {
    // It opened on the empty prompt while TikTok was blocked, and stayed there
    // after TikTok became selectable — so a TikTok creator saw no source, and no
    // catalogue either, since the checklist keys off the selection.
    harness({ creator: { ...CREATOR, primary_source: 'tiktok', import_opt_in: true } });

    expect(picker().value).toBe('tiktok');
  });

  it('sits on an unselectable prompt when no source has been chosen', () => {
    // The state a row an operator left on Instagram opens in, and the one
    // Disconnect returns to. It needs somewhere to rest in the control without
    // being an answer a creator can give.
    harness({ creator: { ...CREATOR, primary_source: 'instagram', import_opt_in: true } });

    expect(picker().value).toBe('none');
    const placeholder = Array.from(picker().options).find(o => o.value === 'none');
    expect(placeholder?.disabled).toBe(true);
  });

  it('disables Instagram alone, and leaves the rest selectable', () => {
    harness();
    const disabled = Array.from(picker().options).filter(o => o.disabled).map(o => o.value);

    // TikTok was in this list until its credentials landed. The integration was
    // finished the whole time — what was missing was a client key — so it moves
    // out the moment that is untrue, rather than staying disabled because the
    // ticket was written when it was.
    expect(disabled).toEqual(['instagram']);
  });

  it('marks the disabled one unavailable on the option itself', () => {
    harness();

    // On the option, which is where a creator meets it. The paragraph that
    // repeated each reason under the dropdown is gone: it restated a label
    // nobody can select, and the section reads as instructions rather than a
    // list of excuses without it.
    for (const option of CREATOR_SOURCE_OPTIONS.filter(o => o.blockedReason)) {
      const el = Array.from(picker().options).find(o => o.value === option.source);
      expect(el?.textContent).toMatch(/not available yet/i);
      expect(screen.queryByTestId(`blocked-${option.source}`)).toBeNull();
    }
  });

  it('sends nothing for a source that cannot be chosen', async () => {
    const { calls } = harness();

    // jsdom will happily assign a disabled option's value where a browser will
    // not let a user pick one, so this asserts the half that is ours: no write,
    // and no body pretending Instagram is a thing they can set up. The server
    // refuses it too, in `chooseCreatorSource`.
    fireEvent.change(picker(), { target: { value: 'instagram' } });

    await waitFor(() => expect(calls.some(c => c.method === 'PATCH')).toBe(false));
    expect(screen.queryByTestId('catalogue')).toBeNull();
  });

  it('shows the body for whichever source is picked, and only that one', async () => {
    harness();

    expect(screen.getByLabelText('Your website or blog')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /connect youtube/i })).toBeNull();

    fireEvent.change(picker(), { target: { value: 'youtube' } });

    expect(await screen.findByRole('button', { name: /connect youtube/i })).toBeTruthy();
    expect(screen.queryByLabelText('Your website or blog')).toBeNull();

    fireEvent.change(picker(), { target: { value: 'tiktok' } });

    expect(await screen.findByRole('button', { name: /connect tiktok/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /connect youtube/i })).toBeNull();
  });
});

// ── TikTok, which is real but provisional ────────────────────────────────────

describe('TikTok’s limited release', () => {
  it('warns nobody in advance about a refusal most will never hit', async () => {
    harness();
    fireEvent.change(picker(), { target: { value: 'tiktok' } });

    // The credentials are sandbox credentials, so TikTok refuses accounts it has
    // not registered as testers. That used to be said up front to every creator;
    // it is said by the callback instead, to the one creator it happened to. A
    // caveat above a button is read by everyone and true for almost none of them.
    await waitFor(() => expect(picker().value).toBe('tiktok'));
    expect(screen.queryByTestId('note-tiktok')).toBeNull();
    // And the option stays a plain choice, as it was.
    expect(Array.from(picker().options).find(o => o.value === 'tiktok')?.textContent).toBe('TikTok');
  });

  it('explains a refusal from TikTok instead of blaming the creator', async () => {
    // What the callback now redirects to when TikTok returns an error that is
    // not `access_denied` — which, while the app is in sandbox, is usually an
    // account that is not on its allow-list.
    window.history.replaceState(null, '', '/creator?tiktok=failed&reason=unavailable');
    harness();

    // It lands on TikTok by itself: a creator who has just been turned down has
    // to arrive at the panel that can tell them why, and the failure case is the
    // one where landing anywhere else is worst.
    await waitFor(() => expect(picker().value).toBe('tiktok'));
    const message = await screen.findByText(/did not connect that account/i);
    expect(message.textContent).toMatch(/limited release/i);
    expect(message.textContent).toMatch(/tell us and we will add yours/i);
    // And it does not say they cancelled, which is what every TikTok error used
    // to be reported as.
    expect(screen.queryByText(/you cancelled/i)).toBeNull();

    window.history.replaceState(null, '', '/creator');
  });

  it('says so plainly when the deployment has no TikTok credentials', async () => {
    harness({
      routes: {
        '/api/creator/tiktok': () =>
          json({ connected: false, account: null, brokenReason: null, expiresAt: null, configured: false }),
      },
    });
    fireEvent.change(picker(), { target: { value: 'tiktok' } });

    // `tiktokAuthUrl` returns null with no client key, so the button could only
    // ever produce a 500. It is replaced rather than left there to fail.
    expect(await screen.findByTestId('unconfigured-tiktok')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /connect tiktok/i })).toBeNull();
  });
});

// ── The promise ──────────────────────────────────────────────────────────────

describe('the promise the whole feature rests on', () => {
  it('says future posts sync automatically and come back for review', () => {
    harness();

    const section = screen.getByTestId('sync-source-section');
    // Both halves. "Syncs automatically" alone is a thing being done *to* them;
    // "comes back to review" is what makes it acceptable, and neither sentence
    // is worth much without the other.
    expect(section.textContent).toMatch(/syncs automatically/i);
    expect(section.textContent).toMatch(/comes back to you as a draft to review/i);
  });

  it('says it before any control, not after a creator has committed', () => {
    harness();

    const promise = screen.getByText(/syncs automatically/i);
    // Compared in the DOM rather than by searching the section's text, because
    // the intro paragraph contains the phrase "where you publish" too and a
    // string search finds that one first.
    expect(promise.compareDocumentPosition(picker()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('says the back catalogue is not swept up with it', async () => {
    harness({ creator: SYNCING, entries: [entry(1)] });

    // The first poll baselines: existing posts are marked seen, not imported.
    // Said beside the list, because it is the reason the list is there.
    const catalogue = await screen.findByTestId('catalogue');
    expect(catalogue.textContent).toMatch(/nothing you posted before now is imported on its own/i);
  });

  it('offers a way out only once there is something to stop', async () => {
    // The "Mealio is watching your Website now" line went with the redesign: the
    // promise at the top of the section already says what a connected source
    // does, and repeating it under the control read as filler. What has to
    // survive is the Disconnect beside it — that sentence was the only thing
    // anchoring the button, and the button is the off switch.
    harness({ creator: SYNCING });

    expect((await screen.findByTestId('sync-disconnect')).textContent).toMatch(/Disconnect Website/i);
  });

  it('claims nothing for a creator who has set nothing up', () => {
    harness();
    expect(screen.queryByTestId('sync-live')).toBeNull();
  });
});

// ── Choosing, and being refused ──────────────────────────────────────────────

describe('choosing a source', () => {
  it('takes effect when a ready source is picked', async () => {
    // Their site is checked, but they are currently syncing from nothing.
    const { calls, saved } = harness({
      creator: { ...SYNCING, primary_source: 'none', import_opt_in: false },
    });

    fireEvent.change(picker(), { target: { value: 'none' } });
    fireEvent.change(picker(), { target: { value: 'website' } });

    await waitFor(() => {
      const patch = calls.find(c => c.method === 'PATCH' && c.body?.primarySource === 'website');
      expect(patch?.url).toBe('/api/creator/me');
    });
    // And the portal around it is told, so the rest of the page is not showing
    // a row the server has moved on from.
    await waitFor(() => expect(saved.at(-1)).toMatchObject({ primary_source: 'website', import_opt_in: true }));
  });

  it('says what a switch gives up, naming the source being left', async () => {
    // Mealio reads one place, so switching is also stopping — and that half is
    // silent: the old account stays connected and nothing else on the screen
    // mentions it again. Without this a creator moves to TikTok, keeps posting
    // recipes to YouTube, and finds out months later from the missing drafts.
    harness({ creator: SYNCING });

    fireEvent.change(picker(), { target: { value: 'youtube' } });

    const warning = await screen.findByTestId('switch-warning');
    expect(warning.textContent).toMatch(/new you post to Website will not be imported/i);
    // And that the connection survives, because the warning would otherwise read
    // as "we have disconnected it".
    expect(warning.textContent).toMatch(/stays connected/i);
  });

  it('does not warn a creator who is only correcting an unanswered choice', async () => {
    // Nothing was being synced, so nothing is being given up. A warning here
    // teaches creators that this box cries wolf, and the one that matters is the
    // next one.
    harness();

    fireEvent.change(picker(), { target: { value: 'youtube' } });

    await waitFor(() => expect(picker().value).toBe('youtube'));
    expect(screen.queryByTestId('switch-warning')).toBeNull();
  });

  it('lets a creator stop being read at all', async () => {
    const { calls } = harness({ creator: SYNCING });

    fireEvent.click(screen.getByTestId('sync-disconnect'));

    // Consent that can only be given is not consent. Disconnect is not optional,
    // and for a website it clears the link as well as the row — that link is the
    // whole of what Mealio was given, so leaving it would make Disconnect mean
    // less here than it does for an account whose grant is revoked.
    await waitFor(() =>
      expect(calls.some(c =>
        c.method === 'PATCH' && c.body?.primarySource === 'none' && c.body?.links?.website === '')).toBe(true));
    expect(screen.getByTestId('sync-off').textContent).toMatch(/not reading anything you publish/i);
  });

  it('offers exactly one Disconnect, not one per card', async () => {
    // The connect cards carry their own Disconnect for standalone use, and
    // YouTube's is a separate component from the other platforms' — so
    // suppressing one of them embedded is not suppressing both. Two buttons with
    // the same label, one of which only revokes the grant and leaves the row
    // pointing at it, is worse than either alone.
    harness({
      creator: { ...CREATOR, primary_source: 'youtube', import_opt_in: true },
      routes: {
        // A live grant, which is the only state in which either button renders.
        '/api/creator/youtube': () => json({
          hasChannel: true,
          connected: true,
          channel: { title: 'Chef Sarah' },
          brokenReason: null,
          canWriteDescriptions: true,
          appendOptIn: false,
        }),
      },
    });

    await waitFor(() => expect(screen.getByTestId('sync-disconnect')).toBeTruthy());
    expect(screen.getAllByText(/^Disconnect YouTube$/)).toHaveLength(1);
  });

  it('does not announce a disconnection during an ordinary source write', async () => {
    // One flag used to cover both, and the section writes the creator's choice
    // as the page settles — so refreshing the portal showed a button saying
    // "Disconnecting…" at somebody who had pressed nothing.
    harness({ creator: SYNCING });

    fireEvent.change(picker(), { target: { value: 'website' } });

    await waitFor(() => expect(screen.getByTestId('sync-disconnect')).toBeTruthy());
    expect(screen.getByTestId('sync-disconnect').textContent).toMatch(/^Disconnect /);
  });

  it('starts reading the catalogue without waiting on the connect card', async () => {
    // The catalogue call is the slow one — TikTok pages twenty at a time, so up
    // to five round trips — and it used to sit behind the connect card's status
    // read rather than beside it. The row already says this source is being
    // synced, which is enough to start.
    const { calls } = harness({ creator: { ...CREATOR, primary_source: 'tiktok', import_opt_in: true } });

    await waitFor(() =>
      expect(calls.some(c => c.url.includes('/api/creator/sync/catalog'))).toBe(true));
  });

  it('revokes the grant before it says a connected account is disconnected', async () => {
    const { calls } = harness({ creator: { ...CREATOR, primary_source: 'youtube', import_opt_in: true } });

    await waitFor(() => expect(screen.getByTestId('sync-disconnect')).toBeTruthy());
    fireEvent.click(screen.getByTestId('sync-disconnect'));

    await waitFor(() =>
      expect(calls.some(c => c.method === 'PATCH' && c.body?.primarySource === 'none')).toBe(true));

    // Order matters and is the point. Clearing the row first would leave Mealio
    // holding a live token for an account it has been told to stop reading.
    const revoke = calls.findIndex(c => c.method === 'DELETE' && c.url.includes('/api/creator/youtube'));
    const clear = calls.findIndex(c => c.method === 'PATCH' && c.body?.primarySource === 'none');
    expect(revoke).toBeGreaterThanOrEqual(0);
    expect(revoke).toBeLessThan(clear);
  });

  it('keeps syncing, and says so, when the revocation fails', async () => {
    const { calls } = harness({
      creator: { ...CREATOR, primary_source: 'youtube', import_opt_in: true },
      routes: {
        '/api/creator/youtube': (init) =>
          init?.method === 'DELETE'
            ? json({ error: 'We could not disconnect that account. It is still connected — please try again.' }, 500)
            : json({ connected: true }),
      },
    });

    await waitFor(() => expect(screen.getByTestId('sync-disconnect')).toBeTruthy());
    fireEvent.click(screen.getByTestId('sync-disconnect'));

    // The row must not be cleared behind a token that is still live at Google.
    // A creator told "disconnected" while Mealio can still read them is the one
    // error in this flow nobody would think to check.
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/still connected/i));
    expect(calls.some(c => c.method === 'PATCH' && c.body?.primarySource === 'none')).toBe(false);
  });

  it('writes nothing merely because the portal was opened', async () => {
    // A row an operator set to Instagram, which this dropdown cannot show, so it
    // opens on "Nothing". Turning that into a write would silently reverse the
    // operator's decision for anybody who visited their own settings.
    const { calls } = harness({
      creator: { ...CREATOR, primary_source: 'instagram', import_opt_in: true },
    });

    await waitFor(() => expect(screen.getByTestId('sync-off')).toBeTruthy());
    expect(calls.some(c => c.method === 'PATCH')).toBe(false);
  });

  it('shows the server’s refusal rather than pretending it worked', async () => {
    const { calls } = harness({
      creator: { ...SYNCING, primary_source: 'none', import_opt_in: false },
      routes: {
        '/api/creator/me': () => json({ error: 'Connect your YouTube account first.' }, 400),
      },
    });

    fireEvent.change(picker(), { target: { value: 'youtube' } });
    // The connect card reports a live connection, so the section tries to set
    // the source and the server is the one that says no.
    await waitFor(() => expect(calls.some(c => c.method === 'PATCH')).toBe(false));
    expect(screen.queryByTestId('sync-live')).toBeNull();
  });
});

// ── The website box ──────────────────────────────────────────────────────────

describe('saving a website', () => {
  const site = () => screen.getByLabelText('Your website or blog');
  const save = () => fireEvent.click(screen.getByRole('button', { name: 'Save' }));

  it('sends the address to the check and shows what came back', async () => {
    const { calls, saved } = harness({
      routes: {
        '/api/creator/website': () =>
          json({
            ok: true,
            websiteUrl: 'https://chefsarah.test/',
            feedUrl: 'https://chefsarah.test/feed',
            outcome: 'viable',
            checked: 10,
            passed: 8,
            detail: '8 of the 10 recent posts we read are recipes Mealio can import. From now on new posts sync automatically.',
          }),
      },
    });

    fireEvent.change(site(), { target: { value: 'chefsarah.test' } });
    save();

    await waitFor(() => expect(calls.some(c => c.url.includes('/api/creator/website'))).toBe(true));
    expect(await screen.findByTestId('website-detail')).toBeTruthy();
    // Normalised server-side, so what is shown from here on is what is stored.
    await waitFor(() => expect((site() as HTMLInputElement).value).toBe('https://chefsarah.test/'));
    expect(saved.at(-1)).toMatchObject({ primary_source: 'website', import_opt_in: true });
  });

  it('shows a failed check as a reason, not a status code', async () => {
    harness({
      routes: {
        '/api/creator/website': () =>
          json({
            ok: false,
            outcome: 'unavailable',
            error: 'We could not find a feed on https://chefsarah.test/. Mealio follows your posts through an RSS or Atom feed.',
          }),
      },
    });

    fireEvent.change(site(), { target: { value: 'chefsarah.test' } });
    save();

    const failure = await screen.findByTestId('website-error');
    expect(failure.textContent).toMatch(/could not find a feed/i);
    // And nothing claims a save happened.
    expect(screen.queryByTestId('website-detail')).toBeNull();
    expect(screen.queryByTestId('catalogue')).toBeNull();
  });

  it('catches a typo before spending a few seconds on a round trip', async () => {
    const { calls } = harness();

    fireEvent.change(site(), { target: { value: 'https://instagram.com/chefsarah' } });
    save();

    expect((await screen.findByTestId('website-error')).textContent).toMatch(/Instagram/i);
    expect(calls.some(c => c.url.includes('/api/creator/website'))).toBe(false);
  });
});

// ── The checklist and its cap ────────────────────────────────────────────────

describe('the back-catalogue checklist', () => {
  const tickAll = () => fireEvent.click(screen.getByRole('button', { name: /Tick the \d+ newest/ }));

  it('appears once a source is connected, without being asked for', async () => {
    harness({ creator: SYNCING, entries: [entry(1), entry(2)] });

    // Drawing it costs a feed read and one query — no page fetched, no model
    // called — so making a creator press a button to find out what Mealio can
    // see would be ceremony over a free answer.
    const catalogue = await screen.findByTestId('catalogue');
    expect(within(catalogue).getByLabelText('Post 1')).toBeTruthy();
    expect(within(catalogue).getByLabelText('Post 2')).toBeTruthy();
  });

  it('is not offered at all until there is something to list', () => {
    harness();
    expect(screen.queryByTestId('catalogue')).toBeNull();
  });

  it('counts what is chosen against the cap while they tick', async () => {
    harness({ creator: SYNCING, entries: [entry(1), entry(2)] });
    await screen.findByTestId('catalogue');

    expect(screen.getByTestId('selection-count').textContent).toBe(`0 of ${CREATOR_SELECTION_MAX} chosen`);

    fireEvent.click(screen.getByLabelText('Post 1'));

    // A limit discovered at the moment it refuses you is a limit that reads as
    // a bug, so it is on screen from the first tick.
    expect(screen.getByTestId('selection-count').textContent).toBe(`1 of ${CREATOR_SELECTION_MAX} chosen`);
  });

  it('stops at the cap rather than letting them tick past it', async () => {
    const many = Array.from({ length: CREATOR_SELECTION_MAX + 20 }, (_, i) => entry(i));
    harness({ creator: SYNCING, entries: many });
    await screen.findByTestId('catalogue');

    tickAll();

    // Select-all takes the cap, not the catalogue.
    expect(screen.getByTestId('selection-count').textContent).toBe(`${CREATOR_SELECTION_MAX} of ${CREATOR_SELECTION_MAX} chosen`);
    expect(screen.getByTestId('cap-reached')).toBeTruthy();

    // And one more by hand does nothing but stay unticked — a creator who ticked
    // 140 and is then told to untick 40 has been made to do the counting the
    // screen was already doing.
    const overflow = screen.getByLabelText(`Post ${CREATOR_SELECTION_MAX + 5}`) as HTMLInputElement;
    expect(overflow.disabled).toBe(true);
    fireEvent.click(overflow);
    expect(screen.getByTestId('selection-count').textContent).toBe(`${CREATOR_SELECTION_MAX} of ${CREATOR_SELECTION_MAX} chosen`);
  });

  it('sends at most the cap when the run starts', async () => {
    const many = Array.from({ length: CREATOR_SELECTION_MAX + 20 }, (_, i) => entry(i));
    const { calls } = harness({
      creator: SYNCING,
      entries: many,
      routes: {
        '/api/creator/sync/worker': () =>
          json({ run: { id: 'r1', status: 'done', items: [] }, totals: { selected: CREATOR_SELECTION_MAX, pending: 0, drafted: CREATOR_SELECTION_MAX, rejected: 0, failed: 0, skipped: 0, costUsd: 0, needALook: 0 } }),
        '/api/creator/sync': () => json({ run: { id: 'r1', status: 'queued', items: [] } }, 201),
      },
    });
    await screen.findByTestId('catalogue');

    tickAll();
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`Import ${CREATOR_SELECTION_MAX} posts`) }));

    await waitFor(() => {
      const start = calls.find(c => c.url.endsWith('/api/creator/sync') && c.method === 'POST');
      expect(start?.body.items).toHaveLength(CREATOR_SELECTION_MAX);
    });
  });

  it('re-reads the catalogue and tells the queue once the run is done', async () => {
    // Both were stale until a manual refresh. The summary said "2 waiting in
    // your review queue" while the list underneath still showed both posts as
    // never imported, and the Drafts tab — a sibling component with its own
    // fetch — showed the queue as it was before the import. A creator reads that
    // pair as the import having silently failed.
    const imported = vi.fn();
    window.addEventListener('mealio:drafts-imported', imported);

    const { calls } = harness({
      creator: SYNCING,
      entries: [entry(1), entry(2)],
      routes: {
        '/api/creator/sync/worker': () =>
          json({
            run: { id: 'r1', status: 'done', items: [] },
            totals: { selected: 2, pending: 0, drafted: 2, rejected: 0, failed: 0, skipped: 0, costUsd: 0, needALook: 0 },
          }),
        '/api/creator/sync': () => json({ run: { id: 'r1', status: 'queued', items: [] } }, 201),
      },
    });
    await screen.findByTestId('catalogue');

    const before = calls.filter(c => c.url.includes('/api/creator/sync/catalog')).length;
    tickAll();
    fireEvent.click(screen.getByRole('button', { name: /Import 2 posts/ }));

    await screen.findByTestId('run-summary');
    await waitFor(() =>
      expect(calls.filter(c => c.url.includes('/api/creator/sync/catalog')).length).toBeGreaterThan(before));
    await waitFor(() => expect(imported).toHaveBeenCalled());

    window.removeEventListener('mealio:drafts-imported', imported);
  });

  it('fetches the next window when the creator scrolls to the bottom', async () => {
    // TikTok answers twenty at a time. Reading a hundred up front was five round
    // trips before the portal could draw anything, so the list takes one window
    // and asks for the next as the creator reaches it.
    stubIntersectionObserver();
    let page = 0;
    const { calls } = harness({
      creator: { ...CREATOR, primary_source: 'tiktok', import_opt_in: true },
      routes: {
        '/api/creator/tiktok': () =>
          json({ connected: true, account: { name: 'chefsarah' }, brokenReason: null, expiresAt: null, configured: true }),
        '/api/creator/sync/catalog': () => {
          page++;
          return json({
            catalog: {
              ok: true,
              source: 'tiktok',
              feed: null,
              entries: [entry(page * 10), entry(page * 10 + 1)],
              truncated: false,
              nextPageToken: page < 2 ? String(1_785_000_000_000 - page) : null,
            },
          });
        },
      },
    });

    await screen.findByTestId('catalogue-more');
    expect(screen.getAllByText(/^Post /)).toHaveLength(2);

    scrollToBottom();

    // Appended, not replaced — a list that swapped one window for the next would
    // lose whatever the creator had already ticked further up.
    await waitFor(() => expect(screen.getAllByText(/^Post /)).toHaveLength(4));
    const paged = calls.filter(c => c.url.includes('/api/creator/sync/catalog') && c.body?.pageToken);
    expect(paged).toHaveLength(1);

    // And it stops: the second window says there is no more, so the sentinel goes
    // with it rather than asking forever.
    await waitFor(() => expect(screen.queryByTestId('catalogue-more')).toBeNull());
  });

  it('stops asking when a window adds nothing it did not already have', async () => {
    // Blog feeds that do not implement `?paged=` answer every page with their
    // first one. The server cannot tell — each page looks full — so the list is
    // where it has to be noticed, or a creator scrolls forever past the same ten
    // posts while we re-fetch them.
    stubIntersectionObserver();
    const { calls } = harness({
      creator: SYNCING,
      routes: {
        '/api/creator/sync/catalog': () =>
          json({
            catalog: {
              ok: true,
              source: 'website',
              feed: null,
              entries: [entry(1), entry(2)],
              truncated: false,
              nextPageToken: '2',
            },
          }),
      },
    });

    await screen.findByTestId('catalogue-more');
    scrollToBottom();

    await waitFor(() =>
      expect(calls.filter(c => c.url.includes('/api/creator/sync/catalog')).length).toBeGreaterThan(1));
    // Same two posts back, so this is the end of the archive whatever the token
    // claims — the invitation to scroll for more goes away.
    await waitFor(() => expect(screen.queryByTestId('catalogue-more')).toBeNull());
    expect(screen.getAllByText(/^Post /)).toHaveLength(2);
  });

  it('cannot tick a post that is already in, but can tick one nothing came of', async () => {
    // Only an import is settled — that is the one the server refuses, and a box
    // that ticks and then silently does nothing is worse than no box. A gate
    // rejection is a machine's reading of the post and a decline is a mind that
    // can change; both stay tickable, because until MEAL-99 the only way to act
    // on either was a DELETE in the SQL editor.
    const already = { ...entry(1), record: { status: 'imported', detail: null, at: null, firstSeenAt: null } };
    const rejected = { ...entry(2), record: { status: 'rejected', detail: 'No ingredient list on the page.', at: null, firstSeenAt: null } };
    harness({ creator: SYNCING, entries: [already, rejected, entry(3)] });
    await screen.findByTestId('catalogue');

    const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
    expect(boxes[0].disabled).toBe(true);
    expect(boxes[1].disabled).toBe(false);
    expect(boxes[2].disabled).toBe(false);

    expect(screen.getByTestId('not-a-recipe').textContent).toMatch(/No recipe found/i);

    // Ticking it counts, so the run really is asked for it.
    fireEvent.click(boxes[1]);
    expect(screen.getByTestId('selection-count').textContent).toBe(`1 of ${CREATOR_SELECTION_MAX} chosen`);
  });

  it('says a declined post was declined, and offers it back', async () => {
    // The post produced a draft and a person said no, so `imported` would be a
    // lie — there is no meal. `Declined` is the tag, the box is live, and the
    // detail says what to do about it. What does *not* happen is an automatic
    // re-import: the poller reads the record's presence, not its status.
    const declined = {
      ...entry(1),
      record: {
        // Its own status, rather than a `rejected` identified by having a draft
        // behind it — that inference was sound but lived nowhere in the schema.
        status: 'declined',
        detail: 'This was turned into a draft and then declined in review, so nothing was published.',
        at: null,
        firstSeenAt: null,
        draftId: 'd1',
      },
    };
    harness({ creator: SYNCING, entries: [declined, entry(2)] });
    await screen.findByTestId('catalogue');

    expect(screen.getByTestId('declined').textContent).toMatch(/Declined/);
    expect(screen.queryByTestId('not-a-recipe')).toBeNull();
    expect((screen.getAllByRole('checkbox')[0] as HTMLInputElement).disabled).toBe(false);

    // Not in the bulk tick, though. Re-reading a post costs a model call to be
    // told the same thing, which is worth one creator's deliberate tick and not
    // worth a button that ticks forty.
    tickAll();
    expect(screen.getByTestId('selection-count').textContent).toBe(`1 of ${CREATOR_SELECTION_MAX} chosen`);
  });

  it('shows every post in the run, with the one being read marked', async () => {
    // An import of forty posts takes minutes, and the only thing on screen was a
    // button reading "Importing…" — a run that was working and a run that had
    // hung looked identical, and the summary only became true at the end.
    const items = [
      { itemId: 'a', url: 'https://chefsarah.test/a', title: 'Post A', publishedAt: null, status: 'drafted', detail: null, draftId: 'd1', mealName: 'Harissa Chicken', needALook: 2 },
      { itemId: 'b', url: 'https://chefsarah.test/b', title: 'Post B', publishedAt: null, status: 'pending', detail: null, draftId: null, mealName: null, needALook: null },
      { itemId: 'c', url: 'https://chefsarah.test/c', title: 'Post C', publishedAt: null, status: 'pending', detail: null, draftId: null, mealName: null, needALook: null },
    ];
    harness({
      creator: SYNCING,
      entries: [entry(1), entry(2), entry(3)],
      routes: {
        '/api/creator/sync': () => json({ run: { id: 'r1', status: 'queued', items: [] } }, 201),
        '/api/creator/sync/worker': () =>
          json({
            run: { id: 'r1', status: 'running', items },
            totals: { selected: 3, pending: 2, drafted: 1, rejected: 0, failed: 0, skipped: 0, costUsd: 0, needALook: 2 },
          }),
      },
    });
    await screen.findByTestId('catalogue');

    tickAll();
    fireEvent.click(screen.getByRole('button', { name: /Import 3 posts/ }));

    const queue = await screen.findByTestId('run-queue');
    // The extracted name rather than the post's title, once we have one: it is
    // what the creator will look for in their review queue.
    await waitFor(() => expect(queue.textContent).toMatch(/Harissa Chicken/));
    expect(queue.textContent).toMatch(/2 fields need a look/);
    // Exactly one row is being read — the first still waiting, since the worker
    // takes them in order.
    expect(queue.textContent).toMatch(/Reading this one/);
    expect(queue.querySelectorAll('.animate-spin')).toHaveLength(1);
  });

  it('drops a catalogue that belongs to another source', async () => {
    // Returning from a consent screen sets the source directly, without going
    // through the picker that clears this — so a creator who connected TikTok
    // landed on a checklist of their website's posts, and the loader would not
    // replace it because a catalogue was already loaded.
    window.history.replaceState(null, '', '/creator?tiktok=connected');
    stubIntersectionObserver();
    const { calls } = harness({
      creator: SYNCING,
      routes: {
        '/api/creator/tiktok': () =>
          json({ connected: true, account: { name: 'chefsarah' }, brokenReason: null, expiresAt: null, configured: true }),
      },
    });

    await waitFor(() => expect(picker().value).toBe('tiktok'));
    // Asked for TikTok's list, not left showing the website's.
    await waitFor(() =>
      expect(calls.some(c => c.url.includes('/api/creator/sync/catalog') && c.body?.source === 'tiktok')).toBe(true));
    window.history.replaceState(null, '', '/creator');
  });

  it('shows the address already on the row', async () => {
    // The field was seeded once at mount from whatever the prop held then, and
    // the portal reloads its creator after a publish or a delete — so the box
    // sat empty beside a website_url the row plainly had, and a creator reading
    // that concludes we forgot their site.
    // Mounted before the address was known, which is the shape that broke it:
    // the initial state runs once, and the portal reloads its creator after a
    // publish or a delete.
    harness({ creator: { ...CREATOR, primary_source: 'website' } });
    const field = () => screen.getByLabelText(/website or blog/i) as HTMLInputElement;
    expect(field().value).toBe('');

    rerender(
      <SyncSourceSection creator={SYNCING} onSaved={() => {}} />,
    );

    await waitFor(() => expect(field().value).toBe('https://chefsarah.test/'));
  });

  it('shows the queue as soon as the run exists, not when the first chunk ends', async () => {
    // The card was gated on `totals`, which arrives with the first worker chunk
    // — so a creator pressed Import and watched a dead button for however long
    // that chunk took. The run is created with its items already in it, which is
    // everything the queue needs.
    let releaseWorker: (v: Response) => void = () => {};
    harness({
      creator: SYNCING,
      entries: [entry(1), entry(2)],
      routes: {
        '/api/creator/sync': () =>
          json({ run: { id: 'r1', status: 'queued', items: [
            { itemId: 'a', url: 'u', title: 'Post A', publishedAt: null, status: 'pending', detail: null, draftId: null, mealName: null, needALook: null },
          ] } }, 201),
        // Never answers, standing in for a chunk that is still working.
        '/api/creator/sync/worker': () => new Response(new ReadableStream({ start() {} })),
      },
    });
    await screen.findByTestId('catalogue');

    tickAll();
    fireEvent.click(screen.getByRole('button', { name: /Import 2 posts/ }));

    const queue = await screen.findByTestId('run-queue');
    expect(queue.textContent).toMatch(/Post A/);
    void releaseWorker;
  });

  it('says a post was imported and withdrawn, and still lets it be ticked', async () => {
    // Deleting a published meal withdraws its post (MEAL-105) so it can be
    // imported again. Without the label that reads exactly like a post we never
    // touched — the one creator who knows they published and deleted it gets no
    // sign we noticed.
    const withdrawn = { ...entry(1), record: { status: 'withdrawn', detail: null, at: null, firstSeenAt: null } };
    harness({ creator: SYNCING, entries: [withdrawn] });
    await screen.findByTestId('catalogue');

    expect(screen.getByTestId('withdrawn').textContent).toMatch(/Withdrawn/);
    expect((screen.getAllByRole('checkbox')[0] as HTMLInputElement).disabled).toBe(false);
  });

  it('says when a post could not be read, and still lets it be retried', async () => {
    // A failed post used to render with no tag at all — identical to one nobody
    // had touched. That is how Budget Bytes' renamed slug showed up as the same
    // recipe twice: once "Already Imported" under the new URL, once looking
    // brand new under the old one, which by then was a 404.
    //
    // Still tickable, because a failure is about our afternoon rather than about
    // the post: the site was down, the fetch timed out. Unlike a gate rejection,
    // trying again can genuinely work.
    const unreadable = {
      ...entry(1),
      record: { status: 'failed', detail: 'HTTP 404 from https://chefsarah.test/post-1', at: null, firstSeenAt: null },
    };
    harness({ creator: SYNCING, entries: [unreadable] });
    await screen.findByTestId('catalogue');

    expect(screen.getByTestId('unreadable').textContent).toMatch(/Could not read/);
    expect(screen.getByTestId('unreadable').getAttribute('title')).toMatch(/404/);
    expect((screen.getAllByRole('checkbox')[0] as HTMLInputElement).disabled).toBe(false);
  });

  it('keeps the import queue directly under the checklist it came from', async () => {
    // The settings page lays these out in a grid, and the section hands down a
    // single stacked item so nothing can be redistributed when a card appears.
    // Pressing Import used to insert a sibling into a balanced multi-column
    // layout, and the queue landed under the checklist or beside it depending on
    // which arrangement evened the columns out.
    harness({
      creator: SYNCING,
      entries: [entry(1), entry(2)],
      routes: {
        '/api/creator/sync': () => json({ run: { id: 'r1', status: 'queued', items: [
          { itemId: 'a', url: 'u', title: 'Post A', publishedAt: null, status: 'pending', detail: null, draftId: null, mealName: null, needALook: null },
        ] } }, 201),
        '/api/creator/sync/worker': () => new Response(new ReadableStream({ start() {} })),
      },
    });
    await screen.findByTestId('catalogue');

    tickAll();
    fireEvent.click(screen.getByRole('button', { name: /Import 2 posts/ }));
    await screen.findByTestId('run-summary');

    // Same parent, and the run comes after the checklist in document order.
    const catalogue = screen.getByTestId('catalogue');
    const run = screen.getByTestId('run-summary');
    expect(run.parentElement).toBe(catalogue.parentElement);
    expect(catalogue.compareDocumentPosition(run) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('says a post is being imported, not that it could not be read', async () => {
    // A claim in flight is stored as `failed` carrying CLAIM_DETAIL, so a worker
    // that dies leaves a retryable row. Right for the retry sweep, alarming for
    // a creator: the checklist said "Could not read" about a post it was
    // importing at that moment.
    const importing = {
      ...entry(1),
      record: { status: 'failed', detail: 'An import of this post started…', at: null, firstSeenAt: null, inFlight: true },
    };
    harness({ creator: SYNCING, entries: [importing] });
    await screen.findByTestId('catalogue');

    expect(screen.getByTestId('importing').textContent).toMatch(/Importing/);
    expect(screen.queryByTestId('unreadable')).toBeNull();
    // And no tick: the server would stand a second run down as already in flight.
    expect((screen.getAllByRole('checkbox')[0] as HTMLInputElement).disabled).toBe(true);
  });

  it('still says a genuinely failed post could not be read', async () => {
    // The lease has passed or the run finished with a real failure. Tickable,
    // because a failure is about our afternoon rather than about the post.
    const failed = {
      ...entry(1),
      record: { status: 'failed', detail: 'HTTP 404', at: null, firstSeenAt: null, inFlight: false },
    };
    harness({ creator: SYNCING, entries: [failed] });
    await screen.findByTestId('catalogue');

    expect(screen.getByTestId('unreadable').textContent).toMatch(/Could not read/);
    expect(screen.queryByTestId('importing')).toBeNull();
    expect((screen.getAllByRole('checkbox')[0] as HTMLInputElement).disabled).toBe(false);
  });

  it('puts the checklist beside the picker, not under it', async () => {
    // Two columns and two questions: "where do you publish" on the left, "what
    // have you already posted" on the right. Sibling columns rather than one
    // stack, so the checklist never pushes the picker up the page as it grows.
    harness({ creator: SYNCING, entries: [entry(1)] });
    await screen.findByTestId('catalogue');

    const picker = screen.getByTestId('sync-source-section');
    const catalogue = screen.getByTestId('catalogue');
    expect(catalogue.parentElement).not.toBe(picker.parentElement);
    // Same grid, one level up.
    expect(catalogue.parentElement?.parentElement).toBe(picker.parentElement?.parentElement);
  });

  it('keeps the cards their own width and leaves the right side blank', async () => {
    // The second column exists whether or not there is anything in it. Letting
    // the remaining card stretch across the whole panel would mean it shrank
    // the moment a source was connected, which reads as the page breaking
    // rather than as a checklist arriving.
    harness();

    expect(screen.queryByTestId('catalogue')).toBeNull();
    const grid = screen.getByTestId('sync-source-section').parentElement?.parentElement;
    expect(grid?.className).toContain('lg:grid-cols-2');
  });

  it('renders whatever the portal puts above the picker', async () => {
    // The profile card arrives as children so the left column reads as one
    // decision — who you are, and where you publish.
    render(<SyncSourceSection creator={CREATOR}><p>profile card</p></SyncSourceSection>);
    expect(await screen.findByText('profile card')).toBeTruthy();
  });

  it('shows a row settling while the chunk is still working', async () => {
    // The worker persists after every two items but only answers when its
    // 40-second budget is spent, so the queue used to move once per chunk: one
    // row spinning for most of a minute, then several resolving at once. The
    // rows were already right in the database; nothing was asking for them.
    const items = (status: string) => [
      { itemId: 'a', url: 'u', title: 'Post A', publishedAt: null, status, detail: null, draftId: null, mealName: status === 'drafted' ? 'Harissa Chicken' : null, needALook: null },
      { itemId: 'b', url: 'v', title: 'Post B', publishedAt: null, status: 'pending', detail: null, draftId: null, mealName: null, needALook: null },
    ];
    harness({
      creator: SYNCING,
      entries: [entry(1), entry(2)],
      routes: {
        '/api/creator/sync': (init) =>
          // The POST creates the run; the GET is the progress read.
          init?.method === 'POST'
            ? json({ run: { id: 'r1', status: 'queued', items: items('pending') } }, 201)
            : json({ run: { id: 'r1', status: 'running', items: items('drafted') }, totals: { selected: 2, pending: 1, drafted: 1, rejected: 0, failed: 0, skipped: 0, costUsd: 0, needALook: 0 } }),
        // Never answers: this is the chunk still working.
        '/api/creator/sync/worker': () => new Response(new ReadableStream({ start() {} })),
      },
    });
    await screen.findByTestId('catalogue');

    tickAll();
    fireEvent.click(screen.getByRole('button', { name: /Import 2 posts/ }));
    await screen.findByTestId('run-queue');

    // Nothing has come back from the worker, and the first row has still landed.
    // Real time rather than fake: the poll is an interval around a fetch, and
    // faking the clock stalls the microtasks the fetch resolves on.
    await waitFor(
      () => expect(screen.getByTestId('run-queue').textContent).toMatch(/Harissa Chicken/),
      { timeout: 6_000 },
    );
  }, 10_000);

  it('marks what is already in, and leaves it out of select-all', async () => {
    const already = { ...entry(1), record: { status: 'imported', detail: null, at: null, firstSeenAt: null } };
    harness({ creator: SYNCING, entries: [already, entry(2)] });
    await screen.findByTestId('catalogue');

    expect(screen.getByText('Already Imported')).toBeTruthy();

    tickAll();

    // Ticking a catalogue half of which is already in is the expensive mistake
    // this list keeps more than one click away.
    expect(screen.getByTestId('selection-count').textContent).toBe(`1 of ${CREATOR_SELECTION_MAX} chosen`);
  });

  it('adds up what the run did, including where the rest went', async () => {
    harness({
      creator: SYNCING,
      entries: [entry(1), entry(2), entry(3)],
      routes: {
        '/api/creator/sync/worker': () =>
          json({
            run: { id: 'r1', status: 'done', items: [] },
            totals: { selected: 3, pending: 0, drafted: 2, rejected: 1, failed: 0, skipped: 0, costUsd: 0.03, needALook: 0 },
          }),
        '/api/creator/sync': () => json({ run: { id: 'r1', status: 'queued', items: [] } }, 201),
      },
    });
    await screen.findByTestId('catalogue');

    tickAll();
    fireEvent.click(screen.getByRole('button', { name: /Import 3 posts/ }));

    // "Chose 3, got 2" with nothing about the third makes a correct run look
    // broken.
    const summary = await screen.findByTestId('run-summary');
    await waitFor(() => expect(summary.textContent).toMatch(/Chose 3/));
    expect(summary.textContent).toMatch(/2 waiting in your review queue/);
    expect(summary.textContent).toMatch(/1 did not look like a recipe/);
  });

  it('says why a catalogue could not be listed, instead of an empty list', async () => {
    harness({
      creator: SYNCING,
      routes: {
        '/api/creator/sync/catalog': () =>
          json({ catalog: { ok: false, reason: 'no-feed', detail: 'We could not find a feed on your site.' } }, 422),
      },
    });

    expect(await screen.findByText(/could not find a feed on your site/i)).toBeTruthy();
  });
});
