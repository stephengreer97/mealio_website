import { NextRequest, NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createServerSupabaseClient } from '@/lib/supabase';
import { requireAdmin } from '@/lib/requireAdmin';
import { fetchAllPages } from '@/lib/paged-select';
import { log } from '@/lib/logger';

export const dynamic = 'force-dynamic';

/**
 * Matches the sibling storage jobs (`backfill-hashes`, `backfill-photos`), which is
 * the ceiling this one has always needed and never declared.
 *
 * Realistically this is a handful of listing pages plus one paged read per
 * reference source, well inside the default. It is declared because of WHERE a
 * timeout would land: the delete batches run before `invalidateHashes`, so a
 * request cut off in between has destroyed objects whose `photo_hashes` rows still
 * point at them — MEAL-132's poisoning, in place, with no response body to say so.
 * Re-running the sweep clears it, but only if somebody knows to.
 */
export const maxDuration = 300;

const BASE_URL = 'https://etaracmlewdvzpcjrgru.supabase.co/storage/v1/object/public/meal-photos/';

/**
 * One page of referenced-photo rows.
 *
 * Matches Supabase's `db-max-rows`, so a full page is also the signal that there
 * may be another one. See MAX_PAGES.
 */
const PAGE_ROWS = 1000;

/**
 * Page ceiling per table — 2 million rows. Not expected to be reached; it exists
 * so a paging bug can never spin forever against a table that keeps answering.
 * Hitting it is treated as an INCOMPLETE read, never as "that's all of them".
 */
const MAX_PAGES = 2000;

/**
 * One page of the bucket listing.
 *
 * MEAL-134. `list_storage_objects` is a set-returning function, and PostgREST
 * applies `db-max-rows` to a function's result exactly as it does to a table — so
 * the single `.rpc()` call this route used to make returned the first 1000 objects
 * of the bucket and said nothing about the rest.
 *
 * That direction is safe on its own: an object never listed is an object never
 * deleted, so the bug UNDER-deletes. What it is not is honest. The function has no
 * ORDER BY, so *which* 1000 came back was arbitrary and could differ between two
 * runs a minute apart, and an operator sweeping a large bucket to reclaim space
 * watched the reclaimed total plateau while most of the bucket had never been
 * looked at once. Ordering the walk on `name` makes the pages a partition of the
 * bucket rather than three arbitrary samples of it.
 *
 * NO SQL WAS REQUIRED FOR THIS HALF. PostgREST's `limit`/`offset` (which is what
 * supabase-js `.range()` sends) applies to the outer select over the function's
 * result, so the function can be paged from the client with no `LIMIT`/`OFFSET`
 * parameter of its own — `app/api/admin/storage/backfill-hashes/route.ts` has
 * paged this same function that way since MEAL-129. The migration in
 * `supabase/migrations/20260807000002_list_storage_objects_created_at.sql` is for
 * MEAL-133's `created_at` only.
 */
const OBJECT_PAGE_ROWS = 1000;

/**
 * Page ceiling for the bucket listing — 200,000 objects.
 *
 * Two orders of magnitude past this bucket, and deliberately far higher than
 * `lib/paged-select`'s default of 20 pages, because hitting it is now FATAL (see
 * Gate 1): a ceiling low enough to reach in practice would refuse the sweep in
 * exactly the situation where an operator most wants it, a bucket that has grown
 * too large. It exists so a paging bug cannot spin forever, not as a policy about
 * how many photos there may be.
 */
const MAX_OBJECT_PAGES = 200;

/**
 * How old an unreferenced object must be before it may be deleted.
 *
 * MEAL-133. `/api/images/upload` and `storeImageBuffer` hand back a public URL
 * BEFORE anything references it: the client is given the URL and the meal, the
 * creator profile or the import draft that will point at it is saved in a later
 * request, or not at all. For the seconds or minutes in between, a perfectly live
 * photo is genuinely unreferenced by every table in REFERENCE_SOURCES — and a
 * sweep landing in that window saw an orphan and destroyed it, leaving the user's
 * save pointing at nothing. Neither gate can see it: one keep-set row is not
 * missing, so the reconciliation is clean, and one object is nowhere near half the
 * bucket. Unlikely per sweep, unrecoverable when it happens, and likelier the more
 * often the sweep runs.
 *
 * An hour is not tuned; it is chosen to be much longer than any upload-then-save
 * flow (the mobile picker, the web editor, and the import pipeline's
 * download-store-draft sequence are all seconds) and much shorter than the age of
 * anything a sweep is actually trying to reclaim. Nothing is lost by waiting: an
 * object that really is abandoned is still abandoned an hour later, and the next
 * sweep takes it.
 *
 * WHY THIS AND NOT A PROVISIONAL REFERENCE ROW. The alternative MEAL-133 offers is
 * for the upload to write a placeholder reference that the save promotes and a TTL
 * job clears. It is strictly more machinery — a table, a write on the hot upload
 * path, a promotion step in every save path that can forget to promote (which is
 * MEAL-131's failure mode again), and a second sweep to clear what never got
 * promoted — for the same protection this gets from a column the storage layer
 * already maintains.
 *
 * WHY NOT `photo_hashes.created_at`, which needs no migration at all: every upload
 * does write a row there, but `onConflict: 'hash', ignoreDuplicates: true` means a
 * re-upload of already-seen bytes leaves the ORIGINAL row's timestamp in place, so
 * a brand-new object can inherit a year-old `created_at`. That is a wrong answer in
 * the deleting direction, which is the one direction this route may not be wrong
 * in. Objects predating the hash cache have no row at all.
 */
