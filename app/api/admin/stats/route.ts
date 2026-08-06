import { NextRequest, NextResponse } from 'next/server';
import { SupabaseClient } from '@supabase/supabase-js';
import { createServerSupabaseClient } from '@/lib/supabase';
import { requireAdmin } from '@/lib/requireAdmin';
import { log } from '@/lib/logger';

/**
 * PostgREST answers a select with at most `db-max-rows` — 1000 on Supabase — and
 * **says nothing about having truncated**. No error, no flag, nothing in the body.
 * A select with no `.limit()`, `.range()` or `.order()` is therefore not "all the
 * rows", it is an arbitrary and unordered 1000 of them, and which 1000 is decided
 * by physical row order, so the same request can answer differently twice.
 *
 * That is what MEAL-127 was: the profit-share leaderboard folded an unbounded read
 * of `preset_meal_saves` in memory, so every creator's save count — and the payout
 * derived from it — was a fraction of the truth, silently, and a creator whose
 * saves sat past the cut was under-credited permanently.
 *
 * Two rules follow, and this route only uses these two:
 *
 *  - A number Postgres can compute is asked of Postgres, with
 *    `{ count: 'exact', head: true }`. `db-max-rows` caps the ROWS in a response,
 *    not the count in `Content-Range`, so a count is bounded by nothing — and it
 *    is cheaper than shipping every row to Node to call `.length` on it.
 *  - A read that genuinely needs the rows (grouping saves per creator) is ORDERED
 *    and PAGED to exhaustion, the same idiom as `lib/poll-health.ts` and
 *    `app/api/admin/automation-funnel/route.ts`. Unordered paging is not paging:
 *    an OFFSET without an ORDER BY may repeat one row and skip another.
 *
 * `MAX_PAGES` is a bound on one screen draw, not a limit on the business: 50k
 * creator saves in a rolling year is far past where we are. If it is ever reached
 * the leaderboard is withheld rather than shown short — see `incomplete` below.
 */
const PAGE_ROWS = 1000;
const MAX_PAGES = 50;

function getQuarterBounds(year: number, q: number) {
  const startMonth = (q - 1) * 3;
  const start = new Date(year, startMonth, 1);
  const end   = new Date(year, startMonth + 3, 1); // exclusive upper bound
  return { start: start.toISOString(), end: end.toISOString() };
}

function getAvailableQuarters(): { year: number; q: number; label: string }[] {
  const now = new Date();
  const quarters = [];
  let year  = now.getFullYear();
  let q     = Math.floor(now.getMonth() / 3) + 1;

  for (let i = 0; i < 8; i++) {
    quarters.push({ year, q, label: `Q${q} ${year}` });
    q--;
    if (q === 0) { q = 4; year--; }
  }
  return quarters;
}

/**
 * How many `subscription_events` rows of one kind fall in a window, counted by
 * Postgres.
 *
 * `null` means the read failed, and is deliberately not `0`: these feed the net
 * new paid tiles, and "we could not tell" has to reach the operator as a dash
 * rather than as a confident zero. The caller collects nulls into `incomplete`.
 */
async function countEvents(
  supabase: SupabaseClient,
  event: string,
  from?: string,
  to?: string,
): Promise<number | null> {
  let query = supabase
    .from('subscription_events')
    .select('id', { count: 'exact', head: true })
    .eq('event', event);
  if (from) query = query.gte('created_at', from);
  if (to)   query = query.lt('created_at', to);

  const { count, error } = await query;
  return error ? null : (count ?? 0);
}

type CreatorSaveRow = {
  saved_at: string | null;
  preset_meals?: {
    creator_id?: string | null;
    creators?: { id: string; display_name: string } | null;
  } | null;
};

/**
 * Every save on a creator meal inside the rolling window, paged to exhaustion.
 *
 * These rows cannot be a count: the leaderboard groups them by creator, and one
 * count per creator would be a query per row of the table's creator list. So the
 * rows are fetched — but ordered on the primary key and paged with `.range()`,
 * which is the only way an offset walk visits each row exactly once.
 *
 * Two things moved into SQL that used to happen in the loop below:
 *
 *  - **The window.** `saved_at >= annualStart` was applied in Node after fetching
 *    all time, which meant the page ceiling was spent on ancient rows that were
 *    then thrown away — the truncation and the filter fought each other. In SQL it
 *    uses `idx_preset_meal_saves_saved_at` and every row fetched is a row counted.
 *    Note this also drops saves whose `saved_at` is NULL; the old in-memory test
 *    compared `NaN < annualStart`, which is false, so a null-timestamped save used
 *    to be counted as in-window. A save that cannot be dated is not evidence of a
 *    save inside the window, and Postgres agrees: a comparison against NULL is
 *    never true.
 *  - **"Has a creator."** `!inner` on both embeds is the join doing the work that
 *    `.not('preset_meals.creator_id', 'is', null)` used to: a save whose meal has
 *    no creator row is not in the result at all. Expressing it as a nested inner
 *    join rather than a filter on an embedded column keeps one source of truth for
 *    the exclusion, and it is checkable by the fake in `tests/helpers`, which
 *    models embeds but not dotted filters over them.
 *
 * `complete: false` means either a failed page or `MAX_PAGES` — both make the
 * counts short, and neither may be reported as a number.
 */
