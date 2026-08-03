/**
 * Appending the Mealio link to a creator's own video descriptions (MEAL-79).
 *
 * The half of the ticket that **writes**, and it is gated three ways. All three
 * have to hold, every time, for every meal:
 *
 *   1. the creator has a YouTube channel connected,
 *   2. `creators.youtube_append_opt_in` is true, and
 *   3. the meal came from one of *their* videos.
 *
 * The first two are `assertAppendAllowed` in `lib/youtube.ts`, which is the
 * single enforcement point and is never reimplemented or bypassed here. The
 * third is this file's job, and it is the part the original ticket was built
 * around — matching a meal to a video by title, with a confidence score and an
 * operator adjudicating "is this the right video".
 *
 * **That problem mostly evaporated.** Matching is only hard when the meal and
 * the video have no recorded relationship, and admin sync records one: a draft
 * carries the `source` and the `item_id` it was imported from, and approving it
 * writes `published_meal_id` onto the same row. So "this meal came from that
 * video" is a column, not an inference.
 *
 * A meal that did not come from one of their videos is therefore **never
 * offered**. That is a small loss and a large simplification, and it fails safe:
 * the worst outcome is a video that could have carried a link and does not.
 *
 * Two rules the ticket is explicit about, and both are load-bearing:
 *
 *   - **Appending twice must not add the link twice.** The description itself is
 *     the record — see `withMealioLink`. A second press reads, finds the link,
 *     and writes nothing.
 *   - **Revoking consent stops future appends and does not retract links already
 *     written.** There is no un-append here and there is not going to be one. We
 *     cannot un-tell a viewer, and silently editing a creator's description a
 *     second time is another write nobody asked for.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { log } from '@/lib/logger';
import { mealShareUrl } from '@/lib/sourcePlatform';
import {
  assertAppendAllowed,
  fetchVideoSnippet,
  updateVideoDescription,
  withMealioLink,
  YOUTUBE_QUOTA,
  type GoogleApiOptions,
} from '@/lib/youtube';
import { usableAccessToken } from '@/lib/platform-tokens';

/** One published meal that came from one of this creator's videos. */
export interface AppendableMeal {
  draftId: string;
  mealId: string;
  mealName: string;
  videoId: string;
  videoUrl: string;
  /** The Mealio page the link points at. Shown so an operator sees what gets written. */
  mealUrl: string;
  approvedAt: string | null;
}

export interface AppendDeps extends GoogleApiOptions {
  supabase: SupabaseClient;
}

/**
 * A refusal carries the HTTP status the route should use, because every one of
 * them is a different thing for an operator to do: 403 is "the creator has not
 * agreed", 409 is "the connection cannot carry this", 404 is "no such meal".
 */
export type AppendRefusal = {
  ok: false;
  status: number;
  error: string;
  /**
   * Units already spent when the refusal happened.
   *
   * A refusal after the `videos.list` — a video on somebody else's channel, a
   * description with no room left, a write YouTube turned down — has cost real
   * quota, and reporting nothing is how the screen's running total ends up below
   * Google's. Absent means nothing was sent: every gate before the first request
   * refuses for free.
   */
  quotaUnits?: number;
};

/**
 * How many published meals one screen offers.
 *
 * Each append is a read plus a write — 51 quota units — so this is a bound on
 * the most expensive button on the screen as much as on the query. There is no
 * cursor past it, so the list says when it is standing on one: a creator with
 * more than 200 approved video imports would otherwise have the older ones
 * become unlinkable with the screen showing nothing at all about it.
 */
export const APPENDABLE_LIMIT = 200;

/**
 * The meals this creator could have a link written back for.
 *
 * Returns a refusal rather than an empty list when consent is off or the channel
 * is not connected, because those are opposite facts: an empty list means "we
 * have imported nothing from their videos yet", and a refusal means "we are not
 * allowed to write". Rendering the first as the second is how a creator gets
 * asked to fix a problem they do not have — and rendering the second as the
 * first hides a consent decision behind a shrug.
 */
