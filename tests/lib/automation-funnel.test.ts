import { describe, it, expect } from 'vitest';
import {
  aggregateFunnel,
  median,
  okRateUpperBound,
  percentile,
  unavailableItemsByRun,
  worstStep,
  DEFAULT_BLOCKED_RATE_THRESHOLD,
  DEFAULT_ITEM_SUCCESS_DROP_THRESHOLD,
  RunRow,
  StepRow,
  WorstStepInput,
} from '@/lib/automation-funnel';
import { RUNNING_GRACE_MS } from '@/lib/automation-trace';

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
    // No `started_at` on these, so the age is unknown — which runConcern resolves
    // toward abandoned on purpose, the direction that shows a row rather than
    // quietly calling it fine. That is why this pre-existing case is unchanged.
    expect(heb.runsAbandoned).toBe(2);
  });

  // ── Unverified runs, counted apart (MEAL-190) ────────────────────────────
  //
  // A run that finished without reading the cart reports outcome 'unverified'.
  // The number matters more than it looks: it is the coverage qualifier on every
  // other figure in the card. `itemsAdded` on such a run is the run's own report
  // of itself, and the cart diff is the only check that has ever contradicted a
  // run — so a store where this approaches `runs` has no measured add path at
  // all, whatever its rates say. A store whose cart URL redirects (Walmart today)
  // can be in that state on every single run.

  it('counts unverified runs separately from successes', () => {
    const runs = [
      run({ outcome: 'success' }),
      run({ outcome: 'unverified' }),
      run({ outcome: 'unverified' }),
      run({ outcome: 'partial' }),
    ];
    const [heb] = aggregateFunnel(runs, []);
    expect(heb.runs).toBe(4);
    expect(heb.runsUnverified).toBe(2);
    // Not folded into either of the neighbours it would otherwise hide in.
    expect(heb.runsSucceeded).toBe(1);
    expect(heb.runsAbandoned).toBe(0);
  });

  it('leaves unverified runs in the terminal success denominator', () => {
    // Deliberate, and the reason the count above has to be on screen beside it.
    // Dropping them from the denominator would raise the rate by narrowing the
    // population it describes, with nothing rendered to say the population moved.
    // They are not successes either — the run was never checked — so the rate
    // falls, and `runsUnverified` is what makes that fall explicable instead of
    // looking like an automation regression.
    const runs = [run({ outcome: 'success' }), run({ outcome: 'unverified' })];
    const [heb] = aggregateFunnel(runs, []);
    expect(heb.terminalSuccessRate).toBe(0.5);
  });

  it('does not count a run that is still going as abandoned', () => {
    // MEAL-145. This counted every `status: 'started'` row, so whatever happened to
    // be running when the query fired was reported as an abandoned run. At peak,
    // healthy traffic inflated the number that is supposed to say the engine is
    // wedging.
    const runs = [
      run({ status: 'completed', outcome: 'success' }),
      run({ status: 'started', outcome: null, started_at: new Date(Date.now() - 30_000).toISOString() }),
    ];
    const [heb] = aggregateFunnel(runs, []);
    expect(heb.runs).toBe(2);
    expect(heb.runsAbandoned).toBe(0);
  });

  it('counts a run that stopped reporting as abandoned once the grace band passes', () => {
    // The other side of the same line: past RUNNING_GRACE_MS a run that never
    // reported finishing is exactly what this number is for.
    const runs = [
      run({
        status: 'started',
        outcome: null,
        started_at: new Date(Date.now() - RUNNING_GRACE_MS - 60_000).toISOString(),
      }),
    ];
    const [heb] = aggregateFunnel(runs, []);
    expect(heb.runsAbandoned).toBe(1);
  });

  it('judges the grace band against the window\'s clock, not wall time', () => {
    // MEAL-145, and the mistake this ticket is about, made once more inside the fix
    // for it. aggregateFunnel takes a `now` and every other time-dependent figure
    // honours it; runConcern defaults to Date.now() if you let it. Left defaulted,
    // a run that is 30 seconds old *relative to the reported window* gets measured
    // against the wall clock instead — here, a fixed NOW well in the past, so it
    // reads as hours-abandoned.
    //
    // The other tests in this file cannot see it: they build fixtures from
    // Date.now(), which is exactly what makes them agree with the bug.
    const WINDOW_NOW = Date.parse('2026-08-05T12:00:00Z');
    const runs = [
      run({
        status: 'started',
        outcome: null,
        started_at: new Date(WINDOW_NOW - 30_000).toISOString(),
      }),
    ];
    expect(aggregateFunnel(runs, [], { now: WINDOW_NOW, days: 7 })[0].runsAbandoned).toBe(0);

    // And the same row IS abandoned once the window's clock has moved past the band.
    const later = WINDOW_NOW + RUNNING_GRACE_MS + 60_000;
    expect(aggregateFunnel(runs, [], { now: later, days: 7 })[0].runsAbandoned).toBe(1);
  });

  it('counts a half-landed completion write as abandoned even inside the grace band', () => {
    // This is what `completed_at` buys, and it is the reason it had to be added to
    // the funnel's select rather than reusing runConcern on the columns already
    // there. A row with `completed_at` set and `status` still 'started' is a
    // completion write that landed partway. runConcern refuses to call that
    // `running` — it is not a run still going — so it lands as abandoned
    // immediately, without waiting out the grace band.
    //
    // Same age as the "still going" case above; the only difference is this column.
    const halfLanded = run({
      status: 'started',
      outcome: null,
      started_at: new Date(Date.now() - 30_000).toISOString(),
      completed_at: new Date().toISOString(),
    });
    expect(aggregateFunnel([halfLanded], [])[0].runsAbandoned).toBe(1);

    const { completed_at: _dropped, ...stillGoing } = halfLanded;
    expect(aggregateFunnel([stillGoing], [])[0].runsAbandoned).toBe(0);
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

  it('computes blockedRate from blocked RUNS over runs', () => {
    // Was "blocked steps over runs", which is two different units over each
    // other. One of four runs walled off is 25% either way in this fixture; see
    // "never reports more than 100%" below for the fixture where it was not.
    const runs = [run({ id: 'r1' }), run({ id: 'r2' }), run({ id: 'r3' }), run({ id: 'r4' })];
    const [heb] = aggregateFunnel(runs, [step({ run_id: 'r1', step: 'blocked', outcome: 'blocked' })]);
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
    const runs = [run({ id: 'r1' }), run({ id: 'r2' }), run({ id: 'r3' }), run({ id: 'r4' })];
    const [heb] = aggregateFunnel(runs, [step({ run_id: 'r1', step: 'blocked', outcome: 'blocked' })]);
    expect(heb.blockedRate).toBe(0.25);
    expect(heb.blocked).toEqual({ steps: 1, runs: 1, rate: 0.25 });
  });
});