const MIN_OBJECT_AGE_MS = 60 * 60 * 1000;

/**
 * One place a live photo reference is stored.
 *
 * `column` is both what the select asks for and what the null-filter is written
 * against, so the count and the pages always ask the same question — see
 * `readTable`. `extract` turns one row's value for that column into zero or more
 * storage paths.
 *
 * This list is an ALLOWLIST, and that is the shape of the whole bug class: a
 * place to store an image that is not named here is not under-protected, it is
 * DELETED, silently, on the next sweep. MEAL-126 was the reads being short;
 * MEAL-131 was this list being short. Adding a column or a jsonb key that can
 * hold a storage URL without adding it here is a data-loss change, so anything
 * new goes in this list in the same commit. See the note on `extractFromJsonb`
 * for how far that obligation is reduced within a jsonb blob.
 */
interface ReferenceSource {
  table: string;
  column: string;
  extract: (value: unknown, paths: Set<string>) => void;
}

/** A plain `text` column holding at most one URL. */
function extractFromUrlColumn(value: unknown, paths: Set<string>): void {
  const path = toStoragePath(typeof value === 'string' ? value : null);
  if (path) paths.add(path);
}

/**
 * Every storage URL anywhere inside a jsonb value, at any depth.
 *
 * Deliberately a whole-blob scan rather than the narrower `draft->>'photoUrl'`
 * that would answer MEAL-131 exactly, for two reasons.
 *
 * The first is safety of the DEFAULT. Inside a jsonb column this inverts the
 * allowlist above into deny-by-default: the next key added to the draft shape —
 * a per-step photo, a second image, a gallery array — is protected the day it is
 * added, by nobody remembering anything. A key-specific select would make that
 * addition MEAL-131 a second time, and the failure would again be a silent
 * deletion rather than an error.
 *
 * The second is that a jsonb-path select cannot be verified here. PostgREST
 * would take `draft->>photoUrl` in the select and the filter, but if that
 * expression is wrong in any way — the operator, the quoting, a renamed key —
 * the read does not fail. It returns nulls, the count agrees with the pages, the
 * completeness gate passes, and the keep-set is missing every draft photo: the
 * exact bug being fixed, wearing the fix's clothes. The test double this
 * repository uses does not implement jsonb operators either, so a green suite
 * would prove nothing about the real query. Selecting the column whole is a
 * plain column read that behaves identically in both, and the extraction is
 * ordinary TypeScript that the tests genuinely exercise.
 *
 * The cost is transferring the draft blobs rather than one field of each. On an
 * operator-triggered sweep over a review queue that is thousands of rows at
 * most, that is the cheaper half of the trade.
 */
function extractFromJsonb(value: unknown, paths: Set<string>): void {
  if (typeof value === 'string') { extractFromUrlColumn(value, paths); return; }
  if (Array.isArray(value)) {
    for (const item of value) extractFromJsonb(item, paths);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const nested of Object.values(value)) extractFromJsonb(nested, paths);
  }
}

/** Every table whose contents protect an object from deletion. */
const REFERENCE_SOURCES: readonly ReferenceSource[] = [
  { table: 'meals',                 column: 'photo_url', extract: extractFromUrlColumn },
  { table: 'preset_meals',          column: 'photo_url', extract: extractFromUrlColumn },
  { table: 'creators',              column: 'photo_url', extract: extractFromUrlColumn },
  { table: 'creator_applications',  column: 'photo_url', extract: extractFromUrlColumn },
  // MEAL-131. The import pipeline stores a creator's page image through
  // `storeImageBuffer` — same bucket as everything else — and the URL lands on
  // `draft.photoUrl`, INSIDE the jsonb. So there is no `photo_url` column here
  // to read: a column select would have found nothing even if the table had been
  // scanned. Until the draft is published nothing else references the object, so
  // every sweep deleted it and the creator's review queue rendered a broken
  // image. Unlike MEAL-126 this needed no particular table size; it fired every
  // time.
  //
  // No status filter: `creator_import_drafts` marks a decision and never deletes
  // the row, and a cancelled draft's photo is still displayed as part of the
  // record of what was proposed. Every row of this table is a live reference.
  //
  // `confidence` is NOT read. It holds field provenance — level, match, score,
  // and the evidence span quoted from the source page — and no storage URL of
  // ours. If it ever carries one it belongs in this list as its own source.
  { table: 'creator_import_drafts', column: 'draft',     extract: extractFromJsonb },
];

/**
 * Refuse to delete when more than this share of the bucket looks orphaned.
 *
 * A backstop for keep-set corruption that row counting cannot see — most
 * concretely, BASE_URL drifting away from the project's real storage host, which
 * makes `toStoragePath` return null for every row. Every table then reconciles
 * perfectly against its count and the keep-set is still empty.
 *
 * Deliberately NOT the primary guard. In the case that motivated MEAL-126 —
 * 1000 of 1500 meals read — the 500 live photos wrongly marked orphaned are a
 * third of the bucket, comfortably under any threshold anybody would set here.
 * A proportion check would have watched that deletion happen.
 */
const MAX_ORPHAN_SHARE = 0.5;

/**
 * Below this many objects the share check is noise: an all-but-empty bucket that
 * genuinely is all orphans is both plausible and cheap to be wrong about.
 */
