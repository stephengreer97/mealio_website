// Pure aggregation for the per-store add-to-cart telemetry funnel.
//
// Kept free of NextRequest/Supabase so it is unit-testable: the admin route does
// nothing but fetch rows and hand them here. The interesting logic — which steps
// count as a denominator, how a "first-click confirm" is distinguished from a
// retry, when a store is alerting — is exactly the logic worth having tests for.

export type StepName =
  | 'login_check' | 'search' | 'candidates' | 'add_click'
  | 'confirm' | 'reconcile' | 'blocked' | 'run_summary';

export type StepOutcome = 'ok' | 'empty' | 'timeout' | 'error' | 'blocked' | 'skipped';

/** Step rows as stored (snake_case straight from Supabase). */
export interface StepRow {
  store_id: string;
  step: string;
  outcome: string;
  duration_ms: number | null;
  /** Client-supplied structured payload; `attempt` distinguishes retries. */
  detail: Record<string, unknown> | null;
}

export interface RunRow {
  store_id: string;
  outcome: string | null;
  status: string;
  items_requested: number | null;
  items_added: number | null;
}

export interface StepStats {
  step: string;
  total: number;
  /** Count per outcome; keys absent when zero. */
  outcomes: Record<string, number>;
  /** ok / total, or null when total is 0 (never report 0% for no data). */
  okRate: number | null;
  p50DurationMs: number | null;
  p95DurationMs: number | null;
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
  /** confirm:ok / add_click:total — the headline reliability number. */
  confirmRate: number | null;
  /** Share of confirms that landed WITHOUT a retry (detail.attempt <= 1). */
  firstClickConfirmRate: number | null;
  /** Share of runs that hit a WAF/robot wall. */
  blockedRate: number | null;
  /** True when confirmRate is below threshold on a large enough sample. */
  alerting: boolean;
}

export interface AggregateOptions {
  /** Alert when confirmRate drops below this. Default 0.9. */
  confirmRateThreshold?: number;
  /** Don't alert on a sample this small — noise, not signal. Default 20. */
  minSampleForAlert?: number;
}

// The order the funnel is displayed in: the real sequence a run walks through.
const STEP_ORDER: StepName[] = [
  'login_check', 'search', 'candidates', 'add_click',
  'confirm', 'reconcile', 'blocked', 'run_summary',
];

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

export function aggregateFunnel(
  runs: RunRow[],
  steps: StepRow[],
  options: AggregateOptions = {},
): StoreFunnel[] {
  const threshold = options.confirmRateThreshold ?? 0.9;
  const minSample = options.minSampleForAlert ?? 20;

  // Every store that appears in EITHER table gets a row. A store with runs but no
  // steps (older app build that predates step reporting) must still show up, and
  // so must steps whose run row was pruned.
  const storeIds = new Set<string>();
  for (const r of runs) if (r.store_id) storeIds.add(r.store_id);
  for (const s of steps) if (s.store_id) storeIds.add(s.store_id);

  const result: StoreFunnel[] = [];

  for (const storeId of storeIds) {
    const storeRuns = runs.filter((r) => r.store_id === storeId);
    const storeSteps = steps.filter((s) => s.store_id === storeId);

    // ── Per-step rollup ────────────────────────────────────────────────────
    const byStep = new Map<string, { outcomes: Record<string, number>; durations: number[] }>();
    for (const s of storeSteps) {
      let bucket = byStep.get(s.step);
      if (!bucket) { bucket = { outcomes: {}, durations: [] }; byStep.set(s.step, bucket); }
      bucket.outcomes[s.outcome] = (bucket.outcomes[s.outcome] ?? 0) + 1;
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
      const sortedDurations = [...bucket.durations].sort((a, b) => a - b);
      stepStats.push({
        step,
        total,
        outcomes: bucket.outcomes,
        okRate: rate(bucket.outcomes.ok ?? 0, total),
        p50DurationMs: percentile(sortedDurations, 50),
        p95DurationMs: percentile(sortedDurations, 95),
      });
    }

    // ── Headline rates ─────────────────────────────────────────────────────
    // Denominator is add_click attempts, not confirm rows: a click that produced
    // no confirm signal at all is precisely the failure we're hunting, and it
    // would vanish if we divided by confirms.
    const addClicks = byStep.get('add_click');
    const addClickTotal = addClicks
      ? Object.values(addClicks.outcomes).reduce((a, b) => a + b, 0)
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
    const runsBlocked = storeSteps.filter((s) => s.step === 'blocked').length;

    const confirmRate = rate(confirmOk, addClickTotal);

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
      blockedRate: rate(runsBlocked, storeRuns.length),
      alerting: confirmRate != null && addClickTotal >= minSample && confirmRate < threshold,
    });
  }

  // Busiest store first — that's where a regression costs the most.
  return result.sort((a, b) => b.runs - a.runs || a.storeId.localeCompare(b.storeId));
}
