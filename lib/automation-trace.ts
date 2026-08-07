// One run, step by step. The other half of lib/automation-funnel.ts.
//
// The funnel answers "how often does HEB's confirm step fail". It cannot answer
// "show me one of the failures", because every number it produces is a rate over
// a store and a window, and a rate has no rows underneath it once it is computed.
// This module holds the per-run reasoning: given one run row and its ordered step
// rows, what can honestly be said about that run.
//
// Kept free of NextRequest/Supabase for the same reason the funnel is: the route
// fetches, this decides, and the deciding is what the tests pin.
//
// THREE THINGS IT REFUSES TO SAY, each of which the aggregate view gets wrong for
// structural reasons a single trace can actually fix — or, where it cannot, must
// admit rather than paper over:
//
//   1. AN EMPTY TRACE IS NOT AN IDLE RUN. The parallel and pre-search add pools
//      emit no per-item step rows at all (MEAL-122, on for HEB, Walmart, Amazon
//      Fresh and Albertsons), and Kroger adds through the public API without ever
//      running the WebView engine. A run at one of those stores can add every item
//      it was asked for and leave behind nothing but `run_summary`. So zero steps
//      is a statement about instrumentation, never about the run.
//   2. A RUN-LEVEL CODE IS NOT A CAUSE. `run_summary` carries the run's MOST
//      FREQUENT code, not its most severe (MEAL-123): three `confirm_failed` and
//      one `waf_block` reports `confirm_failed`, and the WAF block — the only
//      actionable half — disappears. It is surfaced here labelled and never as the
//      verdict.
//   3. AN INCOMPLETE TRACE HAS NO FIRST FAILURE. "Which step broke first" is only
//      a fact about rows read in full. Against a truncated read it is a fact about
//      whichever prefix happened to arrive, which is the shape of every bug in
//      this repository's truncation family.
//
// What a complete trace DOES give, and the reason this exists: within one run the
// steps are totally ordered by `seq`, so the first failing step is an observation
// rather than a ranking. That dissolves MEAL-123 for the run you are looking at —
// you can see the `waf_block` sitting at seq 4 whatever the summary code says.

/** A step row as stored, in the shape the drilldown route selects it. */
export interface TraceStepRow {
  /** Monotonic within a run; `(run_id, seq)` is unique, so it totally orders one run. */
  seq: number;
  step: string;
  outcome: string;
  /** MEAL-4 failure taxonomy. Null on ok/skipped rows and on pre-taxonomy rows. */
  code: string | null;
  duration_ms: number | null;
  /** Which item of the basket this row is about, when the step is per-item. */
  item_index: number | null;
  detail: Record<string, unknown> | null;
  /** The config the CLIENT was running for this step — see `versionsSeen`. */
  config_version: number | null;
  app_version: string | null;
  occurred_at: string | null;
}

/** The run row, in the shape the drilldown route selects it. */
export interface TraceRunRow {
  id: string;
  store_id: string;
  source: string | null;
  status: string;
  outcome: string | null;
  meal_count: number | null;
  items_requested: number | null;
  items_added: number | null;
  started_at: string | null;
  completed_at: string | null;
  config_version: number | null;
  app_version: string | null;
  platform: string | null;
}

/** Outcomes that are not a failure: it worked, or it was deliberately not done. */
const NON_FAILURE_OUTCOMES = new Set(['ok', 'skipped']);

/** The WAF/robot-wall code, held apart from drift exactly as the funnel holds it. */
const BLOCK_CODE = 'waf_block';

/** A row that hit a robot wall, by any of the three ways the app can say so. */
export function isBlockedStep(s: Pick<TraceStepRow, 'step' | 'outcome' | 'code'>): boolean {
  return s.step === 'blocked' || s.outcome === 'blocked' || s.code === BLOCK_CODE;
}

/** A row that went wrong and a WAF is not why. */
export function isFailingStep(s: Pick<TraceStepRow, 'step' | 'outcome' | 'code'>): boolean {
  if (isBlockedStep(s)) return false;
  return !NON_FAILURE_OUTCOMES.has(s.outcome);
}