const MIN_OBJECTS_FOR_SHARE_CHECK = 50;

/**
 * Public URLs per `photo_hashes` delete.
 *
 * `.in('url', […])` is a query-string filter, so the URI grows with the list, and
 * one public URL is ~105 characters that percent-encode to ~155 bytes. The
 * 100-item chunk `lib/push.ts` uses for Expo tokens would therefore be a ~16 KB
 * DELETE URI — inside the 8–16 KB range Cloudflare and Kong reject, so it would
 * not be slow, it would 414. 25 keeps it under 4 KB, which also stays under the
 * 8 KB ceiling the fake in `tests/helpers/supabase-mock.ts` enforces.
 *
 * A 414 here is not just a missing invalidation: it would leave exactly the
 * poisoned rows this route exists to remove, on the biggest sweeps only.
 */
const HASH_FILTER_CHUNK = 25;

function toStoragePath(url: string | null | undefined): string | null {
  if (!url) return null;
  if (url.startsWith(BASE_URL)) return url.slice(BASE_URL.length);
  return null;
}

/** One object in the bucket, as this route needs it. */
interface StorageObject {
  name: string;
  size: number;
  /**
   * Creation time in epoch milliseconds, or null when it could not be
   * established from what the RPC returned. Null means AGE UNKNOWN, and age
   * unknown is never treated as old — see `splitByAge`.
   */
  createdAt: number | null;
}

/**
 * Reads `created_at` off one listing row.
 *
 * Strings only, because that is what PostgREST renders a `timestamptz` as, and
 * every other shape is something this route does not understand. A number is
 * rejected rather than guessed at: epoch seconds and epoch milliseconds differ by
 * a factor of a thousand and picking the wrong one makes a young object look
 * decades old, which is the one error this must not make. Anything unparseable
 * therefore lands on null — age unknown, keep the object.
 *
 * `storage.objects.created_at` is a `timestamptz`, so PostgREST emits an explicit
 * offset and `Date.parse` needs no help. (A naive timestamp with no offset would
 * be read as server-local; on Vercel that is UTC, and any drift from a
 * behind-UTC server makes objects look YOUNGER, which keeps them.)
 */
