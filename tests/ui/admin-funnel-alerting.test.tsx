// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import {
  DEFAULT_BLOCKED_RATE_THRESHOLD,
  DEFAULT_ITEM_SUCCESS_DROP_THRESHOLD,
} from '@/lib/automation-funnel';

/**
 * The funnel page and the alert email name the same stores for the same reasons
 * (MEAL-6).
 *
 * `aggregateFunnel` decides once and both read it, so they cannot disagree about
 * WHO is broken. What they can still disagree about is what the page then says,
 * and that is what is asserted here: a store raised for `success_drop` must not
 * be described to an operator as a confirm-rate problem, and the number the
 * email quoted has to be somewhere on the page to check.
 *
 * The judgement itself lives in `lib/automation-funnel.ts` and is tested there;
 * this is only about what an operator reads.
 */

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/components/AdminSyncPanel', () => ({ default: () => null }));
vi.mock('@/components/AdminReviewQueue', () => ({ default: () => null }));

const AdminPage = (await import('@/app/admin/page')).default;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type Store = Record<string, unknown>;

/** A store with nothing wrong with it, for a test to break one thing on. */
const store = (over: Store = {}): Store => ({
  storeId: 'heb',
  runs: 120,
  runsSucceeded: 118,
  runsAbandoned: 0,
  itemsRequested: 600,
  itemsAdded: 594,
  itemSuccessRate: 0.99,
  itemSuccess: { recent: 0.99, recentItemsRequested: 90, median: 0.99, baselineWindows: 7, drop: 0 },
  steps: [],
  confirmRate: 0.99,
  firstClickConfirmRate: 0.97,
  terminalSuccessRate: 0.98,
  blocked: { steps: 0, runs: 0, rate: 0 },
  failureCodes: {},
  runSummaryCodes: {},
  blockedRate: 0,
  coverage: { missingSteps: [], partialInstrumentation: false, uncodedFailures: 0 },
  daily: [],
  weekOverWeek: null,
  alerting: false,
  alertReasons: [],
  ...over,
});

async function openFunnel(stores: Store[]) {
  const alertingFor = (reason: string) =>
    stores.filter((s) => (s.alertReasons as string[]).includes(reason)).map((s) => s.storeId as string);

  vi.stubGlobal('fetch', (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/auth/verify')) return json({ user: { isAdmin: true } });
    if (url.includes('/api/admin/applications')) return json({ applications: [] });
    if (url.includes('/api/admin/automation-config')) return json({ versions: [] });
    if (url.includes('/api/admin/automation-funnel')) {
      return json({
        days: 30,
        since: '2026-07-10T00:00:00.000Z',
        truncated: false,
        stepRowsScanned: 0,
        runRowsScanned: 0,
        stores,
        alerting: stores.filter((s) => s.alerting).map((s) => s.storeId as string),
        confirmRateAlerting: alertingFor('confirm_rate'),
        successDropAlerting: alertingFor('success_drop'),
        blockedAlerting: alertingFor('blocked'),
        partialInstrumentation: [],
      });
    }
    return json({}, 404);
  }) as typeof fetch);

  render(<AdminPage />);
  fireEvent.click(await screen.findByRole('button', { name: 'Automation' }));
  return screen.findByTestId(`funnel-store-${stores[0].storeId}`);
}