/**
 * The first thing that went wrong in this run, or an explicit reason there is no
 * such answer.
 *
 * A verdict rather than a nullable step, for the same reason `worstStep` is one:
 * the ways there is nothing to name are different sentences on the screen, and
 * rendering them all as "nothing failed" is a claim none of them supports.
 *
 * Blocks count as a failure here — unlike in the funnel, where they are pulled out
 * of every rate. That difference is deliberate: the funnel separates them because
 * mixing a WAF campaign into a selector-drift rate destroys the only bit that says
 * which one you have. A trace has no rate to protect, and "the run stopped at a
 * robot wall on seq 4" is precisely the sentence someone opened it for.
 */
export type FirstFailure =
  | {
      kind: 'failed';
      seq: number;
      step: string;
      outcome: string;
      code: string | null;
      itemIndex: number | null;
      /** True when the first thing to go wrong was a robot wall, not drift. */
      blocked: boolean;
    }
  /** Every row read was ok or skipped. */
  | { kind: 'clean' }
  /** No step rows at all — MEAL-122, not an idle run. */
  | { kind: 'no_trace' }
  /** The rows are a prefix of the run, so "first" is unanswerable. */
  | { kind: 'incomplete' };

/**
 * What `seq` says about rows that never made it into the table.
 *
 * `seq` is assigned by the CLIENT and ingest keeps it verbatim, so the gaps are
 * informative. Ingest `continue`s past a row whose `step` or `outcome` this deploy
 * does not recognise (deliberately — losing one row beats 400-ing a whole batch),
 * and a batch that a client dropped after a 4xx is never retried. Both leave a
 * hole in the sequence. So a gap means ROWS ARE MISSING, which is a different and
 * more alarming statement than "the run did fewer things".
 */
export interface SeqCoverage {
  min: number | null;
  max: number | null;
  /** Rows present. */
  count: number;
  /** `max - min + 1 - count`: rows the client numbered that never landed. */
  missing: number;
  /** True when the numbering starts above 1, so the run's opening rows are gone. */
  startsLate: boolean;
}

/**
 * Every config and app version any row of this run mentions.
 *
 * Plural on purpose. The run row records the versions the client reported when it
 * STARTED, and step batches each carry their own — so a config push mid-run, or an
 * app updated between batches, shows up here as two values and nowhere else. That
 * is the attribution half of the ticket: a trace that can be pinned to a config
 * push is worth more than one that can only be pinned to a day.
 */
export interface VersionsSeen {
  configVersions: number[];
  appVersions: string[];
  /** True when the rows disagree — a push landed mid-run, or two builds reported. */
  mixed: boolean;
}

export interface TraceSummary {
  /** Rows in `steps`, however many the run really has. */
  stepsRead: number;
  /**
   * True only when the read reached the end of this run's rows AND reconciled
   * against the row count taken before paging.
   *
   * Everything derived below is qualified by it. A `false` here makes
   * `firstFailure` `incomplete` rather than a guess off a prefix.
   */
  complete: boolean;
  firstFailure: FirstFailure;
  /** Rows that went wrong, blocks excluded — the drift-shaped ones. */
  failures: number;
  /** Rows that hit a robot wall. */
  blocked: number;
  /**
   * The code on the terminal `run_summary` row, if the run wrote one.
   *
   * NOT a cause. See MEAL-123 in the header: it is the run's most frequent code,
   * so it can name the noise and hide the wall. Compare it against
   * `firstFailure` — when they disagree, `firstFailure` is the one that saw the
   * rows in order.
   */
  runSummaryCode: string | null;
  /** True when the run wrote a `run_summary` row at all. */
  hasRunSummary: boolean;
  seq: SeqCoverage;
  versions: VersionsSeen;
  /**
   * The steps this run never reported, out of the per-item four.
   *
   * Same list the funnel's `coverage.missingSteps` uses, so the two views agree
   * about what "no data" looks like.
   */
  missingItemSteps: string[];
  /**
   * True when the run produced no per-item rows at all: the MEAL-122 blind spot
   * for one run rather than for a store. The UI must say "not instrumented", never
   * "did nothing".
   */
  noItemInstrumentation: boolean;
  /** Items the run asked for that it never reported adding. Null without both counts. */
  itemsMissed: number | null;
}

