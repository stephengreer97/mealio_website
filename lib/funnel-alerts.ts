import type { SupabaseClient } from '@supabase/supabase-js';
import {
  aggregateFunnel,
  UNCODED,
  type AlertReason,
  type StoreFunnel,
} from '@/lib/automation-funnel';
import { fetchFunnelRows } from '@/lib/automation-funnel-rows';
import { adminNotifyEmails, sendFunnelAlertEmail, type StoreAlertLine } from '@/lib/email';
import { log } from '@/lib/logger';

/**
 * Tell an operator when a store's cart automation regresses (MEAL-6).
 *
 * The admin funnel already computes this judgement and puts it on a screen. A
 * dashboard nobody opens is not detection: a store whose selectors were renamed
 * overnight is silent from every other angle — no error reaches us, no user
 * files a bug, they just get four of their six items and assume the shop was
 * out of stock. This is the same judgement arriving unasked.
 *
 * **`aggregateFunnel` decides, here as on the screen.** Not "recompute something
 * similar over the same rows", and not "pass different thresholds": the sweep
 * calls it with no threshold options at all, so the numbers are the module's
 * defaults and the page's by construction. A page and an email that disagree
 * about who is broken are worse than either alone, and this is the shape that
 * makes the disagreement impossible rather than merely unintended.
 *
 * The hysteresis is `lib/poll-health-alerts.ts`'s rule, generalised from one
 * status to a set of reasons: only a store broken in a way we have not already
 * reported earns an email, and only a store healthy on every count re-arms it.
 */

/**
 * How much history the sweep reads: the current 24h window plus the seven that
 * form its baseline median. One more than strictly needed, so a run that
 * started just before the oldest window's edge is still in hand.
 */
export const ALERT_WINDOW_DAYS = 9;

/** One store, as the sweep decided about it. */
interface Judged {
  store: StoreFunnel;
  storeLabel: string;
  /** What we last emailed about this store; empty when nothing. */
  alerted: AlertReason[];
  /** Reasons it is alerting for now that are not in `alerted`. */
  newReasons: AlertReason[];
}

export interface FunnelAlertDeps {
  supabase: SupabaseClient;
  /** Injectable clock, so a test can describe a week of history. */
  now?: () => number;
  notifier?: typeof sendFunnelAlertEmail;
  /** Who hears about it. Defaults to the admin list every operator email uses. */
  recipients?: (supabase: SupabaseClient) => Promise<string[]>;
}

export interface FunnelAlertPass {
  /** Stores that produced any telemetry at all in the window. */
  storesExamined: number;
  /** How many of them are alerting for at least one reason right now. */
  alerting: number;
  /** Of those, the ones the email named and that are now recorded as reported. */
  alerted: number;
  /** And the ones already reported for every reason they show, left alone. */
  suppressed: number;
  /** Stores that came back healthy and had their alert re-armed. */
  recovered: number;
  /** 0 or 1 — the digest, if there was anything to put in it. */
  emailsSent: number;
  /**
   * True when the window was too big to read fully. The judgement is then made
   * on part of the window, so a quiet sweep does not mean a quiet day.
   */
  truncated: boolean;
}

/**
 * One sweep: judge every store with telemetry, email about the ones that got
 * worse in a way nobody has been told about yet.
 *
 * Runs from `/api/cron/daily` (14:00 UTC). Daily rather than per-run because
 * this is a digest: one message about everything that changed, and the
 * transition check means a standing problem is not repeated either way.
 */