// ── The blocked rate is a share of RUNS, not a step count over runs ──────────
// The units used to disagree: blocked STEPS over RUNS. A walled-off run emits one
// blocked row per item it tried, so the "rate" was unbounded and the tile rendered
// "WAF blocked 500.0%" — a number that tells an operator nothing except that the
// page is broken, on the one tile whose job is to say "stop reading the rest".

describe('aggregateFunnel — blockedRate is a share of runs', () => {
  const blockedItems = (runId: string, n: number) =>
    Array.from({ length: n }, () => step({ run_id: runId, step: 'add_click', outcome: 'blocked' }));

  it('never reports more than 100%, however many items each blocked run tried', () => {
    // Two runs, five walled-off items each. Ten blocked steps over two runs read
    // as 500%. The truth is that every run this store made was walled off: 100%.
    const runs = [run({ id: 'r1' }), run({ id: 'r2' })];
    const steps = [...blockedItems('r1', 5), ...blockedItems('r2', 5)];
    const [heb] = aggregateFunnel(runs, steps);
    expect(heb.blocked.steps).toBe(10);
    expect(heb.blocked.runs).toBe(2);
    expect(heb.blockedRate).toBe(1);
  });

  it('counts one walled-off run once no matter how many steps it blocked on', () => {
    // Nine blocked rows, all from the same run, alongside three clean runs. One
    // run in four is behind the wall — 25%, not 225%.
    const runs = [run({ id: 'r1' }), run({ id: 'r2' }), run({ id: 'r3' }), run({ id: 'r4' })];
    const [heb] = aggregateFunnel(runs, blockedItems('r1', 9));
    expect(heb.blocked.steps).toBe(9);
    expect(heb.blockedRate).toBe(0.25);
  });

  it('keeps the numerator inside the denominator when a blocked run was not fetched', () => {
    // A run that started just before the window still writes steps inside it, so
    // its step rows arrive without a run row. Counting those blocked runs against
    // the fetched runs alone would push the rate over 100% again; the denominator
    // is the union of both sides.
    const [heb] = aggregateFunnel([run({ id: 'r1' })], [
      ...blockedItems('r1', 3),
      ...blockedItems('older-run', 4),
    ]);
    expect(heb.blocked.runs).toBe(2);
    expect(heb.blockedRate).toBe(1);
  });

  it('does not count a clean run as walled off', () => {
    const runs = [run({ id: 'r1' }), run({ id: 'r2' })];
    const steps = [
      step({ run_id: 'r1', step: 'add_click', outcome: 'ok' }),
      step({ run_id: 'r2', step: 'add_click', outcome: 'error', code: 'selector_miss' }),
    ];
    const [heb] = aggregateFunnel(runs, steps);
    expect(heb.blocked).toEqual({ steps: 0, runs: 0, rate: 0 });
  });
});

// ── Alerting on a wall, not just on drift ───────────────────────────────────
// `alerting` used to key off confirmRate alone, and confirmRate deliberately
// excludes blocked clicks — so the one store shape the page most needs to shout
// about, a store the WAF has stopped serving, raised nothing at all.

