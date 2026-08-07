// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';

import AdminRunDrilldown from '@/components/AdminRunDrilldown';

/**
 * The per-run drilldown, tested for the three claims it must never accidentally
 * make. All three are the same mistake in different clothes — drawing "we don't
 * know" as "we know" — and on this screen each one costs someone a day.
 *
 *   * An empty trace rendered as an idle run. Four stores emit no per-item rows at
 *     all (MEAL-122), so this is the DEFAULT for them, not an edge case.
 *   * A truncated trace rendered as a trace, where the last row reads as where the
 *     run stopped.
 *   * `run_summary`'s code rendered as the cause, when it is the run's most
 *     frequent code and can hide the wall that caused everything else (MEAL-123).
 *
 * The decisions belong to `lib/automation-trace.ts` and the route, and are tested
 * there. What is asserted here is that this component puts them on the screen as
 * text rather than as something to work out.
 */

afterEach(cleanup);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const RUN_ID = '11111111-1111-4111-8111-111111111111';

const run = (over: Record<string, unknown> = {}) => ({
  id: RUN_ID,
  store_id: 'heb',
  source: 'my_meals',
  status: 'completed',
  outcome: 'failed',
  meal_count: 1,
  items_requested: 4,
  items_added: 2,
  started_at: '2026-08-01T10:00:00.000Z',
  completed_at: '2026-08-01T10:02:00.000Z',
  config_version: 12,
  app_version: '1.4.0',
  platform: 'ios',
  ...over,
});

const step = (seq: number, over: Record<string, unknown> = {}) => ({
  seq,
  step: 'search',
  outcome: 'ok',
  code: null,
  duration_ms: 100,
  item_index: 0,
  detail: null,
  config_version: 12,
  app_version: '1.4.0',
  occurred_at: '2026-08-01T10:00:05.000Z',
  ...over,
});

const summary = (over: Record<string, unknown> = {}) => ({
  stepsRead: 0,
  complete: true,
  firstFailure: { kind: 'clean' },
  failures: 0,
  blocked: 0,
  runSummaryCode: null,
  hasRunSummary: false,
  seq: { min: null, max: null, count: 0, missing: 0, startsLate: false },
  versions: { configVersions: [12], appVersions: ['1.4.0'], mixed: false },
  missingItemSteps: [],
  noItemInstrumentation: false,
  itemsMissed: 2,
  ...over,
});

const traceBody = (over: Record<string, unknown> = {}) => ({
  run: run(),
  steps: [],
  summary: summary(),
  read: { stepsRead: 0, expectedSteps: 0, pagesComplete: true, complete: true },
  truncated: false,
  caveats: [],
  ...over,
});