beforeEach(() => { localStorage.setItem('accessToken', 'admin-token'); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('the funnel page on a store the alert email raised', () => {
  it('names the drop, and does not blame a confirm rate that is fine', async () => {
    // The regression MEAL-6 exists for: 99% of items added every day for a week,
    // 84% today. Nothing else about this store has moved — the confirm rate is
    // untouched, so a badge that says "confirm rate" sends the operator to a
    // number that is fine and back again convinced the alert was noise.
    const card = await openFunnel([store({
      alerting: true,
      alertReasons: ['success_drop'],
      itemSuccess: { recent: 0.84, recentItemsRequested: 90, median: 0.99, baselineWindows: 7, drop: 0.15 },
    })]);

    const badge = card.querySelector('span[title]')!;
    expect(badge.textContent).toBe('ALERTING · SUCCESS DROP');
    expect(badge.getAttribute('title')).toMatch(/trailing 7-day median/);
    expect(badge.getAttribute('title')).not.toMatch(/confirm rate/i);
  });

  it('puts the number the email quoted on the page, beside the median it fell from', async () => {
    // An email saying "84% against a median of 99%" and a page with no tile for
    // either leaves an operator nothing to check it against.
    const card = await openFunnel([store({
      alerting: true,
      alertReasons: ['success_drop'],
      itemSuccess: { recent: 0.84, recentItemsRequested: 90, median: 0.99, baselineWindows: 7, drop: 0.15 },
    })]);

    expect(card.textContent).toContain('Item success');
    expect(card.textContent).toContain('84.0%');
    expect(card.textContent).toMatch(/median 99\.0%/);
  });

  it('says so when there is not enough history to have a median', async () => {
    // A new store, or one that was quiet all week. The tile must not imply the
    // rate was compared against anything.
    const card = await openFunnel([store({
      itemSuccess: { recent: 0.91, recentItemsRequested: 40, median: null, baselineWindows: 1, drop: null },
    })]);

    expect(card.textContent).toMatch(/too little history for a median/);
  });

  it('names every reason at once, not just the first', async () => {
    // A store already reported for drift and now walled off as well is a second
    // problem with a second fix, and that is exactly when the email sends again.
    const card = await openFunnel([store({
      alerting: true,
      alertReasons: ['confirm_rate', 'success_drop', 'blocked'],
      confirmRate: 0.72,
      blockedRate: 0.11,
      blocked: { steps: 40, runs: 13, rate: 0.11 },
      itemSuccess: { recent: 0.6, recentItemsRequested: 90, median: 0.95, baselineWindows: 7, drop: 0.35 },
    })]);

    expect(card.querySelector('span[title]')!.textContent)
      .toBe('ALERTING · CONFIRM RATE · SUCCESS DROP · BLOCKED');
  });

  it('banners the drop separately from the confirm rate', async () => {
    await openFunnel([
      store({ storeId: 'heb', alerting: true, alertReasons: ['success_drop'] }),
      store({ storeId: 'walmart', alerting: true, alertReasons: ['confirm_rate'], confirmRate: 0.6 }),
    ]);

    // Two banners, each naming only its own store. One list would have the page
    // blame a renamed selector for a store whose problem is the confirm rate.
    expect(screen.getByText(/Item success has fallen away from normal/).parentElement!.textContent)
      .toMatch(/heb/);
    expect(screen.getByText(/Item success has fallen away from normal/).parentElement!.textContent)
      .not.toMatch(/walmart/);
    expect(screen.getByText(/Confirm rate below threshold/).parentElement!.textContent)
      .toMatch(/walmart/);
  });
});

describe('the page and the email use one set of numbers', () => {
  /**
   * Not a restatement of the constants — the point is that the tiles colour at
   * the thresholds the alert fires on. The WAF tile shipped red at 5% while the
   * alert fires at 3%, so a store could be emailed about and still be black on
   * the page an operator opened because of the email.
   */
  it('colours the WAF tile at the threshold that alerts, not one of its own', async () => {
    const justOver = DEFAULT_BLOCKED_RATE_THRESHOLD;
    const justUnder = DEFAULT_BLOCKED_RATE_THRESHOLD / 2;

    const card = await openFunnel([
      store({ storeId: 'heb', blockedRate: justOver, blocked: { steps: 9, runs: 4, rate: justOver } }),
      store({ storeId: 'walmart', blockedRate: justUnder, blocked: { steps: 3, runs: 2, rate: justUnder } }),
    ]);

    const value = (el: Element) => el.querySelector('div > div:nth-child(2)');
    const heb = [...card.querySelectorAll('div')].find((d) => d.textContent?.startsWith('WAF blocked'))!;
    expect(heb.textContent).toContain('3.0%');
    expect(value(heb)!.getAttribute('style')).toMatch(/color: rgb\(185, 28, 28\)/);
  });

  it('colours the item success tile at the drop the alert uses', async () => {
    const card = await openFunnel([store({
      // One point past the decided ten, on a sample well over the floor.
      itemSuccess: {
        recent: 0.88, recentItemsRequested: 90, median: 0.88 + DEFAULT_ITEM_SUCCESS_DROP_THRESHOLD + 0.01,
        baselineWindows: 7, drop: DEFAULT_ITEM_SUCCESS_DROP_THRESHOLD + 0.01,
      },
    })]);

    const tile = [...card.querySelectorAll('div')].find((d) => d.textContent?.startsWith('Item success'))!;
    expect(tile.querySelector('div > div:nth-child(2)')!.getAttribute('style'))
      .toMatch(/color: rgb\(185, 28, 28\)/);
  });
});
