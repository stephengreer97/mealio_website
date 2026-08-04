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
 * The ticket asks for the **last failed poll and its reason**. Neither is
 * stored: `creator_source_state` keeps `consecutive_failures` but not when the
 * last failure happened or what it said, and the poller's own sentence goes to
 * the log and nowhere else. Surfacing it needs two new columns
 * (`last_failed_at`, `last_failure_reason`) written by `recordPollOutcome`, and
 * a migration — so this reports the count, which is stored, and says plainly
 * that the reason is not. A screen that invented a reason would be worse than
 * one that admits it has none.
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

/** How many creators one call will report on. A page, not the world. */
export const POLL_HEALTH_LIMIT = 500;

function iso(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

/**
 * Poll health for every creator named, keyed by creator id.
 *
 * Four queries rather than one per creator: this screen lists everybody, and a
 * query per row is how an admin page that was fine with twelve creators becomes
 * a timeout at two hundred.
 */
export async function pollHealthByCreator(
  supabase: SupabaseClient,
  creatorIds: string[],
): Promise<Map<string, CreatorPollHealth>> {
  const out = new Map<string, CreatorPollHealth>();
  if (creatorIds.length === 0) return out;

  const ids = creatorIds.slice(0, POLL_HEALTH_LIMIT);

  const [stateRes, itemRes, draftRes] = await Promise.all([
    supabase
      .from('creator_source_state')
      .select('creator_id, source, last_polled_at, poll_after, consecutive_failures')
      .in('creator_id', ids),
    // Every item this creator's polling has ever seen, newest first seen. The
    // max per creator is the answer; done in one pass below rather than one
    // query per creator.
    supabase
      .from('creator_source_items')
      .select('creator_id, created_at')
      .in('creator_id', ids),
    supabase
      .from('creator_import_drafts')
      .select('creator_id, published_meal_id')
      .in('creator_id', ids),
  ]);

  for (const id of ids) {
    out.set(id, {
      creatorId: id,
      source: null,
      lastPolledAt: null,
      pollAfter: null,
      consecutiveFailures: 0,
      lastNewItemAt: null,
      draftedCount: 0,
      publishedCount: 0,
    });
  }

  for (const row of (stateRes.data ?? []) as Array<Record<string, any>>) {
    const entry = out.get(row.creator_id);
    if (!entry) continue;
    entry.source = iso(row.source);
    entry.lastPolledAt = iso(row.last_polled_at);
    entry.pollAfter = iso(row.poll_after);
    entry.consecutiveFailures = Number.isFinite(row.consecutive_failures) ? Number(row.consecutive_failures) : 0;
  }

  for (const row of (itemRes.data ?? []) as Array<Record<string, any>>) {
    const entry = out.get(row.creator_id);
    const seen = iso(row.created_at);
    if (!entry || !seen) continue;
    if (!entry.lastNewItemAt || seen > entry.lastNewItemAt) entry.lastNewItemAt = seen;
  }

  for (const row of (draftRes.data ?? []) as Array<Record<string, any>>) {
    const entry = out.get(row.creator_id);
    if (!entry) continue;
    entry.draftedCount += 1;
    if (row.published_meal_id) entry.publishedCount += 1;
  }

  return out;
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
