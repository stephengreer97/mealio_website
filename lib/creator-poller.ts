/**
 * The feed poller (MEAL-75), and the one email it sends (MEAL-76).
 *
 * A cron pass over every creator who has a source set and has opted in, asking
 * one question — *what has this creator published that we have not seen?* —
 * and handing the answer to the pipeline that already exists. It is deliberately
 * **not** a second import engine: listing is `buildCatalog`, and gate → extract →
 * draft is `processSyncItem`, both unchanged from the operator path. What lives
 * here is which items are new, how often we may ask, and what happens when a
 * source starts saying no.
 *
 * The five rules that shaped it, each of which is a way this silently goes wrong:
 *
 *   1. **Two switches, both an operator's.** `primary_source` and
 *      `import_opt_in`. Neither is inferred, and the query enforces both — a
 *      creator who has not agreed to this is not somebody to poll politely, they
 *      are somebody not to poll.
 *   2. **The first poll imports nothing.** Every item in a newly connected feed
 *      is unseen, so the naive version fires an extraction per archived post:
 *      a blog with 200 of them is ~$13 and 200 drafts nobody asked for. The
 *      baseline marks them `seen` instead. Back-catalog import is a deliberate,
 *      separate action (MEAL-79), never a side effect of connecting.
 *   3. **Never a high-water mark.** "Everything after the last guid" is the
 *      obvious implementation and it loses posts with no error: scheduled posts
 *      publish late with earlier dates, edits reorder entries, some platforms
 *      backdate. `creator_source_items` is keyed `(creator_id, source, item_id)`,
 *      so what we have seen is a set, and its UNIQUE constraint is also the
 *      idempotency guarantee for a cron that will eventually overlap itself.
 *   4. **A cap per creator per poll.** Five. Beyond that we wait for the next
 *      cycle and say so — a site that republishes its whole archive after a
 *      migration is indistinguishable from a burst of new recipes until someone
 *      looks, and the cap is what makes the difference cost one cycle rather
 *      than the whole archive.
 *   5. **Every item stands alone.** One failure is one failed item, retryable on
 *      its own, and the other four still land.
 *
 * On hygiene: conditional requests so an unchanged feed costs a 304, the
 * publisher's own advertised interval honoured where they state one, per-source
 * and per-origin backoff when we are refused, robots.txt through the same
 * `robotsPerOrigin` every other fetch here uses, and the honest `MealioBot/1.0
 * (+https://mealio.co/about)` User-Agent that `ssrf.ts` already sends. **A new
 * 403 on a source that used to work is a signal, not an error** — a creator's
 * site starting to block us must not present as their having stopped publishing.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  buildCatalog,
  processSyncItem,
  type CatalogEntry,
  type SyncCreator,
  type SyncDeps,
  type SyncItem,
} from '@/lib/admin-sync';
import { isPlatformSource, SOURCE_LABELS, type PlatformSource } from '@/lib/creator-sources';
import { sendCreatorDraftsReadyEmail, type DraftedRecipe } from '@/lib/email';
import { log } from '@/lib/logger';
import type { ConditionalValidators } from '@/lib/import/ssrf';

// ── The schedule, in one place ───────────────────────────────────────────────

/**
 * How often a source may be polled, in minutes. **The one number to change.**
 *
 * MEAL-75 specifies 15, and the arithmetic behind it is sound: a conditional GET
 * on a 300-byte feed is not the expensive request, the page fetch is, and *that*
 * rate is set by how often the creator posts rather than by how often we look.
 * Fifteen minutes takes detection latency from ~12h average to ~7.5min, which is
 * the difference between a creator pasting their Mealio link into a caption
 * while still in posting mode and finding out about it two days later.
 *
 * We ship **1440** anyway, because Vercel Hobby caps cron jobs at once per day
 * and a more frequent expression does not degrade — it **fails the deployment**
 * with "Hobby accounts are limited to daily cron jobs." Shipping 15 would ship
 * nothing at all.
 *
 * On Pro this becomes `15`, `vercel.json` is regenerated from
 * `cronScheduleFor()` (a test asserts the two agree), and nothing else in this
 * file changes: `poll_after`, the backoff schedule and the TTL floor are all
 * expressed in terms of this constant precisely so that they follow it.
 */
