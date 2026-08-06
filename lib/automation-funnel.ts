// Pure aggregation for the per-store add-to-cart telemetry funnel.
//
// Kept free of NextRequest/Supabase so it is unit-testable: the admin route does
// nothing but fetch rows and hand them here. The interesting logic — which steps
// count as a denominator, how a "first-click confirm" is distinguished from a
// retry, what counts as a WAF block rather than drift, when a store is alerting —
// is exactly the logic worth having tests for.
//
// Three things this file is deliberately careful about, because getting any of
// them wrong produces a dashboard that looks authoritative and is not:
//
//   1. BLOCKS ARE NOT FAILURES. A WAF wall and a renamed button are different
//      problems with different fixes, and averaging them into one "failure rate"
//      loses the only bit that tells you which one you have. Blocked rows are
//      pulled out of every failure denominator and counted on their own.
//   2. NO DATA IS NOT ZERO. Every rate is null when its denominator is empty.
//      Reporting 0% for a store nobody used pages someone for nothing.
//   3. A PERCENTAGE IS A SHARE OF ONE THING. Blocks are reported as RUNS walled
//      off over runs, never as blocked step rows over runs: a walled-off run
//      emits a blocked row per item it tried, so the mixed-unit version was
//      unbounded and the tile rendered "WAF blocked 500.0%".
//   4. AN UNINSTRUMENTED STORE IS NOT A HEALTHY ONE. The parallel and pre-search
//      add pools emit no per-item step rows at all (MEAL-122), so those stores'
//      funnels are `login_check → (nothing) → reconcile → run_summary`. That
//      reads as a flawless funnel unless it is called out, which is what
//      `coverage.partialInstrumentation` is for.

export type StepName =
  | 'login_check' | 'search' | 'candidates' | 'add_click'
  | 'confirm' | 'reconcile' | 'blocked' | 'run_summary';

export type StepOutcome = 'ok' | 'empty' | 'timeout' | 'error' | 'blocked' | 'skipped';

/**
 * MEAL-4's failure taxonomy, as the app emits it. Listed for documentation and
 * for ordering the dashboard's breakdown — NOT as a filter. An unrecognized code
 * from a newer client is counted under its own name rather than discarded.
 */
export const FAILURE_CODES = [
  'selector_miss', 'waf_block', 'auth_required', 'no_candidates',
  'match_rejected', 'confirm_failed', 'timeout', 'nav_failed',
] as const;

/**
 * The bucket a failure with no `code` lands in.
 *
 * Not a defect and not rare: every row written before the app shipped the
 * taxonomy has a null code, and no backfill is possible (steps upsert with
 * ignoreDuplicates, so old rows never gain one). Naming the bucket is how the
 * dashboard says "we don't know" instead of quietly reporting zero of everything.
 */
export const UNCODED = 'uncoded';

/** The WAF/robot-wall code. Held apart from every drift-shaped failure. */
const BLOCK_CODE = 'waf_block';

/** Step rows as stored (snake_case straight from Supabase). */
export interface StepRow {
  store_id: string;
  /**
   * The run this step belongs to. Optional on the type only because a caller may
   * not have selected it; when it is absent a blocked row can't be attributed to
   * a run and is counted as a run of its own (see `blocked.runs`).
   */
  run_id?: string | null;
  step: string;
  outcome: string;
  duration_ms: number | null;
  /** Client-supplied structured payload; `attempt` distinguishes retries. */
  detail: Record<string, unknown> | null;
  /**
   * MEAL-4 failure taxonomy. Optional on the type because it is null for every
   * ok/skipped row and for everything recorded before the column existed.
   */
  code?: string | null;
  /** Optional: rows without it are counted in totals but not in the daily trend. */
  occurred_at?: string | null;
}

export interface RunRow {
  /** Run uuid. Used to count DISTINCT runs behind a WAF wall. */
  id?: string | null;
  store_id: string;
  outcome: string | null;
  status: string;
  items_requested: number | null;
  items_added: number | null;
  /** Optional for the same reason as StepRow.occurred_at. */
  started_at?: string | null;
}

