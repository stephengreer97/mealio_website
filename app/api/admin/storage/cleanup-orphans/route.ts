import { NextRequest, NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createServerSupabaseClient } from '@/lib/supabase';
import { requireAdmin } from '@/lib/requireAdmin';
import { log } from '@/lib/logger';

export const dynamic = 'force-dynamic';

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

  // List all storage objects via RPC
  const { data: objects, error: listError } = await supabase
    .rpc('list_storage_objects', { bucket: 'meal-photos' });

  if (listError) {
    log({ event: 'STORAGE:CLEANUP', status: 'error', userId: admin.userId, error: listError });
    return NextResponse.json({ error: listError.message }, { status: 500 });
  }

  const storageObjects: { name: string; size: number }[] = objects ?? [];

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
  if (!keepSet.complete) {
    log({
      event: 'STORAGE:CLEANUP', status: 'error', userId: admin.userId,
      reason: 'incomplete keep-set', detail: keepSet.reason,
    });
    return NextResponse.json({
      blocked: true,
      reason: keepSet.reason,
      error: `Refusing to compute orphans: the reference read was incomplete (${keepSet.reason}). Nothing was deleted.`,
      tables: keepSet.tables,
    }, { status: 409 });
  }

  // Find orphans
  const orphanObjects = storageObjects.filter(obj => !keepSet.paths.has(obj.name));
  const orphanPaths = orphanObjects.map(o => o.name);
  const estimatedBytes = orphanObjects.reduce((sum, o) => sum + (o.size ?? 0), 0);

  const orphanShare = storageObjects.length > 0 ? orphanObjects.length / storageObjects.length : 0;
  const shareTooHigh =
    storageObjects.length >= MIN_OBJECTS_FOR_SHARE_CHECK && orphanShare > MAX_ORPHAN_SHARE;

  const stats = {
    objectsListed: storageObjects.length,
    // `list_storage_objects` is a set-returning RPC, so PostgREST caps IT at
    // db-max-rows as well. Truncation there is not destructive — an object we
    // never saw is an object we never delete — but it does mean the counts below
    // describe only part of the bucket, and the operator should know that.
    objectListMaybeTruncated: storageObjects.length >= PAGE_ROWS,
    keepSetSize: keepSet.paths.size,
    referenceRowsRead: keepSet.tables.reduce((sum, t) => sum + t.read, 0),
    orphanShare: Number(orphanShare.toFixed(4)),
    tables: keepSet.tables,
  };

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
      detail: `orphans=${orphanPaths.length}/${storageObjects.length} share=${stats.orphanShare}`,
    });
    return NextResponse.json({
      blocked: true,
      reason: `orphan share ${(orphanShare * 100).toFixed(1)}% exceeds the ${MAX_ORPHAN_SHARE * 100}% ceiling`,
      error:
        `Refusing to delete ${orphanPaths.length} of ${storageObjects.length} objects ` +
        `(${(orphanShare * 100).toFixed(1)}%): that is more of the bucket than a cleanup should ever ` +
        `remove. Check the dry-run list, then re-run with force=true if it is genuinely correct. ` +
        `Nothing was deleted.`,
      orphanCount: orphanPaths.length,
      estimatedBytes,
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

  const warnings: string[] = [];
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