describe('aggregateFunnel — blocked-side alert', () => {
  /** n runs, all of whose add clicks were walled off. */
  const walledRuns = (n: number, from = 0) =>
    Array.from({ length: n }, (_, i) => run({ id: `blocked-${from + i}` }));
  const walledSteps = (n: number, from = 0) =>
    Array.from({ length: n }, (_, i) => step({ run_id: `blocked-${from + i}`, step: 'add_click', outcome: 'blocked' }));

  it('alerts on a store whose runs are nearly all walled off, despite a perfect confirm rate', () => {
    // The probe: 9 of 10 runs blocked, the one that got through confirmed. The
    // confirm rate is 100% and honestly so — blocked clicks are not missed
    // confirms — which is exactly why it cannot be the only alert condition.
    const runs = [...walledRuns(9), run({ id: 'clean', outcome: 'failed' })];
    const steps = [
      ...walledSteps(9),
      step({ run_id: 'clean', step: 'add_click', outcome: 'ok' }),
      step({ run_id: 'clean', step: 'confirm', outcome: 'ok' }),
    ];
    const [heb] = aggregateFunnel(runs, steps);
    expect(heb.confirmRate).toBe(1);
    expect(heb.blockedRate).toBe(0.9);
    expect(heb.alerting).toBe(true);
    expect(heb.alertReasons).toEqual(['blocked']);
  });

  it('does not alert when only a small share of runs is walled off', () => {
    // 1 in 50 = 2%, under the 3% MEAL-6 settled on. This used to read 1 in 20
    // and pass at the 20% the module shipped with; a fifth of a store's traffic
    // walled off is not "a small share" by any reading, which is most of why the
    // number moved.
    const runs = [...walledRuns(1), ...Array.from({ length: 49 }, (_, i) => run({ id: `ok-${i}` }))];
    const [heb] = aggregateFunnel(runs, walledSteps(1));
    expect(heb.blockedRate).toBe(0.02);
    expect(heb.alerting).toBe(false);
    expect(heb.alertReasons).toEqual([]);
  });

  it('alerts at the 3% MEAL-6 decided on, not the 20% this shipped with', () => {
    // The threshold is asserted through the DEFAULT rather than by passing it,
    // because the default is what the admin page and the alert email both get.
    // A test that passed `blockedRateThreshold: 0.03` would keep passing after
    // the two callers had drifted apart, which is the thing MEAL-6 is trying to
    // make impossible.
    expect(DEFAULT_BLOCKED_RATE_THRESHOLD).toBe(0.03);
    const runs = [...walledRuns(2), ...Array.from({ length: 48 }, (_, i) => run({ id: `ok-${i}` }))];
    const [heb] = aggregateFunnel(runs, walledSteps(2));
    expect(heb.blockedRate).toBe(0.04);
    expect(heb.alertReasons).toEqual(['blocked']);
  });

  it('does not alert on a handful of runs even when every one is walled off', () => {
    // Two runs blocked is one shopper on hotel wifi, not a campaign.
    const [heb] = aggregateFunnel(walledRuns(2), walledSteps(2));
    expect(heb.blockedRate).toBe(1);
    expect(heb.alerting).toBe(false);
  });

  it('alerts at the threshold rather than waiting for the next percent', () => {
    const runs = [...walledRuns(2), ...Array.from({ length: 8 }, (_, i) => run({ id: `ok-${i}` }))];
    const [heb] = aggregateFunnel(runs, walledSteps(2), { blockedRateThreshold: 0.2 });
    expect(heb.blockedRate).toBe(0.2);
    expect(heb.alertReasons).toEqual(['blocked']);
  });

  it('names both reasons when a store is drifting AND being walled off', () => {
    const runs = [...walledRuns(5), ...Array.from({ length: 5 }, (_, i) => run({ id: `ok-${i}` }))];
    const steps = [
      ...walledSteps(5),
      // 20 real clicks, 10 confirms: drift on top of the wall.
      ...Array.from({ length: 20 }, () => step({ run_id: 'ok-0', step: 'add_click', outcome: 'ok' })),
      ...Array.from({ length: 10 }, () => step({ run_id: 'ok-0', step: 'confirm', outcome: 'ok' })),
    ];
    const [heb] = aggregateFunnel(runs, steps, { minSampleForAlert: 20 });
    expect(heb.confirmRate).toBe(0.5);
    expect(heb.blockedRate).toBe(0.5);
    expect(heb.alertReasons).toEqual(['confirm_rate', 'blocked']);
  });

  it('reports the confirm-rate reason on its own when nothing is blocked', () => {
    const steps = [
      ...Array.from({ length: 20 }, () => step()),
      ...Array.from({ length: 10 }, () => step({ step: 'confirm' })),
    ];
    const [heb] = aggregateFunnel([run()], steps, { minSampleForAlert: 20 });
    expect(heb.alertReasons).toEqual(['confirm_rate']);
    expect(heb.alerting).toBe(true);
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
    // FEATURE_PARALLEL_ADD is on for HEB, Walmart and Albertsons —
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
    // Strengthened: the fixture now includes rows in the half-day the fetch
    // window reaches into but the dense series does not cover (`since` is
    // NOW − 30×24h = 2026-07-06T12:00, whose calendar day sits before the first
    // dense day). With only a row at at(0) this test passed either way.
    const runs = [
      run({ started_at: at(0) }),
      run({ started_at: '2026-07-06T18:00:00Z' }),   // inside the fetch window…
      run({ started_at: '2026-07-06T23:59:00Z' }),   // …but outside the 30 dense days
    ];
    const steps = [step({ occurred_at: '2026-07-06T18:00:00Z', outcome: 'error', code: 'selector_miss' })];
    const [heb] = aggregateFunnel(runs, steps, { now: NOW, days: 30 });
    expect(heb.daily).toHaveLength(30);
    expect(heb.daily[0].day).toBe('2026-07-07');
    expect(heb.daily[29].day).toBe('2026-08-05');
    expect(heb.daily.map((d) => d.day)).not.toContain('2026-07-06');
    // Still counted in the store's totals — they are inside the fetched window.
    expect(heb.runs).toBe(3);
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

  it('does not invent a bucket for the sliver of the day before the window', () => {
    // The off-by-one: the dense series walks back CALENDAR days from `now`, but
    // the fetch window is the rolling instant `now - days*24h`, which lands inside
    // the calendar day BEFORE the first dense one. Ten minutes before midnight
    // UTC, that sliver is ten minutes wide — and it was drawn as a full-width
    // point that supplied the chart's left-edge date label, so a single unlucky
    // run in those ten minutes plotted a 0% left endpoint for a day that is
    // 99.3% unfetched.
    const LATE = Date.parse('2026-08-05T23:50:00Z');
    const runs = [
      run({ started_at: '2026-07-29T23:55:00Z', outcome: 'failed' }), // in the sliver
      run({ started_at: '2026-08-05T10:00:00Z', outcome: 'success' }),
    ];
    const [heb] = aggregateFunnel(runs, [], { now: LATE, days: 7 });

    expect(heb.daily).toHaveLength(7);
    expect(heb.daily[0].day).toBe('2026-07-30');
    expect(heb.daily[6].day).toBe('2026-08-05');
    // The sliver run is not a day of history, and above all not a 0% one.
    expect(heb.daily.some((d) => d.day === '2026-07-29')).toBe(false);
    expect(heb.daily[0]).toMatchObject({ runs: 0, terminalSuccessRate: null });
    // It is still a run this store made inside the fetched window.
    expect(heb.runs).toBe(2);
    expect(heb.terminalSuccessRate).toBe(0.5);
  });

  it('keeps a blocked step in the sliver out of the trend as well', () => {
    const LATE = Date.parse('2026-08-05T23:50:00Z');
    const steps = [
      step({ occurred_at: '2026-07-29T23:59:00Z', step: 'blocked', outcome: 'blocked' }),
      step({ occurred_at: '2026-08-05T01:00:00Z', step: 'add_click', outcome: 'error', code: 'selector_miss' }),
    ];
    const [heb] = aggregateFunnel([run({ started_at: '2026-08-05T01:00:00Z' })], steps, { now: LATE, days: 7 });
    expect(heb.daily).toHaveLength(7);
    expect(heb.daily.reduce((a, d) => a + d.blocked, 0)).toBe(0);
    expect(heb.daily[6].failures).toBe(1);
    // Counted store-wide, just not drawn on a day the chart does not cover.
    expect(heb.blocked.steps).toBe(1);
  });

  it('does not bucket a row timestamped after the window ends', () => {
    // Device clocks run fast, and a bucket to the right of "today" stretches the
    // x-axis into the future and takes the last-value label with it.
    const [heb] = aggregateFunnel([run({ started_at: '2026-08-06T04:00:00Z' })], [], { now: NOW, days: 7 });
    expect(heb.daily).toHaveLength(7);
    expect(heb.daily[6].day).toBe('2026-08-05');
    expect(heb.daily.every((d) => d.runs === 0)).toBe(true);
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

// ── "Dying on": the tile that names a step ──────────────────────────────────
// The most quoted number on the page and the easiest to make libellous. Three
// separate ways it used to assert a death that had not happened: a five-attempt
// sample floor, no answer for "nothing is dying", and no exemption for a store
// whose per-item funnel is not instrumented at all.

describe('okRateUpperBound', () => {
  it('is 1 for an empty sample — an unmeasured step is never the accused', () => {
    expect(okRateUpperBound(0, 0)).toBe(1);
  });

  it('stays above the bar for a tiny sample, however bad the raw rate looks', () => {
    // 4 ok of 5 is "80%", and it is also four coin flips. The optimistic reading
    // is 96%, which is the honest thing to say about it.
    expect(okRateUpperBound(4, 5)).toBeGreaterThan(0.9);
    // The bound alone is not the whole guard: one attempt that failed reads as
    // 79%, low enough to clear the bar. The 20-attempt floor is what keeps a
    // single row from naming a step, which is why worstStep applies both.
    expect(okRateUpperBound(0, 1)).toBeLessThan(0.9);
  });

  it('tightens onto the raw rate as the sample grows', () => {
    expect(okRateUpperBound(4450, 5000)).toBeLessThan(0.9);   // 89.0%
    expect(okRateUpperBound(4450, 5000)).toBeGreaterThan(0.89);
  });

  it('never exceeds 1', () => {
    expect(okRateUpperBound(3, 3)).toBe(1);
  });
});

describe('worstStep', () => {
  const stat = (step: string, ok: number, attempted: number): WorstStepInput => ({
    step,
    attempted,
    okRate: attempted === 0 ? null : ok / attempted,
    outcomes: { ok, error: attempted - ok },
  });
  const store = (steps: WorstStepInput[], partialInstrumentation = false) =>
    ({ steps, coverage: { partialInstrumentation } });

  it('will not name a step on a five-attempt sample', () => {
    // The probe: 4 ok and 1 empty on `search` rendered "Dying on: search, 80.0%
    // ok over 5" in red, beside a 200-attempt add_click at 100%.
    const v = worstStep(store([stat('search', 4, 5), stat('add_click', 200, 200)]));
    expect(v.kind).toBe('healthy');
  });

  it('says there is no usable sample rather than naming the only small step', () => {
    const v = worstStep(store([stat('search', 4, 5)]));
    expect(v.kind).toBe('insufficient_sample');
  });

  it('names nothing when nothing is dying', () => {
    // "Dying on: search — 100.0% ok over 100" asserts a death that did not
    // happen. Not red, and still wrong.
    const v = worstStep(store([stat('search', 100, 100), stat('add_click', 98, 100)]));
    expect(v.kind).toBe('healthy');
  });

  it('is silent for a store whose per-item funnel is not instrumented', () => {
    // MEAL-122/HEB: login_check, reconcile and run_summary are the only steps
    // that exist. Naming login_check points at the one part of the run that is
    // measured while the part that fails is invisible.
    const v = worstStep(store([stat('login_check', 60, 100), stat('reconcile', 100, 100)], true));
    expect(v.kind).toBe('unmeasured');
  });

  it('ranks by the optimistic reading, so volume outweighs a noisy small sample', () => {
    // 15 ok of 20 is a worse RATE (75%) than 320 of 400 (80%), and a far weaker
    // claim: five failures against eighty. The old reduce took the minimum rate
    // and named the 20-attempt step.
    const v = worstStep(store([stat('search', 15, 20), stat('add_click', 320, 400)]));
    expect(v.kind).toBe('dying');
    if (v.kind !== 'dying') throw new Error('unreachable');
    expect(v.step).toBe('add_click');
  });

  it('still names a small step when the collapse is unambiguous', () => {
    // A 20-attempt floor is not a 20-attempt excuse: half of twenty failing is
    // outside the noise, and the verdict says so.
    const v = worstStep(store([stat('add_click', 10, 20)]));
    expect(v.kind).toBe('dying');
    if (v.kind !== 'dying') throw new Error('unreachable');
    expect(v.step).toBe('add_click');
    expect(v.okRate).toBe(0.5);
    expect(v.attempted).toBe(20);
    expect(v.okRateUpper).toBeLessThan(0.9);
  });

  it('never names run_summary or blocked', () => {
    // run_summary is a terminal roll-up carrying the run's most FREQUENT code
    // (MEAL-123), and blocked rows are held apart from drift everywhere else.
    const v = worstStep(store([
      stat('search', 100, 100),
      stat('run_summary', 0, 100),
      stat('blocked', 0, 100),
    ]));
    expect(v.kind).toBe('healthy');
  });

  it('reads the shape aggregateFunnel actually returns', () => {
    // Guards the seam: the tile is fed straight from the endpoint's step rows.
    const steps = [
      ...Array.from({ length: 40 }, () => step({ step: 'add_click', outcome: 'ok' })),
      ...Array.from({ length: 60 }, () => step({ step: 'add_click', outcome: 'error', code: 'selector_miss' })),
      ...Array.from({ length: 100 }, () => step({ step: 'search', outcome: 'ok' })),
    ];
    const [heb] = aggregateFunnel([run()], steps);
    const v = worstStep(heb);
    expect(v.kind).toBe('dying');
    if (v.kind !== 'dying') throw new Error('unreachable');
    expect(v.step).toBe('add_click');
    expect(v.okRate).toBeCloseTo(0.4);
  });

  it('honours a caller-supplied floor and threshold', () => {
    const steps = [stat('add_click', 8, 10)];
    expect(worstStep(store(steps)).kind).toBe('insufficient_sample');
    expect(worstStep(store(steps), { minSample: 10, threshold: 0.99 }).kind).toBe('dying');
  });
});

// ── MEAL-6: the item rate against the store's own trailing median ───────────
// The regression alert, as distinct from the absolute floor beside it. The
// distinction is the whole ticket: a floor alarms forever on a store that has
// always been middling and stays silent through the break that matters, which is
// a store falling away from what IT normally does.

describe('median', () => {
  it('returns null for an empty sample', () => {
    expect(median([])).toBeNull();
  });

  it('takes the middle of an odd sample and averages the two middles of an even one', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it('is unmoved by one catastrophic day, which a mean would not be', () => {
    // The reason this is a median. Six good days and one total outage: the mean
    // is 0.84, low enough that a second day of outage reads as an improvement.
    const week = [0.98, 0.99, 0.97, 0.98, 1, 0.99, 0];
    expect(median(week)).toBe(0.98);
  });
});

describe('aggregateFunnel — item success trend', () => {
  const NOW = Date.parse('2026-03-08T14:00:00.000Z');
  const HOUR = 3_600_000;

  /**
   * A run that started `hoursAgo` before NOW, asking for `requested` items and
   * getting `added`. Hours rather than days so a test can place a run precisely
   * inside or outside a 24h window boundary.
   */
  const at = (hoursAgo: number, requested: number, added: number, over: Partial<RunRow> = {}): RunRow => ({
    store_id: 'heb',
    outcome: 'success',
    status: 'completed',
    items_requested: requested,
    items_added: added,
    started_at: new Date(NOW - hoursAgo * HOUR).toISOString(),
    ...over,
  });

  /** `perDay` runs of 10 items in each of the 7 baseline windows, at `rate`. */
  function baseline(rate: number, perDay = 3): RunRow[] {
    const runs: RunRow[] = [];
    for (let day = 1; day <= 7; day++) {
      for (let i = 0; i < perDay; i++) {
        // Mid-window, so a boundary is never what a test is really asserting.
        runs.push(at(day * 24 + 12, 10, Math.round(10 * rate), { id: `base-${day}-${i}` }));
      }
    }
    return runs;
  }

  /** Today's traffic: `runs` runs of 10 items at `rate`. */
  function today(rate: number, count = 4): RunRow[] {
    return Array.from({ length: count }, (_, i) => at(6, 10, Math.round(10 * rate), { id: `today-${i}` }));
  }

  it('measures the recent window against the median of the seven before it', () => {
    const [heb] = aggregateFunnel([...baseline(1), ...today(0.5)], [], { now: NOW });
    expect(heb.itemSuccess.recent).toBe(0.5);
    expect(heb.itemSuccess.median).toBe(1);
    expect(heb.itemSuccess.baselineWindows).toBe(7);
    expect(heb.itemSuccess.drop).toBe(0.5);
    expect(heb.alertReasons).toEqual(['success_drop']);
  });

  it('says nothing about a store holding steady at a rate a floor would condemn', () => {
    // 70% every day for a week and 70% today. This is the case an absolute floor
    // gets wrong forever: nothing has changed, so there is nothing to tell
    // anyone, and a daily email saying "still 70%" is how the alert gets muted.
    const [heb] = aggregateFunnel([...baseline(0.7), ...today(0.7)], [], { now: NOW });
    expect(heb.itemSuccess.recent).toBeCloseTo(0.7);
    expect(heb.itemSuccess.median).toBeCloseTo(0.7);
    expect(heb.itemSuccess.drop).toBeCloseTo(0);
    expect(heb.alertReasons).toEqual([]);
  });

  it('catches a store that fell from excellent to merely good', () => {
    // 99% → 88%. No floor set anywhere near 88% would see this, and it is
    // exactly what a renamed selector on one of several product tiles looks
    // like.
    const dipped = Array.from({ length: 4 }, (_, i) => at(6, 25, 22, { id: `today-${i}` }));
    const [heb] = aggregateFunnel([...baseline(1), ...dipped], [], { now: NOW });
    expect(heb.itemSuccess.recent).toBe(0.88);
    expect(heb.itemSuccess.drop).toBeCloseTo(0.12);
    expect(heb.alertReasons).toEqual(['success_drop']);
  });

  it('is ten points, and ten points is the decided number', () => {
    expect(DEFAULT_ITEM_SUCCESS_DROP_THRESHOLD).toBe(0.1);
  });

  it('does not fire on a drop of exactly the threshold', () => {
    // "More than 10 percentage points" is strict, so a drop of exactly the
    // threshold is the boundary and not over it.
    //
    // The threshold is passed here rather than left at its default, and the
    // numbers are quarters, because THE COMPARISON IS THE ASSERTION and floating
    // point will quietly stop it being made. `1 - 0.9` is 0.09999999999999998,
    // which is under 0.1 whichever way the operator points — so the obvious
    // version of this test passes just as well against `>=` and proves nothing.
    // 1 - 0.75 is exactly 0.25.
    const threeQuarters = Array.from({ length: 4 }, (_, i) => at(6, 20, 15, { id: `today-${i}` }));
    const [heb] = aggregateFunnel([...baseline(1), ...threeQuarters], [], {
      now: NOW, itemSuccessDropThreshold: 0.25,
    });
    expect(heb.itemSuccess.recent).toBe(0.75);
    expect(heb.itemSuccess.drop).toBe(0.25);
    expect(heb.alertReasons).toEqual([]);
  });

  it('fires one item past that boundary', () => {
    // The other side of the same line, so "does not fire" above is a threshold
    // and not a dead branch.
    const [heb] = aggregateFunnel([...baseline(1), ...today(0.7)], [], {
      now: NOW, itemSuccessDropThreshold: 0.25,
    });
    expect(heb.itemSuccess.drop).toBeCloseTo(0.3);
    expect(heb.alertReasons).toEqual(['success_drop']);
  });

  it('does not alert on a recent window too small to mean anything', () => {
    // One run of 10 items, all of them missed. A single shopper on bad wifi is
    // not a store regression, and `minSampleForAlert` is counted in ITEMS —
    // the denominator of the rate being judged.
    const [heb] = aggregateFunnel([...baseline(1), at(6, 10, 0, { id: 'lonely' })], [], { now: NOW });
    expect(heb.itemSuccess.recent).toBe(0);
    expect(heb.itemSuccess.recentItemsRequested).toBe(10);
    expect(heb.alertReasons).toEqual([]);
  });

  it('refuses to judge against a baseline of one or two days', () => {
    // Two days of history is not "normal for this store". A store that is only
    // busy at weekends would otherwise alert every Tuesday.
    const sparse = [at(36, 10, 10, { id: 'b1' }), at(60, 10, 10, { id: 'b2' })];
    const [heb] = aggregateFunnel([...sparse, ...today(0)], [], { now: NOW });
    expect(heb.itemSuccess.baselineWindows).toBe(2);
    expect(heb.itemSuccess.median).toBeNull();
    expect(heb.itemSuccess.drop).toBeNull();
    expect(heb.alertReasons).toEqual([]);
  });

  it('drops a quiet baseline day rather than scoring it zero', () => {
    // No data is not zero, here as everywhere else on this page. Three busy days
    // and four with no traffic gives a median of the three, not a median dragged
    // to 0 by four phantom outages.
    const partial = [1, 3, 5].flatMap((day) => [
      at(day * 24 + 12, 10, 10, { id: `b-${day}` }),
      at(day * 24 + 13, 10, 10, { id: `b2-${day}` }),
    ]);
    const [heb] = aggregateFunnel([...partial, ...today(0.5)], [], { now: NOW });
    expect(heb.itemSuccess.baselineWindows).toBe(3);
    expect(heb.itemSuccess.median).toBe(1);
    expect(heb.alertReasons).toEqual(['success_drop']);
  });

  it('ignores runs with no readable start time entirely', () => {
    // They still count in the store's totals — they just cannot be placed on a
    // timeline, and defaulting them into the current window would let a backfill
    // read as this morning's outage.
    const orphan: RunRow = { store_id: 'heb', outcome: 'failed', status: 'completed', items_requested: 500, items_added: 0 };
    const [heb] = aggregateFunnel([...baseline(1), ...today(1), orphan], [], { now: NOW });
    expect(heb.itemsRequested).toBe(750);
    expect(heb.itemSuccess.recent).toBe(1);
    expect(heb.alertReasons).toEqual([]);
  });

  it('reports the drop but stays quiet when the store recovers', () => {
    const broken = aggregateFunnel([...baseline(1), ...today(0.4)], [], { now: NOW })[0];
    expect(broken.alertReasons).toEqual(['success_drop']);
    // The same store a day later, back to normal. The baseline now contains the
    // bad day, and the median shrugs it off — which is what lets a fixed store
    // stop alerting immediately instead of a week later.
    const fixed = aggregateFunnel(
      [...baseline(1), ...today(0.4).map((r) => ({ ...r, started_at: new Date(Date.parse(r.started_at!) - 24 * HOUR).toISOString() })), ...today(1)],
      [],
      { now: NOW },
    )[0];
    expect(fixed.alertReasons).toEqual([]);
  });

  it('names the drop alongside a wall when a store is doing both', () => {
    const walled = Array.from({ length: 4 }, (_, i) => at(6, 10, 5, { id: `walled-${i}` }));
    const blockedSteps: StepRow[] = walled.map((r) => ({
      store_id: 'heb', run_id: r.id!, step: 'add_click', outcome: 'blocked',
      duration_ms: null, detail: null, occurred_at: r.started_at,
    }));
    const [heb] = aggregateFunnel([...baseline(1), ...walled], blockedSteps, { now: NOW });
    expect(heb.alertReasons).toEqual(['success_drop', 'blocked']);
  });

  it('carries the item rate onto the daily series too', () => {
    const [heb] = aggregateFunnel([...baseline(0.8), ...today(0.5)], [], { now: NOW, days: 9 });
    const day = heb.daily.find((d) => d.day === '2026-03-08')!;
    expect(day.itemsRequested).toBe(40);
    expect(day.itemsAdded).toBe(20);
    expect(day.itemSuccessRate).toBe(0.5);
    // A dense bucket nobody shopped in reports null, not a 0% outage.
    const quiet = heb.daily.find((d) => d.itemsRequested === 0);
    expect(quiet?.itemSuccessRate ?? null).toBeNull();
  });

  // ── MEAL-29 ────────────────────────────────────────────────────────────────
  // An item the store does not have is not our automation failing, and until now
  // it was counted as one: it is in items_requested and not in items_added, so it
  // dragged the rate down whatever its step row said. That was cosmetic while the
  // rate only drew a chart. It stops being cosmetic here, on this branch, because
  // this is where that rate starts emailing every admin.
  describe('out-of-stock items leave the denominator', () => {
    /** `count` items this run asked for and the store did not have. */
    const oosSteps = (
      runId: string,
      count: number,
      over: { path?: string; startIndex?: number; occurredAt?: string } = {},
    ): StepRow[] =>
      Array.from({ length: count }, (_, i) => ({
        store_id: 'heb',
        run_id: runId,
        step: 'confirm',
        outcome: 'error',
        code: 'out_of_stock',
        duration_ms: null,
        item_index: (over.startIndex ?? 0) + i,
        detail: { path: over.path ?? 'parallel_add' },
        occurred_at: over.occurredAt ?? new Date(NOW - 6 * HOUR).toISOString(),
      }));

    it('counts distinct items, not rows', () => {
      // The same item reported twice — once in the parallel pass, once when the
      // top-up looked at it again. One item, and a row count would say two.
      const dupes = [
        ...oosSteps('r1', 1),
        ...oosSteps('r1', 1),
      ];
      expect(unavailableItemsByRun(dupes).get('r1')).toBe(1);
    });

    it('keeps the same index in different passes apart', () => {
      // The reconcile re-points the active-items array at its retry subset and
      // restarts the index, so index 0 of the top-up is a DIFFERENT item from
      // index 0 of the first pass. Keying on item_index alone merges them and
      // under-counts; the path is what separates them.
      const twoPasses = [
        ...oosSteps('r1', 1, { path: 'parallel_add' }),
        ...oosSteps('r1', 1, { path: 'fused' }),
      ];
      expect(unavailableItemsByRun(twoPasses).get('r1')).toBe(2);
    });

    it('ignores the run-level row that carries the same code', () => {
      // `out_of_stock` is ranked mid-table in the app's severity list, so a run
      // whose worst outcome is an empty shelf writes the code onto its
      // run_summary row too — with no item_index, because it is about the run and
      // not about an item. Counting it would invent an item nobody asked for.
      const withSummary: StepRow[] = [
        ...oosSteps('r1', 2),
        {
          store_id: 'heb', run_id: 'r1', step: 'run_summary', outcome: 'error',
          code: 'out_of_stock', duration_ms: null, item_index: null, detail: null,
        },
      ];
      expect(unavailableItemsByRun(withSummary).get('r1')).toBe(2);
    });

    it('ignores other codes and rows it cannot attribute to a run', () => {
      const noise: StepRow[] = [
        ...oosSteps('r1', 1),
        { store_id: 'heb', run_id: 'r1', step: 'confirm', outcome: 'error', code: 'match_rejected', duration_ms: null, item_index: 7, detail: null },
        { store_id: 'heb', run_id: null, step: 'confirm', outcome: 'error', code: 'out_of_stock', duration_ms: null, item_index: 8, detail: null },
      ];
      const counts = unavailableItemsByRun(noise);
      expect(counts.get('r1')).toBe(1);
      expect(counts.size).toBe(1);
    });

    it('takes them out of the store total and reports what it took out', () => {
      // 4 runs × 10 items, 5 added each. Half the shortfall was the store's shelf.
      const runs = today(0.5);
      const steps = runs.flatMap((r) => oosSteps(r.id!, 5));
      const [heb] = aggregateFunnel([...baseline(1), ...runs], steps, { now: NOW });

      // Raw counts are untouched — the adjustment is visible, not baked in.
      // 21 baseline runs of 10 plus today's 4, all added except today's shortfall.
      expect(heb.itemsRequested).toBe(250);
      expect(heb.itemsAdded).toBe(230);
      expect(heb.itemsUnavailable).toBe(20);
      // Every item either store could supply, we added. The window-wide rate says
      // so; before this it said 92%, and the missing 8% was somebody's shelf.
      expect(heb.itemSuccessRate).toBe(1);
      // Of the 20 items today's runs could have supplied, all 20 arrived.
      expect(heb.itemSuccess.recent).toBe(1);
      expect(heb.itemSuccess.recentItemsRequested).toBe(40);
      expect(heb.itemSuccess.recentItemsUnavailable).toBe(20);
      expect(heb.itemSuccess.recentItemsJudged).toBe(20);
    });

    it('does not page anyone about a store that simply ran out of things', () => {
      // The scenario the ticket was filed about. Without the subtraction this is
      // a 50% day against a 100% median — a 50-point drop, five times over the
      // threshold, an email to every admin — and nothing is wrong with our code.
      const runs = today(0.5);
      const steps = runs.flatMap((r) => oosSteps(r.id!, 5));

      const unadjusted = aggregateFunnel([...baseline(1), ...runs], [], { now: NOW })[0];
      expect(unadjusted.alertReasons).toContain('success_drop');

      const [heb] = aggregateFunnel([...baseline(1), ...runs], steps, { now: NOW });
      expect(heb.itemSuccess.drop).toBe(0);
      expect(heb.alertReasons).toEqual([]);
    });

    it('still pages when the store is out of stock AND we are broken', () => {
      // The other half of the same claim, and the one that matters more: this
      // must not become a way for a real regression to hide behind an inventory
      // problem. 10 items a run, 3 off the shelf, and of the 7 we could have got
      // we got 3 — 43% against a 100% median, still far past the threshold.
      const runs = Array.from({ length: 4 }, (_, i) => at(6, 10, 3, { id: `mixed-${i}` }));
      const steps = runs.flatMap((r) => oosSteps(r.id!, 3));
      const [heb] = aggregateFunnel([...baseline(1), ...runs], steps, { now: NOW });

      expect(heb.itemSuccess.recent).toBeCloseTo(3 / 7);
      expect(heb.alertReasons).toContain('success_drop');
    });

    it('clamps to the items the run did not add, so a rate can never exceed 100%', () => {
      // More out-of-stock rows than there were misses. Nothing should produce
      // this — but a duplicate the key above does not catch, or step rows from a
      // run the run-row query did not return, would, and the failure mode is a
      // denominator smaller than the numerator: a store reporting 250% success,
      // or a negative denominator reading as "no data" for a store that is fine.
      const runs = today(0.5);
      const steps = runs.flatMap((r) => oosSteps(r.id!, 9));
      const [heb] = aggregateFunnel([...baseline(1), ...runs], steps, { now: NOW });

      expect(heb.itemsUnavailable).toBe(20);
      expect(heb.itemSuccess.recent).toBe(1);
      expect(heb.itemSuccessRate).toBeLessThanOrEqual(1);
    });

    it('reports no rate at all when the store had none of what was asked for', () => {
      // Denominator zero. Null, not 0% and not 100% — the same rule as every
      // other rate on this page. We learned nothing about our automation here.
      const runs = Array.from({ length: 4 }, (_, i) => at(6, 10, 0, { id: `empty-${i}` }));
      const steps = runs.flatMap((r) => oosSteps(r.id!, 10));
      const [heb] = aggregateFunnel([...baseline(1), ...runs], steps, { now: NOW });

      expect(heb.itemSuccess.recent).toBeNull();
      expect(heb.itemSuccess.drop).toBeNull();
      expect(heb.alertReasons).toEqual([]);
    });

    it('judges the alert sample on items judged, not items asked for', () => {
      // 25 items requested clears the 20-item sample bar; 5 items judged does
      // not. A rate over five items is noise, and reading the raw request count
      // here would let the store with an inventory problem — precisely the store
      // whose two numbers differ most — be the one that pages someone on it.
      const runs = Array.from({ length: 5 }, (_, i) => at(6, 5, 1, { id: `thin-${i}` }));
      const steps = runs.flatMap((r) => oosSteps(r.id!, 4));
      const [heb] = aggregateFunnel([...baseline(1), ...runs], steps, { now: NOW });

      expect(heb.itemSuccess.recentItemsRequested).toBe(25);
      expect(heb.itemSuccess.recentItemsJudged).toBe(5);
      expect(heb.itemSuccess.recent).toBe(1);
      expect(heb.alertReasons).toEqual([]);

      // And with the same five-item sample sitting at 20%, still nothing: the
      // gate is what is holding it, not the rate happening to be good.
      const bad = Array.from({ length: 5 }, (_, i) => at(6, 5, 0, { id: `thinbad-${i}` }));
      const badSteps = bad.flatMap((r) => oosSteps(r.id!, 4));
      const [hebBad] = aggregateFunnel([...baseline(1), ...bad], badSteps, { now: NOW });
      expect(hebBad.itemSuccess.recentItemsJudged).toBe(5);
      expect(hebBad.itemSuccess.recent).toBe(0);
      expect(hebBad.alertReasons).toEqual([]);
    });

    it('subtracts on the run\'s day, not the step row\'s', () => {
      const runs = today(0.5);
      const steps = runs.flatMap((r) => oosSteps(r.id!, 5));
      const [heb] = aggregateFunnel([...baseline(1), ...runs], steps, { now: NOW, days: 9 });

      const day = heb.daily.find((d) => d.day === '2026-03-08')!;
      expect(day.itemsRequested).toBe(40);
      expect(day.itemsAdded).toBe(20);
      expect(day.itemsUnavailable).toBe(20);
      expect(day.itemSuccessRate).toBe(1);
    });

    it('leaves every store that reports no out-of-stock rows exactly as it was', () => {
      // Kroger is the case: it runs server-side through the Kroger API, which has
      // no out-of-stock signal to give us, so it emits none of these rows. The
      // subtraction has to be a no-op for it rather than a source of zeroes, which
      // is also what option A would have written into its column.
      const runs = today(0.5).map((r) => ({ ...r, store_id: 'kroger' }));
      const base = baseline(1).map((r) => ({ ...r, store_id: 'kroger' }));
      const [kroger] = aggregateFunnel([...base, ...runs], [], { now: NOW });

      expect(kroger.itemsUnavailable).toBe(0);
      expect(kroger.itemSuccess.recent).toBe(0.5);
      expect(kroger.alertReasons).toContain('success_drop');
    });
  });
});