export const POLL_INTERVAL_MINUTES = 1440;

/** Hour of the day a daily schedule fires, UTC-ish — Hobby's precision is ±59 min. */
const DAILY_CRON_HOUR = 4;

/**
 * The cron expression `vercel.json` must carry for a given interval.
 *
 * Exported so the schedule and the interval cannot drift apart silently: the
 * one thing worse than polling daily is *believing* we poll every fifteen
 * minutes while `vercel.json` says otherwise, and that is invisible from
 * anywhere inside the application.
 */
export function cronScheduleFor(minutes: number): string {
  if (minutes < 60) return `*/${minutes} * * * *`;
  if (minutes < 1440) return `0 */${Math.round(minutes / 60)} * * *`;
  return `${0} ${DAILY_CRON_HOUR} * * *`;
}

const MINUTE_MS = 60_000;
const POLL_INTERVAL_MS = POLL_INTERVAL_MINUTES * MINUTE_MS;

// ── Budgets and caps ─────────────────────────────────────────────────────────

/**
 * Items extracted per creator per poll.
 *
 * Five is a starting number, not a measured one. It is above what any creator
 * publishes between two polls at any cadence we would run, and far below what a
 * site re-publishing its archive would produce — so exceeding it is nearly
 * always the second thing, which is why exceeding it raises a signal rather than
 * just costing a cycle.
 */
export const POLL_ITEM_CAP = 5;

/**
 * Creators considered in one pass.
 *
 * 100 because that is what fits in a PostgREST `.in()` filter: those go in the
 * QUERY STRING, and Supabase's proxies reject URIs in the 8–16 KB range, so 100
 * uuids (~4 KB) leaves room for the rest of the URL. The same ceiling `push.ts`
 * chunks against, for the same reason.
 */
export const POLL_CREATOR_BATCH = 100;

/**
 * Wall-clock budget for one pass, under the route's `maxDuration = 300`.
 *
 * Bounded by a clock and not only by a row count, for the reason the token sweep
 * gives: a batch size bounds how many creators are touched and says nothing
 * about how long touching them takes, and time is what runs out inside a cron
 * invocation. Creators not reached are untouched, so they sort first next pass —
 * `lastPolledAt` ordering makes that automatic rather than a thing to remember.
 */
export const POLL_PASS_BUDGET_MS = 240_000;

/**
 * Longest a publisher's advertised TTL may push us out.
 *
 * The TTL is honoured — it is what they asked for, in writing, on their own feed
 * — but a `<sy:updatePeriod>monthly</sy:updatePeriod>` is far more often a
 * template default nobody chose than a considered request, and a month of
 * silence is indistinguishable from the feature being broken. A week is the
 * compromise: still far more conservative than our own cadence, still short
 * enough that a creator notices nothing.
 */
const MAX_TTL_MS = 7 * 24 * 60 * MINUTE_MS;

/** Backoff ceiling. Past this, a source is not "busy", it is a thing to go and look at. */
const MAX_BACKOFF_MS = 7 * 24 * 60 * MINUTE_MS;

/** Doubling per consecutive failure, off the poll interval, capped above. */
function backoffMs(consecutiveFailures: number): number {
  const doublings = Math.min(consecutiveFailures, 10);
  return Math.min(POLL_INTERVAL_MS * 2 ** doublings, MAX_BACKOFF_MS);
}

// ── Shapes ───────────────────────────────────────────────────────────────────

/**
 * A creator the poller may touch: source set, opted in.
 *
 * No email address on it. The address is looked up at the end of the pass, for
 * the creators who actually have something waiting — a poll that drafts nothing
 * has no business having carried anyone's address around in the first place.
 */
export interface PollableCreator extends SyncCreator {
  source: PlatformSource;
}

