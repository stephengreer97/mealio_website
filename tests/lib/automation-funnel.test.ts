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

// ── Blocks are not failures ─────────────────────────────────────────────────
// The distinction the whole dashboard rests on. A WAF wall and a renamed button
// produce the same `outcome`, need completely different fixes, and averaging them
// into one number destroys the only bit that says which one you are looking at.

describe('aggregateFunnel — blocked is held apart from drift', () => {
  it('keeps a blocked row out of the step ok-rate denominator', () => {
    // 2 ok, 1 selector miss, 1 WAF wall. The honest drift number is 2/3, not 2/4:
    // the blocked attempt never got to succeed or fail on its own merits.
    const steps = [
      step({ step: 'add_click', outcome: 'ok' }),
      step({ step: 'add_click', outcome: 'ok' }),
      step({ step: 'add_click', outcome: 'error', code: 'selector_miss' }),
      step({ step: 'add_click', outcome: 'error', code: 'waf_block' }),
    ];
    const [heb] = aggregateFunnel([run()], steps);
    const click = heb.steps.find((s) => s.step === 'add_click')!;
    expect(click.total).toBe(4);
    expect(click.blocked).toBe(1);
    expect(click.attempted).toBe(3);
    expect(click.okRate).toBeCloseTo(2 / 3);
    expect(click.failures).toBe(1);
  });

  it('recognizes a block from the code alone, not just the blocked step', () => {
    // A run walled off mid-search dies on `search` with code waf_block. Counting
    // that as search drift sends someone to rewrite selectors that are fine.
    const [heb] = aggregateFunnel([run()], [step({ step: 'search', outcome: 'error', code: 'waf_block' })]);
    const search = heb.steps.find((s) => s.step === 'search')!;
    expect(search.blocked).toBe(1);
    expect(search.failures).toBe(0);
    expect(heb.failureCodes).toEqual({});
    expect(heb.blocked.steps).toBe(1);
  });

  it('recognizes a block from a blocked outcome on an ordinary step', () => {
    const [heb] = aggregateFunnel([run()], [step({ step: 'confirm', outcome: 'blocked', code: null })]);
    expect(heb.steps.find((s) => s.step === 'confirm')!.blocked).toBe(1);
    expect(heb.blocked.steps).toBe(1);
  });

  it('excludes blocked clicks from the confirm-rate denominator', () => {
    // 2 real clicks, both confirmed, plus 2 the WAF stopped. 100%, not 50% —
    // otherwise a block campaign reads as a confirm regression and someone spends
    // a day on the selectors.
    const steps = [
      step({ step: 'add_click' }), step({ step: 'add_click' }),
      step({ step: 'add_click', outcome: 'blocked' }), step({ step: 'add_click', outcome: 'blocked' }),
      step({ step: 'confirm' }), step({ step: 'confirm' }),
    ];
    const [heb] = aggregateFunnel([run()], steps);
    expect(heb.confirmRate).toBe(1);
  });

  it('reports the blocked rate over runs on its own axis', () => {
    const runs = [run(), run(), run(), run()];
    const [heb] = aggregateFunnel(runs, [step({ step: 'blocked', outcome: 'blocked' })]);
    expect(heb.blockedRate).toBe(0.25);
    expect(heb.blocked).toEqual({ steps: 1, rate: 0.25 });
  });
});

// ── MEAL-4 failure codes ────────────────────────────────────────────────────

