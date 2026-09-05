// MEAL-219. The picture the network rail can actually give.
import { describe, it, expect } from 'vitest';
import { buildRequestView, statusBucket, isHealthy, type RequestRow } from '@/lib/automation-requests';

const row = (over: Partial<RequestRow> = {}): RequestRow => ({
  store_id: 'heb', rail: 'heb', phase: 'search', outcome: 'ok',
  code: null, http_status: 200, attempts: 1, duration_ms: 100, ...over,
});

describe('which bucket a status falls in', () => {
  it('gives the anti-bot statuses their own buckets', () => {
    // These are the ones that change what you DO — 429 says back off, 403/412/
    // 418 say the wall is up. Folded into a single 4xx rate they rise for three
    // unrelated reasons and the number stops meaning anything.
    expect(statusBucket(429)).toBe('429');
    expect(statusBucket(403)).toBe('403');
    expect(statusBucket(412)).toBe('412');
    expect(statusBucket(418)).toBe('418');
    expect(statusBucket(422)).toBe('4xx');
  });

  it('separates NO ANSWER from a server error', () => {
    // A dropped connection is not a 5xx. Folding it in says the store answered
    // when it did not.
    expect(statusBucket(null)).toBe('none');
    expect(statusBucket(undefined)).toBe('none');
    expect(statusBucket(503)).toBe('5xx');
  });

  it('counts 2xx and 3xx as served', () => {
    expect(isHealthy(200)).toBe(true);
    expect(isHealthy(304)).toBe(true);
    expect(isHealthy(500)).toBe(false);
    expect(isHealthy(null)).toBe(false);
  });
});

describe('what gets counted at all', () => {
  it('drops rows that were never about a request', () => {
    // Ordinary step rows from before this ticket, and from older clients. A
    // denominator built from them puts a percentage under a question they
    // cannot answer, which is worse than no percentage.
    const view = buildRequestView([
      { ...row(), http_status: null, phase: null },
      { ...row(), http_status: null, phase: null },
    ]);
    expect(view).toEqual([]);
  });

  it('keeps a row that has a phase but no status', () => {
    // A request that got no answer is still a request, and losing it would make
    // an unreachable store look like a quiet one.
    const view = buildRequestView([row({ http_status: null })]);
    expect(view[0].requests).toBe(1);
    expect(view[0].statuses).toEqual([{ bucket: 'none', count: 1 }]);
  });
});

describe('the numbers a store gets', () => {
  it('reports the share the store actually served', () => {
    const view = buildRequestView([
      row({ http_status: 200 }), row({ http_status: 200 }),
      row({ http_status: 500 }), row({ http_status: 429 }),
    ]);
    expect(view[0].okRate).toBe(0.5);
  });

  it('separates how often we retried from whether retrying worked', () => {
    // A high retry rate with a high success rate is the policy earning its
    // keep. A high retry rate with a low one is a store that is simply down,
    // and retrying is only making the run slower.
    const view = buildRequestView([
      row({ attempts: 3, http_status: 200 }),
      row({ attempts: 3, http_status: 500 }),
      row({ attempts: 1, http_status: 200 }),
      row({ attempts: 1, http_status: 200 }),
    ]);
    expect(view[0].retryRate).toBe(0.5);
    expect(view[0].retrySuccessRate).toBe(0.5);
  });

  it('says NULL, not zero, when nothing was retried', () => {
    // "0% of retries succeeded" reads as a broken retry policy. It means there
    // were none.
    const view = buildRequestView([row({ attempts: 1 }), row({ attempts: 1 })]);
    expect(view[0].retryRate).toBe(0);
    expect(view[0].retrySuccessRate).toBeNull();
  });

  it('breaks the run down by PHASE, which is what a rail actually does', () => {
    const view = buildRequestView([
      row({ phase: 'session', http_status: 200, duration_ms: 50 }),
      row({ phase: 'search', http_status: 200, duration_ms: 300 }),
      row({ phase: 'search', http_status: 500, duration_ms: 900 }),
      row({ phase: 'cart_read', http_status: 412, duration_ms: 90 }),
    ]);
    const byName = Object.fromEntries(view[0].phases.map((p) => [p.phase, p]));
    expect(byName.search.requests).toBe(2);
    expect(byName.search.okRate).toBe(0.5);
    expect(byName.cart_read.okRate).toBe(0);
    expect(byName.session.okRate).toBe(1);
  });

  it('names the rail as well as the banner', () => {
    // Fifteen Albertsons banners share one implementation. Without this a
    // rail-level regression reads as fifteen unrelated store problems.
    const view = buildRequestView([
      row({ store_id: 'safeway', rail: 'albertsons' }),
      row({ store_id: 'safeway', rail: 'albertsons' }),
    ]);
    expect(view[0].storeId).toBe('safeway');
    expect(view[0].rails).toEqual(['albertsons']);
  });

  it('puts the busiest store first', () => {
    const view = buildRequestView([
      row({ store_id: 'aldi' }),
      row({ store_id: 'heb' }), row({ store_id: 'heb' }), row({ store_id: 'heb' }),
    ]);
    expect(view.map((s) => s.storeId)).toEqual(['heb', 'aldi']);
  });

  it('reports durations as percentiles over rows that carried one', () => {
    const view = buildRequestView([
      row({ duration_ms: 100 }), row({ duration_ms: 200 }),
      row({ duration_ms: 300 }), row({ duration_ms: null }),
    ]);
    expect(view[0].phases[0].p50).toBe(200);
    expect(view[0].phases[0].p95).toBe(300);
  });

  it('has no duration percentile when nothing carried one', () => {
    const view = buildRequestView([row({ duration_ms: null })]);
    expect(view[0].phases[0].p50).toBeNull();
  });
});
