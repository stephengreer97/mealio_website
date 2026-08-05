// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';

/**
 * Is polling working, and for whom? (MEAL-96)
 *
 * Polling is invisible: a creator's source can stop producing recipes and
 * nothing on any screen says so, so an operator finds out when the creator asks
 * why nothing has appeared. What is asserted here is that the Sources tab
 * answers that without anyone knowing to look — the broken creator is at the
 * top, the source that polls cleanly and yields nothing is named as a problem,
 * and the creator who simply never set polling up is not called broken.
 *
 * The decisions themselves live in `lib/poll-health.ts` and are tested there.
 */

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/components/AdminSyncPanel', () => ({ default: () => null }));
vi.mock('@/components/AdminReviewQueue', () => ({ default: () => null }));

const AdminPage = (await import('@/app/admin/page')).default;

const NOW = Date.parse('2026-08-05T12:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();
const hoursAgo = (n: number) => new Date(NOW - n * 3_600_000).toISOString();

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const creator = (over: Record<string, unknown> = {}) => ({
  id: 'c1',
  display_name: 'Chef Sarah',
  handle: 'chefsarah',
  website_url: 'https://chefsarah.test/',
  youtube_url: null,
  instagram_url: null,
  tiktok_url: null,
  primary_source: 'website',
  import_opt_in: true,
  feed_url: 'https://chefsarah.test/feed',
  import_paused_reason: null,
  import_paused_at: null,
  connections: [],
  ...over,
});

const health = (over: Record<string, unknown> = {}) => ({
  creatorId: 'c1',
  source: 'website',
  lastPolledAt: hoursAgo(2),
  pollAfter: new Date(NOW + 4 * 3_600_000).toISOString(),
  consecutiveFailures: 0,
  lastFailedAt: null,
  lastError: null,
  lastStatus: null,
  lastNewItemAt: daysAgo(2),
  draftedCount: 4,
  publishedCount: 2,
  ...over,
});

async function openSourcesTab(creators: Array<Record<string, unknown>>) {
  vi.stubGlobal('fetch', (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/auth/verify')) return json({ user: { isAdmin: true } });
    if (url.includes('/api/admin/applications')) return json({ applications: [] });
    if (url.includes('/api/admin/creators')) return json({ creators });
    return json({}, 404);
  }) as typeof fetch);
  render(<AdminPage />);
  fireEvent.click(await screen.findByRole('button', { name: 'Sources' }));
  await screen.findByTestId('poll-health-summary');
}

/** Creator names in the order the tab renders them. */
const rendered = () => Array.from(document.querySelectorAll('h2')).map((h) => h.textContent);