describe('aggregateFunnel — failure codes', () => {
  it('groups failures by code, per step and per store', () => {
    const steps = [
      step({ step: 'search', outcome: 'empty', code: 'no_candidates' }),
      step({ step: 'search', outcome: 'empty', code: 'no_candidates' }),
      step({ step: 'add_click', outcome: 'error', code: 'selector_miss' }),
    ];
    const [heb] = aggregateFunnel([run()], steps);
    expect(heb.steps.find((s) => s.step === 'search')!.codes).toEqual({ no_candidates: 2 });
    expect(heb.steps.find((s) => s.step === 'add_click')!.codes).toEqual({ selector_miss: 1 });
    expect(heb.failureCodes).toEqual({ no_candidates: 2, selector_miss: 1 });
  });

  it('buckets a failure with NO code as "uncoded" rather than dropping it', () => {
    // No backfill is possible — step rows upsert with ignoreDuplicates, so every
    // row written before the taxonomy shipped keeps a null code forever. Silently
    // omitting them would report a store with 40 unexplained failures as having
    // none at all, which is the exact opposite of the truth.
    const steps = [
      step({ step: 'add_click', outcome: 'error', code: null }),
      step({ step: 'add_click', outcome: 'timeout' }),
      step({ step: 'add_click', outcome: 'error', code: 'selector_miss' }),
    ];
    const [heb] = aggregateFunnel([run()], steps);
    expect(heb.failureCodes).toEqual({ uncoded: 2, selector_miss: 1 });
    expect(heb.coverage.uncodedFailures).toBe(2);
  });

  it('counts an unrecognized code under its own name', () => {
    // A client newer than this deploy. The point of storing it as-is.
    const [heb] = aggregateFunnel([run()], [step({ outcome: 'error', code: 'captcha_wall' })]);
    expect(heb.failureCodes).toEqual({ captcha_wall: 1 });
  });

  it('never counts an ok or skipped row as a failure', () => {
    const steps = [
      step({ step: 'login_check', outcome: 'ok' }),
      step({ step: 'login_check', outcome: 'skipped' }),
    ];
    const [heb] = aggregateFunnel([run()], steps);
    expect(heb.failureCodes).toEqual({});
    expect(heb.steps.find((s) => s.step === 'login_check')!.failures).toBe(0);
  });

  it('reports run_summary codes separately from the per-step ones', () => {
    // run_summary carries the run's MOST FREQUENT code, not its most severe
    // (MEAL-123): three confirm_failed and one waf_block reports confirm_failed
    // and hides the actionable cause. It gets its own field so the UI can say so,
    // and it is never the headline.
    const steps = [
      step({ step: 'confirm', outcome: 'error', code: 'confirm_failed' }),
      step({ step: 'confirm', outcome: 'error', code: 'confirm_failed' }),
      step({ step: 'confirm', outcome: 'error', code: 'confirm_failed' }),
      step({ step: 'search', outcome: 'error', code: 'waf_block' }),
      step({ step: 'run_summary', outcome: 'error', code: 'confirm_failed' }),
    ];
    const [heb] = aggregateFunnel([run()], steps);
    expect(heb.runSummaryCodes).toEqual({ confirm_failed: 1 });
    // The severe cause is still visible on its own step, which is the point.
    expect(heb.blocked.steps).toBe(1);
    expect(heb.failureCodes.confirm_failed).toBe(4);
  });
});

// ── Coverage: the parallel-add blind spot (MEAL-122) ────────────────────────

