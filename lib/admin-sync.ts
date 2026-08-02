/**
 * Operator-driven sync (MEAL-90).
 *
 * Two modes, one engine: paste a single link, or tick items off a creator's
 * catalog. Both build a `creator_sync_runs` row holding the selection and let a
 * worker chew through it; running the two through the same code is what makes
 * "the gate still ran, and here is what it said" true of a one-link sync as much
 * as a 200-item one.
 *
 * Three things this file is careful about, all of them the same worry — that a
 * batch acting on a creator's behalf gets quietly wrong:
 *
 *   1. **Rendering the catalog is free.** Titles, dates and links come from feed
 *      metadata; nothing here fetches a post or calls a model to draw a list.
 *      Opening a 200-post blog costs the feed request and the already-imported
 *      lookup, and nothing else.
 *   2. **The gate still runs.** An operator selecting an item is not a bypass. A
 *      selected post that is not a recipe is dropped with its reason recorded,
 *      so "I selected 12 and got 9" is explainable on screen.
 *   3. **One failure does not sink the batch.** Every item has its own outcome
 *      in `creator_source_items`; a failure stays retryable on its own.
 *
 * Admin sync publishes **directly** — it never writes `creator_import_drafts`.
 * MEAL-77 forbids acting on a creator's behalf *without their knowledge*, and
 * what keeps this on the right side of that is the email at the bottom of this
 * file, not an approval queue.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { publishCreatorMeal } from '@/lib/creator-meals';
import { sendCreatorSyncPublishedEmail } from '@/lib/email';
import { log } from '@/lib/logger';
import { SOURCE_COLUMNS, SOURCE_LABELS, type PlatformSource } from '@/lib/creator-sources';
import { discoverFeed, readFeed, type FeedDiscoveryResult } from '@/lib/import/feed-discovery';
import { runImport, type RunImportOptions } from '@/lib/import/pipeline';
import { loadRobots } from '@/lib/import/robots';
import type { SafeFetchOptions } from '@/lib/import/ssrf';
import { formatTelemetry } from '@/lib/import/telemetry';
import type { FeedKind } from '@/lib/import/feed';
import type { ImportResult } from '@/lib/import/types';

// ── Shapes ───────────────────────────────────────────────────────────────────

/**
 * Per-item outcome inside a run.
 *
 * `rejected` and `failed` mean different things to an operator and must not be
 * merged: rejected is the gate saying this is not a recipe (a correct answer,
 * retrying changes nothing), failed is us not managing to read it (a timeout, a
 * 503, a classifier outage — worth another go).
 */
export type SyncItemStatus = 'pending' | 'imported' | 'rejected' | 'failed' | 'skipped';

export interface SyncItem {
  /** Feed guid / video id / the URL itself. Half of the `creator_source_items` key. */
  itemId: string;
  url: string;
  title: string | null;
  publishedAt: string | null;
  status: SyncItemStatus;
  /** The gate's sentence, the fetch failure, or why it was skipped. */
  detail: string | null;
  mealId: string | null;
  mealName: string | null;
  costUsd: number;
  /**
   * True once this item has appeared in an email to the creator. Per item rather
   * than per run so a retry that publishes later still gets announced, without
   * re-announcing the nine that already went out.
   */
  notified?: boolean;
}

export type SyncRunStatus = 'queued' | 'running' | 'done';
export type SyncRunMode = 'link' | 'catalog';

export interface SyncRun {
  id: string;
  creatorId: string;
  source: PlatformSource;
  mode: SyncRunMode;
  status: SyncRunStatus;
  notifyCreator: boolean;
  items: SyncItem[];
  notifiedAt: string | null;
  notifyError: string | null;
  createdAt: string | null;
  finishedAt: string | null;
}

/** Counts the sync screen shows, so "selected 12, published 9" adds up on screen. */
export interface SyncRunTotals {
  selected: number;
  pending: number;
  imported: number;
  rejected: number;
  failed: number;
  skipped: number;
  costUsd: number;
}