/** `creator_source_state`, as this file speaks it. */
interface SourceState {
  etag: string | null;
  lastModified: string | null;
  /**
   * When we last **successfully listed** this source — not when we last tried.
   *
   * That distinction is load-bearing twice over. It is how a first poll is
   * recognised (null means we have never enumerated this feed, so the baseline
   * has not run and importing everything in it would be the $13 mistake), and it
   * is how a *new* 403 is told from a source that has never worked. Writing it
   * on a failed attempt would collapse both.
   */
  lastPolledAt: string | null;
  pollAfter: string | null;
  consecutiveFailures: number;
}

/**
 * Why an operator should look at a source.
 *
 * Both kinds describe a source that is behaving differently rather than badly,
 * which is exactly the case a log line at `error` would bury and a silent skip
 * would lose entirely.
 */
export interface PollSignal {
  creatorId: string;
  source: PlatformSource;
  /** `blocked` — a source that used to work now refuses us. `flood` — more new items than the cap. */
  kind: 'blocked' | 'flood';
  detail: string;
}

export interface PollCreatorResult {
  creatorId: string;
  source: PlatformSource;
  status: 'polled' | 'not-modified' | 'baselined' | 'skipped' | 'failed' | 'blocked';
  /** Items in the listing we had no record of. */
  newItems: number;
  /** Marked `seen` without importing, on the first poll of a source. */
  baselined: number;
  drafted: number;
  rejected: number;
  failed: number;
  /** New items left for the next cycle: over the cap, or past the pass budget. */
  deferred: number;
  detail: string | null;
  signal: PollSignal | null;
  /** What the creator will be emailed about, in the order they were processed. */
  drafts: DraftedRecipe[];
}

export interface PollDeps extends SyncDeps {
  /** The transactional notifier. Injected in tests; production sends for real. */
  notifier?: typeof sendCreatorDraftsReadyEmail;
  /** Real-clock deadline for the whole pass. Defaults to `POLL_PASS_BUDGET_MS` from now. */
  deadline?: number;
}

// ── One creator ──────────────────────────────────────────────────────────────

/** Blank fields for a `SyncItem` the poller builds from a catalog entry. */
function toSyncItem(entry: CatalogEntry): SyncItem {
  return {
    itemId: entry.itemId,
    url: entry.url,
    title: entry.title,
    publishedAt: entry.publishedAt,
    status: 'pending',
    detail: null,
    draftId: null,
    mealName: null,
    needALook: null,
    photoUrl: null,
    ingredientCount: null,
    costUsd: 0,
  };
}

/**
 * A zeroed result.
 *
 * A function, not a shared constant: `drafts` is mutable, and a module-level
 * literal spread into every result would hand every creator in the pass the same
 * array — so the first creator's drafts would ride along in the second
 * creator's email, under their name.
 */
function emptyResult() {
  return {
    newItems: 0,
    baselined: 0,
    drafted: 0,
    rejected: 0,
    failed: 0,
    deferred: 0,
    detail: null as string | null,
    signal: null as PollSignal | null,
    drafts: [] as DraftedRecipe[],
  };
}

/**
 * Polls one creator's one source.
 *
 * Never throws: a pass over fifty creators must not end because one of them has
 * a feed that returns nonsense. Everything it learns about the source — the
 * validators, the interval, the failure count — is written back to
 * `creator_source_state` before it returns, including on the paths where nothing
 * was imported.
 */