export interface StepStats {
  step: string;
  /** Every row for this step, blocks included. The unfiltered truth. */
  total: number;
  /** Count per outcome; keys absent when zero. */
  outcomes: Record<string, number>;
  /** Rows that hit a WAF/robot wall. Excluded from `attempted` and `okRate`. */
  blocked: number;
  /** total - blocked: the rows where the automation actually got to try. */
  attempted: number;
  /** ok / attempted, or null when attempted is 0 (never report 0% for no data). */
  okRate: number | null;
  /** Not ok, not skipped, not blocked — the drift-shaped failures. */
  failures: number;
  /** Failure counts by MEAL-4 code; null codes bucketed under UNCODED. */
  codes: Record<string, number>;
  p50DurationMs: number | null;
  p95DurationMs: number | null;
}

/** One UTC day of a store's history, for the trend line. */
export interface DayPoint {
  /** YYYY-MM-DD, UTC. */
  day: string;
  runs: number;
  runsSucceeded: number;
  /** runsSucceeded / runs, null on a day with no runs. */
  terminalSuccessRate: number | null;
  blocked: number;
  failures: number;
}

/** One side of the week-over-week comparison. */
export interface WindowSummary {
  runs: number;
  runsSucceeded: number;
  terminalSuccessRate: number | null;
  blocked: number;
  failures: number;
}

export interface WeekOverWeek {
  current: WindowSummary;
  previous: WindowSummary;
  /** current - previous, null unless BOTH sides have a denominator. */
  terminalSuccessRateDelta: number | null;
  runsDelta: number;
}

/**
 * What the funnel can and cannot see for this store.
 *
 * `partialInstrumentation` is the MEAL-122 case: the parallel and pre-search add
 * pools report nothing per item, so the store has terminal rows and no middle.
 * A funnel that renders clean because there is nothing to render is the single
 * most dangerous number on this page.
 */
export interface FunnelCoverage {
  /** Canonical per-item steps that produced no rows at all in the window. */
  missingSteps: string[];
  partialInstrumentation: boolean;
  /** Failures with no code — pre-taxonomy rows, not zero failures. */
  uncodedFailures: number;
}

export interface StoreFunnel {
  storeId: string;
  runs: number;
  /** Runs whose own outcome was a full success. */
  runsSucceeded: number;
  /** Runs never completed — the app was killed or the engine wedged. */
  runsAbandoned: number;
  itemsRequested: number;
  itemsAdded: number;
  steps: StepStats[];
  /** confirm:ok / add_click attempts — the headline reliability number. */
  confirmRate: number | null;
  /** Share of confirms that landed WITHOUT a retry (detail.attempt <= 1). */
  firstClickConfirmRate: number | null;
  /** runsSucceeded / runs. Taken from RUN rows, which every store writes. */
  terminalSuccessRate: number | null;
  /**
   * WAF/robot walls, kept out of every failure rate above.
   *
   * `steps` is a count of step ROWS and `runs` a count of distinct RUNS that hit
   * a wall; `rate` is runs over runs, never steps over runs. One walled-off run
   * emits a blocked row per item it tried, so steps/runs is not a proportion of
   * anything — it read 450% on a heavily blocked store.
   */
  blocked: { steps: number; runs: number; rate: number | null };
  /** Drift-shaped failure codes across the whole store, blocks excluded. */
  failureCodes: Record<string, number>;
  /**
   * Codes on the terminal run_summary row. Reported separately and never used as
   * the headline: run_summary carries the MOST FREQUENT code in the run, not the
   * most severe (MEAL-123), so three confirm_failed and one waf_block reports
   * confirm_failed and hides the actionable cause.
   */
  runSummaryCodes: Record<string, number>;
  /**
   * Share of this store's RUNS that hit a WAF/robot wall — the same value as
   * `blocked.rate`, kept as a top-level field because it is a headline tile.
   *
   * Runs over runs, so it is a genuine percentage in [0, 1]. It used to be
   * blocked STEPS over runs, which is a ratio of two different things: two runs
   * of five walled-off items each reported 500%.
   */
  blockedRate: number | null;
  coverage: FunnelCoverage;
  daily: DayPoint[];
  /** Null when the window is shorter than 14 days — nothing to compare against. */
  weekOverWeek: WeekOverWeek | null;
  /** True when `alertReasons` is non-empty. */
  alerting: boolean;
  /**
   * Why this store is alerting, so the page can name the reason instead of
   * asserting the confirm rate is at fault. Two independent conditions, because
   * they fail independently: a store can be walled off at 90% and still report a
   * perfect confirm rate, since blocked clicks leave the confirm denominator.
   * Keying the alert off confirmRate alone let exactly that store sit unflagged.
   */
  alertReasons: AlertReason[];
}