export function summariseRun(run: SyncRun): SyncRunTotals {
  const count = (status: SyncItemStatus) => run.items.filter((item) => item.status === status).length;
  return {
    selected: run.items.length,
    pending: count('pending'),
    imported: count('imported'),
    rejected: count('rejected'),
    failed: count('failed'),
    skipped: count('skipped'),
    costUsd: run.items.reduce((total, item) => total + (item.costUsd || 0), 0),
  };
}

/** Row shape → the type everything else here speaks. */
export function toSyncRun(row: Record<string, any>): SyncRun {
  return {
    id: row.id,
    creatorId: row.creator_id,
    source: row.source,
    mode: row.mode,
    status: row.status,
    notifyCreator: Boolean(row.notify_creator),
    items: Array.isArray(row.items) ? (row.items as SyncItem[]) : [],
    notifiedAt: row.notified_at ?? null,
    notifyError: row.notify_error ?? null,
    createdAt: row.created_at ?? null,
    finishedAt: row.finished_at ?? null,
  };
}

export interface SyncCreator {
  id: string;
  user_id: string;
  display_name: string;
  website_url?: string | null;
  youtube_url?: string | null;
  instagram_url?: string | null;
  tiktok_url?: string | null;
  feed_url?: string | null;
}

/** Everything the creator engine needs, injectable so tests need no network. */
export interface SyncDeps {
  supabase: SupabaseClient;
  fetchOptions?: SafeFetchOptions;
  /** The import pipeline seam. Tests substitute a stub; production runs the real thing. */
  importer?: (url: string, options: RunImportOptions) => Promise<ImportResult>;
  publisher?: typeof publishCreatorMeal;
  notifier?: typeof sendCreatorSyncPublishedEmail;
  now?: () => number;
}

// ── Catalog ──────────────────────────────────────────────────────────────────

/**
 * Ceiling on catalog size, matching the feed parser's own cap. A blog with more
 * posts than this is not a checklist problem, it is a "sync the recent ones and
 * come back" problem.
 */
export const CATALOG_MAX_ENTRIES = 500;

export interface CatalogEntry {
  itemId: string;
  url: string;
  title: string | null;
  publishedAt: string | null;
  /**
   * The `creator_source_items` record, when there is one. Drives the
   * already-imported marker, and the row starts deselected because select-all on
   * a catalog half of which is already in is the obvious expensive mistake.
   */
  record: { status: string; detail: string | null; at: string | null } | null;
}

export type CatalogResult =
  | {
      ok: true;
      source: PlatformSource;
      feed: { url: string; kind: FeedKind; via: string } | null;
      entries: CatalogEntry[];
      /** True when the source published more than we will list. */
      truncated: boolean;
    }
  | { ok: false; reason: string; detail: string };

/**
 * Lists everything a creator's source publishes, from feed metadata alone.
 *
 * A confirmed `feed_url` is re-read rather than re-discovered — an operator
 * already looked at that feed and said yes, and re-deriving it would make the
 * confirmation meaningless (and cost three more requests).
 */
