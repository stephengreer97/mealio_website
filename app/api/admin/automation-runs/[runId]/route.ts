import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';
import { requireAdmin } from '@/lib/requireAdmin';
import { fetchAllPages } from '@/lib/paged-select';
import { summarizeTrace, type TraceRunRow, type TraceStepRow } from '@/lib/automation-trace';
import { log } from '@/lib/logger';

// GET /api/admin/automation-runs/[runId]
//
// One run, step by step (MEAL-143). Every telemetry row already carries `run_id`
// and a monotonic `seq`, and ingest holds `(run_id, seq)` unique and upserts with
// ignoreDuplicates — so a complete, ordered, per-run trace has existed in the
// database since the funnel shipped and nothing could read it. This reads it.
//
// Response shape:
//   {
//     run: { …run row as stored… },
//     steps: [ { seq, step, outcome, code, duration_ms, item_index, detail, … } ],
//     summary: TraceSummary,       // see lib/automation-trace.ts
//     read: { stepsRead, expectedSteps, pagesComplete, complete, reason? },
//     truncated,                   // the negation of read.complete, hoisted
//     caveats: string[],
//   }
//
// Row data is passed through in its stored shape — `duration_ms`, `item_index`,
// snake case — rather than renamed into camelCase. A rename is a place a column can
// be silently dropped or mistyped, and the funnel's own `StepRow` already speaks
// this shape. Derived fields (`summary`, `read`) are camelCase, and the split is
// the boundary between "what the database said" and "what we concluded".
//
// ADMIN ONLY, AND NOT NEGOTIABLE. `detail` is a client-supplied payload — search
// terms, product names, page state — and it is the reason this route exists at all.
// Anything unauthenticated that returned a trace would be publishing what a named
// user put in their basket.

export const dynamic = 'force-dynamic';

/**
 * The run row, minus `user_id`.
 *
 * Same list as the list endpoint, for the same reason: the operator question is
 * about a store's automation, not about whose basket it was. The run id is enough
 * to join back by hand if an abuse question ever needs the user.
 */
const RUN_FIELDS =
  'id, store_id, source, status, outcome, meal_count, items_requested, items_added, ' +
  'started_at, completed_at, config_version, app_version, platform';

/**
 * `config_version` and `app_version` are selected PER STEP, not just off the run.
 *
 * The run row records what the client said when it started. A step batch carries
 * its own, so a config push that landed mid-run, or an app updated between batches,
 * is visible here and nowhere else — which is what makes a trace attributable to a
 * specific push rather than to a day.
 */
const STEP_FIELDS =
  'seq, step, outcome, code, duration_ms, item_index, detail, config_version, app_version, occurred_at';

