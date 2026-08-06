import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Is polling working, and for whom? (MEAL-96)
 *
 * Polling is invisible: a creator's source can stop producing recipes and
 * nothing on any screen says so, so an operator finds out when the creator asks
 * why nothing has appeared. This assembles the answer for the Sources tab.
 *
 * Read-only and per-creator. Every figure comes from a table something else
 * already writes — nothing here is a new signal, it is the existing ones being
 * looked at for the first time.
 *
 * ## The one that matters
 *
 * `lastNewItemAt` is the column an operator should read first, and the reason
 * this screen is worth building. A source can poll successfully forever and
 * yield nothing — a blog that moved its recipes behind a different feed, a
 * channel that switched to Shorts we cannot read — and that reads as perfectly
 * healthy on every other column: recent successful poll, no failures, next poll
 * scheduled. Only "when did this last produce anything" tells them apart.
 *
 * ## What is not here, and why
 *
 * Everything the ticket asks for is here. An earlier version of this note said
 * the last failure's reason was unstored and needed a migration; that was
 * wrong — `creator_source_state.last_error` and `last_status` have been written
 * on every failure since the poller shipped. Only *when* it failed was missing,
 * because `last_polled_at` is deliberately left untouched by a failure so the
 * next pass cannot mistake a broken source for one that has ever worked. That
 * one column, `last_failed_at`, is the only thing this needed adding.
 */

export interface CreatorPollHealth {
  creatorId: string;
  source: string | null;
  /** Last time the source was listed without error. */
  lastPolledAt: string | null;
  /** When the next poll is allowed — makes the backoff legible. */
  pollAfter: string | null;
  /** One failure is weather; six is a broken source nobody has looked at. */
  consecutiveFailures: number;
  /** When it last broke. Kept through later successes — see `writeState`. */
  lastFailedAt: string | null;
  /**
   * What went wrong, in the poller's own words.
   *
   * `creator_source_state.last_error`, which already existed — an earlier note
   * here claimed the reason was unstored and asked for a migration to add one.
   * It was wrong: `last_error` and `last_status` have been written on every
   * failure all along. Only the *timestamp* was missing.
   */
  lastError: string | null;
  /** The HTTP status behind the failure, where there was one. */
  lastStatus: number | null;
  /**
   * When polling last saw a post it had not seen before.
   *
   * Read off `creator_source_items.created_at` — the row is written the first
   * time polling meets a post, so its creation *is* first-seen (see
   * `firstSeenAt` in `buildCatalog`). Written for everything found, including
   * posts marked seen without importing, so this answers "is this source still
   * producing" rather than "did we like what it produced".
   */
  lastNewItemAt: string | null;
  /** Lifetime drafts from polling, so a silent creator stands out. */
  draftedCount: number;
  /**
   * Drafts that became published meals.
   *
   * A different question from `draftedCount`, and the gap between them is the
   * interesting number: a creator who declines everything is a problem about the
   * extraction, and one whose drafts nobody has looked at is a problem about the
   * queue.
   */
  publishedCount: number;
}

/**
 * How many creators one call will report on. A page, not the world.
 *
 * Exceeding it is not silent to the CALLER — the returned map simply has no
 * entry for the ids past it — but it is silent to whoever reads the screen, so a
 * caller that lists every creator has to say when it truncated. See `incomplete`
 * in `app/api/admin/creators/route.ts`.
 */
export const POLL_HEALTH_LIMIT = 500;