/** The steps a run emits once per item; their total absence is MEAL-122. */
const ITEM_STEPS = ['search', 'candidates', 'add_click', 'confirm'] as const;

/** Sorted, de-duplicated, nulls dropped. */
function distinct<T>(values: (T | null | undefined)[]): T[] {
  const set = new Set<T>();
  for (const v of values) if (v !== null && v !== undefined) set.add(v);
  return [...set].sort((a, b) =>
    typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b)));
}

/**
 * Everything that can be said about one run from its rows.
 *
 * `steps` must already be in `seq` order — the route orders the query by it, which
 * is a total order because `(run_id, seq)` is unique and the query is filtered to
 * one run. Deliberately NOT re-sorted here: a defensive sort in this function
 * would make the route's `.order('seq')` untestable, and losing the order is
 * exactly the mistake worth a failing test.
 */
export function summarizeTrace(
  run: TraceRunRow,
  steps: TraceStepRow[],
  read: { complete: boolean },
): TraceSummary {
  const seqs = steps.map((s) => s.seq).filter((n) => typeof n === 'number' && Number.isFinite(n));
  const min = seqs.length > 0 ? Math.min(...seqs) : null;
  const max = seqs.length > 0 ? Math.max(...seqs) : null;

  const failing = steps.filter(isFailingStep);
  const blocked = steps.filter(isBlockedStep);

  // The first row, in the run's own order, that either failed or hit a wall.
  const firstBad = steps.find((s) => isFailingStep(s) || isBlockedStep(s)) ?? null;

  let firstFailure: FirstFailure;
  if (!read.complete) firstFailure = { kind: 'incomplete' };
  else if (steps.length === 0) firstFailure = { kind: 'no_trace' };
  else if (!firstBad) firstFailure = { kind: 'clean' };
  else {
    firstFailure = {
      kind: 'failed',
      seq: firstBad.seq,
      step: firstBad.step,
      outcome: firstBad.outcome,
      code: firstBad.code ?? null,
      itemIndex: firstBad.item_index ?? null,
      blocked: isBlockedStep(firstBad),
    };
  }

  const runSummary = steps.filter((s) => s.step === 'run_summary');
  // The LAST one if a client somehow wrote more than one: the terminal row is the
  // run's final word, and `(run_id, seq)` only stops it being written twice with
  // the same seq.
  const terminal = runSummary.length > 0 ? runSummary[runSummary.length - 1] : null;

  // Versions from the run row AND from every step row. The run row's are what the
  // client reported at start; a step batch can carry different ones.
  const configVersions = distinct<number>([run.config_version, ...steps.map((s) => s.config_version)]);
  const appVersions = distinct<string>([run.app_version, ...steps.map((s) => s.app_version)]);

  const present = new Set(steps.map((s) => s.step));
  const missingItemSteps = ITEM_STEPS.filter((s) => !present.has(s));

  const requested = run.items_requested;
  const added = run.items_added;
  const itemsMissed =
    typeof requested === 'number' && typeof added === 'number' ? Math.max(0, requested - added) : null;

  return {
    stepsRead: steps.length,
    complete: read.complete,
    firstFailure,
    failures: failing.length,
    blocked: blocked.length,
    runSummaryCode: terminal?.code ?? null,
    hasRunSummary: terminal != null,
    seq: {
      min,
      max,
      count: steps.length,
      missing: min != null && max != null ? Math.max(0, max - min + 1 - steps.length) : 0,
      startsLate: min != null && min > 1,
    },
    versions: {
      configVersions,
      appVersions,
      mixed: configVersions.length > 1 || appVersions.length > 1,
    },
    missingItemSteps,
    noItemInstrumentation: missingItemSteps.length === ITEM_STEPS.length,
    itemsMissed,
  };
}