function toEpochMs(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/** The bucket listing, plus what is known about how trustworthy it is. */
interface ObjectListing {
  objects: StorageObject[];
  /** True only when a short page proved the end of the bucket was reached. */
  complete: boolean;
  /**
   * True when the RPC answered with a `created_at` column at all — i.e. the
   * migration has been applied. False is the PRE-MIGRATION shape, in which no
   * object's age is knowable and the grace window cannot be applied to any of
   * them.
   */
  ageColumn: boolean;
  /** Set when `complete` is false: which page, and why it stopped there. */
  reason?: string;
  /** A page that failed outright, reported the way the old single call was. */
  error: { message?: string } | null;
}

/**
 * Every object in the bucket, paged to exhaustion and ordered on `name`.
 *
 * TOLERATING BOTH SHAPES OF THE RPC, which it has to: the migration that adds
 * `created_at` can only be applied by hand, so this code runs against the old
 * two-column function until somebody does, and pre-migration behaviour must be
 * today's behaviour rather than an error.
 *
 * That is why the select is `*` rather than `name, size, created_at`. Asking for a
 * column the old function does not return is a 42703 from Postgres — the whole
 * listing fails, and the route stops working the moment it deploys. `*` returns
 * whatever the function declares, so the shape is discovered from the rows instead
 * of asserted at them: `created_at` present on a row means the migration is in,
 * absent means it is not. There is no error to classify and no second round trip,
 * and the same code path serves both shapes.
 *
 * The presence test is on the KEY, not the value. `select=*` renders every declared
 * column, so a post-migration row always carries the key even when the value is
 * null (`storage.objects.created_at` is nullable), and that distinction is
 * load-bearing: a null value on a listing that HAS the column is one object of
 * unknown age, which is kept, while the column being absent altogether is the old
 * function, under which nothing's age is known and the window is simply not
 * available. Collapsing the two would turn the pre-migration deploy into a sweep
 * that deletes nothing and reports zero orphans, which looks like success.
 */
async function listAllObjects(supabase: SupabaseClient): Promise<ObjectListing> {
  const read = await fetchAllPages<Record<string, unknown>>(
    (from, to) =>
      supabase
        .rpc('list_storage_objects', { bucket: 'meal-photos' })
        .select('*')
        .order('name', { ascending: true })
        .range(from, to),
    { pageRows: OBJECT_PAGE_ROWS, maxPages: MAX_OBJECT_PAGES },
  );

  const objects: StorageObject[] = [];
  const seen = new Set<string>();
  let ageColumn = false;

  for (const row of read.rows) {
    if (row && typeof row === 'object' && 'created_at' in row) ageColumn = true;
    const name = row?.name;
    // A row with no usable name names no object, so there is nothing to delete
    // and nothing to protect. Dropped rather than coerced: leaving it in would put
    // `undefined` into a `remove()` batch, and counting it would move the Gate 2
    // denominator for an object that does not exist.
    if (typeof name !== 'string' || name === '') continue;
    // An OFFSET walk over a bucket being written to can hand the same object back
    // twice, because an upload landing earlier in the `name` ordering shifts every
    // later object one place forward. Names are unique within a bucket, so a repeat
    // is always the walk and never two objects — deduplicated here so it cannot
    // double-count `objectsListed`, inflate `estimatedBytes`, or ask storage to
    // remove one path twice and then report the second attempt as unconfirmed.
    if (seen.has(name)) continue;
    seen.add(name);
    const size = typeof row.size === 'number' ? row.size : 0;
    objects.push({ name, size, createdAt: toEpochMs(row.created_at) });
  }

  return {
    objects,
    complete: read.complete,
    ageColumn,
    error: read.error,
    reason: read.complete
      ? undefined
      : read.error
        ? `object list: page read failed after ${objects.length} object(s): ${read.error.message ?? 'unknown error'}`
        : `object list: hit the ${MAX_OBJECT_PAGES}-page ceiling (${MAX_OBJECT_PAGES * OBJECT_PAGE_ROWS} objects) without reaching the end of the bucket`,
  };
}

/** How the grace window split the unreferenced objects. */
interface AgeSplit {
  /** Unreferenced AND old enough to delete. */
  deletable: StorageObject[];
  /** Unreferenced but too new, or of unknown age. Kept. */
  tooNew: StorageObject[];
}

/**
 * Splits unreferenced objects into what may be deleted and what is protected by
 * the grace window.
 *
 * Every branch that cannot establish an age keeps the object, with the single
 * documented exception of the pre-migration RPC shape (`ageColumn` false), where
 * no age exists to establish for any object and the route must go on behaving as
 * it did before this change rather than turning itself off.
 *
 * A future-dated `created_at` — a clock ahead of this server's — gives a negative
 * age, which is below the window and therefore kept. That is the right way round.
 */
function splitByAge(unreferenced: StorageObject[], ageColumn: boolean, now: number): AgeSplit {
  if (!ageColumn) return { deletable: unreferenced, tooNew: [] };

  const deletable: StorageObject[] = [];
  const tooNew: StorageObject[] = [];
  for (const object of unreferenced) {
    if (object.createdAt === null || now - object.createdAt < MIN_OBJECT_AGE_MS) tooNew.push(object);
    else deletable.push(object);
  }
  return { deletable, tooNew };
}

/** Per-table result of the keep-set read, reported so a refusal names the table. */
interface TableRead {
  table: string;
  /** Exact row count PostgREST reported for the same filter, before paging. */
  expected: number | null;
  /** Rows actually read across all pages. */
  read: number;
  pages: number;
  complete: boolean;
  reason?: string;
}

interface KeepSet {
  paths: Set<string>;
  tables: TableRead[];
  /** True only when every table was read to exhaustion and reconciled. */
  complete: boolean;
  reason?: string;
}

/**
 * Reads one reference source to exhaustion, paged, folding every storage path it
 * yields into `paths`.
 *
 * An unlimited select is not "all rows": PostgREST answers with the first
 * `db-max-rows` of them, with no error and nothing saying it truncated. That is
 * what MEAL-126 was — four unbounded selects, so from meal 1001 onward a live
 * photo was simply absent from the keep-set and the sweep deleted it.
 *
 * Ordered on the primary key rather than left to chance, like the other paged
 * reads in this codebase (`lib/poll-health.ts`, `lib/admin-sync.ts`): an
 * unordered OFFSET may return one row twice and skip another, and for a keep-set
 * a skipped row is a deleted photo.
 *
 * The exact count is taken BEFORE paging, and the caller requires
 * `read >= expected`. The asymmetry is deliberate, because ids are random uuids
 * so a concurrent write lands in the middle of the ordering rather than the end:
 *
 *  - An INSERT during the walk shifts later rows forward, so a row can be read
 *    twice. Harmless — `paths` is a set, and the keep-set only ever grows.
 *  - A DELETE during the walk shifts later rows back, so a row can be SKIPPED —
 *    the same failure as truncation, from a different cause. Then
 *    `read < expected` and the caller refuses.
 *
 * The one case that slips through is an insert and a delete inside the same walk,
 * whose ±1 cancel in `read` while a row was still skipped. Keyset paging
 * (`.gt('id', last)`) would be immune, but it is not the idiom the rest of this
 * codebase pages with; the residual is one photo in a window of seconds on a
 * hand-triggered sweep, against the cost of a second paging pattern to review.
 */
async function readTable(
  supabase: SupabaseClient,
  source: ReferenceSource,
  paths: Set<string>,
): Promise<TableRead> {
  const { table, column } = source;

  // Rows with nothing in the column cannot protect an object, so they are
  // filtered out of both the count and the pages. The filter is written once,
  // here, on purpose: if the count and the pages ever disagreed about which rows
  // they cover, the reconciliation below would be comparing two different
  // questions. (On a NOT NULL column like `creator_import_drafts.draft` the
  // filter is a no-op, which is why it can stay unconditional.)
  const rowsWithPhotos = () =>
    supabase.from(table).select(column).not(column, 'is', null);

  const { count, error: countError } = await supabase
    .from(table)
    .select(column, { count: 'exact', head: true })
    .not(column, 'is', null);

  if (countError) {
    return {
      table, expected: null, read: 0, pages: 0, complete: false,
      reason: `count failed: ${countError.message ?? 'unknown error'}`,
    };
  }

  let read = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const from = page * PAGE_ROWS;
    const { data, error } = await rowsWithPhotos()
      .order('id', { ascending: true })
      .range(from, from + PAGE_ROWS - 1);

    if (error) {
      // A failed page read used to be indistinguishable from an empty one:
      // `res.data ?? []` contributed nothing to the keep-set and the sweep
      // carried on and deleted the difference. It is now fatal.
      return {
        table, expected: count ?? null, read, pages: page, complete: false,
        reason: `page ${page} failed: ${error.message ?? 'unknown error'}`,
      };
    }

    // Through `unknown` because the select list is a variable rather than a
    // literal, so supabase-js can no longer infer the row shape from it and
    // falls back to `GenericStringError[]`. The runtime shape is a row object
    // keyed by `column`; `extract` treats anything else as no reference.
    const rows = (data ?? []) as unknown as Array<Record<string, unknown>>;
    for (const row of rows) source.extract(row[column], paths);
    read += rows.length;

    // A short page is the only proof there is nothing after it. A full page may
    // be the last one, in which case the next read comes back empty and this
    // ends one request later — cheaper than being wrong about it.
    if (rows.length < PAGE_ROWS) {
      const expected = count ?? 0;
      return {
        table, expected: count ?? null, read, pages: page + 1,
        complete: read >= expected,
        reason: read >= expected
          ? undefined
          : `read ${read} of ${expected} rows (rows moved under the walk, or the read was truncated)`,
      };
    }
  }

  return {
    table, expected: count ?? null, read, pages: MAX_PAGES, complete: false,
    reason: `hit the ${MAX_PAGES}-page ceiling without reaching the end`,
  };
}