/**
 * How many creator ids go into one `.in()` filter.
 *
 * A filter travels in the QUERY STRING, so `.in('creator_id', ids)` grows the
 * URL linearly with the id count, and the proxy in front of PostgREST rejects a
 * long URI before the database sees it. Measured exactly, because this was a
 * live bug (MEAL-112) and not a theory: `creator_id=in.(…)` of n uuids is
 * `15 + 37n` bytes, so 221 ids is 8192 bytes and fits, and **222 ids is 8229 and
 * comes back 414**. The route that lists every creator passed all of them.
 *
 * A 414 is the worst possible shape of failure here. It is not an exception and
 * `data ?? []` turns it into "no state rows", which reads as "never polled",
 * which `pollStatus` calls `unconfigured` — so the Sources tab rendered the whole
 * creator list as having no source configured, and an operator looking at a
 * screen that says nothing is set up has no reason to disbelieve it.
 *
 * 100 is the same chunk `poll-health-alerts.ts` sweeps in and the idiom
 * `loadStates` uses, and it leaves an order of magnitude of headroom: 100 uuids
 * is 3715 bytes against a conservative 8 KB ceiling. Chunking here rather than in
 * each caller is deliberate — the paging inside `foldDrafts` and
 * `foldLastNewItem` was unreachable from the admin route until the filter that
 * carried the ids stopped being over-long, and a fix in one caller leaves the
 * next one to rediscover this.
 */
const ID_CHUNK = 100;

/**
 * Rows one read asks for, and how many of those reads it is allowed.
 *
 * PostgREST answers a select with at most `db-max-rows` — 1000 on Supabase —
 * and **says nothing about having truncated**. No error, no flag, nothing in the
 * body. Code that folds the result in memory therefore keeps working on every
 * test-sized table and quietly stops being correct for exactly the rows that
 * grew.
 *
 * That is not theoretical here. `creator_source_items` is append-only, so an
 * unordered read comes back oldest-first, which means the page ceiling cuts
 * precisely the newest rows — the only ones `lastNewItemAt` is looking for. One
 * alert chunk is 100 creators; 100 creators averaging ten seen posts is past the
 * ceiling, and every one of them then reads as having last produced something
 * months ago. So both reads below are ORDERED and PAGED explicitly: an unordered
 * page is not a page, it is a random sample that changes between calls.
 *
 * The page ceiling is a bound on one screen draw, not a limit on a creator —
 * 20k rows is two orders of magnitude past the largest catalog we will list.
 */
const PAGE_ROWS = 1000;
const MAX_PAGES = 20;