export async function pollCreator(
  deps: PollDeps,
  creator: PollableCreator,
  state: SourceState | null,
): Promise<PollCreatorResult> {
  const now = deps.now ?? Date.now;
  const source = creator.source;
  const base = { creatorId: creator.id, source, ...emptyResult() };

  // Re-asserted even though the query already filtered on it. `none` is the off
  // switch and is not a `PlatformSource`, so this one check covers both "not
  // set" and "not a value we know". It is the line between importing a
  // creator's posts and importing a stranger's, and it costs one comparison to
  // make it true of the function rather than only of its one caller.
  if (!isPlatformSource(source)) {
    return { ...base, status: 'skipped', detail: 'No source is set for this creator.' };
  }

  const catalog = await buildCatalog(deps, creator, source, {
    conditional: state ? { etag: state.etag, lastModified: state.lastModified } : undefined,
  });

  if (!catalog.ok) {
    // The good failure: the publisher answered our conditional request with
    // "nothing has changed", which is the whole point of sending one. Counts as
    // a successful poll — we asked and got an answer.
    if (catalog.reason === 'not-modified') {
      await writeState(deps, creator, {
        etag: state?.etag ?? null,
        lastModified: state?.lastModified ?? null,
        polledAt: new Date(now()).toISOString(),
        pollAfter: new Date(now() + POLL_INTERVAL_MS).toISOString(),
        consecutiveFailures: 0,
        status: 304,
        error: null,
      });
      return { ...base, status: 'not-modified' };
    }

    // A source refusing us is not the same fact as a source having nothing new,
    // and the difference only exists if we remember it used to work. `blocked`
    // covers 401/403/429 — `ssrf.ts` folds those together because for a creator
    // pasting a link they mean the same thing; here the *change* is the signal.
    const refused = catalog.reason === 'blocked-by-site' || catalog.reason === 'blocked-by-robots';
    const wasWorking = Boolean(state?.lastPolledAt);
    const failures = (state?.consecutiveFailures ?? 0) + 1;

    await writeState(deps, creator, {
      etag: state?.etag ?? null,
      lastModified: state?.lastModified ?? null,
      // Untouched: this attempt listed nothing, so it must not make the next
      // pass think the source has ever worked.
      polledAt: state?.lastPolledAt ?? null,
      pollAfter: new Date(now() + backoffMs(failures)).toISOString(),
      consecutiveFailures: failures,
      status: refused ? 403 : null,
      error: catalog.detail,
    });

    const signal: PollSignal | null =
      refused && wasWorking
        ? {
            creatorId: creator.id,
            source,
            kind: 'blocked',
            detail:
              `${creator.display_name}'s ${SOURCE_LABELS[source]} source has started refusing us after ` +
              `previously working: ${catalog.detail} Their posts will stop arriving until this clears — ` +
              'this is a conversation to have with them, not a source to quietly drop.',
          }
        : null;

    if (signal) {
      log({ event: 'POLL:SOURCE', status: 'error', userId: creator.id, reason: 'newly blocked', detail: signal.detail });
    }

    return {
      ...base,
      status: refused ? 'blocked' : 'failed',
      detail: catalog.detail,
      signal,
    };
  }

  const validators: ConditionalValidators = catalog.validators ?? {};
  const polledAt = new Date(now()).toISOString();
  // The publisher's stated interval wins when it is longer than ours; ours wins
  // when it is shorter, because a feed asking to be read hourly is not an
  // instruction to read it hourly.
  const ttlMs = catalog.ttlSeconds ? Math.min(catalog.ttlSeconds * 1000, MAX_TTL_MS) : 0;
  const nextState = {
    etag: validators.etag ?? null,
    lastModified: validators.lastModified ?? null,
    polledAt,
    pollAfter: new Date(now() + Math.max(POLL_INTERVAL_MS, ttlMs)).toISOString(),
    consecutiveFailures: 0,
    status: 200,
    error: null as string | null,
  };

  // A record — of any status — is the whole memory. `seen`, `imported`,
  // `rejected` and `failed` all mean "we have met this item"; only the absence
  // of a row means new. No dates are compared and no position in the feed is
  // trusted, which is what makes a backdated or reordered entry a non-event.
  const unseen = catalog.entries.filter((entry) => entry.record === null);

  // ── The first poll: mark, do not import ───────────────────────────────────
  if (!state?.lastPolledAt) {
    const marked = await markSeen(deps, creator, source, unseen, polledAt);
    await writeState(deps, creator, nextState);
    log({
      event: 'POLL:SOURCE',
      status: 'success',
      userId: creator.id,
      detail: `${source} first poll: ${marked} existing items marked seen, none imported`,
    });
    return { ...base, status: 'baselined', newItems: unseen.length, baselined: marked };
  }

  const overCap = Math.max(0, unseen.length - POLL_ITEM_CAP);
  const batch = unseen.slice(0, POLL_ITEM_CAP);
  const signal: PollSignal | null =
    overCap > 0
      ? {
          creatorId: creator.id,
          source,
          kind: 'flood',
          detail:
            `${creator.display_name}'s ${SOURCE_LABELS[source]} source produced ${unseen.length} new items in ` +
            `one poll; ${POLL_ITEM_CAP} were processed and ${overCap} wait for the next cycle. A creator does ` +
            'not publish that fast — a site re-publishing its archive after a migration looks exactly like ' +
            'this, and so does a feed whose item ids have changed.',
        }
      : null;

  if (signal) {
    log({ event: 'POLL:SOURCE', status: 'error', userId: creator.id, reason: 'over item cap', detail: signal.detail });
  }

  const result: PollCreatorResult = {
    ...base,
    status: 'polled',
    newItems: unseen.length,
    deferred: overCap,
    signal,
  };

  // `null` rather than a synthesised id: there is no `creator_sync_runs` row
  // behind a cron pass, and inventing one would put a dangling reference in
  // every draft the poller creates.
  const context = { id: null, source };
  // The gate resolves an `unsure` verdict as a **no** on this path. Set here
  // rather than left to the caller: an operator forgetting it on one call site
  // is a draft and an email about a post the creator never offered us.
  const itemDeps: PollDeps = { ...deps, gateMode: deps.gateMode ?? 'poller' };

  for (const entry of batch) {
    // Checked before the item, not after. An extraction is a fetch and two model
    // calls; starting one we cannot finish spends the money and loses the
    // result. An item not started has no record, so it is simply new again next
    // cycle — the same place a deferred item sits.
    if (Date.now() >= passDeadline(deps)) {
      result.deferred += 1;
      continue;
    }

    // Never throws, by construction. A failure is recorded as `failed` on the
    // item and stays retryable; the rest of the batch is unaffected.
    const processed = await processSyncItem(itemDeps, context, creator, toSyncItem(entry));

    if (processed.status === 'drafted') {
      result.drafted += 1;
      result.drafts.push({
        draftId: processed.draftId ?? '',
        name: processed.mealName ?? processed.title ?? 'Untitled recipe',
        sourceUrl: processed.url,
        photoUrl: processed.photoUrl,
        ingredientCount: processed.ingredientCount ?? 0,
        needALook: processed.needALook ?? 0,
      });
    } else if (processed.status === 'rejected') {
      // Silently. Nobody asked for this import, so a gate false positive that
      // reached the creator would be spam with our name on it — and the gate is
      // right often enough that telling them about every "no" would be noise
      // even when it is correct. The record is the audit trail.
      result.rejected += 1;
    } else {
      result.failed += 1;
    }
  }

  await writeState(deps, creator, nextState);

  log({
    event: 'POLL:SOURCE',
    status: 'success',
    userId: creator.id,
    detail:
      `${source} new=${result.newItems} drafted=${result.drafted} rejected=${result.rejected} ` +
      `failed=${result.failed} deferred=${result.deferred}`,
  });

  return result;
}