async function fetchWindowedCreatorSaves(
  supabase: SupabaseClient,
  since: string,
): Promise<{ rows: CreatorSaveRow[]; complete: boolean }> {
  const rows: CreatorSaveRow[] = [];

  for (let page = 0; page < MAX_PAGES; page++) {
    const { data, error } = await supabase
      .from('preset_meal_saves')
      .select('id, saved_at, preset_meals!preset_meal_id!inner ( creator_id, creators!creator_id!inner ( id, display_name ) )')
      .gte('saved_at', since)
      .order('id', { ascending: true })
      .range(page * PAGE_ROWS, page * PAGE_ROWS + PAGE_ROWS - 1);

    if (error) return { rows, complete: false };

    const batch = (data ?? []) as CreatorSaveRow[];
    rows.push(...batch);
    // A short page is the end of the table: everything the filters match was in
    // it. A full page proves nothing either way, so ask again.
    if (batch.length < PAGE_ROWS) return { rows, complete: true };
  }

  return { rows, complete: false };
}

// GET /api/admin/stats?year=YYYY&q=N (defaults to current quarter)
export async function GET(request: NextRequest) {
  const admin = await requireAdmin(request);
  if (!admin) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const supabase = createServerSupabaseClient();
  const now = new Date();

  const currentYear = now.getFullYear();
  const currentQ    = Math.floor(now.getMonth() / 3) + 1;

  const paramYear = request.nextUrl.searchParams.get('year');
  const paramQ    = request.nextUrl.searchParams.get('q');

  const selectedYear = paramYear ? parseInt(paramYear) : currentYear;
  const selectedQ    = paramQ    ? parseInt(paramQ)    : currentQ;
  const isCurrent    = selectedYear === currentYear && selectedQ === currentQ;

  const { start: qtrStart, end: qtrEnd } = getQuarterBounds(selectedYear, selectedQ);
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  // Which aggregates could not be read in full. Everything named here is
  // returned as `null` rather than as a smaller number, so the admin page cannot
  // print a partial figure by forgetting to look — see the response comment.
  const incomplete: string[] = [];

  // Platform-wide meal totals (personal meals created by users) — only for current quarter view
  const [saves30d, savesQtr, savesAll] = await Promise.all([
    isCurrent
      ? supabase.from('meals').select('id', { count: 'exact', head: true }).gte('created_at', thirtyDaysAgo)
      : Promise.resolve({ count: null }),
    supabase.from('meals').select('id', { count: 'exact', head: true })
      .gte('created_at', qtrStart).lt('created_at', qtrEnd),
    isCurrent
      ? supabase.from('meals').select('id', { count: 'exact', head: true })
      : Promise.resolve({ count: null }),
  ]);

  // User signup counts
  const [signups30d, signupsQtr, signupsAll] = await Promise.all([
    isCurrent
      ? supabase.from('user_profiles').select('id', { count: 'exact', head: true }).gte('created_at', thirtyDaysAgo)
      : Promise.resolve({ count: null }),
    supabase.from('user_profiles').select('id', { count: 'exact', head: true })
      .gte('created_at', qtrStart).lt('created_at', qtrEnd),
    isCurrent
      ? supabase.from('user_profiles').select('id', { count: 'exact', head: true })
      : Promise.resolve({ count: null }),
  ]);

  // Subscription events — six counts done by Postgres. This used to be one
  // unbounded select folded in memory, so every all-time figure froze at the
  // 1000-row ceiling and the 30-day and quarter figures were whatever slice of
  // those 1000 rows happened to fall in range.
  const [
    subsStarted30d, subsStartedQtr, subsStartedAll,
    subsCancelled30d, subsCancelledQtr, subsCancelledAll,
  ] = await Promise.all([
    isCurrent ? countEvents(supabase, 'started', thirtyDaysAgo) : null,
    countEvents(supabase, 'started', qtrStart, qtrEnd),
    isCurrent ? countEvents(supabase, 'started') : null,
    isCurrent ? countEvents(supabase, 'cancelled', thirtyDaysAgo) : null,
    countEvents(supabase, 'cancelled', qtrStart, qtrEnd),
    isCurrent ? countEvents(supabase, 'cancelled') : null,
  ]);

  // A null here is a failed count, not "not asked for": the not-current-quarter
  // figures are hard-coded `null` above and are never a read at all.
  const subsIncomplete = (isCurrent
    ? [subsStarted30d, subsStartedQtr, subsStartedAll, subsCancelled30d, subsCancelledQtr, subsCancelledAll]
    : [subsStartedQtr, subsCancelledQtr]
  ).some(v => v === null);
  if (subsIncomplete) incomplete.push('subscriptionEvents');

  /** Net new paid, or null if either side of the subtraction is unknown. */
  const net = (started: number | null, cancelled: number | null) =>
    started === null || cancelled === null ? null : started - cancelled;

  // Profit-share leaderboard is based entirely on a rolling 12-month (365-day) window of creator saves.
  const annualStart = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
  const { rows: windowedSaves, complete: savesComplete } = await fetchWindowedCreatorSaves(supabase, annualStart);

  type CreatorEntry = { name: string; annualSaves: number };
  const creatorMap: Record<string, CreatorEntry> = {};

  let totalCreatorAnnualSaves = 0;

  for (const row of windowedSaves) {
    // Belt and braces against the join: a save whose creator row vanished cannot
    // be credited to anybody, and must not inflate the denominator either.
    const creator = row.preset_meals?.creators;
    if (!creator) continue;

    const { id: creatorId, display_name: creatorName } = creator;
    if (!creatorMap[creatorId]) {
      creatorMap[creatorId] = { name: creatorName, annualSaves: 0 };
    }

    creatorMap[creatorId].annualSaves++;
    totalCreatorAnnualSaves++;
  }

  const creators = Object.values(creatorMap).map(c => ({
    name:        c.name,
    annualSaves: c.annualSaves,
    sharePercent: totalCreatorAnnualSaves > 0
      ? parseFloat((c.annualSaves / totalCreatorAnnualSaves * 100).toFixed(1))
      : 0,
  }));

  // Withheld outright when the read was short. Every number on the leaderboard is
  // payout-relevant, and a short read does not make them smaller uniformly — it
  // drops whichever creators' rows sat past the cut, so the SHARES are wrong too,
  // not just the counts. There is no honest way to render that, so it is not
  // rendered: `null` forces the page to say the figure is unavailable.
  const leaderboard = savesComplete ? [...creators].sort((a, b) => b.annualSaves - a.annualSaves) : null;
  if (!savesComplete) incomplete.push('creatorSaves');

  if (incomplete.length > 0) {
    // Worth an entry in the log as well as the response: this is the failure that
    // used to be invisible, and it decides money.
    log({
      event: 'ADMIN:STATS',
      status: 'error',
      userId: admin.userId,
      reason: 'incomplete read',
      detail: incomplete.join(','),
    });
  }

  return NextResponse.json({
    isCurrent,
    quarterLabel: `Q${selectedQ} ${selectedYear}`,
    availableQuarters: getAvailableQuarters(),
    totals: {
      saves30d:                saves30d.count  ?? null,
      savesQtr:                savesQtr.count  ?? 0,
      savesAll:                savesAll.count  ?? null,
      totalCreatorAnnualSaves: savesComplete ? totalCreatorAnnualSaves : null,
      signups30d:              isCurrent ? (signups30d.count ?? 0)  : null,
      signupsQtr:              signupsQtr.count ?? 0,
      signupsAll:              isCurrent ? (signupsAll.count ?? 0)  : null,
      subsStarted30d,
      subsStartedQtr,
      subsStartedAll,
      subsCancelled30d,
      subsCancelledQtr,
      subsCancelledAll,
      netNewPaid30d:           net(subsStarted30d, subsCancelled30d),
      netNewPaidQtr:           net(subsStartedQtr, subsCancelledQtr),
      netNewPaidAll:           net(subsStartedAll, subsCancelledAll),
    },
    // Aggregates whose underlying read could not be completed — empty on a healthy
    // response. Anything named here is `null` above rather than a smaller number,
    // because a payout figure that is quietly partial is worse than no figure:
    // nobody double-checks a number that looks fine. The admin page turns this
    // into a banner and renders the affected tiles as a dash.
    incomplete,
    // Rolling 12-month leaderboard is window-relative, not quarter-relative — always returned.
    // `null` (not `[]`) when the read was short: an empty list means "no creator
    // saves", which is a different and equally actionable answer.
    leaderboard,
  });
}