/** Answers the list call with one failing run, then the trace call with `body`. */
function stubFetch(body: Record<string, unknown>) {
  const fetchMock = vi.fn(async (url: string) => {
    if (String(url).includes('/api/admin/automation-runs?')) {
      return json({
        days: 7, storeId: 'heb', filter: 'failing', limit: 50,
        runs: [{ ...run(), concern: { abandoned: false, failed: true, partialAdds: true, clean: false } }],
        listMaybeTruncated: false,
        caveats: [],
      });
    }
    return json(body);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** Lists runs, then opens the one trace the stub is holding. */
async function openTrace() {
  render(<AdminRunDrilldown stores={['heb', 'kroger']} />);
  fireEvent.click(screen.getByRole('button', { name: 'List runs' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Trace' })).toBeTruthy());
  fireEvent.click(screen.getByRole('button', { name: 'Trace' }));
  await waitFor(() => expect(screen.getByText(/first failure, in run order/i)).toBeTruthy());
}

describe('AdminRunDrilldown', () => {
  beforeEach(() => {
    localStorage.setItem('accessToken', 'admin-token');
  });

  it('calls a run with no steps uninstrumented, never idle', async () => {
    stubFetch(traceBody({
      run: run({ outcome: 'success', items_added: 4 }),
      steps: [],
      summary: summary({ firstFailure: { kind: 'no_trace' }, noItemInstrumentation: true, itemsMissed: 0 }),
      caveats: ['This run reported no search, candidates, add_click or confirm rows at all. …MEAL-122…'],
    }));
    await openTrace();

    // The words that keep the empty state honest.
    expect(screen.getByText(/statement about instrumentation, not about/i)).toBeTruthy();
    // Named in both the API's caveat banner and the component's own empty state.
    expect(screen.getAllByText(/MEAL-122/).length).toBeGreaterThan(0);
    // …and the run's own figures beside them, so it reads as "we didn't record it"
    // rather than "nothing happened".
    expect(screen.getByText(/nothing recorded about how it got there/)).toBeTruthy();
  });

  it('labels a truncated trace before the steps, not under them', async () => {
    stubFetch(traceBody({
      steps: [step(1), step(2, { step: 'add_click' })],
      summary: summary({ stepsRead: 2, complete: false, firstFailure: { kind: 'incomplete' }, failures: 1 }),
      read: { stepsRead: 2, expectedSteps: 4000, pagesComplete: true, complete: false, reason: 'read 2 of 4000 step rows' },
      truncated: true,
      caveats: ['This trace is INCOMPLETE (read 2 of 4000 step rows). The steps below are a prefix of the run, not the run…'],
    }));
    await openTrace();

    expect(screen.getByText(/INCOMPLETE/)).toBeTruthy();
    // The verdict refuses rather than naming the last row it happened to read.
    expect(screen.getByText(/unknown — trace incomplete/)).toBeTruthy();
    expect(screen.getByText(/prefix, so “first” is not a fact/)).toBeTruthy();
    // Counts are marked as floors.
    expect(screen.getByText(/lower bounds/)).toBeTruthy();
  });

  it('shows the first failure in run order beside run_summary, and marks which is weaker', async () => {
    stubFetch(traceBody({
      steps: [
        step(1, { step: 'login_check' }),
        step(2, { step: 'add_click', outcome: 'blocked', code: 'waf_block', item_index: 1 }),
        step(3, { step: 'confirm', outcome: 'error', code: 'confirm_failed', item_index: 2 }),
        step(4, { step: 'run_summary', outcome: 'error', code: 'confirm_failed', item_index: null }),
      ],
      summary: summary({
        stepsRead: 4,
        firstFailure: { kind: 'failed', seq: 2, step: 'add_click', outcome: 'blocked', code: 'waf_block', itemIndex: 1, blocked: true },
        failures: 1,
        blocked: 1,
        runSummaryCode: 'confirm_failed',
        hasRunSummary: true,
      }),
      read: { stepsRead: 4, expectedSteps: 4, pagesComplete: true, complete: true },
      caveats: ['run_summary reports "confirm_failed", which is the run\'s MOST FREQUENT code and not its most severe (MEAL-123)…'],
    }));
    await openTrace();

    expect(screen.getByText('add_click · seq 2')).toBeTruthy();
    expect(screen.getByText(/robot wall, not drift/)).toBeTruthy();
    expect(screen.getByText(/most frequent code, not its most severe \(MEAL-123\)/)).toBeTruthy();
    // The steps are rendered in the order the API returned them, which is seq
    // order — a table that re-sorted by anything else would stop being a trace.
    const stepCells = [...document.querySelectorAll('tbody tr')]
      .map((tr) => tr.querySelector('td')?.textContent)
      .filter((t) => t && /^\d+$/.test(t));
    expect(stepCells).toEqual(['1', '2', '3', '4']);
  });

  it('says a run reporting success with partial adds is outside the failing filter', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({
      days: 7, storeId: null, filter: 'failing', limit: 50,
      runs: [],
      listMaybeTruncated: false,
      caveats: [],
    })));
    render(<AdminRunDrilldown stores={['heb']} />);
    fireEvent.click(screen.getByRole('button', { name: 'List runs' }));

    await waitFor(() => expect(screen.getByText(/No run in the last 7 days matched/)).toBeTruthy());
    expect(screen.getByText(/PostgREST cannot compare two columns/)).toBeTruthy();
  });

  it('explains a 404 rather than rendering an empty trace', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'Run not found' }, 404)));
    render(<AdminRunDrilldown stores={['heb']} />);
    fireEvent.change(screen.getByPlaceholderText(/paste a run id/), { target: { value: RUN_ID } });
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));

    await waitFor(() => expect(screen.getByText(/No run with that id/)).toBeTruthy());
    expect(screen.queryByText(/first failure, in run order/i)).toBeNull();
  });
});