/** The keep-set, plus whether it can be trusted to be complete. */
async function collectReferencedPaths(supabase: SupabaseClient): Promise<KeepSet> {
  const paths = new Set<string>();
  const tables: TableRead[] = [];

  // Sequential, not Promise.all as before: every source paged concurrently is a
  // burst of requests against one PostgREST instance for no benefit on an
  // operator-triggered sweep, and a partial failure is easier to report.
  //
  // Driven off REFERENCE_SOURCES so a source cannot be added to the keep-set
  // without also being reconciled below — an unreconciled source would be a
  // truncatable read whose truncation is not fatal, which is MEAL-126 again.
  for (const source of REFERENCE_SOURCES) {
    tables.push(await readTable(supabase, source, paths));
  }

  const broken = tables.filter((t) => !t.complete);
  return {
    paths,
    tables,
    complete: broken.length === 0,
    reason: broken.length === 0
      ? undefined
      : broken.map((t) => `${t.table}: ${t.reason}`).join('; '),
  };
}

/**
 * The subset of `batch` that storage reported as ACTUALLY removed.
 *
 * `remove()` is not all-or-nothing. It answers 200 with the rows it deleted, and a
 * path it did not delete — already gone, renamed under it, or refused by a storage
 * policy — is simply ABSENT from that list rather than raised as an `error`. So a
 * batch can half-succeed with `error` null, and this list is the only evidence of
 * which half. `name` on those rows is the object's key within the bucket, which is
 * both what this route asked to delete and what its public URL is built from.
 *
 * Intersected with what was asked for rather than trusted wholesale, so a hash row
 * can only ever be dropped for a path THIS run put in a remove call.
 *
 * When the list is missing altogether — `null`, which a client version or a proxy
 * that drops the response body can produce — this returns nothing. The hash rows
 * then stay, the response reports them as unconfirmed, and behaviour degrades to
 * exactly what it was before MEAL-132 rather than to deleting rows on a guess.
 */
function confirmedRemovals(batch: string[], removed: unknown): string[] {
  if (!Array.isArray(removed)) return [];
  const asked = new Set(batch);
  const confirmed = new Set<string>();
  for (const entry of removed) {
    const name = (entry as { name?: unknown } | null)?.name;
    if (typeof name === 'string' && asked.has(name)) confirmed.add(name);
  }
  return [...confirmed];
}

/** Outcome of dropping the dedupe rows for the objects this run destroyed. */
interface HashInvalidation {
  /** `photo_hashes` rows actually removed. */
  deleted: number;
  /** Destroyed objects whose row could not be dropped, because the delete failed. */
  failed: number;
  /** True only when every delete this run attempted succeeded. */
  complete: boolean;
  reason?: string;
}

/**
 * Drops the `photo_hashes` rows that point at objects which no longer exist.
 *
 * MEAL-132. `photo_hashes` is a content-addressed cache of "these bytes are
 * already stored, here is the URL", read by `storeImageBuffer` and by
 * `/api/images/upload` before they upload anything. Deleting the object without
 * deleting the row leaves a permanent lie: the next upload of those exact bytes
 * matches the row, is handed the URL of an object that is gone, and saves a meal
 * or a draft with a broken image. Re-uploading cannot fix it, because dedupe keeps
 * answering with the same dead URL for the same bytes — one sweep poisons that
 * image for every future upload of it, with no user-visible way out. It also
 * falsifies MEAL-131's recovery path: re-running an import re-downloads the same
 * source image, hashes to the same sha256, and gets the dead URL straight back.
 *
 * `photo_hashes` is emphatically NOT a reference source and must never join
 * REFERENCE_SOURCES: every object ever uploaded has a row here, so protecting
 * objects with it would make the keep-set equal the bucket and disable the cleanup
 * silently. It is a cache to invalidate, not a reference to honour.
 *
 * Rows are addressed by `url`, not by `hash`, because this route never sees the
 * bytes — only paths. That URL is `BASE_URL + path`, the exact string both writers
 * store (`getPublicUrl(path)`), so an object's row is found by rebuilding it. A row
 * written in some other shape simply does not match and is left behind, which is
 * the safe direction below.
 *
 * ORDER AND ERROR DIRECTION. Called only with paths storage confirmed are gone, and
 * only after they are gone, so the two ways to be wrong are not symmetrical:
 *
 *  - Leaving a row whose object went away costs dedupe correctness until the next
 *    sweep — and it is recoverable, since re-running the cleanup deletes it.
 *  - Deleting a row whose object SURVIVED costs dedupe for a live image: the next
 *    upload of those bytes stores a second copy. Wasteful, but never a broken
 *    image, and self-correcting.
 *
 * Both are mild next to the poisoning above, so this errs toward the first: no
 * confirmation from storage means no delete. A partially failed batch invalidates
 * only its confirmed half, and a hash delete that fails is reported rather than
 * folded into a clean-looking sweep — this route had never written to
 * `photo_hashes` before, and a silent failure here reads exactly like the bug.
 */
