// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';

/**
 * One card per store, from all three reads of the same traffic.
 *
 * The Health Dashboard used to draw three panels over `automation_runs` and
 * `automation_steps`: "Add-to-cart funnel" (run-level tiles plus a per-step
 * table in the DOM vocabulary), "Network rail" (what the store answered) and
 * "Requests" (the served rate and the phase latencies). An operator asking
 * whether HEB was healthy read the same store in three places, a screen apart,
 * and had to hold two of them in their head.
 *
 * They are one card now, and the step table is the only thing that was deleted
 * rather than moved — DOM automation went on 2026-09-01 and took the vocabulary
 * with it, so for every live store the table read `login_check → (nothing) →
 * reconcile` and a clean one meant NO DATA rather than no failures.
 *
 * What is asserted here is the join, not the arithmetic: that the run half and
 * the request half of one store land in one card, that the facts each source
 * uniquely holds all survived, and that the step table and the banners which
 * existed only to explain it are gone. The numbers themselves are pinned in
 * `lib/automation-funnel.ts` and `admin-funnel-alerting.test.tsx`.
 */

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/components/AdminSyncPanel', () => ({ default: () => null }));
vi.mock('@/components/AdminReviewQueue', () => ({ default: () => null }));
vi.mock('@/components/AdminCanary', () => ({ default: () => null }));

const AdminPage = (await import('@/app/admin/page')).default;
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } });

const FUNNEL_STORE = {
  storeId: 'heb', runs: 120, runsSucceeded: 118, runsUnverified: 2, runsAbandoned: 0,
  itemsRequested: 600, itemsAdded: 594, itemsUnavailable: 0,
  itemSuccess: { recent: 0.99, recentItemsRequested: 90, recentItemsUnavailable: 0, recentItemsJudged: 90, median: 0.99, baselineWindows: 7, drop: 0 },
  steps: [{ step: 'add_click', total: 5, outcomes: {}, blocked: 0, attempted: 5, okRate: 1, failures: 0, codes: {}, p50DurationMs: 10, p95DurationMs: 20 }],
  confirmRate: 0.99, terminalSuccessRate: 0.98, blockedRate: 0, blocked: { steps: 0, runs: 0, rate: 0 },
  failureCodes: { waf_block: 3 }, runSummaryCodes: {},
  coverage: { missingSteps: [], partialInstrumentation: true, uncodedFailures: 0 },
  daily: [], weekOverWeek: null, alerting: false, alertReasons: [],
};

const NET_STORE = {
  storeId: 'heb', rows: 900, rowsWithoutStatus: 100,
  statuses: [{ label: '2xx', count: 700 }, { label: '429', count: 100 }],
  phases: [{ phase: 'search', ok: 400, failed: 2, topCode: 'rate_limited' }, { phase: 'add', ok: 300, failed: 0, topCode: null }],
  retryRate: 0.12, retrySuccessRate: 0.8, retried: 96, retriedOk: 77, legacyCodeRows: 4, rails: ['heb-network'],
};

beforeEach(() => {
  localStorage.setItem('accessToken', 't');
  vi.stubGlobal('fetch', (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/auth/verify')) return json({ user: { isAdmin: true } });
    if (url.includes('/api/admin/applications')) return json({ applications: [] });
    if (url.includes('automation-funnel')) return json({ days: 30, stores: [FUNNEL_STORE], confirmRateAlerting: [], blockedAlerting: [], successDropAlerting: [], partialInstrumentation: ['heb'], truncated: false });
    if (url.includes('automation-network')) return json({ days: 30, rowsScanned: 1000, truncated: false, coverage: { rowsWithStatus: 900, rowsWithPhase: 900, rowsWithAttempts: 900 }, stores: [NET_STORE, { ...NET_STORE, storeId: 'aldi' }], headlines: [] });
    if (url.includes('automation-requests')) return json({
      days: 30, truncated: false,
      stores: [{
        storeId: 'heb', rails: ['heb-network'], requests: 820, okRate: 0.97, retryRate: 0.12, retrySuccessRate: 0.8,
        statuses: [], codes: [],
        phases: [{ phase: 'search', requests: 402, okRate: 0.99, failures: 2, p50: 180, p95: 900 }],
      }],
    });
    if (url.includes('automation-config')) return json({ versions: [], active: null });
    return json({}, 404);
  }) as typeof fetch);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('the Health Dashboard store card', () => {
  it('joins the run, network and request reads into one card', async () => {
    render(<AdminPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Health Dashboard' }));
    const card = await screen.findByTestId('funnel-store-heb');
    const t = card.textContent!;

    // run-level, kept
    expect(t).toContain('Terminal success');
    expect(t).toContain('594/600 items added');
    expect(t).toContain('2 unverified');
    expect(t).toContain('Item success');
    expect(t).toContain('WAF blocked');
    expect(t).toContain('Confirm rate');
    // network half, folded in
    expect(t).toContain('rail: heb-network');
    expect(t).toContain('What the store answered');
    expect(t).toContain('2xx · 700');
    expect(t).toContain('429 · 100');
    expect(t).toContain('rate_limited');
    expect(t).toContain('retried 12%');
    // what only the request read knows, on the same card
    expect(t).toContain('Served');
    expect(t).toContain('820 instrumented requests');
    expect(t).toContain('180ms');
    expect(t).toContain('900ms');
    expect(t).toContain('4 rows carrying pre-network codes');
    expect(t).toContain('waf_block');
    // step table and its scaffolding, gone
    expect(t).not.toContain('Dying on');
    expect(t).not.toContain('NO STEP DATA');
    expect(t).not.toMatch(/\bAttempted\b/);
    expect(screen.queryByText(/Funnel has no middle for/)).toBeNull();
    expect(screen.queryByText(/Add-to-cart funnel/)).toBeNull();
    // one panel, one selector
    expect(screen.getByText('Per-store health')).toBeTruthy();
    expect(screen.queryByText('Network rail')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Requests' })).toBeNull();
    // the merged panel's own header carries exactly one window selector
    const panel = screen.getByText('Per-store health').closest('div')!.parentElement!;
    expect([...panel.querySelectorAll('button')].filter(b => b.textContent === '30d')).toHaveLength(1);
    // coverage, and the store the rail saw but the runs did not
    expect(screen.getByTestId('network-coverage').textContent).toContain('1,000 step rows');
    expect(screen.getByTestId('network-only-stores').textContent).toContain('aldi');
  });
});