export async function listAppendableMeals(
  supabase: SupabaseClient,
  creatorId: string,
): Promise<{ ok: true; meals: AppendableMeal[]; truncated: boolean } | AppendRefusal> {
  // The consent gate first, and before any query that could put a video id on
  // screen. A screen that lists a creator's videos beside an Append button has
  // already implied we may write to them.
  const permission = await assertAppendAllowed(supabase, creatorId);
  if (!permission.ok) return permission;

  const { data } = await supabase
    .from('creator_import_drafts')
    .select('id, item_id, published_meal_id, draft, decided_at')
    .eq('creator_id', creatorId)
    // `source` is what says the meal came from a *video* rather than from their
    // blog. Without it a website import with a numeric `item_id` would be
    // offered as if it were a YouTube video id.
    .eq('source', 'youtube')
    .in('status', ['approved', 'edited'])
    // `nullsFirst: false` against Postgres' default, which puts NULLs *first* on
    // a DESC order. A draft with no `decided_at` is an older or hand-fixed row,
    // and leaving the default in place gives those rows the head of a 200-row
    // window — so the meals an operator is most likely to want, the ones just
    // approved, are the first ones the limit drops.
    .order('decided_at', { ascending: false, nullsFirst: false })
    // One more than we will show, purely to find out whether there is one. There
    // is no cursor here; the extra row is what lets the screen say so.
    .limit(APPENDABLE_LIMIT + 1);

  const rows = (data ?? []) as Array<Record<string, any>>;
  const truncated = rows.length > APPENDABLE_LIMIT;

  const meals: AppendableMeal[] = [];
  for (const row of rows.slice(0, APPENDABLE_LIMIT)) {
    const videoId = typeof row.item_id === 'string' ? row.item_id : '';
    const mealId = typeof row.published_meal_id === 'string' ? row.published_meal_id : '';
    // A draft that is approved but has no published meal is a publish that
    // failed. There is nothing to link to, so there is nothing to offer.
    if (!videoId || !mealId) continue;
    meals.push({
      draftId: row.id,
      mealId,
      mealName: typeof row.draft?.name === 'string' ? row.draft.name : 'Untitled',
      videoId,
      videoUrl: `https://www.youtube.com/watch?v=${videoId}`,
      mealUrl: mealShareUrl(mealId),
      approvedAt: row.decided_at ?? null,
    });
  }

  return { ok: true, meals, truncated };
}

export type AppendOutcome =
  | {
      ok: true;
      /** False when the link was already in the description and nothing was written. */
      written: boolean;
      mealUrl: string;
      videoId: string;
      /** Units spent. A no-op second press costs the read and not the write. */
      quotaUnits: number;
      detail: string;
    }
  | AppendRefusal;

/**
 * Writes the Mealio link into one video's description.
 *
 * The order of the checks is the point. Consent, then ownership of the meal,
 * then ownership of the *video* as YouTube reports it — only then a write. The
 * third check is not redundant with the second: `draftId` arrives in a request
 * body, and the video id it leads to is a string in a table. Comparing the
 * video's own `channelId` against the connected channel is what makes it
 * impossible to write to a channel this creator does not own, whatever any row
 * or any client says.
 *
 * **The read-modify-write is not protected against a lost update, and cannot
 * be.** Between `fetchVideoSnippet` and `updateVideoDescription` — one HTTP
 * round trip — the creator can edit that description in YouTube Studio, and the
 * PUT reverts their edit without noticing. `videos.update` documents no
 * conditional request: no `If-Match`, no etag precondition, nothing to send a
 * version with, so there is no way to make the write fail instead. Named here
 * rather than left silent, because a reader who assumes the concurrency this
 * file *does* handle covers this one is wrong about which risk was taken. The
 * concurrency it handles is two presses of our own button, and that one is
 * genuinely benign: the second press reads the link and writes nothing.
 */
