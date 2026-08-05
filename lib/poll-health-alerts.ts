import type { SupabaseClient } from '@supabase/supabase-js';
import {
  pollConcern,
  pollHealthByCreator,
  pollStatus,
  type CreatorPollHealth,
  type PollStatusKind,
} from '@/lib/poll-health';
import { isPlatformSource, SOURCE_LABELS } from '@/lib/creator-sources';
import { adminNotifyEmails, DIGEST_ROWS, sendPollHealthAlertEmail, type UnhealthySourceLine } from '@/lib/email';
import { daysSince } from '@/lib/relative-time';
import { log } from '@/lib/logger';

/**
 * Tell an operator when a creator's source goes unhealthy (MEAL-109).
 *
 * MEAL-96 built the judgement and put it on a screen. A screen is only read by
 * somebody who has already decided to look, which leaves the original failure
 * intact: a creator whose source quietly stopped producing is still discovered
 * by the creator asking, only now there is a page that can explain it
 * afterwards. This is the same judgement arriving unasked.
 *
 * **`pollStatus` decides, here as on the screen.** Not "recompute something
 * similar over the same columns" — a second definition of unhealthy is the one
 * outcome that makes this worse than nothing, because the email and the tab
 * would disagree about who is broken and the operator would have to work out
 * which to believe.
 */

/**
 * The two statuses that earn an email, and the three that do not.
 *
 *  - `failing` — actively erroring, and nobody has looked at it.
 *  - `silent` — polling cleanly and producing nothing. The one this is really
 *    for: it reads as healthy on every other column, so nothing but a deliberate
 *    look at "when did this last produce anything" would ever surface it.
 *
 * `unconfigured` is excluded outright: nothing is broken about a creator nobody
 * has set polling up for, and mailing about them is how an alert earns a filter
 * rule. `wobbling` is a failure or two — weather, and the poller's own backoff
 * is already handling it. `ok` speaks for itself.
 */
export const ALERTING_STATUSES = ['failing', 'silent'] as const;
export type AlertingStatus = (typeof ALERTING_STATUSES)[number];

export function isAlerting(kind: PollStatusKind): kind is AlertingStatus {
  return (ALERTING_STATUSES as readonly string[]).includes(kind);
}

/**
 * How bad each alerting status is, and the whole of the hysteresis.
 *
 * **Only an escalation earns a second email, and only `ok` re-arms.** Both
 * halves are needed, and each fixes a way the plain "did the word change?" test
 * spammed an operator about one unfixed source:
 *
 *  - A chronically silent source that errors now and then flips between `silent`
 *    and `failing` as its consecutive-failure count crosses three and resets.
 *    Every flip was a changed word, so five days of one dead blog was five
 *    emails. Ranking them means the escalation `silent` → `failing` is still
 *    said out loud once — it is a genuinely different problem with a different
 *    fix — while the drop back to `silent` is not, because the operator already
 *    knows and the mark stays at the worse of the two.
 *  - `failing` → `wobbling` → `failing` did the same thing through the recovery
 *    branch: `wobbling` is not an alerting status, so it cleared the mark and
 *    re-armed the alert, and the next poll that failed raised it again. A
 *    failure or two is exactly what the poller's backoff is for — it is not the
 *    source coming back. Only `ok` is the source coming back.
 *
 * The cost is real and is the right way round: a source that recovers to
 * `wobbling` and stays there is never re-armed until it reaches `ok`. That
 * suppresses an email about a source an operator has already been told about.
 * The alternative suppresses nothing and gets filtered to a folder, at which
 * point every alert is suppressed and everyone believes otherwise.
 */
const SEVERITY: Record<AlertingStatus, number> = { silent: 1, failing: 2 };

function severityOf(status: string | null): number {
  return status !== null && isAlerting(status as PollStatusKind) ? SEVERITY[status as AlertingStatus] : 0;
}

/**
 * How many creators one sweep reads health for at a time.
 *
 * The same ceiling `loadStates` chunks against, for the same reason: an `.in()`
 * filter travels in the QUERY STRING, and a few hundred uuids in one is a URL
 * the proxy in front of PostgREST rejects before the database sees it. That
 * comes back as no state at all — which reads as "never polled", which reads as
 * healthy, which would make this sweep silently stop alerting at exactly the
 * scale it starts mattering.
 */
