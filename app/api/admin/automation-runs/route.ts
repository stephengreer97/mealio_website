import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';
import { requireAdmin } from '@/lib/requireAdmin';
import { runConcern, type TraceRunRow } from '@/lib/automation-trace';
import { log } from '@/lib/logger';

// GET /api/admin/automation-runs?storeId=heb&days=7&limit=50&filter=failing|all
//
// THE WAY IN to a single run's trace (MEAL-143). The funnel tells you HEB's confirm
// step fails 12% of the time; this tells you which runs, so the next click can be
// `/api/admin/automation-runs/<id>` for the whole ordered trace. Without it a
// drilldown is only usable by someone who already has a run id, which nobody has.
//
// Response shape:
//   {
//     days, since, storeId, filter, limit,
//     runs: [ { …run row as stored…, concern: { running, abandoned, failed, partialAdds, clean } } ],
//     listMaybeTruncated,    // there are more matching runs than this page shows
//     partialAddsFiltered,   // false when the `partial_adds` migration is not applied
//     inFlight,              // runs in the grace band: RUNNING, not ABANDONED
//     caveats: string[],     // what this list structurally cannot show
//   }
//
// Admin-only: run rows carry a user_id and the trace behind them carries `detail`
// payloads. `user_id` is deliberately NOT selected — an operator debugging a
// selector does not need to know whose basket it was, and the run id is enough to
// join back by hand if an abuse question ever needs it.

export const dynamic = 'force-dynamic';

const MAX_DAYS = 90;
const DEFAULT_DAYS = 7;

/**
 * Runs one request will list, and the ceiling an operator can ask for.
 *
 * Both well under `db-max-rows` (1000), so this is a bound that genuinely binds
 * rather than one chosen to look like a bound. It is a PICKER, not an export: 50
 * recent failures is more than anyone reads before opening one, and the response
 * says outright when there were more.
 */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * The run row, minus `user_id`.
 *
 * `config_version` / `app_version` / `platform` are here because they are half the
 * diagnostic value of the list: three failing runs that all report config v12 and
 * none on v11 is a config push, and that is visible before any trace is opened.
 */
const RUN_FIELDS =
  'id, store_id, source, status, outcome, meal_count, items_requested, items_added, ' +
  'started_at, completed_at, config_version, app_version, platform';

/**
 * The PostgREST predicate for "not a clean, completed success".
 *
 * All three terms are needed and the middle one is the subtle one. Postgres
 * three-valued logic means `outcome <> 'success'` is NULL — not TRUE — for a row
 * whose outcome is NULL, so the row is DROPPED. A run that crashed hard enough to
 * leave `outcome` null while something else moved `status` off 'started' would
 * therefore be filtered out by the very query meant to find it. `outcome.is.null`
 * is what puts it back. (`tests/helpers/supabase-mock.ts` models this correctly,
 * which is how the omission was caught rather than shipped.)
 */
const NOT_CLEAN_TERMS = ['status.eq.started', 'outcome.is.null', 'outcome.neq.success'] as const;

/**
 * The fourth term: a 'success' that added fewer items than it was asked for.
 *
 * PostgREST cannot compare two columns in a filter and cannot ORDER BY the
 * difference, so this is only expressible against a column that already holds the
 * answer — `partial_adds`, the generated column in
 * `supabase/migrations/20260807000001_automation_runs_drilldown_index.sql`.
 *
 * The gap it closes is not cosmetic. Without it, a selector regression that makes
 * every run at a store add one fewer item than requested while still reporting
 * `outcome = 'success'` leaves the default failing list EMPTY. The documented
 * workaround — `filter=all` plus the `PARTIAL` badge — reads a page of the most
 * recent runs of any kind, so at a store doing hundreds of runs a day the broken
 * ones arrive diluted into a sample of mostly-clean rows and read as noise.
 *
 * DEGRADES RATHER THAN 400s. Only Stephen can apply a migration, so this route
 * must answer correctly before it has been applied: PostgREST rejects a filter
 * over a column that does not exist with `42703`, and the retry below drops this
 * one term and restores the pre-migration caveat instead of failing the request.
 * `partialAdds` is computed per row from `items_added`/`items_requested` either
 * way, so the badge is right in both worlds — the only thing the column changes is
 * whether those rows are FOUND.
 */
const PARTIAL_ADDS_TERM = 'partial_adds.is.true';

const NOT_CLEAN = [...NOT_CLEAN_TERMS, PARTIAL_ADDS_TERM].join(',');
const NOT_CLEAN_WITHOUT_PARTIAL_ADDS = NOT_CLEAN_TERMS.join(',');

/** Postgres `undefined_column`. What a filter over `partial_adds` returns pre-migration. */
const UNDEFINED_COLUMN = '42703';

/**
 * Is this error PostgREST refusing a column it does not have?
 *
 * Narrow on purpose: the retry it gates re-runs the query, so it must not swallow
 * anything else. The message check is a belt on the braces because the code is
 * absent from some PostgREST error shapes, and it requires the column NAME so an
 * unrelated `42703` still surfaces as a 500.
 */