function passDeadline(deps: PollDeps): number {
  return deps.deadline ?? Number.POSITIVE_INFINITY;
}

/**
 * Records every listed item as `seen`, importing none of them.
 *
 * Only items with no record at all, so an operator's earlier sync is not
 * downgraded: a post already `imported` must keep pointing at its draft, and a
 * post already `rejected` must stay rejected. `upsert` on the natural key on top
 * of that, because two overlapping passes must not fight.
 */
async function markSeen(
  deps: PollDeps,
  creator: PollableCreator,
  source: PlatformSource,
  entries: CatalogEntry[],
  at: string,
): Promise<number> {
  if (entries.length === 0) return 0;

  const { error } = await deps.supabase.from('creator_source_items').upsert(
    entries.map((entry) => ({
      creator_id: creator.id,
      source,
      item_id: entry.itemId,
      url: entry.url,
      title: entry.title,
      published_at: entry.publishedAt,
      status: 'seen',
      detail:
        'Already published when this source was connected. Marked seen without importing — ' +
        'back-catalog import is a separate, deliberate action.',
      updated_at: at,
    })),
    { onConflict: 'creator_id,source,item_id' },
  );

  if (error) {
    // The baseline failing is worth knowing about precisely because the *next*
    // pass would then see a first poll again — which is correct, and is why this
    // is logged rather than thrown.
    log({ event: 'POLL:SOURCE', status: 'error', userId: creator.id, reason: 'baseline write failed', error });
    return 0;
  }
  return entries.length;
}