beforeEach(() => {
  localStorage.setItem('accessToken', 'admin-token');
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('admin Sources tab — poll health', () => {
  it('leads with the last poll that found a new post', async () => {
    await openSourcesTab([creator({ pollHealth: health({ lastNewItemAt: daysAgo(4) }) })]);

    const lead = screen.getByTestId('poll-last-new-c1');
    expect(lead.textContent).toMatch(/Last poll that found a new post/i);
    // As an age, not an ISO string: "is this stale" is the question, and nobody
    // answers it by subtracting dates in their head.
    expect(lead.textContent).toMatch(/4 days ago/);
  });

  it('names the source that polls cleanly and produces nothing', async () => {
    // The failure this screen exists to catch: recent poll, no failures, next
    // poll scheduled, and nothing has come out of it in two months.
    await openSourcesTab([creator({ pollHealth: health({ lastPolledAt: hoursAgo(1), lastNewItemAt: daysAgo(62) }) })]);

    expect(screen.getByTestId('poll-status-c1').getAttribute('data-poll-status')).toBe('silent');
    expect(screen.getByTestId('poll-status-c1').textContent).toMatch(/Producing nothing for 62 days/);
    expect(screen.getByTestId('poll-last-new-c1').textContent).toMatch(/producing nothing/i);
  });

  it('distinguishes a failure or two from a source nobody has looked at', async () => {
    await openSourcesTab([
      creator({ id: 'c1', display_name: 'Chef Sarah', pollHealth: health({ consecutiveFailures: 1, lastFailedAt: hoursAgo(3) }) }),
      creator({ id: 'c2', display_name: 'Chef Ben', pollHealth: health({ creatorId: 'c2', consecutiveFailures: 6, lastFailedAt: hoursAgo(1) }) }),
    ]);

    expect(screen.getByTestId('poll-status-c1').getAttribute('data-poll-status')).toBe('wobbling');
    const broken = screen.getByTestId('poll-status-c2');
    expect(broken.getAttribute('data-poll-status')).toBe('failing');
    expect(broken.textContent).toMatch(/6 in a row/);
  });

  it('labels the successful poll as successful, so it cannot be read as "the queue reached them"', async () => {
    // `last_polled_at` deliberately does not advance on a failure. An operator
    // reading it as "last time we tried" would take a broken source for a quiet
    // one, which is the misreading the ticket calls out.
    await openSourcesTab([creator({ pollHealth: health() })]);

    const panel = screen.getByTestId('poll-health-c1');
    expect(panel.textContent).toMatch(/Last successful poll/i);
    expect(panel.textContent).toMatch(/unchanged by a failed poll/i);
    expect(panel.textContent).toMatch(/Next poll due/i);
    expect(panel.textContent).toMatch(/in 4 hours/);
  });

  it('shows the lifetime drafted and published counts', async () => {
    await openSourcesTab([creator({ pollHealth: health({ draftedCount: 11, publishedCount: 3 }) })]);

    const panel = screen.getByTestId('poll-health-c1');
    expect(panel.textContent).toMatch(/Drafted by polling/i);
    expect(panel.textContent).toMatch(/Published from those/i);
    expect(panel.textContent).toContain('11');
  });

  it('puts the broken creator first, whatever order the API returned', async () => {
    await openSourcesTab([
      creator({ id: 'c1', display_name: 'Healthy Hana', pollHealth: health({ creatorId: 'c1' }) }),
      creator({ id: 'c2', display_name: 'Quiet Quinn', pollHealth: health({ creatorId: 'c2', lastNewItemAt: daysAgo(40) }) }),
      creator({ id: 'c3', display_name: 'Broken Bruno', pollHealth: health({ creatorId: 'c3', consecutiveFailures: 7, lastFailedAt: hoursAgo(1) }) }),
    ]);

    // "Who is broken", not "how is everyone doing".
    expect(rendered()).toEqual(['Broken Bruno', 'Quiet Quinn', 'Healthy Hana']);
  });

  it('does not let a creator with no source dominate the list, or read as a failure', async () => {
    await openSourcesTab([
      creator({ id: 'c1', display_name: 'Unset Ursula', primary_source: 'none', import_opt_in: false, feed_url: null, pollHealth: health({ creatorId: 'c1', source: null, lastPolledAt: null, pollAfter: null, lastNewItemAt: null, draftedCount: 0, publishedCount: 0 }) }),
      creator({ id: 'c2', display_name: 'Quiet Quinn', pollHealth: health({ creatorId: 'c2', lastNewItemAt: daysAgo(40) }) }),
    ]);

    // Nothing is broken about a creator nobody has set polling up for, so they
    // sort below the source that is producing nothing…
    expect(rendered()).toEqual(['Quiet Quinn', 'Unset Ursula']);
    // …get no alarming badge…
    expect(screen.queryByTestId('poll-status-c1')).toBeNull();
    // …and are not told they were "never polled" as though it were a failure.
    expect(screen.getByTestId('poll-health-c1').textContent).toMatch(/nothing here is broken/i);
  });

  it('counts who is broken above the list', async () => {
    await openSourcesTab([
      creator({ id: 'c1', display_name: 'Healthy Hana', pollHealth: health({ creatorId: 'c1' }) }),
      creator({ id: 'c2', display_name: 'Quiet Quinn', pollHealth: health({ creatorId: 'c2', lastNewItemAt: daysAgo(40) }) }),
      creator({ id: 'c3', display_name: 'Broken Bruno', pollHealth: health({ creatorId: 'c3', consecutiveFailures: 7 }) }),
    ]);

    const summary = screen.getByTestId('poll-health-summary');
    expect(summary.textContent).toMatch(/1 failing/);
    expect(summary.textContent).toMatch(/1 producing nothing/);
    expect(summary.textContent).toMatch(/1 polling healthily/);
  });

  describe('the last failure, in the remote server’s own words', () => {
    const SHOUTY = `<b>Gateway Timeout</b><img src=x onerror="alert(1)"> ${'verylongtokenwithnospaces'.repeat(40)}`;

    it('renders it as text, never as markup', async () => {
      await openSourcesTab([creator({ pollHealth: health({ consecutiveFailures: 4, lastFailedAt: hoursAgo(1), lastStatus: 504, lastError: SHOUTY }) })]);

      const block = screen.getByTestId('poll-last-failure-c1');
      // `last_error` is not written by us — it is whatever the source said.
      expect(block.querySelector('b')).toBeNull();
      expect(block.querySelector('img')).toBeNull();
      expect(block.textContent).toContain('<b>Gateway Timeout</b>');
      expect(block.textContent).toMatch(/HTTP 504/);
    });

    it('caps how much of it reaches the page', async () => {
      await openSourcesTab([creator({ pollHealth: health({ consecutiveFailures: 4, lastFailedAt: hoursAgo(1), lastError: SHOUTY }) })]);

      // A remote stack trace or HTML error page arrives as one unbroken run of
      // characters; uncapped it takes the card over.
      const text = screen.getByTestId('poll-last-failure-c1').querySelector('p')!;
      expect(text.textContent!.length).toBeLessThan(400);
      expect(text.textContent!.endsWith('…')).toBe(true);
      // The whole thing is still available, on hover rather than in the layout.
      expect(text.getAttribute('title')).toBe(SHOUTY);
    });

    it('keeps a healed failure visible, and says it healed', async () => {
      await openSourcesTab([creator({ pollHealth: health({ consecutiveFailures: 0, lastFailedAt: daysAgo(3), lastStatus: 404, lastError: 'Not Found' }) })]);

      // "It failed on Tuesday and has been fine since" is a different story from
      // "it is failing", and only one of them needs acting on.
      const block = screen.getByTestId('poll-last-failure-c1');
      expect(block.textContent).toMatch(/3 days ago/);
      expect(block.textContent).toMatch(/recovered/i);
      expect(screen.getByTestId('poll-status-c1').getAttribute('data-poll-status')).toBe('ok');
    });
  });
});