/**
 * A uuid, near enough for a route parameter.
 *
 * Checked before the query because `automation_runs.id` is a `uuid` column and
 * PostgREST answers a malformed comparison with a 400 and code 22P02 — which this
 * route would otherwise log as an internal error and return as a 500, so a typo in
 * the URL would read as a broken server.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ runId: string }> },
) {
  const admin = await requireAdmin(request);
  if (!admin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { runId } = await params;
  if (!UUID_RE.test(runId ?? '')) {
    return NextResponse.json({ error: 'runId must be a uuid' }, { status: 400 });
  }

  const supabase = createServerSupabaseClient();

  try {
    const { data: run, error: runError } = await supabase
      .from('automation_runs')
      .select(RUN_FIELDS)
      .eq('id', runId)
      .maybeSingle();

    if (runError) throw runError;
    // `maybeSingle`, not `single`: an unknown id is a 404, not a 500. Runs are
    // pruned and a bookmarked trace outlives its row.
    if (!run) return NextResponse.json({ error: 'Run not found' }, { status: 404 });

    // The row count for this run, taken BEFORE paging, so the pages can be
    // reconciled against it. `readTable` in the orphan-cleanup route does exactly
    // this, and the asymmetry is the same: rows can only be APPENDED to a run's
    // trace (ingest upserts and never deletes), so `read < expected` means the read
    // was short, while `read > expected` just means a late batch landed during the
    // walk — which is not a problem, since a trace only ever grows.
    const { count, error: countError } = await supabase
      .from('automation_steps')
      .select('seq', { count: 'exact', head: true })
      .eq('run_id', runId);

    if (countError) throw countError;

    // Paged, and ordered by `seq` ASCENDING — which is both the order the trace is
    // meant to be read in and a TOTAL order, because `(run_id, seq)` carries a
    // unique index and this query is filtered to one run. That is why this can page
    // on the display column while the funnel cannot: there, `occurred_at` is
    // non-unique even within one store, so a tie group straddling a page boundary
    // could hand back one row twice and skip another.
    //
    // A single busy run really can exceed a page: ingest accepts 200 steps per
    // batch with no cap on batches, and a large basket emits several rows per item.
    // A trace truncated at 1000 would be actively misleading — completeness is the
    // entire point of looking at one run — so it is paged and any shortfall is
    // reported rather than absorbed.
    const read = await fetchAllPages<TraceStepRow>((from, to) =>
      supabase
        .from('automation_steps')
        .select(STEP_FIELDS)
        .eq('run_id', runId)
        .order('seq', { ascending: true })
        .range(from, to));

    // A failed page is fatal, not a caveat. The two other ways to come up short —
    // the page ceiling, and a count the rows do not reconcile with — are properties
    // of a read that otherwise worked, and a labelled prefix is still useful for
    // diagnosis. An errored page is a broken read, and answering 200 with whatever
    // arrived before it would make a database problem look like a short run.
    if (read.error) throw read.error;

    const expectedSteps = count ?? null;
    const reconciled = expectedSteps == null || read.rows.length >= expectedSteps;
    const complete = read.complete && reconciled;

    const reason = !read.complete
      ? 'the page ceiling was reached before the end of the trace'
      : !reconciled
        ? `read ${read.rows.length} of ${expectedSteps} step rows`
        : undefined;

    const summary = summarizeTrace(run as unknown as TraceRunRow, read.rows, { complete });

    const caveats: string[] = [];
    if (!complete) {
      caveats.push(
        `This trace is INCOMPLETE (${reason}). The steps below are a prefix of the run, not the ` +
        `run. Do not read the last row as where it stopped, and treat every count here as a ` +
        `lower bound.`,
      );
    }
    if (summary.noItemInstrumentation) {
      caveats.push(
        'This run reported no search, candidates, add_click or confirm rows at all. That is the ' +
        'parallel/pre-search add pool reporting nothing (MEAL-122), or a store that adds through ' +
        'the public API rather than the WebView, NOT a run that did nothing. Judge it on ' +
        'items_added and the run outcome.',
      );
    }
    if (summary.seq.missing > 0 || summary.seq.startsLate) {
      caveats.push(
        `The seq numbering has ${summary.seq.missing} hole(s)` +
        (summary.seq.startsLate ? ` and starts at ${summary.seq.min} rather than 1` : '') +
        '. seq comes from the client, so a gap means rows are MISSING. Ingest skips a step name ' +
        'or outcome it does not recognise, and a batch the client dropped after a 4xx is never ' +
        'retried. It does not mean the run did fewer things.',
      );
    }
    if (summary.runSummaryCode) {
      caveats.push(
        `run_summary reports "${summary.runSummaryCode}", which is the run's MOST FREQUENT code ` +
        `and not its most severe (MEAL-123): three confirm_failed and one waf_block reports ` +
        `confirm_failed. Trust the ordered steps below over it.`,
      );
    }
    if (summary.versions.mixed) {
      caveats.push(
        'Rows in this run disagree about config_version or app_version, so a config push or an ' +
        'app update landed mid-run. Attribute it to both, not to one.',
      );
    }

    return NextResponse.json({
      run,
      steps: read.rows,
      summary,
      read: {
        stepsRead: read.rows.length,
        expectedSteps,
        pagesComplete: read.complete,
        complete,
        ...(reason ? { reason } : {}),
      },
      // Hoisted to the top level alongside `read.complete` because a caller that
      // checks one flag will check this one, and a partial trace presented as a
      // whole one is the failure mode this endpoint has.
      truncated: !complete,
      caveats,
    });
  } catch (error) {
    log({ event: 'ADMIN:AUTOMATION_RUN_TRACE', status: 'error', userId: admin.userId, error });
    return NextResponse.json({ error: 'Failed to load run trace' }, { status: 500 });
  }
}