/** The reasons a store can be alerting. Ordered worst-first for display. */
export type AlertReason = 'confirm_rate' | 'blocked';

export interface AggregateOptions {
  /** Alert when confirmRate drops below this. Default 0.9. */
  confirmRateThreshold?: number;
  /** Don't alert on a sample this small — noise, not signal. Default 20. */
  minSampleForAlert?: number;
  /**
   * Alert when this share of a store's runs is walled off. Default 0.2.
   *
   * At-or-above, unlike the confirm-rate side: a fifth of a store's traffic
   * hitting a robot wall is a campaign, not jitter, and there is no reading of it
   * that improves by waiting for the next percent.
   */
  blockedRateThreshold?: number;
  /**
   * Runs needed before the blocked alert can fire. Default 5 — deliberately
   * lower than `minSampleForAlert`, because the two samples aren't comparable. A
   * wall is store-wide and correlated: five runs in a row all stopped is a wall,
   * whereas five add clicks is one shopper's basket.
   */
  minRunsForBlockedAlert?: number;
  /** End of the window, ms since epoch. Default Date.now(). */
  now?: number;
  /** Window length in days; produces a DENSE daily series of this many buckets. */
  days?: number;
}

// The order the funnel is displayed in: the real sequence a run walks through.
const STEP_ORDER: StepName[] = [
  'login_check', 'search', 'candidates', 'add_click',
  'confirm', 'reconcile', 'blocked', 'run_summary',
];

/**
 * The steps a run emits once per ITEM. Their total absence, alongside runs that
 * completed, is the parallel-add blind spot rather than a healthy funnel.
 */
const ITEM_STEPS: StepName[] = ['search', 'candidates', 'add_click', 'confirm'];

const DAY_MS = 24 * 60 * 60 * 1000;

export function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0];
  // Nearest-rank on a 0-indexed array. Exact interpolation buys nothing for a
  // latency dashboard and makes the expected values harder to reason about.
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(Math.max(rank, 0), sorted.length - 1)];
}

function rate(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return numerator / denominator;
}