interface StateWrite {
  etag: string | null;
  lastModified: string | null;
  polledAt: string | null;
  pollAfter: string;
  consecutiveFailures: number;
  status: number | null;
  error: string | null;
}

async function writeState(deps: PollDeps, creator: PollableCreator, next: StateWrite): Promise<void> {
  const { error } = await deps.supabase.from('creator_source_state').upsert(
    {
      creator_id: creator.id,
      source: creator.source,
      etag: next.etag,
      last_modified: next.lastModified,
      last_polled_at: next.polledAt,
      poll_after: next.pollAfter,
      consecutive_failures: next.consecutiveFailures,
      last_status: next.status,
      last_error: next.error,
    },
    { onConflict: 'creator_id,source' },
  );

  if (error) {
    // Logged, not thrown. Losing the bookkeeping costs us a conditional request
    // and, at worst, a repeated poll; losing the pass because the bookkeeping
    // failed costs every creator behind this one.
    log({ event: 'POLL:SOURCE', status: 'error', userId: creator.id, reason: 'state write failed', error });
  }
}

// ── The pass ─────────────────────────────────────────────────────────────────

export interface PollPassResult {
  eligible: number;
  polled: number;
  notModified: number;
  baselined: number;
  drafted: number;
  rejected: number;
  failed: number;
  deferred: number;
  blocked: number;
  emailsSent: number;
  /** Creators the budget or a `poll_after` meant we did not reach this pass. */
  skipped: number;
  /** Operator-facing sentences. Non-empty means someone should look. */
  signals: string[];
}

const CREATOR_COLUMNS =
  'id, user_id, display_name, website_url, youtube_url, instagram_url, tiktok_url, feed_url, ' +
  'primary_source, import_opt_in';

/**
 * Everyone the poller may touch.
 *
 * **Both switches, in the query.** `import_opt_in` is the creator's consent
 * (MEAL-77) and `primary_source` is the operator's decision about which of a
 * creator's four links is the one we read (MEAL-81); either one absent means no
 * polling, and the partial index in `add-creator-sources.sql` is shaped for
 * exactly this predicate.
 */
export async function eligibleCreators(supabase: SupabaseClient): Promise<PollableCreator[]> {
  const { data } = await supabase
    .from('creators')
    .select(CREATOR_COLUMNS)
    .eq('import_opt_in', true)
    .neq('primary_source', 'none')
    .limit(POLL_CREATOR_BATCH);

  return ((data ?? []) as Array<Record<string, any>>)
    .filter((row) => isPlatformSource(row.primary_source))
    .map((row) => ({
      id: row.id,
      user_id: row.user_id,
      display_name: row.display_name ?? '',
      website_url: row.website_url ?? null,
      youtube_url: row.youtube_url ?? null,
      instagram_url: row.instagram_url ?? null,
      tiktok_url: row.tiktok_url ?? null,
      feed_url: row.feed_url ?? null,
      source: row.primary_source as PlatformSource,
    }));
}

/** State rows for the creators in hand, keyed the way the table is. */
async function loadStates(
  supabase: SupabaseClient,
  creators: PollableCreator[],
): Promise<Map<string, SourceState>> {
  const byKey = new Map<string, SourceState>();
  if (creators.length === 0) return byKey;

  // One `.in()` because `POLL_CREATOR_BATCH` is already sized to fit in a
  // PostgREST query string; see the constant.
  const { data } = await supabase
    .from('creator_source_state')
    .select('creator_id, source, etag, last_modified, last_polled_at, poll_after, consecutive_failures')
    .in('creator_id', creators.map((creator) => creator.id));

  for (const row of (data ?? []) as Array<Record<string, any>>) {
    byKey.set(`${row.creator_id}:${row.source}`, {
      etag: row.etag ?? null,
      lastModified: row.last_modified ?? null,
      lastPolledAt: row.last_polled_at ?? null,
      pollAfter: row.poll_after ?? null,
      consecutiveFailures: row.consecutive_failures ?? 0,
    });
  }
  return byKey;
}