const HEALTH_CHUNK = 100;

/**
 * How the eligible creators are read: a page at a time, all of them.
 *
 * This used to be one `.limit(500)` with no `.order()`, which is two bugs
 * wearing one coat. Past 500 eligible creators the rest were never judged and
 * never alerted on — silently, since nothing anywhere says a limit was reached —
 * and *which* 500 was down to whatever order PostgREST felt like, so the set
 * being watched could differ from one morning to the next. Ordered on the
 * primary key and paged to exhaustion instead: everybody, and the same
 * everybody twice.
 */
const CREATOR_PAGE = 500;
const MAX_CREATOR_PAGES = 20;

/** One creator's source, as the sweep decided about it. */
interface Judged {
  creatorId: string;
  creatorName: string;
  handle: string | null;
  /**
   * The source this creator is polled on, and the `creator_source_state` row
   * key it shares. The same value on both sides is the point: it is what the
   * email names and what `mark` writes to, and a creator with a leftover row
   * from a source they were moved off has two candidates for it.
   */
  source: string;
  status: PollStatusKind;
  /** What we last emailed about this source, or null if nothing. */
  alerted: string | null;
  health: CreatorPollHealth;
}

export interface PollHealthAlertDeps {
  supabase: SupabaseClient;
  /** Injectable clock, so a test can describe a month of silence. */
  now?: () => number;
  notifier?: typeof sendPollHealthAlertEmail;
  /** Who hears about it. Defaults to the admin list every operator email uses. */
  recipients?: (supabase: SupabaseClient) => Promise<string[]>;
}

export interface PollHealthAlertPass {
  /** Creators whose source is actually being polled. */
  examined: number;
  /** How many of them are `failing` or `silent` right now. */
  unhealthy: number;
  /** Of those, the ones the email NAMED and that are now recorded as reported. */
  alerted: number;
  /**
   * And the ones already reported at this severity or worse, left alone.
   */
  suppressed: number;
  /**
   * Transitions past `DIGEST_ROWS`: named as a count in today's email and left
   * unmarked, so tomorrow's names them properly. Normally 0.
   */
  deferred: number;
  /** Sources that came back and had their alert re-armed. */
  recovered: number;
  /** 0 or 1 — the digest, if there was anything to put in it. */
  emailsSent: number;
}

/**
 * One sweep: judge every polled source, email about the ones that changed.
 *
 * Runs from `/api/cron/daily` rather than from the poll pass. The poller fires
 * every fifteen minutes, and while the transition check would suppress the
 * repeats either way, a daily cadence means the digest is one message about
 * everything that changed that day instead of up to ninety-six chances to
 * fragment it into one message per source.
 */