export async function buildCatalog(
  deps: SyncDeps,
  creator: SyncCreator,
  source: PlatformSource,
): Promise<CatalogResult> {
  if (source !== 'website') {
    // Same rule as the viability probe: a source we cannot enumerate reports
    // that plainly and names the ticket. An empty list would read as "this
    // creator publishes nothing", which is the one thing it must not mean.
    const ticket = { youtube: 'MEAL-74', instagram: 'MEAL-82', tiktok: 'MEAL-83' }[source];
    return {
      ok: false,
      reason: 'not-connected',
      detail:
        `${SOURCE_LABELS[source]} cannot be listed yet: it needs the account connection from ${ticket}, ` +
        'which is not built. Use the one-link mode for individual posts in the meantime.',
    };
  }

  const link = creator[SOURCE_COLUMNS[source] as keyof SyncCreator] as string | null | undefined;
  if (!link) {
    return { ok: false, reason: 'no-link', detail: `This creator has no ${SOURCE_LABELS[source]} link.` };
  }

  let origin: string;
  try {
    origin = new URL(creator.feed_url || link).origin;
  } catch {
    return { ok: false, reason: 'no-link', detail: `"${link}" is not a URL we can fetch.` };
  }

  const robots = await loadRobots(origin, deps.fetchOptions);
  const options = { robots, fetchOptions: deps.fetchOptions, maxEntries: CATALOG_MAX_ENTRIES };
  const discovery: FeedDiscoveryResult = creator.feed_url
    ? await readFeed(creator.feed_url, options)
    : await discoverFeed(link, options);

  if (!discovery.ok) {
    return { ok: false, reason: discovery.reason, detail: discovery.detail };
  }

  // One query for the whole catalog, keyed the way the record is keyed. This and
  // the feed read are the entire cost of drawing the screen.
  const { data: records } = await deps.supabase
    .from('creator_source_items')
    .select('item_id, status, detail, updated_at')
    .eq('creator_id', creator.id)
    .eq('source', source);

  const byItemId = new Map<string, { status: string; detail: string | null; at: string | null }>();
  for (const row of (records ?? []) as Array<Record<string, any>>) {
    byItemId.set(String(row.item_id), {
      status: String(row.status),
      detail: row.detail ?? null,
      at: row.updated_at ?? null,
    });
  }

  const entries: CatalogEntry[] = discovery.feed.entries.map((entry) => ({
    itemId: entry.id,
    url: entry.url,
    title: entry.title,
    publishedAt: entry.publishedAt,
    record: byItemId.get(entry.id) ?? null,
  }));

  return {
    ok: true,
    source,
    feed: { url: discovery.feed.url, kind: discovery.feed.kind, via: discovery.feed.via },
    entries,
    truncated: entries.length >= CATALOG_MAX_ENTRIES,
  };
}

// ── Running a selection ──────────────────────────────────────────────────────

/**
 * How long a worker may hold a run.
 *
 * Two browser tabs polling the same run must not import the same post twice, and
 * a worker killed mid-chunk must not wedge the run forever — so this is a lease
 * with an expiry rather than a boolean.
 */
export const LEASE_MS = 90_000;

/**
 * Wall-clock budget for one worker invocation, under the 60s function limit with
 * room for the write-back and the notification. Whatever is left over is picked
 * up by the next call.
 */
export const CHUNK_BUDGET_MS = 40_000;

/** Items imported at once. Each is a fetch plus two model calls; two is plenty. */
export const CHUNK_CONCURRENCY = 2;

function isTerminal(item: SyncItem): boolean {
  return item.status !== 'pending';
}

/**
 * Runs one item: gate, extract, publish, record.
 *
 * Never throws. An item that blows up is a failed item, because the alternative
 * is one bad post taking the other 199 with it.
 */
