/**
 * Reading a whole table out of PostgREST, one page at a time.
 *
 * WHY THIS EXISTS
 *
 * A select with no `.limit()` or `.range()` does not return every row. It returns
 * the first `db-max-rows` — 1000 on Supabase — with no error, no flag and nothing
 * in the body saying the answer was cut short. Code that folds the result in
 * memory keeps working perfectly on every table small enough to test and quietly
 * stops being correct for exactly the rows that grew.
 *
 * That has happened nine times in this codebase. Orphan cleanup deleted 500 live
 * user photos because its keep-set was truncated (MEAL-126). The profit-share
 * leaderboard that payouts come off computed over an arbitrary unordered 1000
 * saves (MEAL-127). The Sources tab reported every creator past the ceiling as
 * having no source configured (MEAL-112). Three separate teams-of-one wrote the
 * same paging loop by hand to fix them, which is the signal that it belongs in
 * one place.
 *
 * WHY THE `.range()` STAYS AT THE CALL SITE
 *
 * The obvious signature would take a finished builder and do the paging out of
 * sight:
 *
 *     fetchAllPages(supabase.from('meals').select('*').eq('user_id', id))  // NO
 *
 * It deliberately does not work that way. `tests/lib/select-bounds.test.ts` reads
 * every select in this repository and fails the build on any that has no visible
 * bound, and it cannot see through a builder handed to a function — so that
 * signature would hide the very thing the check exists to look at, and would make
 * "wrap it in the helper" a way to silence the check rather than a way to satisfy
 * it. Passing a `(from, to) => builder` keeps `.range(from, to)` in the caller's
 * own chain, where both a reader and the checker can see it.
 *
 * The cost of that decision is one arrow function per call site. The benefit is
 * that the safe form is also the shortest form, which is the only version of this
 * that survives.
 */

/** Rows per request. `db-max-rows` on Supabase, so the largest page there is. */
export const PAGE_ROWS = 1000;

/**
 * Requests one read is allowed before it gives up and says so.
 *
 * A bound on one HTTP handler, not a statement about the business: 20 pages is
 * 20,000 rows, two orders of magnitude past anything here. Reaching it is
 * reported through `complete: false` rather than absorbed, because the whole
 * point of this module is that a short answer must never look like a whole one.
 */
export const MAX_PAGES = 20;

export type PageResult<T> = { data: T[] | null; error: { message?: string } | null };

export type PagedRead<T> = {
  rows: T[];
  /**
   * True only when a short page proved the end of the table was reached.
   *
   * False means the rows are a PREFIX, not the answer — either a page failed or
   * `MAX_PAGES` ran out. Callers must not present a `complete: false` read as a
   * total; return `null`, or say "incomplete", the way
   * `app/api/admin/creators/route.ts` does.
   */
  complete: boolean;
  error: { message?: string } | null;
};

/**
 * Runs `page` until it returns a short page, an error, or `MAX_PAGES` is hit.
 *
 * `page` receives an inclusive `[from, to]` row window and must apply it with
 * `.range(from, to)` **and** an `.order()` on a unique column. The order is not
 * optional: an OFFSET walk with no ORDER BY may repeat one row and skip another,
 * because nothing obliges Postgres to hand back the same physical order twice. On
 * a list of creators that is one rendered twice and one missing entirely.
 *
 *     const read = await fetchAllPages<Row>((from, to) =>
 *       supabase.from('meals').select('*').eq('user_id', id)
 *         .order('id', { ascending: true }).range(from, to));
 *     if (!read.complete) { …say so… }
 */
export async function fetchAllPages<T>(
  page: (from: number, to: number) => PromiseLike<PageResult<T>>,
  opts: { pageRows?: number; maxPages?: number } = {},
): Promise<PagedRead<T>> {
  const pageRows = opts.pageRows ?? PAGE_ROWS;
  const maxPages = opts.maxPages ?? MAX_PAGES;
  const rows: T[] = [];

  for (let index = 0; index < maxPages; index++) {
    const from = index * pageRows;
    const { data, error } = await page(from, from + pageRows - 1);

    // A failed page is fatal to the whole read. `data ?? []` here would be the
    // exact mistake that made the orphan sweep delete what it could not read:
    // an error and an empty table become the same value, and the caller folds a
    // missing page into its answer without noticing.
    if (error) return { rows, complete: false, error };

    const batch = data ?? [];
    rows.push(...batch);
    // A short page is the end of the table. A full page proves nothing either
    // way — the next one may be empty — so ask again.
    if (batch.length < pageRows) return { rows, complete: true, error: null };
  }

  return { rows, complete: false, error: null };
}

/**
 * Splits ids into chunks small enough to survive the URI ceiling.
 *
 * A filter travels in the QUERY STRING, so `.in('id', ids)` grows the URL
 * linearly with the id count and the proxy in front of PostgREST rejects a long
 * URI before the database sees it. Measured on this schema (MEAL-112):
 * `creator_id=in.(…)` of n uuids is `15 + 37n` bytes, so 221 uuids fit in 8 KB
 * and **222 come back 414** — not as an exception, but as `data: null`, which
 * `?? []` turns into "no rows found".
 *
 * 100 is the chunk the pollers and the health sweep already use, and it leaves an
 * order of magnitude of headroom.
 */
export const ID_CHUNK = 100;

export function chunkIds<T>(ids: readonly T[], size: number = ID_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}