/** The origin a creator's source is fetched from, or null for the API-backed platforms. */
function originOf(creator: PollableCreator): string | null {
  if (creator.source !== 'website') return null;
  try {
    return new URL(creator.feed_url || creator.website_url || '').origin;
  } catch {
    return null;
  }
}

/**
 * One poll pass over every eligible creator.
 *
 * Ordered **longest-since-polled first**, with never-polled creators ahead of
 * everyone. That is fairness for free: a creator the budget did not reach is
 * untouched, so they sort to the front of the next pass without anything having
 * to remember them. The alternative — a stable order — starves the tail
 * permanently the first time the pass runs long, and does it silently.
 */
export async function runPollPass(deps: PollDeps): Promise<PollPassResult> {
  const now = deps.now ?? Date.now;
  const result: PollPassResult = {
    eligible: 0, polled: 0, notModified: 0, baselined: 0, drafted: 0,
    rejected: 0, failed: 0, deferred: 0, blocked: 0, emailsSent: 0, skipped: 0, signals: [],
  };

  const creators = await eligibleCreators(deps.supabase);
  result.eligible = creators.length;
  if (creators.length === 0) return result;

  const states = await loadStates(deps.supabase, creators);
  const stateFor = (creator: PollableCreator) => states.get(`${creator.id}:${creator.source}`) ?? null;

  const ordered = [...creators].sort((a, b) => {
    const left = stateFor(a)?.lastPolledAt ?? '';
    const right = stateFor(b)?.lastPolledAt ?? '';
    return left.localeCompare(right);
  });

  // Measured against the real clock even when `now` is injected: a test pinning
  // `now` to a constant is describing poll windows, not asking for an unbounded
  // pass.
  const deadline = deps.deadline ?? Date.now() + POLL_PASS_BUDGET_MS;
  const passDeps: PollDeps = { ...deps, deadline };

  /**
   * Origins that refused us during *this* pass.
   *
   * `poll_after` carries backoff per source, which is the durable half. This is
   * the half it cannot express: two creators on the same host would otherwise
   * both be hit inside one pass, the second one after the first had already been
   * told to go away. Being told twice in a minute is precisely the behaviour
   * that turns a temporary 429 into a permanent block.
   */
  const refusedOrigins = new Set<string>();
  const nowIso = new Date(now()).toISOString();
  const outcomes: PollCreatorResult[] = [];

  for (const creator of ordered) {
    if (Date.now() >= deadline) {
      result.skipped += 1;
      continue;
    }

    const state = stateFor(creator);
    if (state?.pollAfter && state.pollAfter > nowIso) {
      // Backing off, or honouring the interval the publisher advertised. Either
      // way this is the poller doing its job, not skipping work.
      result.skipped += 1;
      continue;
    }

    const origin = originOf(creator);
    if (origin && refusedOrigins.has(origin)) {
      result.skipped += 1;
      continue;
    }

    // One creator must not be able to end the pass for everyone behind them.
    // `pollCreator` reports its own failures rather than throwing, so reaching
    // this catch means something unforeseen — a database error, a parser that
    // met input nobody imagined. Either way the creator is untouched and first
    // in the next pass, which is exactly where a deferral leaves them.
    let outcome: PollCreatorResult;
    try {
      outcome = await pollCreator(passDeps, creator, state);
    } catch (err) {
      result.failed += 1;
      log({ event: 'POLL:SOURCE', status: 'error', userId: creator.id, reason: 'poll threw', error: err });
      continue;
    }
    outcomes.push(outcome);

    if (outcome.status === 'blocked' && origin) refusedOrigins.add(origin);

    result.drafted += outcome.drafted;
    result.rejected += outcome.rejected;
    result.failed += outcome.failed;
    result.deferred += outcome.deferred;
    if (outcome.signal) result.signals.push(outcome.signal.detail);

    if (outcome.status === 'polled') result.polled += 1;
    else if (outcome.status === 'not-modified') result.notModified += 1;
    else if (outcome.status === 'baselined') result.baselined += 1;
    else if (outcome.status === 'blocked') result.blocked += 1;
    else if (outcome.status === 'skipped') result.skipped += 1;
  }

  result.emailsSent = await notifyDrafted(deps, creators, outcomes);

  return result;
}