async function invalidateHashes(
  supabase: SupabaseClient,
  paths: string[],
): Promise<HashInvalidation> {
  let deleted = 0;
  let failed = 0;
  const reasons: string[] = [];

  for (let i = 0; i < paths.length; i += HASH_FILTER_CHUNK) {
    const chunk = paths.slice(i, i + HASH_FILTER_CHUNK);
    const { count, error } = await supabase
      .from('photo_hashes')
      .delete({ count: 'exact' })
      .in('url', chunk.map((path) => `${BASE_URL}${path}`));

    if (error) {
      failed += chunk.length;
      reasons.push(`${chunk.length} at offset ${i}: ${error.message ?? 'unknown error'}`);
      continue;
    }

    // A confirmed-removed object with no row is normal, not a failure: objects
    // predating the hash cache, and anything `backfill-hashes` never reached, have
    // none. So this counts rows deleted and never compares it to the object count.
    deleted += count ?? 0;
  }

  return {
    deleted,
    failed,
    complete: failed === 0,
    reason: reasons.length > 0 ? reasons.join('; ') : undefined,
  };
}

export async function POST(request: NextRequest) {
  const admin = await requireAdmin(request);
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const dryRun = request.nextUrl.searchParams.get('dryRun') === 'true';
  // Overrides the orphan-share backstop only — a judgement call an operator is
  // allowed to overrule, e.g. the first sweep of a bucket that has never been
  // cleaned. It does NOT override the completeness gate, which is a defect
  // report rather than a judgement.
  const force = request.nextUrl.searchParams.get('force') === 'true';

  const supabase = createServerSupabaseClient();

  // Every object in the bucket, paged — see OBJECT_PAGE_ROWS for why one `.rpc()`
  // call was never the whole bucket.
  const listing = await listAllObjects(supabase);

  // A page that failed outright is reported as the single call always was: a 5xx,
  // because the request failed rather than the route declining to act on it. It
  // does not reach either gate, so nothing is deleted either way.
  if (listing.error) {
    log({ event: 'STORAGE:CLEANUP', status: 'error', userId: admin.userId, error: listing.error });
    return NextResponse.json({ error: listing.error.message }, { status: 500 });
  }

  const storageObjects = listing.objects;

  // Every referenced photo_url, paged to exhaustion.
  // Soft-deleted meals (is_active=false) are included — their photos are NOT
  // orphans, since a restore has to find the image still there.
  const keepSet = await collectReferencedPaths(supabase);

  // ── Gate 1: completeness ──────────────────────────────────────────────────
  // An incomplete keep-set does not under-report orphans, it INVENTS them: every
  // row it failed to read is a live photo that now looks unreferenced. So this
  // blocks the dry run too. The dry run was the safety mechanism here and it did
  // not catch MEAL-126 precisely because it printed a confident, plausible list
  // computed from the same truncated keep-set. A number that cannot be trusted
  // must not be rendered as a number.
  //
  // The OBJECT LIST is held to the same standard, because once it is paged
  // "everything was read" has two halves and the gate has to assert both. A short
  // listing is not dangerous the way a short keep-set is — an object never listed
  // is never deleted — but every number this route reports is computed from it:
  // `objectsListed`, `orphanCount`, `estimatedBytes` and, most importantly,
  // `orphanShare`, whose denominator IS the listing. Gate 2 is a proportion, and a
  // proportion measured over an unknown fraction of an unordered bucket is not the
  // proportion it claims to be. Letting the sweep proceed on a partial listing
  // would leave Gate 2 nominally intact and quietly measuring something else,
  // which is the same trade MEAL-126 made when it printed a confident dry run.
  //
  // What it does NOT do is reconcile the listing against an exact count the way
  // `readTable` reconciles each table, and that asymmetry is deliberate rather than
  // an omission. A row skipped by the keep-set walk is a live photo that turns into
  // an orphan, so it must be caught; an object skipped by the bucket walk is an
  // object this run does not delete, which costs one deferred reclaim. And the
  // bucket is written to continuously by every upload in the product, so a count
  // taken before the walk would disagree with the rows after it as a matter of
  // routine — reconciling here would refuse most sweeps to guard the one direction
  // that is already safe. Completeness of the listing is therefore "the pages
  // reached the end", which is exactly what a short page proves.
  const gate1 = [listing.reason, keepSet.reason].filter(Boolean).join('; ');
  if (gate1) {
    log({
      event: 'STORAGE:CLEANUP', status: 'error', userId: admin.userId,
      reason: 'incomplete read', detail: gate1,
    });
    return NextResponse.json({
      blocked: true,
      reason: gate1,
      error: `Refusing to compute orphans: the read was incomplete (${gate1}). Nothing was deleted.`,
      tables: keepSet.tables,
      objectsListed: storageObjects.length,
      objectListComplete: listing.complete,
      objectListMaybeTruncated: !listing.complete,
    }, { status: 409 });
  }

  // Unreferenced by every source in REFERENCE_SOURCES. NOT yet the delete set:
  // MEAL-133's grace window comes off it below.
  const unreferenced = storageObjects.filter(obj => !keepSet.paths.has(obj.name));

  const { deletable: orphanObjects, tooNew } =
    splitByAge(unreferenced, listing.ageColumn, Date.now());
  const orphanPaths = orphanObjects.map(o => o.name);
  const estimatedBytes = orphanObjects.reduce((sum, o) => sum + (o.size ?? 0), 0);

  // ── The Gate 2 numerator is UNREFERENCED, not deletable ───────────────────
  // Measured before the grace window rather than after, so MEAL-133's fix cannot
  // talk MEAL-126's backstop down. Gate 2 exists to catch a keep-set that is
  // complete but useless — BASE_URL drifting, so every row reads as a non-path and
  // the keep-set comes out empty — and that corruption shows up as objects being
  // unreferenced, whatever their age. Scoring the share on the post-grace delete
  // set would let a bucket of fresh uploads dilute exactly the signal the gate
  // watches for, and would make the gate's verdict depend on when the sweep ran.
  const orphanShare = storageObjects.length > 0 ? unreferenced.length / storageObjects.length : 0;
  const shareTooHigh =
    storageObjects.length >= MIN_OBJECTS_FOR_SHARE_CHECK && orphanShare > MAX_ORPHAN_SHARE;

  const stats = {
    objectsListed: storageObjects.length,
    /**
     * The bucket listing was read to its end. Always true on a 200 now that the
     * listing is paged and Gate 1 refuses when it is not — it is a guarantee here
     * rather than the guess it used to be.
     *
     * One seam was considered and left alone: `fetchAllPages` reads
     * `data: null, error: null` as a short page, i.e. the end of the bucket, and
     * `lib/paged-select.ts` records that a 414 arrives in exactly that shape
     * (MEAL-112). A 414 mid-walk would therefore end the listing early and be
     * reported as complete. It cannot happen on this call — the URI is a constant
     * length, with no `.in()` filter growing it — and if it somehow did, the missing
     * objects are objects this run does not delete. Under-reclaiming, not
     * over-deleting.
     */
    objectListComplete: listing.complete,
    // Kept, and no longer vestigial: it is now the exact negation of
    // `objectListComplete`, so it can only be true on Gate 1's 409, where it says
    // WHICH half of the read came up short. Before paging it meant "this listing
    // was 1000 objects long, which is suspiciously exactly the ceiling"; it now
    // means "the pages did not reach the end of the bucket", which is a fact
    // rather than a suspicion. A consumer that only ever checked this field still
    // gets a correct answer.
    objectListMaybeTruncated: !listing.complete,
    keepSetSize: keepSet.paths.size,
    referenceRowsRead: keepSet.tables.reduce((sum, t) => sum + t.read, 0),
    /** Objects no table references — the Gate 2 numerator, before the grace window. */
    unreferencedCount: unreferenced.length,
    /** Unreferenced objects held back because they are new, or of unknown age. */
    objectsTooNewToDelete: tooNew.length,
    graceWindowMinutes: MIN_OBJECT_AGE_MS / 60_000,
    /**
     * False against the pre-migration `list_storage_objects`, which returns no
     * `created_at`: no object's age is knowable, so MEAL-133's window protects
     * nothing and the sweep behaves exactly as it did before. This field is how an
     * operator can tell that the migration is still outstanding.
     */
    ageFilterAvailable: listing.ageColumn,
    orphanShare: Number(orphanShare.toFixed(4)),
    tables: keepSet.tables,
  };

  /** Said on every response, because a sweep with no age filter is the old sweep. */
  const ageWarning = listing.ageColumn ? [] : [
    'The bucket listing carried no created_at, so `list_storage_objects` has not been migrated yet ' +
    '(supabase/migrations/20260807000002_list_storage_objects_created_at.sql). Objects uploaded seconds ' +
    'ago cannot be told from abandoned ones, so a photo a user is part-way through attaching can still ' +
    'be deleted (MEAL-133). Apply the migration to enable the ' +
    `${MIN_OBJECT_AGE_MS / 60_000}-minute grace window.`,
  ];

  if (dryRun) {
    log({
      event: 'STORAGE:CLEANUP', status: 'success', userId: admin.userId,
      detail: `dry-run orphans=${orphanPaths.length} keep=${keepSet.paths.size} share=${stats.orphanShare}`,
    });
    // The share verdict rides along rather than blocking: the dry run exists so a
    // human can look at the list, and it is the list itself that tells them
    // whether the sweep has gone wrong. The live run is where it bites.
    return NextResponse.json({
      dryRun: true,
      orphanCount: orphanPaths.length,
      estimatedBytes,
      paths: orphanPaths,
      // Listed, not just counted: "why is this object still here" is a question a
      // dry run should answer, and the grace window is now one of the answers.
      tooNewPaths: tooNew.map((o) => o.name),
      ...(ageWarning.length > 0 ? { warnings: ageWarning } : {}),
      wouldBlock: shareTooHigh,
      ...(shareTooHigh ? {
        blockReason:
          `${(orphanShare * 100).toFixed(1)}% of listed objects look orphaned, over the ` +
          `${MAX_ORPHAN_SHARE * 100}% ceiling. Deletion will refuse unless re-run with force=true.`,
      } : {}),
      ...stats,
    });
  }

  // ── Gate 2: orphan share ──────────────────────────────────────────────────
  if (shareTooHigh && !force) {
    log({
      event: 'STORAGE:CLEANUP', status: 'error', userId: admin.userId,
      reason: 'orphan share over ceiling',
      detail: `unreferenced=${unreferenced.length}/${storageObjects.length} share=${stats.orphanShare}`
        + ` deletable=${orphanPaths.length} tooNew=${tooNew.length}`,
    });
    return NextResponse.json({
      blocked: true,
      reason: `orphan share ${(orphanShare * 100).toFixed(1)}% exceeds the ${MAX_ORPHAN_SHARE * 100}% ceiling`,
      error:
        `Refusing to delete: ${unreferenced.length} of ${storageObjects.length} objects ` +
        `(${(orphanShare * 100).toFixed(1)}%) are referenced by nothing, which is more of the bucket than a ` +
        `cleanup should ever remove. Check the dry-run list, then re-run with force=true if it is genuinely ` +
        `correct. Nothing was deleted.`,
      orphanCount: orphanPaths.length,
      estimatedBytes,
      ...(ageWarning.length > 0 ? { warnings: ageWarning } : {}),
      ...stats,
    }, { status: 409 });
  }

  // Delete in batches of 100
  let deleted = 0;
  /** Paths storage confirmed are gone — the only ones whose hash row may be dropped. */
  const removedForCertain: string[] = [];
  /** Paths asked for whose removal storage did not confirm, so their row stays. */
  let removalsUnconfirmed = 0;

  for (let i = 0; i < orphanPaths.length; i += 100) {
    const batch = orphanPaths.slice(i, i + 100);
    const { data: removedRows, error: deleteError } =
      await supabase.storage.from('meal-photos').remove(batch);
    if (deleteError) {
      log({ event: 'STORAGE:CLEANUP', status: 'error', userId: admin.userId, error: deleteError, detail: `batch ${i}` });
      removalsUnconfirmed += batch.length;
      continue;
    }
    deleted += batch.length;
    const confirmed = confirmedRemovals(batch, removedRows);
    removedForCertain.push(...confirmed);
    removalsUnconfirmed += batch.length - confirmed.length;
  }

  // Invalidate the dedupe cache LAST, and only for what is provably gone. Nothing
  // above this line is reached on a dry run or on either gate's refusal, so those
  // paths write no rows either — a dry run that pruned a cache would not be one.
  const hashes = await invalidateHashes(supabase, removedForCertain);

  const warnings: string[] = [...ageWarning];
  if (removalsUnconfirmed > 0) {
    warnings.push(
      `${removalsUnconfirmed} of ${orphanPaths.length} object(s) were asked for but storage did not ` +
      `confirm removing them, so their photo_hashes rows were deliberately left in place.`,
    );
  }
  if (!hashes.complete) {
    warnings.push(
      `${hashes.failed} photo_hashes row(s) for objects that WERE deleted could not be removed ` +
      `(${hashes.reason}). Uploading those exact bytes again will be handed the deleted URL until ` +
      `this cleanup is re-run, which is safe to do.`,
    );
    log({
      event: 'STORAGE:CLEANUP', status: 'error', userId: admin.userId,
      reason: 'photo_hashes invalidation incomplete', detail: hashes.reason,
    });
  }

  log({
    event: 'STORAGE:CLEANUP', status: 'success', userId: admin.userId,
    detail:
      `deleted=${deleted} estimatedBytes=${estimatedBytes} keep=${keepSet.paths.size}` +
      ` objects=${storageObjects.length} unreferenced=${unreferenced.length} tooNew=${tooNew.length}` +
      ` ageFilter=${listing.ageColumn ? 'on' : 'UNAVAILABLE'}` +
      ` hashRowsDeleted=${hashes.deleted} hashDeletesFailed=${hashes.failed}` +
      ` unconfirmed=${removalsUnconfirmed}${force ? ' forced' : ''}`,
  });
  return NextResponse.json({
    dryRun: false,
    deleted,
    // Reported alongside `deleted` so the two can be compared: a batch that
    // errored is logged, and this is where it shows up as a gap.
    orphanCount: orphanPaths.length,
    estimatedBytes,
    paths: orphanPaths,
    forced: force,
    // `deleted` counts paths storage accepted without an error; this counts the
    // ones it listed back as genuinely removed, which is the number the hash
    // invalidation is driven from. A gap between them is a half-succeeded batch.
    removalsConfirmed: removedForCertain.length,
    removalsUnconfirmed,
    hashRowsDeleted: hashes.deleted,
    hashDeletesFailed: hashes.failed,
    // A sweep that removed objects but could not prune their dedupe rows has left
    // the MEAL-132 poisoning in place for those bytes. It must not read as clean.
    hashInvalidationComplete: hashes.complete,
    ...(warnings.length > 0 ? { warnings } : {}),
    ...stats,
  });
}