describe('aggregateFunnel — instrumentation coverage', () => {
  it('flags a store that reported runs but no per-item steps at all', () => {
    // FEATURE_PARALLEL_ADD is on for HEB, Walmart, Amazon Fresh and Albertsons —
    // four of six stores, and the busiest. Their funnel is
    // login_check → (nothing) → reconcile → run_summary. Rendering that as a
    // flawless funnel is the failure mode this whole flag exists to prevent.
    const steps = [
      step({ step: 'login_check', outcome: 'ok' }),
      step({ step: 'reconcile', outcome: 'ok' }),
      step({ step: 'run_summary', outcome: 'ok' }),
    ];
    const [heb] = aggregateFunnel([run(), run()], steps);
    expect(heb.coverage.partialInstrumentation).toBe(true);
    expect(heb.coverage.missingSteps).toEqual(['search', 'candidates', 'add_click', 'confirm']);
    // And the reliability numbers it cannot compute stay null, not 100%.
    expect(heb.confirmRate).toBeNull();
    expect(heb.alerting).toBe(false);
  });

  it('does not flag a store that reports the full funnel', () => {
    const steps = [
      step({ step: 'search' }), step({ step: 'candidates' }),
      step({ step: 'add_click' }), step({ step: 'confirm' }),
    ];
    const [heb] = aggregateFunnel([run()], steps);
    expect(heb.coverage.partialInstrumentation).toBe(false);
    expect(heb.coverage.missingSteps).toEqual([]);
  });

  it('lists a partially reported funnel without calling it uninstrumented', () => {
    // Searched, found nothing, never clicked. Genuinely missing later steps —
    // different from a pool that reports none of them.
    const steps = [step({ step: 'search', outcome: 'empty', code: 'no_candidates' })];
    const [heb] = aggregateFunnel([run()], steps);
    expect(heb.coverage.partialInstrumentation).toBe(false);
    expect(heb.coverage.missingSteps).toEqual(['candidates', 'add_click', 'confirm']);
  });

  it('flags a store whose only rows are terminal, even with no run rows', () => {
    // Steps outlive a pruned run row. The blind spot is about which STEPS are
    // absent, not about whether the run table still has the row.
    const out = aggregateFunnel([], [step({ store_id: 'heb', step: 'reconcile', outcome: 'ok' })]);
    expect(out[0].coverage.partialInstrumentation).toBe(true);
    // A store with literally nothing never reaches the aggregator at all.
    expect(aggregateFunnel([], [])).toEqual([]);
  });
});

// ── Daily trend and week over week ──────────────────────────────────────────

describe('aggregateFunnel — daily trend', () => {
  const NOW = Date.parse('2026-08-05T12:00:00Z');
  const at = (daysAgo: number) => new Date(NOW - daysAgo * 24 * 60 * 60 * 1000).toISOString();

  it('produces one dense bucket per day in the window, zeros included', () => {
    const [heb] = aggregateFunnel([run({ started_at: at(0) })], [], { now: NOW, days: 30 });
    expect(heb.daily).toHaveLength(30);
    expect(heb.daily[0].day).toBe('2026-07-07');
    expect(heb.daily[29].day).toBe('2026-08-05');
  });

  it('reports a day with no runs as null, not 0%', () => {
    // A gap in the line, not a crater. A quiet Sunday is not an outage, and the
    // chart must not draw it as one.
    const [heb] = aggregateFunnel([run({ started_at: at(0) })], [], { now: NOW, days: 3 });
    expect(heb.daily.map((d) => d.terminalSuccessRate)).toEqual([null, null, 1]);
  });

  it('splits successes and failures across the right days', () => {
    const runs = [
      run({ started_at: at(1), outcome: 'success' }),
      run({ started_at: at(1), outcome: 'failed' }),
      run({ started_at: at(0), outcome: 'success' }),
    ];
    const [heb] = aggregateFunnel(runs, [], { now: NOW, days: 2 });
    expect(heb.daily[0]).toMatchObject({ runs: 2, runsSucceeded: 1, terminalSuccessRate: 0.5 });
    expect(heb.daily[1]).toMatchObject({ runs: 1, runsSucceeded: 1, terminalSuccessRate: 1 });
  });

  it('counts blocked steps on their own line in the daily series', () => {
    const steps = [
      step({ occurred_at: at(0), step: 'blocked', outcome: 'blocked' }),
      step({ occurred_at: at(0), step: 'add_click', outcome: 'error', code: 'selector_miss' }),
    ];
    const [heb] = aggregateFunnel([run({ started_at: at(0) })], steps, { now: NOW, days: 1 });
    expect(heb.daily[0]).toMatchObject({ blocked: 1, failures: 1 });
  });

  it('omits rows with no timestamp from the trend but still counts them in totals', () => {
    // Older rows, and anything the fetch returned without occurred_at. Better an
    // honest gap in the chart than a row invented onto today.
    const [heb] = aggregateFunnel([run({ started_at: null })], [step({ occurred_at: null })], { now: NOW, days: 7 });
    expect(heb.runs).toBe(1);
    expect(heb.daily.every((d) => d.runs === 0)).toBe(true);
  });
});