export async function processSyncItem(
  deps: SyncDeps,
  run: SyncRun,
  creator: SyncCreator,
  item: SyncItem,
): Promise<SyncItem> {
  const supabase = deps.supabase;
  const importer = deps.importer ?? runImport;
  const publisher = deps.publisher ?? publishCreatorMeal;

  // Already in, from an earlier run or the poller. Skipped rather than
  // re-imported: an operator ticking a row they were warned about should not be
  // able to publish the same recipe twice under a creator's name.
  const { data: existing } = await supabase
    .from('creator_source_items')
    .select('status')
    .eq('creator_id', creator.id)
    .eq('source', run.source)
    .eq('item_id', item.itemId)
    .maybeSingle();

  if (existing && (existing as Record<string, any>).status === 'imported') {
    return {
      ...item,
      status: 'skipped',
      detail: 'Already imported — skipped so the same recipe is not published twice.',
    };
  }

  let result: ImportResult;
  try {
    result = await importer(item.url, {
      // The operator picked this URL and is watching it, which is exactly the
      // condition `manual` describes: an `unsure` verdict is attempted rather
      // than silently skipped. A `no` still stops it — that is the gate doing
      // its job, not a bypass to switch off.
      mode: 'manual',
      // Scopes the storage bucket path when a page's image is copied in, so a
      // synced photo lands under the creator it belongs to.
      userId: creator.user_id,
      fetchOptions: deps.fetchOptions,
      telemetry: (event) =>
        log({
          event: 'CREATOR:MEAL_IMPORT',
          status: event.outcome === 'ok' ? 'success' : 'error',
          userId: creator.id,
          detail: formatTelemetry(event),
        }),
    });
  } catch (err) {
    return await recordItem(deps, creator, run, {
      ...item,
      status: 'failed',
      detail: `The import threw before it could report: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  if (result.status === 'rejected') {
    // The gate is an answer about the post; everything else is an answer about
    // our afternoon. Only the first is permanent.
    const rejectedByGate = result.stage === 'gate';
    return await recordItem(deps, creator, run, {
      ...item,
      status: rejectedByGate ? 'rejected' : 'failed',
      detail: result.detail,
      costUsd: 0,
    });
  }

  const costUsd = (result.meta.usage?.costUsd ?? 0) + (result.meta.gateUsage?.costUsd ?? 0);

  try {
    const meal = await publisher(
      supabase,
      { id: creator.id, display_name: creator.display_name, user_id: creator.user_id },
      result.draft,
    );
    return await recordItem(deps, creator, run, {
      ...item,
      status: 'imported',
      detail: null,
      mealId: meal.id,
      mealName: meal.name,
      costUsd,
    });
  } catch (err) {
    // Extraction succeeded and the insert did not. Retryable, and the cost of
    // the extraction is still recorded — it was really spent.
    return await recordItem(deps, creator, run, {
      ...item,
      status: 'failed',
      detail: `Extracted, but publishing failed: ${err instanceof Error ? err.message : String(err)}`,
      costUsd,
    });
  }
}

/**
 * Writes the durable per-item record.
 *
 * `creator_source_items` is what the poller and the next operator read, so it is
 * updated even when the batch row already knows — and a write failure here is
 * logged, not thrown: losing the bookkeeping is bad, losing the run because the
 * bookkeeping failed is worse.
 */
async function recordItem(
  deps: SyncDeps,
  creator: SyncCreator,
  run: SyncRun,
  // Narrowed to the three the table's CHECK constraint accepts, so a new item
  // status can never quietly become an invalid record write.
  item: SyncItem & { status: 'imported' | 'rejected' | 'failed' },
): Promise<SyncItem> {
  try {
    await deps.supabase.from('creator_source_items').upsert(
      {
        creator_id: creator.id,
        source: run.source,
        item_id: item.itemId,
        url: item.url,
        title: item.title,
        published_at: item.publishedAt,
        status: item.status,
        detail: item.detail,
        updated_at: new Date(deps.now?.() ?? Date.now()).toISOString(),
      },
      { onConflict: 'creator_id,source,item_id' },
    );
  } catch (err) {
    log({ event: 'ADMIN:SYNC_ITEM', status: 'error', userId: creator.id, detail: `run=${run.id} item=${JSON.stringify(item.itemId)}`, error: err });
  }
  return item;
}

/**
 * Moves a run forward by one chunk, then returns where it got to.
 *
 * This is the whole background job. It is deliberately *resumable* rather than
 * long-running: it takes a lease, works until its budget is spent, writes what
 * it did and lets go. The admin screen calls it in a loop while a run is
 * unfinished, and the daily cron sweeps anything an operator walked away from —
 * so a closed tab delays a run rather than abandoning it half-published.
 */
export async function advanceRun(deps: SyncDeps, runId: string): Promise<SyncRun | null> {
  const supabase = deps.supabase;
  const now = deps.now ?? Date.now;

  const { data: row } = await supabase.from('creator_sync_runs').select('*').eq('id', runId).maybeSingle();
  if (!row) return null;
  let run = toSyncRun(row as Record<string, any>);

  const nowIso = new Date(now()).toISOString();

  // Claim the lease. `or` covers both "nobody holds it" and "whoever held it is
  // gone"; if neither matches, another worker is mid-chunk and we report
  // progress instead of racing it.
  const { data: claimed } = await supabase
    .from('creator_sync_runs')
    .update({
      status: 'running',
      lease_until: new Date(now() + LEASE_MS).toISOString(),
      started_at: row.started_at ?? nowIso,
      updated_at: nowIso,
    })
    .eq('id', runId)
    .or(`lease_until.is.null,lease_until.lt.${nowIso}`)
    .select();

  if (!Array.isArray(claimed) || claimed.length === 0) {
    return run;
  }

  const creator = await loadSyncCreator(supabase, run.creatorId);
  if (!creator) {
    await supabase
      .from('creator_sync_runs')
      .update({ status: 'done', finished_at: nowIso, lease_until: null, updated_at: nowIso })
      .eq('id', runId);
    log({ event: 'ADMIN:SYNC_RUN', status: 'error', detail: `run=${runId} creator=${run.creatorId} missing` });
    return { ...run, status: 'done' };
  }

  const deadline = now() + CHUNK_BUDGET_MS;
  let items = [...run.items];

  while (items.some((item) => !isTerminal(item)) && now() < deadline) {
    const wave: number[] = [];
    for (let i = 0; i < items.length && wave.length < CHUNK_CONCURRENCY; i++) {
      if (!isTerminal(items[i])) wave.push(i);
    }

    const processed = await Promise.all(
      wave.map((index) => processSyncItem(deps, { ...run, items }, creator, items[index])),
    );
    wave.forEach((index, position) => {
      items[index] = processed[position];
    });

    // Written after every wave, not at the end: the screen polls this row, and a
    // run that shows nothing for four minutes looks broken.
    await supabase
      .from('creator_sync_runs')
      .update({
        items,
        lease_until: new Date(now() + LEASE_MS).toISOString(),
        updated_at: new Date(now()).toISOString(),
      })
      .eq('id', runId);
  }

  const finished = items.every(isTerminal);
  run = { ...run, items, status: finished ? 'done' : 'running' };

  // The email goes out inside the lease, so "did we already tell them?" is never
  // a race between two workers.
  const notified = finished && run.notifyCreator ? await notifyCreator(deps, run, creator) : null;
  if (notified) items = notified.items;

  await supabase
    .from('creator_sync_runs')
    .update({
      items,
      status: finished ? 'done' : 'queued',
      finished_at: finished ? new Date(now()).toISOString() : null,
      lease_until: null,
      updated_at: new Date(now()).toISOString(),
      ...(notified ? { notified_at: notified.notifiedAt, notify_error: notified.notifyError } : {}),
    })
    .eq('id', runId);

  const totals = summariseRun({ ...run, items });
  log({
    event: 'ADMIN:SYNC_RUN',
    status: finished ? 'success' : 'pending',
    userId: creator.id,
    detail:
      `run=${runId} source=${run.source} ${finished ? 'done' : 'partial'} ` +
      `selected=${totals.selected} imported=${totals.imported} rejected=${totals.rejected} ` +
      `failed=${totals.failed} skipped=${totals.skipped} cost=$${totals.costUsd.toFixed(4)}`,
  });

  return { ...run, items, status: finished ? 'done' : 'queued', notifiedAt: notified?.notifiedAt ?? run.notifiedAt };
}

/** Reads the creator fields the engine needs, including the address to notify. */
async function loadSyncCreator(
  supabase: SupabaseClient,
  creatorId: string,
): Promise<(SyncCreator & { email: string | null }) | null> {
  const { data } = await supabase
    .from('creators')
    .select('id, user_id, display_name, website_url, youtube_url, instagram_url, tiktok_url, feed_url, user_profiles!user_id ( email )')
    .eq('id', creatorId)
    .maybeSingle();

  if (!data) return null;
  const row = data as Record<string, any>;
  return {
    id: row.id,
    user_id: row.user_id,
    display_name: row.display_name,
    website_url: row.website_url ?? null,
    youtube_url: row.youtube_url ?? null,
    instagram_url: row.instagram_url ?? null,
    tiktok_url: row.tiktok_url ?? null,
    feed_url: row.feed_url ?? null,
    email: (row.user_profiles as { email?: string } | null)?.email ?? null,
  };
}

/**
 * Tells the creator what went live under their name.
 *
 * Only what published — a creator who did not ask for this sync does not need a
 * list of the operator's gate rejections. Nothing published means nothing sent.
 *
 * The `notified` flag is set per item *before* the send and rolled back if the
 * send throws, so the failure mode is "we try again", never "nobody was told".
 * That is also why a retried item that publishes later produces its own short
 * follow-up instead of being folded silently into a message already delivered.
 */
async function notifyCreator(
  deps: SyncDeps,
  run: SyncRun,
  creator: SyncCreator & { email: string | null },
): Promise<{ items: SyncItem[]; notifiedAt: string | null; notifyError: string | null } | null> {
  const notifier = deps.notifier ?? sendCreatorSyncPublishedEmail;
  const now = deps.now ?? Date.now;

  const fresh = run.items.filter((item) => item.status === 'imported' && item.mealId && !item.notified);
  if (fresh.length === 0) return null;

  if (!creator.email) {
    log({ event: 'ADMIN:SYNC_NOTIFY', status: 'error', userId: creator.id, detail: `run=${run.id}`, reason: 'creator has no email address' });
    return { items: run.items, notifiedAt: run.notifiedAt, notifyError: 'This creator has no email address on file, so nobody was told.' };
  }

  const claimedIds = new Set(fresh.map((item) => item.itemId));
  const items = run.items.map((item) => (claimedIds.has(item.itemId) ? { ...item, notified: true } : item));

  try {
    await notifier(
      creator.email,
      creator.display_name,
      fresh.map((item) => ({ id: item.mealId as string, name: item.mealName || item.title || 'Untitled recipe' })),
    );
    log({ event: 'ADMIN:SYNC_NOTIFY', status: 'success', userId: creator.id, detail: `run=${run.id} meals=${fresh.length}` });
    return { items, notifiedAt: new Date(now()).toISOString(), notifyError: null };
  } catch (err) {
    log({ event: 'ADMIN:SYNC_NOTIFY', status: 'error', userId: creator.id, detail: `run=${run.id} meals=${fresh.length}`, error: err });
    return {
      items: run.items,
      notifiedAt: run.notifiedAt,
      notifyError:
        `The creator was NOT told about ${fresh.length} published ${fresh.length === 1 ? 'recipe' : 'recipes'}: ` +
        `${err instanceof Error ? err.message : String(err)}. Press Retry notification.`,
    };
  }
}

/**
 * Puts one failed item back in the queue.
 *
 * Only `failed` is retryable. Retrying a gate rejection would just pay for the
 * same "no" again, and retrying something already imported is how a recipe gets
 * published twice.
 */
export async function retrySyncItem(
  deps: SyncDeps,
  runId: string,
  itemId: string,
): Promise<{ ok: true; run: SyncRun } | { ok: false; error: string }> {
  const now = deps.now ?? Date.now;
  const { data: row } = await deps.supabase.from('creator_sync_runs').select('*').eq('id', runId).maybeSingle();
  if (!row) return { ok: false, error: 'Run not found' };

  const run = toSyncRun(row as Record<string, any>);
  const target = run.items.find((item) => item.itemId === itemId);
  if (!target) return { ok: false, error: 'That item is not part of this run.' };
  if (target.status !== 'failed') {
    return { ok: false, error: `Only failed items can be retried; this one is ${target.status}.` };
  }

  const items = run.items.map((item) =>
    item.itemId === itemId ? { ...item, status: 'pending' as const, detail: null } : item,
  );

  await deps.supabase
    .from('creator_sync_runs')
    .update({ items, status: 'queued', finished_at: null, updated_at: new Date(now()).toISOString() })
    .eq('id', runId);

  return { ok: true, run: { ...run, items, status: 'queued' } };
}

/**
 * Resumes runs nobody is driving.
 *
 * The admin screen calls the worker in a loop, which means closing the tab
 * stops the loop. Without this a 200-item run could sit half-published forever
 * and — worse — the creator would never get the email about the half that did
 * publish. Called from the daily cron, so the recovery is slow but certain.
 */
export async function resumeStalledSyncRuns(deps: SyncDeps, limit = 5): Promise<number> {
  const nowIso = new Date((deps.now ?? Date.now)()).toISOString();
  const { data } = await deps.supabase
    .from('creator_sync_runs')
    .select('id')
    .neq('status', 'done')
    .or(`lease_until.is.null,lease_until.lt.${nowIso}`)
    .order('created_at', { ascending: true })
    .limit(limit);

  const rows = (data ?? []) as Array<{ id: string }>;
  for (const row of rows) {
    await advanceRun(deps, row.id);
  }
  return rows.length;
}