/** UTC calendar day of a timestamp, or null when it is absent/unparseable. */
export function dayKey(ts: string | null | undefined): string | null {
  if (!ts) return null;
  const t = Date.parse(ts);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * A WAF/robot wall, by any of the three ways the app can say so: the dedicated
 * `blocked` step, a `blocked` outcome on any step, or MEAL-4's `waf_block` code.
 *
 * Any one of them is enough. A client that reports only the code (because the
 * step it died on was `search`, not `blocked`) must not have its block quietly
 * counted as search drift.
 */
export function isBlockedRow(s: StepRow): boolean {
  return s.step === 'blocked' || s.outcome === 'blocked' || s.code === BLOCK_CODE;
}

/** Drift-shaped failure: it went wrong, and a WAF is not why. */
function isFailureRow(s: StepRow): boolean {
  if (isBlockedRow(s)) return false;
  return s.outcome !== 'ok' && s.outcome !== 'skipped';
}

function bumpCode(into: Record<string, number>, s: StepRow): void {
  const key = s.code && s.code.length > 0 ? s.code : UNCODED;
  into[key] = (into[key] ?? 0) + 1;
}

/** The window's calendar days, oldest first, including days with no rows. */
function denseDays(now: number, days: number): string[] {
  const out: string[] = [];
  for (let i = days - 1; i >= 0; i--) out.push(new Date(now - i * DAY_MS).toISOString().slice(0, 10));
  return out;
}

function summarize(runs: RunRow[], steps: StepRow[]): WindowSummary {
  const runsSucceeded = runs.filter((r) => r.outcome === 'success').length;
  return {
    runs: runs.length,
    runsSucceeded,
    terminalSuccessRate: rate(runsSucceeded, runs.length),
    blocked: steps.filter(isBlockedRow).length,
    failures: steps.filter(isFailureRow).length,
  };
}

export function aggregateFunnel(
  runs: RunRow[],
  steps: StepRow[],
  options: AggregateOptions = {},
): StoreFunnel[] {
  const threshold = options.confirmRateThreshold ?? 0.9;
  const minSample = options.minSampleForAlert ?? 20;
  const blockedThreshold = options.blockedRateThreshold ?? 0.2;
  const minRunsForBlocked = options.minRunsForBlockedAlert ?? 5;
  const now = options.now ?? Date.now();
  const days = options.days;

  // Every store that appears in EITHER table gets a row. A store with runs but no
  // steps (older app build that predates step reporting, or one of the four
  // parallel-add stores that never reports per-item steps) must still show up,
  // and so must steps whose run row was pruned.
  const storeIds = new Set<string>();
  for (const r of runs) if (r.store_id) storeIds.add(r.store_id);
  for (const s of steps) if (s.store_id) storeIds.add(s.store_id);

  const result: StoreFunnel[] = [];

  for (const storeId of storeIds) {
    const storeRuns = runs.filter((r) => r.store_id === storeId);
    const storeSteps = steps.filter((s) => s.store_id === storeId);

    // ── Per-step rollup ────────────────────────────────────────────────────
    interface Bucket {
      outcomes: Record<string, number>;
      durations: number[];
      blocked: number;
      failures: number;
      codes: Record<string, number>;
    }
    const byStep = new Map<string, Bucket>();
    for (const s of storeSteps) {
      let bucket = byStep.get(s.step);
      if (!bucket) {
        bucket = { outcomes: {}, durations: [], blocked: 0, failures: 0, codes: {} };
        byStep.set(s.step, bucket);
      }
      bucket.outcomes[s.outcome] = (bucket.outcomes[s.outcome] ?? 0) + 1;
      if (isBlockedRow(s)) bucket.blocked += 1;
      else if (isFailureRow(s)) { bucket.failures += 1; bumpCode(bucket.codes, s); }
      if (typeof s.duration_ms === 'number' && Number.isFinite(s.duration_ms) && s.duration_ms >= 0) {
        bucket.durations.push(s.duration_ms);
      }
    }

    const stepStats: StepStats[] = [];
    // Known steps in funnel order first, then anything unrecognized (a newer
    // client emitting a step this deploy doesn't know about) appended, so new
    // telemetry is visible rather than silently dropped from the dashboard.
    const seen = new Set<string>();
    const ordered = [
      ...STEP_ORDER.filter((s) => byStep.has(s)),
      ...[...byStep.keys()].filter((s) => !(STEP_ORDER as string[]).includes(s)).sort(),
    ];
    for (const step of ordered) {
      if (seen.has(step)) continue;
      seen.add(step);
      const bucket = byStep.get(step)!;
      const total = Object.values(bucket.outcomes).reduce((a, b) => a + b, 0);
      // Blocks come out of the denominator: a store behind a WAF wall would
      // otherwise show every step drifting, which sends someone to rewrite
      // selectors that are perfectly fine.
      const attempted = total - bucket.blocked;
      const sortedDurations = [...bucket.durations].sort((a, b) => a - b);
      stepStats.push({
        step,
        total,
        outcomes: bucket.outcomes,
        blocked: bucket.blocked,
        attempted,
        okRate: rate(bucket.outcomes.ok ?? 0, attempted),
        failures: bucket.failures,
        codes: bucket.codes,
        p50DurationMs: percentile(sortedDurations, 50),
        p95DurationMs: percentile(sortedDurations, 95),
      });
    }

    // ── Headline rates ─────────────────────────────────────────────────────
    // Denominator is add_click ATTEMPTS, not confirm rows: a click that produced
    // no confirm signal at all is precisely the failure we're hunting, and it
    // would vanish if we divided by confirms.
    // Blocked clicks are excluded here too: a run the WAF stopped never got to
    // attempt a confirm, and counting it as a missed confirm turns a block into
    // fake selector drift.
    const addClicks = byStep.get('add_click');
    const addClickTotal = addClicks
      ? Object.values(addClicks.outcomes).reduce((a, b) => a + b, 0) - addClicks.blocked
      : 0;

    const confirms = byStep.get('confirm');
    const confirmOk = confirms?.outcomes.ok ?? 0;

    const firstClickOk = storeSteps.filter((s) => {
      if (s.step !== 'confirm' || s.outcome !== 'ok') return false;
      const attempt = s.detail?.attempt;
      // Absent attempt means the client didn't report retries; treat as first try.
      return attempt == null || (typeof attempt === 'number' && attempt <= 1);
    }).length;

    const runsSucceeded = storeRuns.filter((r) => r.outcome === 'success').length;
    const runsAbandoned = storeRuns.filter((r) => r.status === 'started').length;

    // ── Blocks, in run units ───────────────────────────────────────────────
    // The operator question is "how much of this store's traffic is being walled
    // off", so the answer has to be a share of TRAFFIC. A single walled-off run
    // emits one blocked row per item it tried, so blocked steps over runs is not
    // a share of anything: five items in each of two runs reported 500%.
    //
    // The denominator is the union of the runs we fetched and the runs that step
    // rows point at, because a run that started just before the window still
    // writes steps inside it and so was never fetched. Union means the numerator
    // is always a subset of the denominator, which is what makes this a
    // percentage that cannot exceed 100 however the two windows disagree.
    const observedRuns = new Set<string>();
    storeRuns.forEach((r, i) => observedRuns.add(r.id ?? `run-row:${i}`));
    const blockedRunIds = new Set<string>();
    storeSteps.forEach((s, i) => {
      // No run_id (a caller that didn't select it): count the row as a run of its
      // own rather than collapsing every unattributed block into one run or
      // dropping it. Over-counting one wall as one run is the safe direction.
      const key = s.run_id ?? `step-row:${i}`;
      if (isBlockedRow(s)) {
        blockedRunIds.add(key);
        observedRuns.add(key);
      } else if (s.run_id) {
        observedRuns.add(s.run_id);
      }
    });
    const blockedSteps = storeSteps.filter(isBlockedRow).length;
    const blockedRuns = blockedRunIds.size;
    const blockedRate = rate(blockedRuns, observedRuns.size);

    const confirmRate = rate(confirmOk, addClickTotal);

    // ── Failure taxonomy, store-wide ───────────────────────────────────────
    const failureCodes: Record<string, number> = {};
    for (const s of storeSteps) if (isFailureRow(s)) bumpCode(failureCodes, s);

    const runSummaryCodes: Record<string, number> = {};
    for (const s of storeSteps) {
      if (s.step === 'run_summary' && s.outcome !== 'ok' && s.code) {
        runSummaryCodes[s.code] = (runSummaryCodes[s.code] ?? 0) + 1;
      }
    }

    // ── Coverage: what this funnel structurally cannot see ─────────────────
    const missingSteps = ITEM_STEPS.filter((s) => !byStep.has(s));
    const coverage: FunnelCoverage = {
      missingSteps,
      // Every per-item step absent while the store still produced activity is
      // the parallel-add pool reporting nothing (MEAL-122) — not a clean run.
      partialInstrumentation:
        missingSteps.length === ITEM_STEPS.length && (storeRuns.length > 0 || storeSteps.length > 0),
      uncodedFailures: failureCodes[UNCODED] ?? 0,
    };

    // ── Daily trend ────────────────────────────────────────────────────────
    const dayBuckets = new Map<string, DayPoint>();
    const touch = (day: string): DayPoint => {
      let d = dayBuckets.get(day);
      if (!d) {
        d = { day, runs: 0, runsSucceeded: 0, terminalSuccessRate: null, blocked: 0, failures: 0 };
        dayBuckets.set(day, d);
      }
      return d;
    };
    // The dense series is CALENDAR days; the fetch window is a rolling instant
    // (`now - days*24h`), so the query legitimately returns rows from the calendar
    // day BEFORE the first dense one — as little as a minute of it near midnight
    // UTC. Bucketing those made an extra day that the chart drew full width and
    // took its left-edge date label from, so one unlucky run in that sliver
    // plotted a 0% endpoint for a day that is 99% unfetched. Rows outside the
    // dense range stay in the store's totals (they are inside the fetched window,
    // and week-over-week is instant-based and still counts them) and are kept out
    // of the trend, exactly as rows with no timestamp at all are.
    const dense = days && days > 0 ? denseDays(now, days) : null;
    const first = dense?.[0];
    const lastDay = dense?.[dense.length - 1];
    const inDenseRange = (day: string) =>
      !first || !lastDay || (day >= first && day <= lastDay);

    if (dense) for (const day of dense) touch(day);
    for (const r of storeRuns) {
      const day = dayKey(r.started_at);
      if (!day || !inDenseRange(day)) continue;
      const d = touch(day);
      d.runs += 1;
      if (r.outcome === 'success') d.runsSucceeded += 1;
    }
    for (const s of storeSteps) {
      const day = dayKey(s.occurred_at);
      if (!day || !inDenseRange(day)) continue;
      const d = touch(day);
      if (isBlockedRow(s)) d.blocked += 1;
      else if (isFailureRow(s)) d.failures += 1;
    }
    const daily = [...dayBuckets.values()].sort((a, b) => a.day.localeCompare(b.day));
    for (const d of daily) d.terminalSuccessRate = rate(d.runsSucceeded, d.runs);

    // ── Week over week ─────────────────────────────────────────────────────
    // Only when the fetched window genuinely covers both weeks. Comparing seven
    // days against a partially-fetched prior week manufactures a regression.
    let weekOverWeek: WeekOverWeek | null = null;
    if (days != null && days >= 14) {
      const currentFrom = now - 7 * DAY_MS;
      const previousFrom = now - 14 * DAY_MS;
      const runAt = (r: RunRow) => (r.started_at ? Date.parse(r.started_at) : NaN);
      const stepAt = (s: StepRow) => (s.occurred_at ? Date.parse(s.occurred_at) : NaN);
      const inWindow = (t: number, from: number, to: number) => Number.isFinite(t) && t >= from && t < to;

      const current = summarize(
        storeRuns.filter((r) => inWindow(runAt(r), currentFrom, Infinity)),
        storeSteps.filter((s) => inWindow(stepAt(s), currentFrom, Infinity)),
      );
      const previous = summarize(
        storeRuns.filter((r) => inWindow(runAt(r), previousFrom, currentFrom)),
        storeSteps.filter((s) => inWindow(stepAt(s), previousFrom, currentFrom)),
      );
      weekOverWeek = {
        current,
        previous,
        terminalSuccessRateDelta:
          current.terminalSuccessRate != null && previous.terminalSuccessRate != null
            ? current.terminalSuccessRate - previous.terminalSuccessRate
            : null,
        runsDelta: current.runs - previous.runs,
      };
    }

    // ── Alerting ───────────────────────────────────────────────────────────
    // Two independent conditions. The confirm-rate one cannot see a wall at all:
    // blocked clicks are removed from its denominator on purpose, so a store with
    // 90% of its runs stopped by a WAF reports a 100% confirm rate on the handful
    // that got through and used to raise nothing. The counterweight held —
    // terminalSuccessRate comes from run rows and is not blocked-adjusted, so the
    // store read 100% confirm against 10% terminal and an operator could see the
    // contradiction — but a contradiction someone has to notice is not an alert.
    const alertReasons: AlertReason[] = [];
    if (confirmRate != null && addClickTotal >= minSample && confirmRate < threshold) {
      alertReasons.push('confirm_rate');
    }
    if (blockedRate != null && observedRuns.size >= minRunsForBlocked && blockedRate >= blockedThreshold) {
      alertReasons.push('blocked');
    }

    result.push({
      storeId,
      runs: storeRuns.length,
      runsSucceeded,
      runsAbandoned,
      itemsRequested: storeRuns.reduce((a, r) => a + (r.items_requested ?? 0), 0),
      itemsAdded: storeRuns.reduce((a, r) => a + (r.items_added ?? 0), 0),
      steps: stepStats,
      confirmRate,
      firstClickConfirmRate: rate(firstClickOk, addClickTotal),
      terminalSuccessRate: rate(runsSucceeded, storeRuns.length),
      blocked: { steps: blockedSteps, runs: blockedRuns, rate: blockedRate },
      failureCodes,
      runSummaryCodes,
      blockedRate,
      coverage,
      daily,
      weekOverWeek,
      alerting: alertReasons.length > 0,
      alertReasons,
    });
  }

  // Busiest store first — that's where a regression costs the most.
  return result.sort((a, b) => b.runs - a.runs || a.storeId.localeCompare(b.storeId));
}

// ── "Dying on": which step to point at, and when to point at nothing ─────────

/**
 * Upper end of the Wilson score interval for `ok / n`.
 *
 * Used instead of the raw ok rate so the dashboard only names a step it has
 * enough evidence against. The plain minimum is unusable for ranking: 4 ok out of
 * 5 is an 80% rate and means nothing, yet it outranks 200 attempts at 99.5%, and
 * a 5-sample 89% outranks a 5000-sample 89.5% for no reason but noise. Ranking by
 * this bound folds sample size into the comparison — a small sample's bound stays
 * high, so it cannot win — and gives a threshold test that reads as a claim:
 * "even the optimistic reading of this step is below the bar."
 *
 * Note this is the bound on the OK rate, so a wide interval (a small sample)
 * makes a step look BETTER here. That is the correct direction: an uncertain step
 * is one we have no business naming as the cause.
 */
export function okRateUpperBound(ok: number, n: number, z = 1.96): number {
  if (n <= 0) return 1;
  const p = ok / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z / denom) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return Math.min(1, center + half);
}