export async function runPollHealthAlerts(deps: PollHealthAlertDeps): Promise<PollHealthAlertPass> {
  const now = deps.now ?? Date.now;
  const notifier = deps.notifier ?? sendPollHealthAlertEmail;
  const recipients = deps.recipients ?? adminNotifyEmails;
  const at = now();
  const atIso = new Date(at).toISOString();

  const result: PollHealthAlertPass = {
    examined: 0, unhealthy: 0, alerted: 0, suppressed: 0, deferred: 0, recovered: 0, emailsSent: 0,
  };

  // The same population the Sources tab reads, narrowed by the same two switches
  // `eligibleCreators` polls on. A creator whose import an operator has paused
  // will go silent by construction — that is the pause working, not a source
  // that broke — and alerting on it would mean every deliberate pause produces a
  // false alarm a month later.
  const creators: Array<Record<string, any>> = [];
  for (let page = 0; page < MAX_CREATOR_PAGES; page++) {
    const from = page * CREATOR_PAGE;
    const { data } = await deps.supabase
      .from('creators')
      .select('id, display_name, handle, primary_source')
      .eq('import_opt_in', true)
      .neq('primary_source', 'none')
      .order('id', { ascending: true })
      .range(from, from + CREATOR_PAGE - 1);
    const rows = (data ?? []) as Array<Record<string, any>>;
    creators.push(...rows);
    if (rows.length < CREATOR_PAGE) break;
  }
  if (creators.length === 0) return result;

  const judged: Judged[] = [];
  for (let from = 0; from < creators.length; from += HEALTH_CHUNK) {
    const chunk = creators.slice(from, from + HEALTH_CHUNK);
    const ids = chunk.map((row) => row.id as string);
    // Which source each creator is actually polled on. Without it, a creator
    // moved from their blog to their channel is judged on whichever of the two
    // leftover `creator_source_state` rows came back last — so the live source
    // is never looked at, the email names the wrong platform, and the mark that
    // suppresses tomorrow's repeat lands on a row nothing reads.
    const primarySource = new Map(chunk.map((row) => [row.id as string, (row.primary_source ?? null) as string | null]));
    const [health, alerted] = await Promise.all([
      pollHealthByCreator(deps.supabase, ids, primarySource),
      lastAlerted(deps.supabase, ids),
    ]);

    for (const row of chunk) {
      const entry = health.get(row.id);
      // No state row means nothing has ever polled this creator, which `pollHealth`
      // reports as a null source and `pollStatus` calls `unconfigured`. Nothing to
      // judge and nothing to clear.
      if (!entry?.source) continue;
      result.examined += 1;
      judged.push({
        creatorId: row.id,
        creatorName: typeof row.display_name === 'string' && row.display_name ? row.display_name : 'A creator',
        handle: typeof row.handle === 'string' ? row.handle : null,
        source: entry.source,
        status: pollStatus(entry, at),
        alerted: alerted.get(`${row.id}:${entry.source}`) ?? null,
        health: entry,
      });
    }
  }

  /**
   * The transition, which is the whole design.
   *
   * A source is emailed about when it is unhealthy AND that is WORSE than what
   * we last said about it. Comparing the stored *status* rather than a flag is
   * what makes `silent` → `failing` a second email: a source that was quietly
   * producing nothing and has now started erroring is a different problem with a
   * different fix, and an operator who was told about the first one has not been
   * told about this. Comparing them by SEVERITY rather than by equality is what
   * stops the same fact bouncing back the other way from being a third — see
   * `SEVERITY`.
   */
  const transitions: Judged[] = [];
  const recovered: Judged[] = [];
  for (const entry of judged) {
    if (isAlerting(entry.status)) {
      result.unhealthy += 1;
      if (severityOf(entry.status) > severityOf(entry.alerted)) transitions.push(entry);
      else result.suppressed += 1;
      continue;
    }
    // Back to healthy, and `ok` is the only thing that means. Clearing the mark
    // is what re-arms the alert, so a source that breaks, gets fixed and breaks
    // again raises the second alarm too — while a source that merely drops to
    // `wobbling` on its way through has not been fixed and must not re-arm it.
    if (entry.status === 'ok' && entry.alerted !== null) recovered.push(entry);
  }

  // Worst first, by the same score that orders the Sources tab — so the digest
  // and the screen an operator opens from it agree about what to look at, and so
  // the sources past `DIGEST_ROWS` are the least urgent ones.
  transitions.sort((a, b) => pollConcern(b.health, at) - pollConcern(a.health, at));

  /**
   * Only the sources the email actually NAMES are marked as reported.
   *
   * The digest lists `DIGEST_ROWS` cards and summarises the rest as "…and N
   * more". Marking all of them meant those N were never named in any email at
   * all — the mark says an operator has been told, so every later sweep
   * suppressed them, and the only thing that would ever bring them back was
   * recovering and breaking again. Worst on the first sweep after a deploy,
   * which is when the backlog is largest and the sources most in need of
   * naming. Left unmarked they are the whole of tomorrow's digest instead.
   */
  const named = transitions.slice(0, DIGEST_ROWS);

  if (transitions.length > 0) {
    const adminEmails = await recipients(deps.supabase);
    if (adminEmails.length === 0) {
      // Nothing is marked, so the next sweep tries again once there is somebody
      // to tell. Worth a line either way: the sources are unhealthy now and
      // nobody has been told.
      log({ event: 'POLL:HEALTH_ALERT', status: 'error', reason: 'no admin recipients', detail: `sources=${transitions.length}` });
    } else {
      try {
        await notifier({ adminEmails, sources: transitions.map((entry) => line(entry, at)), now: at });
        result.emailsSent = 1;
        // Marked only after the send returned — and `throwIfRefused` is what
        // makes "returned" mean the mail is on its way rather than that Resend
        // refused it quietly. Marking first would suppress tomorrow's retry on
        // the strength of an email nobody received, and since the mark is only
        // cleared by a recovery, that source would never be raised again.
        result.alerted = await mark(deps.supabase, named, atIso);
        // Counted only on a send that happened. If nothing went out nothing was
        // deferred either — the whole set is re-raised tomorrow, not just the
        // tail of it.
        result.deferred = transitions.length - named.length;
      } catch (err) {
        // Not thrown: the other creators in this sweep, and the rest of the
        // daily cron, are not this send's problem. Nothing was marked, so the
        // next sweep re-raises exactly these sources.
        log({ event: 'POLL:HEALTH_ALERT', status: 'error', reason: 'digest send failed', error: err });
      }
    }
  }

  result.recovered = await clear(deps.supabase, recovered);
  return result;
}