export async function appendMealioLink(
  deps: AppendDeps,
  creatorId: string,
  draftId: string,
  /** Whoever pressed the button. On the log line, because this edits their property. */
  actorUserId: string,
): Promise<AppendOutcome> {
  const supabase = deps.supabase;

  const permission = await assertAppendAllowed(supabase, creatorId);
  if (!permission.ok) return permission;

  const { data } = await supabase
    .from('creator_import_drafts')
    .select('id, creator_id, source, item_id, published_meal_id, status')
    .eq('id', draftId)
    .maybeSingle();

  const draft = (data ?? null) as Record<string, any> | null;
  // Scoped to the creator we checked consent for. A draft id belonging to
  // somebody else must not be usable to write under this creator's grant.
  if (!draft || draft.creator_id !== creatorId) {
    return { ok: false, status: 404, error: 'That draft does not belong to this creator.' };
  }
  if (draft.source !== 'youtube' || typeof draft.item_id !== 'string' || !draft.item_id) {
    return {
      ok: false,
      status: 409,
      error:
        'This meal did not come from one of this creator’s YouTube videos, so there is no video to write ' +
        'to. Only meals imported from a video are offered — there is no title matching here.',
    };
  }
  if (draft.status !== 'approved' && draft.status !== 'edited') {
    return { ok: false, status: 409, error: 'That draft has not been published, so there is no link to add yet.' };
  }
  const mealId = typeof draft.published_meal_id === 'string' ? draft.published_meal_id : '';
  if (!mealId) {
    return { ok: false, status: 409, error: 'That draft has no published meal, so there is nothing to link to.' };
  }

  const accessToken = await usableAccessToken({ supabase }, permission.connection);
  if (!accessToken) {
    return {
      ok: false,
      status: 409,
      error: 'This creator’s YouTube connection could not be renewed, so nothing was written. Ask them to reconnect.',
    };
  }

  const videoId = draft.item_id;
  const apiOptions: GoogleApiOptions = { fetchImpl: deps.fetchImpl, now: deps.now, lookup: deps.lookup };

  const snapshot = await fetchVideoSnippet(accessToken, videoId, apiOptions);
  // The read is charged whether or not it told us something usable, so every
  // refusal from here down carries what it has already cost.
  if (!snapshot.ok) {
    return { ok: false, status: 502, error: snapshot.detail, quotaUnits: YOUTUBE_QUOTA.videosList };
  }

  if (snapshot.snippet.channelId !== permission.channelId) {
    // Either the record is wrong or the request was hand-edited. Both end here.
    return {
      ok: false,
      status: 409,
      quotaUnits: YOUTUBE_QUOTA.videosList,
      error:
        `Video ${videoId} is not on this creator’s connected channel, so nothing was written. Mealio only ` +
        'edits descriptions on the channel whose owner granted access.',
    };
  }

  const mealUrl = mealShareUrl(mealId);
  const edit = withMealioLink(snapshot.snippet.description, mealUrl);

  if (edit.status === 'already-present') {
    // Not an error, and deliberately not a write. This is what makes pressing
    // the button twice — or two operators pressing it once each — harmless.
    return {
      ok: true,
      written: false,
      mealUrl,
      videoId,
      quotaUnits: YOUTUBE_QUOTA.videosList,
      detail: 'The link was already in this description, so nothing was written.',
    };
  }
  if (edit.status === 'too-long') {
    return { ok: false, status: 409, error: edit.detail, quotaUnits: YOUTUBE_QUOTA.videosList };
  }

  const updated = await updateVideoDescription(accessToken, snapshot.snippet, edit.description, apiOptions);
  if (!updated.ok) {
    return {
      ok: false,
      status: 502,
      error: updated.detail,
      quotaUnits: YOUTUBE_QUOTA.videosList + updated.quotaUnits,
    };
  }

  // Logged here rather than in the route, so the line exists for every caller
  // and cannot be skipped by a second one arriving later.
  log({
    event: 'ADMIN:YOUTUBE_APPEND',
    status: 'success',
    userId: actorUserId,
    detail: `creator=${creatorId} draft=${draftId} meal=${mealId} video=${videoId} channel=${permission.channelId}`,
  });

  return {
    ok: true,
    written: true,
    mealUrl,
    videoId,
    quotaUnits: YOUTUBE_QUOTA.videosList + updated.quotaUnits,
    detail: 'The Mealio link was added to the end of this video’s description.',
  };
}