/** The subset of StepStats the "dying on" verdict needs. */
export interface WorstStepInput {
  step: string;
  attempted: number;
  okRate: number | null;
  outcomes: Record<string, number>;
}

/**
 * Which step the eye should go to, or an explicit reason there is no such step.
 *
 * A verdict rather than a nullable step, because the three ways there is nothing
 * to name are three different sentences on the page and were previously all
 * rendered as an assertion that some step was dying.
 */
export type WorstStepVerdict =
  /** Confidently below the bar. `okRateUpper` is the optimistic reading. */
  | { kind: 'dying'; step: string; okRate: number; attempted: number; okRateUpper: number }
  /** Steps measured, none of them convincingly bad. */
  | { kind: 'healthy' }
  /** Steps present, none attempted enough times to say anything. */
  | { kind: 'insufficient_sample' }
  /** The per-item funnel is not instrumented for this store (MEAL-122). */
  | { kind: 'unmeasured' };

export interface WorstStepOptions {
  /** Attempts a step needs before it can be named. Default 20. */
  minSample?: number;
  /** The bar the optimistic reading must fall below. Default 0.9. */
  threshold?: number;
}

/**
 * Answers "which step is this store dying on" — and, more often, refuses to.
 *
 * Three refusals, each of which the page previously turned into a false claim:
 *
 *   * A partially instrumented store gets `unmeasured`. For HEB the only steps
 *     that exist are login_check / reconcile / run_summary; naming login_check
 *     points at the one part of the run that is fine while the part that fails is
 *     not measured at all.
 *   * A store whose worst step is healthy gets `healthy`, not its least-good
 *     step. "Dying on: search — 100.0% ok" asserts a death that did not happen.
 *   * A step with a handful of attempts gets no say. The old floor was 5, so 4 ok
 *     and 1 empty rendered "Dying on: search, 80.0% ok over 5" in red next to a
 *     200-attempt step at 100%.
 */
