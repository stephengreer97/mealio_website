// The network rail, seen through the only thing it all reduces to: HTTP codes.
//
// Stephen, 2026-09-05: "automation statistics ... needs a complete overhaul now
// that we are 100% on network. Now it should be much easier to collect data
// since it all traces back to http codes."
//
// WHY THIS IS A NEW FILE RATHER THAN AN EDIT TO automation-funnel.ts. That file
// aggregates a DOM run: its step vocabulary contains `add_click`, its confirm
// rate is "confirms over add_click attempts", and its `selector_miss` code has
// seven reasons mapping to it. None of those describe what happens now, and the
// rows recorded under them are still in the table and still worth reading. So
// the funnel keeps answering the question it was built for, over the rows that
// answer it, and this answers the new one.
//
// EVERY NUMBER HERE IS NULL WHEN ITS DENOMINATOR IS EMPTY. Reporting 0% for a
// store nobody used pages someone for nothing — the same rule the funnel
// already holds itself to, and the reason both files are this careful about
// what a percentage is a share of.

/** A step row, as far as this file is concerned. */
export interface RequestRow {
  store_id: string;
  rail: string | null;
  phase: string | null;
  outcome: string;
  code: string | null;
  http_status: number | null;
  attempts: number | null;
  duration_ms: number | null;
}

/** The buckets a status falls into. Individually where it matters. */
export type StatusBucket =
  | '2xx' | '3xx' | '400' | '401' | '403' | '404' | '412' | '418' | '429'
  | '4xx' | '5xx' | 'none';

/**
 * Which bucket a status belongs to.
 *
 * The anti-bot statuses get their OWN buckets rather than disappearing into
 * 4xx, because they are the ones that change what you do: a 429 says back off,
 * a 403/412/418 says the wall is up, and a 404 says we asked for something that
 * is not there. Lumping them together produces a "4xx rate" that rises for
 * three unrelated reasons.
 *
 * `none` is a request that got no answer at all. It is NOT zero and not an
 * error class — it is a dropped connection or an abort, and folding it into 5xx
 * would say the store answered when it did not.
 */
export function statusBucket(status: number | null | undefined): StatusBucket {
  if (typeof status !== 'number' || !Number.isFinite(status)) return 'none';
  if (status === 401 || status === 403 || status === 404
      || status === 400 || status === 412 || status === 418 || status === 429) {
    return String(status) as StatusBucket;
  }
  if (status >= 200 && status < 300) return '2xx';
  if (status >= 300 && status < 400) return '3xx';
  if (status >= 400 && status < 500) return '4xx';
  if (status >= 500 && status < 600) return '5xx';
  return 'none';
}

/** True for a status that means the store served us. */
export function isHealthy(status: number | null | undefined): boolean {
  return typeof status === 'number' && status >= 200 && status < 400;
}

export interface PhaseHealth {
  phase: string;
  requests: number;
  /** Requests the store served, over requests made. Null when none were made. */
  okRate: number | null;
  failures: number;
  /** Median and 95th percentile, in ms, over rows that carried a duration. */
  p50: number | null;
  p95: number | null;
}

export interface StoreRequests {
  storeId: string;
  /** The implementation behind the banner, when the rows said. */
  rails: string[];
  requests: number;
  /** Per bucket, highest count first. */
  statuses: Array<{ bucket: StatusBucket; count: number }>;
  okRate: number | null;
  /** Requests that took more than one attempt, over requests. */
  retryRate: number | null;
  /**
   * Of the requests that were retried, how many ended up served.
   *
   * The number that says whether the retry policy is earning its keep. A high
   * retry rate with a high retry success rate is the policy working; a high
   * retry rate with a low one is a store that is simply down, and retrying is
   * only making the run slower.
   */
  retrySuccessRate: number | null;
  phases: PhaseHealth[];
  /** Failure codes on request rows, highest first. */
  codes: Array<{ code: string; count: number }>;
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}

const rate = (num: number, den: number): number | null => (den === 0 ? null : num / den);

/**
 * Aggregate request rows into a per-store picture.
 *
 * Rows with no `http_status` AND no `phase` are DROPPED: they are ordinary step
 * rows from before MEAL-219, or from an older client, and counting them here
 * would put a denominator under a question they cannot answer. That is the
 * whole reason this returns null rather than zero everywhere else — a number
 * computed over rows that were never about requests is worse than no number.
 */
export function buildRequestView(rows: RequestRow[]): StoreRequests[] {
  const byStore = new Map<string, RequestRow[]>();
  for (const r of rows) {
    if (r.http_status == null && !r.phase) continue;
    const list = byStore.get(r.store_id);
    if (list) list.push(r); else byStore.set(r.store_id, [r]);
  }

  const out: StoreRequests[] = [];
  for (const [storeId, list] of byStore) {
    const buckets = new Map<StatusBucket, number>();
    const codes = new Map<string, number>();
    const rails = new Set<string>();
    const byPhase = new Map<string, RequestRow[]>();

    let served = 0;
    let retried = 0;
    let retriedAndServed = 0;

    for (const r of list) {
      const b = statusBucket(r.http_status);
      buckets.set(b, (buckets.get(b) ?? 0) + 1);
      if (r.rail) rails.add(r.rail);
      if (r.code) codes.set(r.code, (codes.get(r.code) ?? 0) + 1);
      if (isHealthy(r.http_status)) served += 1;
      if ((r.attempts ?? 1) > 1) {
        retried += 1;
        if (isHealthy(r.http_status)) retriedAndServed += 1;
      }
      const p = r.phase ?? 'unknown';
      const pl = byPhase.get(p);
      if (pl) pl.push(r); else byPhase.set(p, [r]);
    }

    const phases: PhaseHealth[] = [];
    for (const [phase, pr] of byPhase) {
      const durations = pr.map((r) => r.duration_ms).filter((d): d is number => typeof d === 'number').sort((a, b) => a - b);
      const ok = pr.filter((r) => isHealthy(r.http_status)).length;
      phases.push({
        phase,
        requests: pr.length,
        okRate: rate(ok, pr.length),
        failures: pr.length - ok,
        p50: percentile(durations, 50),
        p95: percentile(durations, 95),
      });
    }
    phases.sort((a, b) => b.requests - a.requests);

    out.push({
      storeId,
      rails: [...rails].sort(),
      requests: list.length,
      statuses: [...buckets.entries()]
        .map(([bucket, count]) => ({ bucket, count }))
        .sort((a, b) => b.count - a.count),
      okRate: rate(served, list.length),
      retryRate: rate(retried, list.length),
      // Null rather than 0 when nothing was retried: "0% of retries succeeded"
      // reads as a broken retry policy, and it means there were none.
      retrySuccessRate: rate(retriedAndServed, retried),
      phases,
      codes: [...codes.entries()]
        .map(([code, count]) => ({ code, count }))
        .sort((a, b) => b.count - a.count),
    });
  }

  out.sort((a, b) => b.requests - a.requests);
  return out;
}