function isMissingPartialAdds(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  const mentionsColumn = /partial_adds/.test(error.message ?? '');
  return error.code === UNDEFINED_COLUMN || (mentionsColumn && /does not exist|column/i.test(error.message ?? ''));
}

export async function GET(request: NextRequest) {
  const admin = await requireAdmin(request);
  if (!admin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const params = request.nextUrl.searchParams;
  const daysParam = Number(params.get('days'));
  const days = Number.isFinite(daysParam) && daysParam > 0
    ? Math.min(Math.trunc(daysParam), MAX_DAYS)
    : DEFAULT_DAYS;
  const limitParam = Number(params.get('limit'));
  const limit = Number.isFinite(limitParam) && limitParam > 0
    ? Math.min(Math.trunc(limitParam), MAX_LIMIT)
    : DEFAULT_LIMIT;
  const storeId = params.get('storeId');
  // `all` exists so a store's recent history is walkable even when nothing is
  // failing — a run that succeeded is the control case you compare a broken trace
  // against, and there is no other way to get one's id.
  const filter = params.get('filter') === 'all' ? 'all' : 'failing';

  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const supabase = createServerSupabaseClient();

  try {
    // Newest first and hard-limited. No paging, so the non-unique `started_at`
    // order is safe here in a way it is not in the funnel: OFFSET paging is what
    // makes a tie group at a page boundary able to repeat one row and skip
    // another, and there is no OFFSET. A tie inside one page just orders two rows
    // arbitrarily with respect to each other, which for a picker is nothing.
    const runQuery = (predicate: string | null) => {
      let query = supabase
        .from('automation_runs')
        .select(RUN_FIELDS)
        .gte('started_at', since)
        .order('started_at', { ascending: false })
        .limit(limit);
      if (storeId) query = query.eq('store_id', storeId);
      if (predicate) query = query.or(predicate);
      return query;
    };

    // One attempt with the `partial_adds` term, and one without it if the column is
    // not there yet. Two round trips only on a database that has not had the
    // migration applied, and never for `filter=all`, which has no predicate at all.
    let partialAddsFiltered = filter === 'failing';
    let { data, error } = await runQuery(filter === 'failing' ? NOT_CLEAN : null);
    if (error && filter === 'failing' && isMissingPartialAdds(error)) {
      partialAddsFiltered = false;
      ({ data, error } = await runQuery(NOT_CLEAN_WITHOUT_PARTIAL_ADDS));
    }
    if (error) throw error;

    const rows = (data ?? []) as unknown as TraceRunRow[];
    const now = Date.now();
    const runs = rows.map((run) => ({ ...run, concern: runConcern(run, now) }));
    const inFlight = runs.filter((r) => r.concern.running).length;

    // A full page is the only signal available that there are more: there is no
    // count here on purpose (an exact count over a 90-day window is a second
    // query for a number nobody acts on). Reported rather than left implicit,
    // because "the 50 most recent failures" read as "the failures" is the whole
    // family of bug this codebase keeps finding.
    const listMaybeTruncated = rows.length >= limit;

    const caveats: string[] = [];
    if (listMaybeTruncated) {
      caveats.push(
        `Showing the ${limit} most recent matching runs and there are probably more. ` +
        `Narrow the window or filter to one store.`,
      );
    }
    if (filter === 'failing') {
      caveats.push(
        'Filtered on the RUN row, not on failing steps: the parallel and pre-search add pools ' +
        'emit no step rows at all (MEAL-122), so filtering on a failing step would hide exactly ' +
        'the stores hardest to debug, and abandoned runs have no failing step to find.',
      );
      if (!partialAddsFiltered) {
        caveats.push(
          'A run that reports outcome=success while adding fewer items than requested is NOT in ' +
          'this list — PostgREST cannot compare two columns, and the `partial_adds` generated ' +
          'column this route filters on has not been applied to this database yet. Use filter=all ' +
          'and look at the partialAdds flag for those, and note that filter=all is a page of ' +
          'recent runs of every kind, so at a busy store they arrive diluted.',
        );
      }
      if (inFlight > 0) {
        caveats.push(
          `${inFlight} of these run(s) are still IN FLIGHT — started less than 15 minutes ago and ` +
          `not yet reporting a finish. They carry concern.running, not concern.abandoned, and will ` +
          `most likely complete normally. They sort to the top because the list is newest-first; do ` +
          `not read them as a wave of abandonments.`,
        );
      }
    }

    return NextResponse.json({
      days,
      since,
      storeId: storeId ?? null,
      filter,
      limit,
      runs,
      listMaybeTruncated,
      // Whether "success with fewer items added than requested" was part of the
      // server-side filter, or only computed per row after the fetch. False means
      // the migration is not applied and the list has the gap the caveat describes.
      partialAddsFiltered,
      inFlight,
      caveats,
    });
  } catch (error) {
    log({ event: 'ADMIN:AUTOMATION_RUNS', status: 'error', userId: admin.userId, error });
    return NextResponse.json({ error: 'Failed to list runs' }, { status: 500 });
  }
}
