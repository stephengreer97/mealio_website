import { describe, it, expect } from 'vitest';
import { aggregateFunnel, percentile, RunRow, StepRow } from '@/lib/automation-funnel';

const run = (over: Partial<RunRow> = {}): RunRow => ({
  store_id: 'heb',
  outcome: 'success',
  status: 'completed',
  items_requested: 5,
  items_added: 5,
  ...over,
});

const step = (over: Partial<StepRow> = {}): StepRow => ({
  store_id: 'heb',
  step: 'add_click',
  outcome: 'ok',
  duration_ms: 100,
  detail: null,
  ...over,
});

describe('percentile', () => {
  it('returns null for an empty sample', () => {
    expect(percentile([], 50)).toBeNull();
  });

  it('returns the only value for a single sample', () => {
    expect(percentile([42], 95)).toBe(42);
  });

  it('picks the nearest rank', () => {
    const sorted = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(percentile(sorted, 50)).toBe(50);
    expect(percentile(sorted, 95)).toBe(100);
    expect(percentile(sorted, 10)).toBe(10);
  });

  it('never indexes out of bounds at the extremes', () => {
    expect(percentile([1, 2, 3], 100)).toBe(3);
    expect(percentile([1, 2, 3], 0)).toBe(1);
  });
});

describe('aggregateFunnel', () => {
  it('returns an empty array when there is no data', () => {
    expect(aggregateFunnel([], [])).toEqual([]);
  });

  it('computes confirmRate as confirms over ADD CLICKS, not over confirm rows', () => {
    // 4 clicks, only 3 produced any confirm row at all. The missing signal is the
    // failure mode we care about, so it must drag the rate down to 0.75 — dividing
    // by confirm rows would report a misleading 100%.
    const steps = [
      step(), step(), step(), step(),
      step({ step: 'confirm' }),
      step({ step: 'confirm' }),
      step({ step: 'confirm' }),
    ];
    const [heb] = aggregateFunnel([run()], steps);
    expect(heb.confirmRate).toBe(0.75);
  });

  it('counts a timed-out confirm against the rate', () => {
    const steps = [
      step(), step(),
      step({ step: 'confirm', outcome: 'ok' }),
      step({ step: 'confirm', outcome: 'timeout' }),
    ];
    const [heb] = aggregateFunnel([run()], steps);
    expect(heb.confirmRate).toBe(0.5);
  });

  it('separates first-click confirms from retries via detail.attempt', () => {
    const steps = [
      step(), step(), step(), step(),
      step({ step: 'confirm', detail: { attempt: 1 } }),
      step({ step: 'confirm', detail: { attempt: 1 } }),
      step({ step: 'confirm', detail: { attempt: 2 } }),
      step({ step: 'confirm', detail: { attempt: 3 } }),
    ];
    const [heb] = aggregateFunnel([run()], steps);
    expect(heb.confirmRate).toBe(1);            // all 4 eventually confirmed
    expect(heb.firstClickConfirmRate).toBe(0.5); // only 2 on the first try
  });

  it('treats a confirm with no attempt detail as a first-click confirm', () => {
    // Older clients don't report attempt. They must not read as 0% first-click.
    const steps = [step(), step({ step: 'confirm', detail: null })];
    const [heb] = aggregateFunnel([run()], steps);
    expect(heb.firstClickConfirmRate).toBe(1);
  });

  it('reports null rather than 0 for rates with no denominator', () => {
    // A store with runs but zero add_click steps has an UNKNOWN confirm rate.
    // Reporting 0% would fire a false alert on a store nobody used.
    const [heb] = aggregateFunnel([run()], []);
    expect(heb.confirmRate).toBeNull();
    expect(heb.firstClickConfirmRate).toBeNull();
    expect(heb.alerting).toBe(false);
  });

  it('does not alert on a small sample even when the rate is terrible', () => {
    const steps = [step(), step(), step()]; // 3 clicks, 0 confirms → 0%
    const [heb] = aggregateFunnel([run()], steps, { minSampleForAlert: 20 });
    expect(heb.confirmRate).toBe(0);
    expect(heb.alerting).toBe(false);
  });

  it('alerts once the sample is large enough and the rate is below threshold', () => {
    const steps = [
      ...Array.from({ length: 20 }, () => step()),
      ...Array.from({ length: 10 }, () => step({ step: 'confirm' })),
    ];
    const [heb] = aggregateFunnel([run()], steps, { minSampleForAlert: 20, confirmRateThreshold: 0.9 });
    expect(heb.confirmRate).toBe(0.5);
    expect(heb.alerting).toBe(true);
  });

  it('does not alert when the rate is exactly at threshold', () => {
    const steps = [
      ...Array.from({ length: 20 }, () => step()),
      ...Array.from({ length: 18 }, () => step({ step: 'confirm' })),
    ];
    const [heb] = aggregateFunnel([run()], steps, { minSampleForAlert: 20, confirmRateThreshold: 0.9 });
    expect(heb.confirmRate).toBeCloseTo(0.9);
    expect(heb.alerting).toBe(false);
  });

  it('counts abandoned runs from status, not outcome', () => {
    const runs = [
      run({ status: 'completed', outcome: 'success' }),
      run({ status: 'started', outcome: null }),
      run({ status: 'started', outcome: null }),
    ];
    const [heb] = aggregateFunnel(runs, []);
    expect(heb.runs).toBe(3);
    expect(heb.runsSucceeded).toBe(1);
    expect(heb.runsAbandoned).toBe(2);
  });

  it('includes a store that has steps but no run rows', () => {
    // Steps can outlive a pruned run row; the store must not vanish silently.
    const out = aggregateFunnel([], [step({ store_id: 'walmart' })]);
    expect(out.map((s) => s.storeId)).toEqual(['walmart']);
    expect(out[0].runs).toBe(0);
  });

  it('includes a store that has runs but no steps', () => {
    const out = aggregateFunnel([run({ store_id: 'aldi' })], []);
    expect(out.map((s) => s.storeId)).toEqual(['aldi']);
    expect(out[0].steps).toEqual([]);
  });

  it('sorts busiest store first', () => {
    const runs = [
      run({ store_id: 'aldi' }),
      run({ store_id: 'heb' }), run({ store_id: 'heb' }), run({ store_id: 'heb' }),
      run({ store_id: 'walmart' }), run({ store_id: 'walmart' }),
    ];
    expect(aggregateFunnel(runs, []).map((s) => s.storeId)).toEqual(['heb', 'walmart', 'aldi']);
  });

  it('orders steps by funnel sequence, not by insertion order', () => {
    const steps = [
      step({ step: 'reconcile' }),
      step({ step: 'login_check' }),
      step({ step: 'confirm' }),
      step({ step: 'search' }),
    ];
    const [heb] = aggregateFunnel([run()], steps);
    expect(heb.steps.map((s) => s.step)).toEqual(['login_check', 'search', 'confirm', 'reconcile']);
  });

  it('appends unrecognized step names instead of dropping them', () => {
    // A newer client may emit a step this deploy predates. Losing it from the
    // dashboard would hide exactly the new signal we just added.
    const steps = [step({ step: 'search' }), step({ step: 'future_step' })];
    const [heb] = aggregateFunnel([run()], steps);
    expect(heb.steps.map((s) => s.step)).toEqual(['search', 'future_step']);
  });

  it('rolls up outcome counts and durations per step', () => {
    const steps = [
      step({ step: 'search', outcome: 'ok', duration_ms: 100 }),
      step({ step: 'search', outcome: 'ok', duration_ms: 300 }),
      step({ step: 'search', outcome: 'empty', duration_ms: 200 }),
      step({ step: 'search', outcome: 'timeout', duration_ms: null }),
    ];
    const [heb] = aggregateFunnel([run()], steps);
    const search = heb.steps.find((s) => s.step === 'search')!;
    expect(search.total).toBe(4);
    expect(search.outcomes).toEqual({ ok: 2, empty: 1, timeout: 1 });
    expect(search.okRate).toBe(0.5);
    expect(search.p50DurationMs).toBe(200); // null duration excluded from latency
    expect(search.p95DurationMs).toBe(300);
  });

  it('keeps stores independent', () => {
    const steps = [
      step({ store_id: 'heb' }), step({ store_id: 'heb', step: 'confirm' }),
      step({ store_id: 'walmart' }), step({ store_id: 'walmart' }),
    ];
    const out = aggregateFunnel([run({ store_id: 'heb' }), run({ store_id: 'walmart' })], steps);
    const heb = out.find((s) => s.storeId === 'heb')!;
    const walmart = out.find((s) => s.storeId === 'walmart')!;
    expect(heb.confirmRate).toBe(1);
    expect(walmart.confirmRate).toBe(0);
  });

  it('computes blockedRate from blocked steps over runs', () => {
    const runs = [run(), run(), run(), run()];
    const [heb] = aggregateFunnel(runs, [step({ step: 'blocked', outcome: 'blocked' })]);
    expect(heb.blockedRate).toBe(0.25);
  });

  it('sums item counts across runs, treating nulls as zero', () => {
    const runs = [
      run({ items_requested: 5, items_added: 4 }),
      run({ items_requested: null, items_added: null }),
      run({ items_requested: 3, items_added: 3 }),
    ];
    const [heb] = aggregateFunnel(runs, []);
    expect(heb.itemsRequested).toBe(8);
    expect(heb.itemsAdded).toBe(7);
  });
});