function iso(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function blank(id: string): CreatorPollHealth {
  return {
    creatorId: id,
    source: null,
    lastPolledAt: null,
    pollAfter: null,
    consecutiveFailures: 0,
    lastFailedAt: null,
    lastError: null,
    lastStatus: null,
    lastNewItemAt: null,
    draftedCount: 0,
    publishedCount: 0,
  };
}

/**
 * Poll health for every creator named, keyed by creator id.
 *
 * A handful of queries rather than one per creator: this screen lists everybody,
 * and a query per row is how an admin page that was fine with twelve creators
 * becomes a timeout at two hundred.
 *
 * `primarySource` says which source each creator is actually polled on, and
 * exists because `creator_source_state` is keyed `(creator_id, source)` and
 * nothing deletes the old row when an operator moves a creator from their blog
 * to their channel. Without it, "the creator's health" is whichever of the two
 * rows PostgREST happened to return last — so a creator on YouTube could be
 * judged, displayed and alerted on as a Website, and the source that is really
 * being polled never looked at. Left out, the fallback is the first row in
 * `source` order: still arbitrary, but at least the same arbitrary answer twice.
 */
export async function pollHealthByCreator(
  supabase: SupabaseClient,
  creatorIds: string[],
  primarySource?: ReadonlyMap<string, string | null>,
): Promise<Map<string, CreatorPollHealth>> {
  const out = new Map<string, CreatorPollHealth>();
  if (creatorIds.length === 0) return out;

  const ids = creatorIds.slice(0, POLL_HEALTH_LIMIT);
  for (const id of ids) out.set(id, blank(id));

  // A chunk at a time, for the URI ceiling in `ID_CHUNK`. Each creator falls in
  // exactly one chunk, so every fold below is complete for the ids it is given
  // and nothing has to be reconciled across chunks. `source` has to be resolved
  // for a chunk before `foldLastNewItem` runs on it, since that fold only counts
  // items belonging to the source the creator is actually polled on.
  for (let from = 0; from < ids.length; from += ID_CHUNK) {
    const chunk = ids.slice(from, from + ID_CHUNK);

    const [stateRes] = await Promise.all([
      // unbounded-select-ok: ID_CHUNK (100) creators per chunk and one row per source,
      // so at most a few hundred rows — see the chunking loop this sits inside
      supabase
        .from('creator_source_state')
        .select('creator_id, source, last_polled_at, poll_after, consecutive_failures, last_failed_at, last_error, last_status')
        .in('creator_id', chunk)
        // One row per source, so a creator can have several. Ordered so that the
        // fallback below picks the same one every time.
        .order('source', { ascending: true }),
      foldDrafts(supabase, chunk, out),
    ]);

    const chosen = new Map<string, Record<string, any>>();
    for (const row of (stateRes.data ?? []) as Array<Record<string, any>>) {
      if (!out.has(row.creator_id)) continue;
      const wanted = primarySource?.get(row.creator_id) ?? null;
      // A state row for a source this creator is no longer polled on is history,
      // not health. Judging it would report on a source nobody is watching and,
      // worse, write the alert mark onto a row the live source never reads.
      if (wanted !== null && row.source !== wanted) continue;
      if (chosen.has(row.creator_id)) continue;
      chosen.set(row.creator_id, row);
    }

    for (const [creatorId, row] of chosen) {
      const entry = out.get(creatorId)!;
      entry.source = iso(row.source);
      entry.lastPolledAt = iso(row.last_polled_at);
      entry.pollAfter = iso(row.poll_after);
      entry.consecutiveFailures = Number.isFinite(row.consecutive_failures) ? Number(row.consecutive_failures) : 0;
      entry.lastFailedAt = iso(row.last_failed_at);
      entry.lastError = iso(row.last_error);
      entry.lastStatus = Number.isFinite(row.last_status) ? Number(row.last_status) : null;
    }

    await foldLastNewItem(supabase, chunk, out);
  }

  return out;
}

/**
 * `lastNewItemAt` for each creator: the newest row they have, and nothing else.
 *
 * Newest-first and paged, for the reason in `PAGE_ROWS` — an unordered read of
 * this table hands back the oldest rows and drops the ones being asked for, with
 * no way to tell that it did. Ordered the other way the first row seen for a
 * creator IS their answer, so each page only has to ask about the creators still
 * without one; that both shrinks every subsequent request and is what makes the
 * loop finish, since a full page whose rows all belong to unanswered creators
 * answers at least one of them.
 *
 * Only rows from the source the creator is polled on count. A creator moved from
 * their blog to their channel still has every blog post in this table, and
 * counting those would report the dead channel as having produced something last
 * week — the one number this whole screen exists to get right.
 */
async function foldLastNewItem(
  supabase: SupabaseClient,
  ids: string[],
  out: Map<string, CreatorPollHealth>,
): Promise<void> {
  let pending = ids;
  for (let page = 0; page < MAX_PAGES && pending.length > 0; page++) {
    const { data } = await supabase
      .from('creator_source_items')
      .select('creator_id, source, created_at')
      .in('creator_id', pending)
      .order('created_at', { ascending: false })
      .limit(PAGE_ROWS);

    const rows = (data ?? []) as Array<Record<string, any>>;
    for (const row of rows) {
      const entry = out.get(row.creator_id);
      if (!entry || entry.lastNewItemAt) continue;
      if (entry.source !== null && row.source !== entry.source) continue;
      const seen = iso(row.created_at);
      if (seen) entry.lastNewItemAt = seen;
    }
    // Short page: every row this creator set has was in it, so whoever is still
    // unanswered genuinely has nothing to answer with.
    if (rows.length < PAGE_ROWS) return;
    pending = pending.filter((id) => !out.get(id)?.lastNewItemAt);
  }
}

/**
 * Lifetime draft and published counts, paged for the same reason.
 *
 * Ordered on the primary key rather than left to chance: an unordered OFFSET may
 * repeat one row and skip another, which for a pair of counters means a number
 * that is wrong in both directions at once.
 */
async function foldDrafts(
  supabase: SupabaseClient,
  ids: string[],
  out: Map<string, CreatorPollHealth>,
): Promise<void> {
  for (let page = 0; page < MAX_PAGES; page++) {
    const from = page * PAGE_ROWS;
    const { data } = await supabase
      .from('creator_import_drafts')
      .select('creator_id, published_meal_id')
      .in('creator_id', ids)
      .order('id', { ascending: true })
      .range(from, from + PAGE_ROWS - 1);

    const rows = (data ?? []) as Array<Record<string, any>>;
    for (const row of rows) {
      const entry = out.get(row.creator_id);
      if (!entry) continue;
      entry.draftedCount += 1;
      if (row.published_meal_id) entry.publishedCount += 1;
    }
    if (rows.length < PAGE_ROWS) return;
  }
}

/**
 * How worrying this creator's polling is, high is worse.
 *
 * The operator's question is almost never "how is everyone doing", it is "who is
 * broken" — so the list sorts on this rather than alphabetically, and the two
 * genuinely different failures rank above everything else:
 *
 *  - **Failing** — consecutive failures, which is a source actively erroring.
 *  - **Silent** — polling fine and producing nothing, which no other column
 *    shows and which nobody would otherwise go looking for.
 *
 * A creator with no source at all scores zero: nothing is broken about a creator
 * who has not set polling up, and floating them to the top would bury the ones
 * that are.
 */
export function pollConcern(health: CreatorPollHealth, now: number = Date.now()): number {
  if (!health.source) return 0;

  const days = (at: string | null): number => {
    if (!at) return 0;
    const t = Date.parse(at);
    return Number.isFinite(t) ? Math.max(0, (now - t) / 86_400_000) : 0;
  };

  // Weighted so six failures outranks a fortnight of silence, and a fortnight of
  // silence outranks a source merely polled a while ago.
  return health.consecutiveFailures * 10
    + days(health.lastNewItemAt)
    + days(health.lastPolledAt) * 0.5;
}

/**
 * The one word for a creator's polling, for the badge an operator scans.
 *
 *  - `unconfigured` — no source. Not a failure and must not be styled as one.
 *  - `failing` — erroring often enough that nobody has looked at it.
 *  - `silent` — polling cleanly and producing nothing, which is the failure this
 *    screen exists to catch and reads as healthy on every other column.
 *  - `wobbling` — a failure or two. Weather, worth showing, not worth alarm.
 *  - `ok` — polling and producing.
 *
 * Separate from `pollConcern` because the two answer different questions: the
 * number orders the list, the kind decides what colour a row is and what it is
 * called. Deriving the badge from the score instead would mean picking score
 * thresholds, and a fortnight of silence and a single failure land on the same
 * number without meaning remotely the same thing.
 */
export type PollStatusKind = 'unconfigured' | 'failing' | 'silent' | 'wobbling' | 'ok';

/** Failures in a row before this stops being weather. */
export const FAILING_AFTER = 3;

/** Days without a new post before a source counts as producing nothing. */
export const SILENT_AFTER_DAYS = 30;

export function pollStatus(health: CreatorPollHealth, now: number = Date.now()): PollStatusKind {
  if (!health.source) return 'unconfigured';
  if (health.consecutiveFailures >= FAILING_AFTER) return 'failing';

  // Only when there is a post to be older than. A source with no items yet is
  // either newly configured or has never produced, and this cannot tell those
  // apart — calling it silent would put every new creator at the top of the list
  // on their first day. `pollConcern` scores a null the same way, at zero.
  const seen = health.lastNewItemAt ? Date.parse(health.lastNewItemAt) : NaN;
  if (Number.isFinite(seen) && now - seen > SILENT_AFTER_DAYS * 86_400_000) return 'silent';

  if (health.consecutiveFailures > 0) return 'wobbling';
  return 'ok';
}