/**
 * What we last emailed about, keyed the way `creator_source_state` is.
 *
 * Throws rather than defaulting to "nothing has been reported", which is what
 * `data ?? []` would quietly mean. The one way this query fails is the column
 * not being there — code deployed ahead of `add-poll-health-alert-state.sql` —
 * and reading that as an empty map makes every unhealthy source a fresh
 * transition every single day. Daily spam about sources an operator already
 * knows about is precisely the outcome the transition check exists to prevent,
 * so the sweep fails closed: no suppression state, no email. `/api/cron/daily`
 * catches it, logs it, and the other passes carry on.
 */
async function lastAlerted(supabase: SupabaseClient, ids: string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (ids.length === 0) return out;
  const { data, error } = await supabase
    .from('creator_source_state')
    .select('creator_id, source, health_alerted_status')
    .in('creator_id', ids);
  if (error) {
    throw new Error(`poll health alerts: cannot read what has already been reported (${error.message ?? error})`);
  }
  for (const row of (data ?? []) as Array<Record<string, any>>) {
    out.set(`${row.creator_id}:${row.source}`, row.health_alerted_status ?? null);
  }
  return out;
}

/** The health, in the words the email uses. */
function line(entry: Judged, at: number): UnhealthySourceLine {
  return {
    creatorName: entry.creatorName,
    handle: entry.handle,
    sourceLabel: isPlatformSource(entry.source) ? SOURCE_LABELS[entry.source] : entry.source,
    status: entry.status as AlertingStatus,
    quietDays: daysSince(entry.health.lastNewItemAt, at),
    lastNewItemAt: entry.health.lastNewItemAt,
    lastPolledAt: entry.health.lastPolledAt,
    consecutiveFailures: entry.health.consecutiveFailures,
    lastFailedAt: entry.health.lastFailedAt,
    lastError: entry.health.lastError,
  };
}

/**
 * Row by row rather than one statement, because the pair a row is keyed by
 * differs per creator and an `.in('creator_id', …)` alone would also clear the
 * mark on a source the creator no longer polls. Transitions are rare by
 * construction — that is what the suppression buys — so this is a handful of
 * writes on the days it writes at all.
 */
async function mark(supabase: SupabaseClient, entries: Judged[], atIso: string): Promise<number> {
  let written = 0;
  for (const entry of entries) {
    const { error } = await supabase
      .from('creator_source_state')
      .update({ health_alerted_status: entry.status, health_alerted_at: atIso })
      .eq('creator_id', entry.creatorId)
      .eq('source', entry.source);
    if (error) {
      // The email has already gone. An unwritten mark costs a duplicate digest
      // tomorrow, which is the right way round to fail.
      log({ event: 'POLL:HEALTH_ALERT', status: 'error', userId: entry.creatorId, reason: 'mark write failed', error });
      continue;
    }
    written += 1;
  }
  return written;
}

async function clear(supabase: SupabaseClient, entries: Judged[]): Promise<number> {
  let cleared = 0;
  for (const entry of entries) {
    const { error } = await supabase
      .from('creator_source_state')
      .update({ health_alerted_status: null, health_alerted_at: null })
      .eq('creator_id', entry.creatorId)
      .eq('source', entry.source);
    if (error) {
      // Left armed-as-alerted: the source is healthy again but still marked, so
      // the next time it breaks nothing is sent. Said out loud for that reason.
      log({ event: 'POLL:HEALTH_ALERT', status: 'error', userId: entry.creatorId, reason: 'recovery clear failed', error });
      continue;
    }
    cleared += 1;
  }
  return cleared;
}