export async function runFunnelAlerts(deps: FunnelAlertDeps): Promise<FunnelAlertPass> {
  const now = deps.now ?? Date.now;
  const notifier = deps.notifier ?? sendFunnelAlertEmail;
  const recipients = deps.recipients ?? adminNotifyEmails;
  const at = now();
  const atIso = new Date(at).toISOString();

  const result: FunnelAlertPass = {
    storesExamined: 0, alerting: 0, alerted: 0, suppressed: 0, recovered: 0, emailsSent: 0, truncated: false,
  };

  const since = new Date(at - ALERT_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const rows = await fetchFunnelRows(deps.supabase, { since });
  result.truncated = rows.truncated;
  if (rows.truncated) {
    // Said out loud rather than swallowed: the alert below is being decided on
    // part of the window, and the part it cannot see is the OLDEST rows — which
    // is the baseline, not the recent window. A median short of history reads
    // higher or lower than the truth in either direction.
    log({ event: 'CRON:FUNNEL_ALERT', status: 'error', reason: 'window truncated', detail: `runs=${rows.runRowsScanned} steps=${rows.stepRowsScanned}` });
  }

  // No thresholds passed. That is the point — see the module comment.
  const funnel = aggregateFunnel(rows.runs, rows.steps, { now: at });
  result.storesExamined = funnel.length;
  if (funnel.length === 0) return result;

  const [labels, alerted] = await Promise.all([
    storeLabels(deps.supabase, funnel.map((s) => s.storeId)),
    lastAlerted(deps.supabase, funnel.map((s) => s.storeId)),
  ]);

  /**
   * The transition, which is the whole design.
   *
   * A store is emailed about when it is alerting for a reason we have not
   * already reported. Comparing the stored *reasons* rather than a flag is what
   * makes drift-then-walled-off a second email: a store that was losing items to
   * a renamed button and is now also being stopped by a WAF is a different
   * problem with a different fix, and an operator told about the first has not
   * been told about this.
   *
   * The stored set only ever GROWS while a store stays unhealthy — `mark` writes
   * the union — which is what stops the same fact bouncing back and forth from
   * being a third email. A store that drops from two reasons to one has not been
   * fixed, and re-raising it when the second reason returns would be announcing
   * something already said.
   */
  const transitions: Judged[] = [];
  const recovered: string[] = [];
  for (const store of funnel) {
    const previous = alerted.get(store.storeId) ?? null;
    if (store.alertReasons.length > 0) {
      result.alerting += 1;
      const newReasons = store.alertReasons.filter((r) => !(previous ?? []).includes(r));
      if (newReasons.length > 0) {
        transitions.push({
          store,
          storeLabel: labels.get(store.storeId) ?? store.storeId,
          alerted: previous ?? [],
          newReasons,
        });
      } else {
        result.suppressed += 1;
      }
      continue;
    }
    // Healthy on every count, which is the only thing that re-arms the alert.
    // Clearing the mark is what makes a store that breaks, gets fixed and breaks
    // again raise the second alarm too.
    if (previous !== null) recovered.push(store.storeId);
  }

  if (transitions.length > 0) {
    // Worst first, by the same order the funnel sorts the dashboard: the busiest
    // store is where a regression costs the most.
    transitions.sort((a, b) => b.store.runs - a.store.runs || a.store.storeId.localeCompare(b.store.storeId));

    const adminEmails = await recipients(deps.supabase);
    if (adminEmails.length === 0) {
      // Nothing is marked, so the next sweep tries again once there is somebody
      // to tell. Worth a line either way: stores are broken now and nobody has
      // been told.
      log({ event: 'CRON:FUNNEL_ALERT', status: 'error', reason: 'no admin recipients', detail: `stores=${transitions.length}` });
    } else {
      try {
        await notifier({ adminEmails, stores: transitions.map(line), now: at });
        result.emailsSent = 1;
        // Marked only after the send returned — and `throwIfRefused` inside the
        // notifier is what makes "returned" mean the mail is on its way rather
        // than that Resend refused it quietly. Marking first would suppress
        // tomorrow's retry on the strength of an email nobody received, and
        // since the mark is only cleared by a recovery, that store would never
        // be raised again.
        result.alerted = await mark(deps.supabase, transitions, atIso);
      } catch (err) {
        // Not thrown: the rest of the daily cron is not this send's problem.
        // Nothing was marked, so the next sweep re-raises exactly these stores.
        log({ event: 'CRON:FUNNEL_ALERT', status: 'error', reason: 'digest send failed', error: err });
      }
    }
  }

  result.recovered = await clear(deps.supabase, recovered);
  return result;
}

/** The regression, in the words the email uses. */
function line(entry: Judged): StoreAlertLine {
  const store = entry.store;
  return {
    storeId: store.storeId,
    storeLabel: entry.storeLabel,
    reasons: store.alertReasons,
    newReasons: entry.newReasons,
    runs: store.runs,
    itemsRequested: store.itemsRequested,
    itemsAdded: store.itemsAdded,
    itemsUnavailable: store.itemsUnavailable,
    itemSuccessRecent: store.itemSuccess.recent,
    itemSuccessMedian: store.itemSuccess.median,
    confirmRate: store.confirmRate,
    blockedRate: store.blockedRate,
    blockedRuns: store.blocked.runs,
    failureCodes: failureBreakdown(store),
  };
}

/**
 * MEAL-4's codes, commonest first — the acceptance criterion for this ticket.
 *
 * `store.failureCodes` deliberately excludes blocks (a WAF wall is not drift and
 * is averaged into nothing on this page), so `waf_block` never appears here. It
 * does not need to: the wall gets its own row in the email, counted in RUNS,
 * which is the only unit it is a percentage of.
 *
 * `uncoded` is kept rather than dropped. It is every failure written before the
 * taxonomy shipped, and a breakdown that hides it reads as "we know what all of
 * these were" when the honest answer is that we do not know what some were.
 */
function failureBreakdown(store: StoreFunnel): Array<{ code: string; count: number }> {
  return Object.entries(store.failureCodes)
    .map(([code, count]) => ({ code, count }))
    // Commonest first; `uncoded` loses every tie, because a named code is the
    // one somebody can act on.
    .sort((a, b) => b.count - a.count
      || (a.code === UNCODED ? 1 : 0) - (b.code === UNCODED ? 1 : 0)
      || a.code.localeCompare(b.code));
}

/**
 * The catalog's names for these stores, so the email says "H-E-B" and not "heb".
 *
 * Cosmetic, and treated as cosmetic: a store missing from the catalog falls back
 * to its id and is still alerted about. A failure to read the catalog must never
 * be a reason an operator is not told a store is broken.
 */
async function storeLabels(supabase: SupabaseClient, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  // unbounded-select-ok: one row per store in the catalog, and `ids` is the
  // handful of stores that produced telemetry this week
  const { data, error } = await supabase.from('stores').select('id, name').in('id', ids);
  if (error) {
    log({ event: 'CRON:FUNNEL_ALERT', status: 'error', reason: 'store labels unreadable', error });
    return out;
  }
  for (const row of (data ?? []) as Array<{ id: string; name: string | null }>) {
    if (row.name) out.set(row.id, row.name);
  }
  return out;
}

/**
 * What we last emailed about, per store.
 *
 * Throws rather than defaulting to "nothing has been reported", which is what
 * `data ?? []` would quietly mean. The one way this query fails is the table not
 * being there — code deployed ahead of `add-automation-alert-state.sql` — and
 * reading that as an empty map makes every broken store a fresh transition every
 * single day. Daily mail about a store an operator already knows about is
 * precisely the outcome the transition check exists to prevent, so the sweep
 * fails closed: no suppression state, no email. `/api/cron/daily` catches it,
 * logs it, and the other passes carry on.
 */
async function lastAlerted(supabase: SupabaseClient, ids: string[]): Promise<Map<string, AlertReason[] | null>> {
  const out = new Map<string, AlertReason[] | null>();
  if (ids.length === 0) return out;
  // unbounded-select-ok: one row per store, and only for stores that have ever
  // been alerted about
  const { data, error } = await supabase
    .from('automation_alert_state')
    .select('store_id, alerted_reasons')
    .in('store_id', ids);
  if (error) {
    throw new Error(`funnel alerts: cannot read what has already been reported (${(error as any).message ?? error})`);
  }
  for (const row of (data ?? []) as Array<{ store_id: string; alerted_reasons: string[] | null }>) {
    // A row whose reasons are null is a store that recovered: the mark was
    // cleared, so it is armed, and that is not the same as having no row.
    const reasons = row.alerted_reasons;
    out.set(row.store_id, reasons && reasons.length > 0 ? (reasons as AlertReason[]) : null);
  }
  return out;
}

/**
 * Record what the email said, as the UNION of what it said before and now.
 *
 * The union rather than the current set is the half of the hysteresis that stops
 * a flapping store mailing twice for the same fact: a store that alerts for
 * drift and a wall, then next week only for the wall, must not raise a third
 * email when the drift comes back. The mark stays at the worst we have said
 * until the store is healthy on every count, at which point `clear` re-arms it.
 */
async function mark(supabase: SupabaseClient, entries: Judged[], atIso: string): Promise<number> {
  let written = 0;
  for (const entry of entries) {
    const union = [...new Set([...entry.alerted, ...entry.store.alertReasons])].sort();
    const { error } = await supabase
      .from('automation_alert_state')
      .upsert({ store_id: entry.store.storeId, alerted_reasons: union, alerted_at: atIso }, { onConflict: 'store_id' });
    if (error) {
      // The email has already gone. An unwritten mark costs a duplicate digest
      // tomorrow, which is the right way round to fail.
      log({ event: 'CRON:FUNNEL_ALERT', status: 'error', reason: 'mark write failed', detail: entry.store.storeId, error });
      continue;
    }
    written += 1;
  }
  return written;
}

async function clear(supabase: SupabaseClient, storeIds: string[]): Promise<number> {
  let cleared = 0;
  for (const storeId of storeIds) {
    const { error } = await supabase
      .from('automation_alert_state')
      .update({ alerted_reasons: null, alerted_at: null })
      .eq('store_id', storeId);
    if (error) {
      // Left armed-as-alerted: the store is healthy again but still marked, so
      // the next time it breaks nothing is sent. Said out loud for that reason.
      log({ event: 'CRON:FUNNEL_ALERT', status: 'error', reason: 'recovery clear failed', detail: storeId, error });
      continue;
    }
    cleared += 1;
  }
  return cleared;
}
