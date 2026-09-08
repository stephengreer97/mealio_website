// MEAL-219 phase 4: the automation tab, rebuilt around what the rail actually does.
//
// Stephen: "automation statistics in the automation tab in the /admin page needs
// a complete overhaul now that we are 100% on network. Now it should be much
// easier to collect data since it all traces back to http codes."
//
// The old funnel counts DOM-era steps and groups failures by codes that mostly
// mean "we picked the wrong product". This aggregates the four columns the rail
// now emits -- http_status, phase, attempts, rail -- into the four questions
// worth asking of a network automation:
//
//   1. What is the store SAYING to us?           status histogram
//   2. Where do runs die?                        phase funnel
//   3. How hard are we having to try?            retry rate, retry success
//   4. What is still speaking the old language?  legacy-code section
//
// Pure functions over rows. Fetching lives in the route, so all of this is
// unit-tested without a database.

/** One automation_steps row, as much of it as this module reads. */
export interface NetworkStepRow {
  store_id: string | null;
  step: string;
  outcome: string;
  code: string | null;
  http_status: number | null;
  phase: string | null;
  attempts: number | null;
  rail: string | null;
  occurred_at: string;
}

/**
 * Codes emitted by the DOM automation, deleted 2026-09-01.
 *
 * Kept visible rather than filtered away, in their own section. A 2026-08
 * selector_miss is not a live problem and must not sit on the same bar as
 * today's failures -- but hiding it would make old rows vanish from totals with
 * no explanation, which is its own kind of lie.
 */
export const LEGACY_CODES = ['selector_miss', 'nav_failed'] as const;

/** The phases a run passes through, in the order it passes through them. */
export const PHASE_ORDER = ['session', 'search', 'add', 'cart_read'] as const;
export type Phase = (typeof PHASE_ORDER)[number];

export interface StatusBucket {
  /** '2xx' | '4xx' | '5xx' | '403' | '412' | '429' — the walls get their own. */
  label: string;
  count: number;
}

export interface PhaseStats {
  phase: Phase;
  ok: number;
  failed: number;
  /** Rows carrying this phase at all. `ok + failed` may be less: 'skipped'. */
  total: number;
  /** Of the failures, the code that explains most of them. */
  topCode: string | null;
}

export interface NetworkStoreStats {
  storeId: string;
  rows: number;
  /** Rows with no http_status. Every row written before MEAL-219 shipped. */
  rowsWithoutStatus: number;
  statuses: StatusBucket[];
  phases: PhaseStats[];
  /** Share of rows that needed more than one attempt. */
  retryRate: number;
  /** Of the rows that retried, the share that ended ok. */
  retrySuccessRate: number;
  retried: number;
  retriedOk: number;
  legacyCodeRows: number;
  rails: string[];
}

/**
 * The walls get their own bucket; everything else rolls up by class.
 *
 * 403/429 are how every store says "not you", and 412/418 are Walmart's. Rolled
 * into a generic 4xx they are invisible, and they are the single most actionable
 * status on this page -- a spike in them is a campaign, not a bug.
 */
export function statusLabel(status: number): string {
  if (status === 403 || status === 429 || status === 412 || status === 418) return String(status);
  if (status === 401) return '401';
  if (status >= 500) return '5xx';
  if (status >= 400) return '4xx';
  if (status >= 300) return '3xx';
  if (status >= 200) return '2xx';
  return String(status);
}

/** Order for display: the walls first, then success, then the rest. */
const STATUS_RANK: Record<string, number> = {
  '403': 0, '429': 1, '412': 2, '418': 3, '401': 4, '5xx': 5, '4xx': 6, '3xx': 7, '2xx': 8,
};

function isFailure(outcome: string): boolean {
  return outcome === 'error' || outcome === 'timeout' || outcome === 'blocked';
}

export function aggregateNetworkStats(rows: NetworkStepRow[]): NetworkStoreStats[] {
  const byStore = new Map<string, NetworkStepRow[]>();
  for (const r of rows) {
    const id = r.store_id || 'unknown';
    const list = byStore.get(id);
    if (list) list.push(r); else byStore.set(id, [r]);
  }

  const out: NetworkStoreStats[] = [];
  for (const [storeId, list] of byStore) {
    const statusCounts = new Map<string, number>();
    let rowsWithoutStatus = 0;
    for (const r of list) {
      if (typeof r.http_status === 'number' && r.http_status > 0) {
        const k = statusLabel(r.http_status);
        statusCounts.set(k, (statusCounts.get(k) ?? 0) + 1);
      } else {
        rowsWithoutStatus += 1;
      }
    }

    const phases: PhaseStats[] = PHASE_ORDER.map((phase) => {
      const inPhase = list.filter((r) => r.phase === phase);
      const failed = inPhase.filter((r) => isFailure(r.outcome));
      const codeCounts = new Map<string, number>();
      for (const f of failed) {
        if (!f.code) continue;
        codeCounts.set(f.code, (codeCounts.get(f.code) ?? 0) + 1);
      }
      const topCode = [...codeCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
      return {
        phase,
        ok: inPhase.filter((r) => r.outcome === 'ok').length,
        failed: failed.length,
        total: inPhase.length,
        topCode,
      };
    });

    // A row with attempts > 1 was retried by the rail's own policy. Rows with a
    // null attempts predate the column and are NOT counted as "did not retry" --
    // they are excluded from the denominator, because assuming they did not is
    // how a rate quietly becomes a lie about a window it does not cover.
    const withAttempts = list.filter((r) => typeof r.attempts === 'number' && r.attempts > 0);
    const retried = withAttempts.filter((r) => (r.attempts as number) > 1);
    const retriedOk = retried.filter((r) => r.outcome === 'ok');

    out.push({
      storeId,
      rows: list.length,
      rowsWithoutStatus,
      statuses: [...statusCounts.entries()]
        .map(([label, count]) => ({ label, count }))
        .sort((a, b) => (STATUS_RANK[a.label] ?? 99) - (STATUS_RANK[b.label] ?? 99)),
      phases,
      retryRate: withAttempts.length ? retried.length / withAttempts.length : 0,
      retrySuccessRate: retried.length ? retriedOk.length / retried.length : 0,
      retried: retried.length,
      retriedOk: retriedOk.length,
      legacyCodeRows: list.filter((r) => r.code && (LEGACY_CODES as readonly string[]).includes(r.code)).length,
      rails: [...new Set(list.map((r) => r.rail).filter((x): x is string => !!x))].sort(),
    });
  }

  return out.sort((a, b) => b.rows - a.rows);
}

/**
 * One line per store, for the alert email and the top of the tab.
 *
 * Deliberately says nothing when a store has no status rows at all: "0% errors"
 * about a store we have no HTTP data for is the flattering kind of wrong.
 */
export function summarize(s: NetworkStoreStats): string {
  if (s.rows === s.rowsWithoutStatus) {
    return `${s.storeId}: ${s.rows} rows, none carrying a status yet`;
  }
  const walls = s.statuses.filter((x) => ['403', '429', '412', '418'].includes(x.label))
    .reduce((n, x) => n + x.count, 0);
  const errs = s.statuses.filter((x) => x.label === '5xx').reduce((n, x) => n + x.count, 0);
  const bits = [`${s.rows} rows`];
  if (walls) bits.push(`${walls} blocked`);
  if (errs) bits.push(`${errs} store errors`);
  if (s.retried) bits.push(`${Math.round(s.retryRate * 100)}% retried, ${Math.round(s.retrySuccessRate * 100)}% of those recovered`);
  return `${s.storeId}: ${bits.join(', ')}`;
}