// ── The email (MEAL-76) ──────────────────────────────────────────────────────

/**
 * One email per creator per pass, listing what is waiting for them.
 *
 * Batched, because that is the single biggest determinant of whether this feels
 * helpful or spammy: a creator who publishes three recipes on a Tuesday gets one
 * message about three drafts. **Nothing drafted means nothing sent** — an empty
 * "here is what we found" is worse than silence, and the rejected and failed
 * items are our problem, not theirs.
 *
 * Transactional, so it goes through `lib/email.ts` directly and never
 * `sendMarketingEmail`: `marketing_opt_out` must not be able to suppress a
 * message about content queued under someone's own name. The unsubscribe page
 * already promises exactly that — "You'll still get important account emails".
 */
async function notifyDrafted(
  deps: PollDeps,
  creators: PollableCreator[],
  outcomes: PollCreatorResult[],
): Promise<number> {
  const notifier = deps.notifier ?? sendCreatorDraftsReadyEmail;
  const byId = new Map(creators.map((creator) => [creator.id, creator] as const));
  let sent = 0;

  // Grouped rather than sent per outcome: one creator has one source today, but
  // "one email per creator per pass" is the property worth encoding, not "one
  // email per source".
  const drafts = new Map<string, DraftedRecipe[]>();
  for (const outcome of outcomes) {
    if (outcome.drafts.length === 0) continue;
    drafts.set(outcome.creatorId, [...(drafts.get(outcome.creatorId) ?? []), ...outcome.drafts]);
  }
  if (drafts.size === 0) return 0;

  // Addresses are read here and nowhere else, for the handful of creators who
  // have something waiting. Deliberately **not** joined onto the creator query:
  // a pass that drafts nothing would otherwise have pulled every opted-in
  // creator's email address into memory for no reason at all.
  //
  // No `marketing_opt_out` in the predicate. This is transactional, and a
  // creator who unsubscribed from campaigns has still asked us to import their
  // recipes — drafts they are never told about are worse than no drafts.
  const emails = new Map<string, string>();
  const userIds = [...drafts.keys()].map((id) => byId.get(id)?.user_id).filter((id): id is string => Boolean(id));
  if (userIds.length > 0) {
    const { data } = await deps.supabase.from('user_profiles').select('id, email').in('id', userIds);
    for (const row of (data ?? []) as Array<Record<string, any>>) {
      if (row.email) emails.set(String(row.id), String(row.email));
    }
  }

  for (const [creatorId, queued] of drafts) {
    const creator = byId.get(creatorId);
    const email = creator ? emails.get(creator.user_id) : undefined;
    if (!creator || !email) {
      // Worth a line: the drafts exist and are waiting, and nobody has been told.
      log({ event: 'POLL:NOTIFY', status: 'error', userId: creatorId, reason: 'creator has no email address' });
      continue;
    }
    try {
      await notifier(email, creator.display_name, queued);
      sent += 1;
      log({ event: 'POLL:NOTIFY', status: 'success', userId: creatorId, detail: `drafts=${queued.length}` });
    } catch (err) {
      // The drafts are queued either way, so this does not fail the pass — but
      // an operator who believes the creator was told when they were not is the
      // failure mode, so it is said out loud.
      log({ event: 'POLL:NOTIFY', status: 'error', userId: creatorId, error: err });
    }
  }

  return sent;
}
