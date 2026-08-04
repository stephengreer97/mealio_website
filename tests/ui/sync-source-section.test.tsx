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
  record: { status: string; detail: string | null; at: string | null; firstSeenAt: string | null } | null;
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

  render(<SyncSourceSection creator={creator} onSaved={changes => { saved.push(changes); }} />);
  return { calls, saved };
}

const picker = () => screen.getByLabelText('Where you publish') as HTMLSelectElement;

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

  it('says plainly when it is actually watching, rather than when it might be', async () => {
    harness({ creator: SYNCING });

    expect((await screen.findByTestId('sync-live')).textContent).toMatch(/Mealio is watching your Website now/i);
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

  it('marks what is already in, and leaves it out of select-all', async () => {
    const already = { ...entry(1), record: { status: 'imported', detail: null, at: null, firstSeenAt: null } };
    harness({ creator: SYNCING, entries: [already, entry(2)] });
    await screen.findByTestId('catalogue');

    expect(screen.getByText('Already in')).toBeTruthy();

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