describe('aggregateFunnel — week over week', () => {
  const NOW = Date.parse('2026-08-05T12:00:00Z');
  const at = (daysAgo: number) => new Date(NOW - daysAgo * 24 * 60 * 60 * 1000).toISOString();

  it('is null on a window too short to hold a prior week', () => {
    // Comparing this week against three days of last week manufactures a
    // regression out of a shorter denominator.
    const [heb] = aggregateFunnel([run({ started_at: at(0) })], [], { now: NOW, days: 7 });
    expect(heb.weekOverWeek).toBeNull();
  });

  it('compares the last 7 days against the 7 before them', () => {
    const runs = [
      // This week: 1 of 2 succeeded.
      run({ started_at: at(1), outcome: 'success' }),
      run({ started_at: at(2), outcome: 'failed' }),
      // Prior week: 2 of 2 succeeded.
      run({ started_at: at(8), outcome: 'success' }),
      run({ started_at: at(9), outcome: 'success' }),
      // Outside both windows — must not leak into either side.
      run({ started_at: at(20), outcome: 'failed' }),
    ];
    const [heb] = aggregateFunnel(runs, [], { now: NOW, days: 30 });
    expect(heb.weekOverWeek!.current).toMatchObject({ runs: 2, terminalSuccessRate: 0.5 });
    expect(heb.weekOverWeek!.previous).toMatchObject({ runs: 2, terminalSuccessRate: 1 });
    expect(heb.weekOverWeek!.terminalSuccessRateDelta).toBe(-0.5);
    expect(heb.weekOverWeek!.runsDelta).toBe(0);
  });

  it('reports a null delta when either week has no runs', () => {
    // A store that launched on Monday has not regressed; it has no comparison.
    const [heb] = aggregateFunnel([run({ started_at: at(1) })], [], { now: NOW, days: 30 });
    expect(heb.weekOverWeek!.previous.terminalSuccessRate).toBeNull();
    expect(heb.weekOverWeek!.terminalSuccessRateDelta).toBeNull();
  });

  it('carries blocks and failures week over week separately', () => {
    const steps = [
      step({ occurred_at: at(1), step: 'blocked', outcome: 'blocked' }),
      step({ occurred_at: at(1), step: 'add_click', outcome: 'error', code: 'selector_miss' }),
      step({ occurred_at: at(9), step: 'add_click', outcome: 'error', code: 'selector_miss' }),
    ];
    const [heb] = aggregateFunnel([run({ started_at: at(1) })], steps, { now: NOW, days: 14 });
    expect(heb.weekOverWeek!.current).toMatchObject({ blocked: 1, failures: 1 });
    expect(heb.weekOverWeek!.previous).toMatchObject({ blocked: 0, failures: 1 });
  });
});

describe('aggregateFunnel — terminal success rate', () => {
  it('is taken from run rows, which every store writes', () => {
    // Deliberately NOT from run_summary steps: the four parallel-add stores emit
    // barely any steps, and a headline number that only exists for the two
    // instrumented stores is a headline number nobody can use.
    const runs = [
      run({ outcome: 'success' }), run({ outcome: 'success' }),
      run({ outcome: 'failed' }), run({ status: 'started', outcome: null }),
    ];
    const [heb] = aggregateFunnel(runs, []);
    expect(heb.terminalSuccessRate).toBe(0.5);
  });

  it('is null rather than zero for a store with no runs', () => {
    const out = aggregateFunnel([], [step({ store_id: 'aldi' })]);
    expect(out[0].terminalSuccessRate).toBeNull();
  });
});
