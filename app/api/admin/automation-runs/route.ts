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
//     runs: [ { …run row as stored…, concern: { abandoned, failed, partialAdds, clean } } ],
//     listMaybeTruncated,   // there are more matching runs than this page shows
//     caveats: string[],    // what this list structurally cannot show
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
 *
 * Not included: a 'success' that added fewer items than requested. PostgREST cannot
 * compare two columns without a computed column or an RPC, so `partialAdds` is
 * computed per row after the fetch and reported in `caveats` as a gap in the
 * filter. Adding a generated column for it is a migration, and this route has to
 * work without one.
 */
const NOT_CLEAN = 'status.eq.started,outcome.is.null,outcome.neq.success';

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
    let query = supabase
      .from('automation_runs')
      .select(RUN_FIELDS)
      .gte('started_at', since)
      .order('started_at', { ascending: false })
      .limit(limit);
    if (storeId) query = query.eq('store_id', storeId);
    if (filter === 'failing') query = query.or(NOT_CLEAN);

    const { data, error } = await query;
    if (error) throw error;

    const rows = (data ?? []) as unknown as TraceRunRow[];
    const runs = rows.map((run) => ({ ...run, concern: runConcern(run) }));

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
      caveats.push(
        'A run that reports outcome=success while adding fewer items than requested is NOT in ' +
        'this list — PostgREST cannot compare two columns. Use filter=all and look at the ' +
        'partialAdds flag for those.',
      );
    }

    return NextResponse.json({
      days,
      since,
      storeId: storeId ?? null,
      filter,
      limit,
      runs,
      listMaybeTruncated,
      caveats,
    });
  } catch (error) {
    log({ event: 'ADMIN:AUTOMATION_RUNS', status: 'error', userId: admin.userId, error });
    return NextResponse.json({ error: 'Failed to list runs' }, { status: 500 });
  }
}
