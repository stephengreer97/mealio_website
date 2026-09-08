/**
 * MEAL-219 phase 4. The dashboard is exactly the kind of thing that passes every
 * unit test and reports fiction, so these tests are about the two ways it could
 * lie rather than about arithmetic:
 *
 *   1. Rows written BEFORE the columns shipped carry null. If those are treated
 *      as zeros, every rate is diluted by a window it does not cover.
 *   2. The walls (403/429/412) rolled into a generic 4xx are invisible, and they
 *      are the single most actionable status here.
 */
import { describe, it, expect } from 'vitest';
import {
  aggregateNetworkStats, statusLabel, summarize, PHASE_ORDER,
  type NetworkStepRow,
} from '../../lib/automation-network-stats';

const row = (o: Partial<NetworkStepRow> = {}): NetworkStepRow => ({
  store_id: 'heb', step: 'search', outcome: 'ok', code: null,
  http_status: 200, phase: 'search', attempts: 1, rail: 'HEB_SESSION',
  occurred_at: '2026-09-07T00:00:00Z', ...o,
});

describe('statusLabel', () => {
  it('gives each wall its own bucket', () => {
    // Rolled into 4xx these vanish, and a spike in them is a campaign.
    for (const s of [403, 429, 412, 418]) expect(statusLabel(s)).toBe(String(s));
    expect(statusLabel(401)).toBe('401');
  });

  it('rolls the rest up by class', () => {
    expect(statusLabel(200)).toBe('2xx');
    expect(statusLabel(404)).toBe('4xx');
    expect(statusLabel(503)).toBe('5xx');
  });
});

describe('aggregateNetworkStats', () => {
  it('counts rows with no status separately instead of as successes', () => {
    const [s] = aggregateNetworkStats([
      row({ http_status: 200 }), row({ http_status: null }), row({ http_status: null }),
    ]);
    expect(s.rows).toBe(3);
    expect(s.rowsWithoutStatus).toBe(2);
    expect(s.statuses).toEqual([{ label: '2xx', count: 1 }]);
  });

  it('EXCLUDES null-attempts rows from the retry rate rather than calling them un-retried', () => {
    // The trap. Every row written before MEAL-219 has attempts null. Counting
    // them as "did not retry" makes the retry rate a statement about a window
    // the data does not cover, and it always reads reassuringly low.
    const [s] = aggregateNetworkStats([
      row({ attempts: null }), row({ attempts: null }), row({ attempts: null }),
      row({ attempts: 2, outcome: 'ok' }),
    ]);
    expect(s.retried).toBe(1);
    expect(s.retryRate).toBe(1);          // 1 of 1 row that HAS an attempts value
    expect(s.retrySuccessRate).toBe(1);
  });

  it('reports how often a retry actually recovered', () => {
    const [s] = aggregateNetworkStats([
      row({ attempts: 2, outcome: 'ok' }),
      row({ attempts: 3, outcome: 'error', code: 'store_error' }),
      row({ attempts: 1, outcome: 'ok' }),
    ]);
    expect(s.retried).toBe(2);
    expect(s.retriedOk).toBe(1);
    expect(s.retrySuccessRate).toBe(0.5);
  });

  it('builds a phase funnel in run order, naming the code that explains each stall', () => {
    const [s] = aggregateNetworkStats([
      row({ phase: 'session', outcome: 'ok' }),
      row({ phase: 'search', outcome: 'error', code: 'store_error' }),
      row({ phase: 'search', outcome: 'error', code: 'store_error' }),
      row({ phase: 'search', outcome: 'error', code: 'timeout' }),
      row({ phase: 'add', outcome: 'ok' }),
    ]);
    expect(s.phases.map((p) => p.phase)).toEqual([...PHASE_ORDER]);
    const search = s.phases.find((p) => p.phase === 'search')!;
    expect(search.failed).toBe(3);
    expect(search.topCode).toBe('store_error');
    expect(s.phases.find((p) => p.phase === 'cart_read')!.total).toBe(0);
  });

  it('keeps legacy DOM-era codes visible in their own count, not filtered away', () => {
    const [s] = aggregateNetworkStats([
      row({ code: 'selector_miss', outcome: 'error' }),
      row({ code: 'nav_failed', outcome: 'error' }),
      row({ code: 'store_error', outcome: 'error' }),
    ]);
    // Filtering them would make old rows vanish from totals with no explanation.
    expect(s.legacyCodeRows).toBe(2);
    expect(s.rows).toBe(3);
  });

  it('splits by store and sorts by volume', () => {
    const stats = aggregateNetworkStats([
      row({ store_id: 'aldi' }), row({ store_id: 'heb' }), row({ store_id: 'heb' }),
    ]);
    expect(stats.map((s) => s.storeId)).toEqual(['heb', 'aldi']);
  });

  it('buckets a null store rather than dropping the rows', () => {
    const [s] = aggregateNetworkStats([row({ store_id: null })]);
    expect(s.storeId).toBe('unknown');
  });
});

describe('summarize', () => {
  it('refuses to imply health for a store with no status data', () => {
    const [s] = aggregateNetworkStats([row({ http_status: null, attempts: null })]);
    expect(summarize(s)).toContain('none carrying a status yet');
    expect(summarize(s)).not.toContain('0%');
  });

  it('leads with the walls', () => {
    const [s] = aggregateNetworkStats([
      row({ http_status: 403, outcome: 'blocked' }), row({ http_status: 200 }),
    ]);
    expect(summarize(s)).toContain('1 blocked');
  });
});