/**
 * How long a run may sit at `status = 'started'` before it is called ABANDONED
 * rather than still going.
 *
 * `status = 'started'` alone cannot tell the two apart, and they are opposite
 * sentences: one is "the engine wedged, go look", the other is "come back in a
 * minute". The list orders `started_at DESC`, so without a band the in-flight
 * runs — the newest rows there are — sort to the TOP of the failing list and read
 * as a wave of abandonments. During a store's dinner-hour peak the first screen is
 * then entirely runs that will complete normally, which is worse than useless: it
 * is an outage that is not happening.
 *
 * WHERE 15 MINUTES COMES FROM. A run's wall clock is bounded by the timeout
 * config, not by the basket. Under `BUNDLED_AUTOMATION_CONFIG` (mealio_app,
 * `lib/automation-config/schema.ts`) the per-item budget is `searchMs` 15s +
 * `addMs` 10s = 25s worst case, with `loginCheckMs` 20s and the cart probes
 * (~32s) paid once per run; a 20-item basket walked strictly serially is
 * therefore about 9 minutes, and `flags.parallelAdd` (3 workers, on by default)
 * divides the per-item half of that. `NUMERIC_BOUNDS` caps every individual
 * timeout at 120s, so a remote push cannot make the tail unbounded either.
 *
 * 15 minutes is ~50% headroom over that serial worst case. It errs toward calling
 * a dead run RUNNING for a while — which delays one diagnosis — rather than
 * toward calling a live run ABANDONED, which manufactures one. The band is only
 * ever a LABEL: nothing is hidden from the list by it, so the cost of the wrong
 * guess is a word on a badge and not a missing row.
 */
export const RUNNING_GRACE_MS = 15 * 60 * 1000;

/**
 * Is this run row something an operator would want to look at?
 *
 * The definition the LIST endpoint filters on, written here so the route's
 * PostgREST predicate and the label the UI puts on a row cannot drift apart. See
 * the route for why the filter is on the run row rather than on the steps.
 *
 * Four ways a run is not a clean success, and they are genuinely different
 * failures:
 *
 *   * `status` still 'started' and `started_at` older than `RUNNING_GRACE_MS` —
 *     the run never reported finishing. The app was killed, or the engine wedged.
 *     There is no failing step to find for these, which is half the argument for
 *     filtering on the run row. Inside the grace band the same row is `running`
 *     instead: a distinct state, because it is not a fault yet.
 *   * `outcome` null on a run that did finish, or any outcome other than
 *     'success'.
 *   * A 'success' that added fewer items than it was asked for. Computed here per
 *     row from the two columns, which works whether or not the `partial_adds`
 *     generated column exists — see the list route for how the server-side term
 *     degrades when the migration has not been applied.
 */
export function runConcern(
  run: Pick<TraceRunRow, 'status' | 'outcome' | 'items_requested' | 'items_added' | 'started_at' | 'completed_at'>,
  now: number = Date.now(),
): {
  running: boolean;
  abandoned: boolean;
  failed: boolean;
  partialAdds: boolean;
  clean: boolean;
} {
  const unterminated = run.status === 'started';
  const startedAt = run.started_at != null ? Date.parse(run.started_at) : NaN;
  // An unreadable or absent `started_at` means the age is unknown. `automation_runs`
  // declares the column NOT NULL DEFAULT now(), so this is defensive — and it
  // resolves toward ABANDONED, the direction that shows a row rather than quietly
  // relabelling it as fine.
  const ageKnown = Number.isFinite(startedAt);
  const running =
    unterminated &&
    // A row carrying a `completed_at` DID report finishing, whatever `status` says
    // — a half-landed completion write, not a run still going.
    run.completed_at == null &&
    ageKnown &&
    now - startedAt < RUNNING_GRACE_MS;
  const abandoned = unterminated && !running;
  const failed = run.outcome != null && run.outcome !== 'success';
  const unfinished = run.outcome == null && !unterminated;
  const partialAdds =
    typeof run.items_requested === 'number' &&
    typeof run.items_added === 'number' &&
    run.items_added < run.items_requested;
  return {
    running,
    abandoned,
    failed,
    partialAdds,
    // A running run is not clean either — it has not finished, so there is nothing
    // yet to call clean. `running` is what the UI badges it, not `OK`.
    clean: !running && !abandoned && !failed && !unfinished && !partialAdds,
  };
}