export function worstStep(
  store: { steps: WorstStepInput[]; coverage: { partialInstrumentation: boolean } },
  options: WorstStepOptions = {},
): WorstStepVerdict {
  const minSample = options.minSample ?? 20;
  const threshold = options.threshold ?? 0.9;

  if (store.coverage.partialInstrumentation) return { kind: 'unmeasured' };

  // run_summary is a terminal roll-up, not a step of the funnel, and `blocked` is
  // held apart from drift everywhere else on this page.
  const candidates = store.steps.filter(
    (st) => st.step !== 'run_summary' && st.step !== 'blocked' && st.okRate != null && st.attempted >= minSample,
  );
  if (candidates.length === 0) return { kind: 'insufficient_sample' };

  const ranked = candidates
    .map((st) => ({ st, upper: okRateUpperBound(st.outcomes.ok ?? 0, st.attempted) }))
    // Worst optimistic reading first; the raw rate only breaks ties.
    .sort((a, b) => a.upper - b.upper || a.st.okRate! - b.st.okRate!);

  const worst = ranked[0];
  if (worst.upper >= threshold) return { kind: 'healthy' };
  return {
    kind: 'dying',
    step: worst.st.step,
    okRate: worst.st.okRate!,
    attempted: worst.st.attempted,
    okRateUpper: worst.upper,
  };
}
