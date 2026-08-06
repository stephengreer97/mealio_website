// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';

/**
 * What the Sources tab tells an operator about a creator nobody is polling.
 *
 * Two things used to be findable only by accident. A paused import existed as an
 * email and a log line, so once the mail was deleted "why is this creator not
 * being polled?" had no answer at all. And a feed left behind on a host the
 * creator's website has since moved off surfaced only as a 400, at the moment
 * somebody tried to turn import back on — the wrong moment to find out and the
 * wrong place to explain it.
 *
 * The decisions themselves belong to `describeSourceHealth` and are tested
 * against it; what is asserted here is that this page renders them, on the row,
 * as text rather than as something to hover over.
 */

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/components/AdminSyncPanel', () => ({ default: () => null }));
vi.mock('@/components/AdminReviewQueue', () => ({ default: () => null }));

const AdminPage = (await import('@/app/admin/page')).default;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A creator whose own link edit paused the import, feed still on the old host. */
const PAUSED = {
  id: 'c1',
  display_name: 'Chef Sarah',
  handle: 'chefsarah',
  website_url: 'https://sarahcooks.test/',
  youtube_url: null,
  instagram_url: null,
  tiktok_url: null,
  primary_source: 'website',
  import_opt_in: false,
  feed_url: 'https://chefsarah.test/feed',
  import_paused_reason:
    'The creator changed the Website link we poll, from https://chefsarah.test/ to https://sarahcooks.test/. ' +
    'Polling is off until someone confirms the new link is theirs.',
  import_paused_at: '2026-07-01T00:00:00.000Z',
  connections: [],
};

function stubApi(creator: Record<string, unknown>) {
  vi.stubGlobal('fetch', (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/auth/verify')) return json({ user: { isAdmin: true } });
    if (url.includes('/api/admin/applications')) return json({ applications: [] });
    if (url.includes('/api/admin/creators')) return json({ creators: [creator] });
    return json({}, 404);
  }) as typeof fetch);
}

async function openSourcesTab(creator: Record<string, unknown> = PAUSED) {
  stubApi(creator);
  render(<AdminPage />);
  fireEvent.click(await screen.findByRole('button', { name: 'Sources' }));
  return await screen.findByText('Chef Sarah');
}

beforeEach(() => { localStorage.setItem('accessToken', 'admin-token'); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('admin Sources tab — why a creator is not being polled', () => {
  it('shows the reason the import was paused, and when', async () => {
    await openSourcesTab();

    const paused = await screen.findByTestId('source-health-paused');
    // The sentence itself, not a tooltip: an operator asking why a creator
    // stopped being polled should not have to know there is something to hover
    // over — that was the failure of leaving this in an inbox.
    expect(paused.textContent).toMatch(/changed the Website link we poll/i);
    expect(paused.textContent).toContain('https://chefsarah.test/');
    expect(paused.textContent).toMatch(/2026/);
    // And a badge beside the connection badges, where an operator scanning the
    // list is already looking.
    expect(screen.getByText('Import paused')).toBeTruthy();
  });

  it('shows a feed the creator’s website has moved away from', async () => {
    await openSourcesTab();

    const mismatch = await screen.findByTestId('source-health-feed-host');
    expect(mismatch.textContent).toMatch(/not on the creator's own site/i);
    // Said before the operator tries the switch, rather than as the 400 they get
    // when they do.
    expect(mismatch.textContent).toMatch(/before turning import back on/i);
    expect(screen.getByText('Feed off-site')).toBeTruthy();
  });

  it('says neither about a creator who is being polled from a feed that matches', async () => {
    await openSourcesTab({
      ...PAUSED,
      website_url: 'https://chefsarah.test/',
      import_opt_in: true,
      import_paused_reason: null,
      import_paused_at: null,
    });

    expect(screen.queryByTestId('source-health-paused')).toBeNull();
    expect(screen.queryByTestId('source-health-feed-host')).toBeNull();
  });
});

/**
 * MEAL-112, as the operator met it.
 *
 * The route passed every creator id to one PostgREST `.in()` filter. Past 221 that
 * URL is too long, the proxy answers 414, `data ?? []` swallows it, and every row's
 * health came back null — which this tab rendered as "with no source". So the screen
 * said nothing was configured, for the entire creator list, and an operator reading
 * it had no reason to disbelieve it.
 *
 * The route no longer produces that answer. This pins the other half: that a missing
 * health reading can never be *displayed* as a configured-nothing, whatever produced
 * it. The two failures are indistinguishable on a row and mean opposite things.
 */
describe('admin Sources tab — health that could not be read', () => {
  function stubIncomplete(incomplete: string[]) {
    vi.stubGlobal('fetch', (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/auth/verify')) return json({ user: { isAdmin: true } });
      if (url.includes('/api/admin/applications')) return json({ applications: [] });
      if (url.includes('/api/admin/creators')) {
        return json({
          // A creator with a source configured, whose health simply was not read.
          creators: [{ ...PAUSED, import_opt_in: true, pollHealth: null }],
          incomplete,
        });
      }
      return json({}, 404);
    }) as typeof fetch);
  }

  async function openWith(incomplete: string[]) {
    stubIncomplete(incomplete);
    render(<AdminPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sources' }));
    return await screen.findByText('Chef Sarah');
  }

  it('counts a creator whose health was not read as "not read", never as "no source"', async () => {
    await openWith(['pollHealth']);

    expect(screen.getByTestId('poll-health-unknown').textContent).toMatch(/1 not read/);
    // The exact sentence the bug produced, for the whole list.
    expect(screen.queryByText(/with no source/)).toBeNull();
  });

  it('warns above the list that the screen is showing less than it was asked for', async () => {
    await openWith(['pollHealth']);

    const banner = screen.getByTestId('incomplete-banner');
    expect(banner.textContent).toMatch(/Incomplete data/i);
    expect(banner.textContent).toMatch(/poll health/i);
  });

  it('says nothing at all when the read was complete', async () => {
    // The warning has to be absent on a healthy response, or it becomes furniture
    // and stops being read on the day it matters.
    stubApi({ ...PAUSED, import_opt_in: true, pollHealth: null });
    render(<AdminPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sources' }));
    await screen.findByText('Chef Sarah');

    expect(screen.queryByTestId('incomplete-banner')).toBeNull();
  });
});
