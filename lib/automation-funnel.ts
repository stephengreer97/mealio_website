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
//   3. AN UNINSTRUMENTED STORE IS NOT A HEALTHY ONE. The parallel and pre-search
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
  /** WAF/robot walls, kept out of every failure rate above. */
  blocked: { steps: number; rate: number | null };
  /** Drift-shaped failure codes across the whole store, blocks excluded. */
  failureCodes: Record<string, number>;
  /**
   * Codes on the terminal run_summary row. Reported separately and never used as
   * the headline: run_summary carries the MOST FREQUENT code in the run, not the
   * most severe (MEAL-123), so three confirm_failed and one waf_block reports
   * confirm_failed and hides the actionable cause.
   */
  runSummaryCodes: Record<string, number>;
  /** Share of runs that hit a WAF/robot wall. */
  blockedRate: number | null;
  coverage: FunnelCoverage;
  daily: DayPoint[];
  /** Null when the window is shorter than 14 days — nothing to compare against. */
  weekOverWeek: WeekOverWeek | null;
  /** True when confirmRate is below threshold on a large enough sample. */
  alerting: boolean;
}

export interface AggregateOptions {
  /** Alert when confirmRate drops below this. Default 0.9. */
  confirmRateThreshold?: number;
  /** Don't alert on a sample this small — noise, not signal. Default 20. */
  minSampleForAlert?: number;
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
    const blockedSteps = storeSteps.filter(isBlockedRow).length;

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
    if (days && days > 0) for (const day of denseDays(now, days)) touch(day);
    for (const r of storeRuns) {
      const day = dayKey(r.started_at);
      if (!day) continue;
      const d = touch(day);
      d.runs += 1;
      if (r.outcome === 'success') d.runsSucceeded += 1;
    }
    for (const s of storeSteps) {
      const day = dayKey(s.occurred_at);
      if (!day) continue;
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
      blocked: { steps: blockedSteps, rate: rate(blockedSteps, storeRuns.length) },
      failureCodes,
      runSummaryCodes,
      blockedRate: rate(blockedSteps, storeRuns.length),
      coverage,
      daily,
      weekOverWeek,
      alerting: confirmRate != null && addClickTotal >= minSample && confirmRate < threshold,
    });
  }

  // Busiest store first — that's where a regression costs the most.
  return result.sort((a, b) => b.runs - a.runs || a.storeId.localeCompare(b.storeId));
}
