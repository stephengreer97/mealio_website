import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { fakeDb } from '../helpers/supabase-mock';
import { stubFetch } from '../helpers/import-stubs';

vi.mock('@/lib/logger', () => ({ log: vi.fn() }));

import { appendMealioLink, listAppendableMeals } from '@/lib/youtube-append';
import { MEALIO_LINK_INTRO, YOUTUBE_QUOTA, YOUTUBE_WRITE_SCOPE } from '@/lib/youtube';

/**
 * Writing the Mealio link into a creator's own video descriptions (MEAL-79).
 *
 * Three gates, and every one of them is tested by asserting **nothing was
 * written** rather than that a refusal came back — a version that returns an
 * error and issues the PUT anyway would pass the second and fail the first.
 *
 *   1. the creator has a channel connected,
 *   2. `youtube_append_opt_in` is true, and
 *   3. the meal came from one of *their* videos.
 *
 * Plus the two rules the ticket states outright: appending twice adds one link,
 * and revoking consent stops the next write without retracting the last one.
 */

const CHANNEL_ID = 'UCabcdefghijklmnopqrstuv';
const VIDEO_ID = 'vid0000000A';
const MEAL_URL = 'https://mealio.co/meal/p/best-guacamole-meal-1';
const YT_API = 'https://www.googleapis.com/youtube/v3';

const VIDEOS_URL = `${YT_API}/videos?${new URLSearchParams({ part: 'snippet', id: VIDEO_ID })}`;
const UPDATE_URL = `${YT_API}/videos?part=snippet`;

const supabase = fakeDb as unknown as SupabaseClient;

function grantRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pa1',
    creator_id: 'c1',
    platform: 'youtube',
    external_id: CHANNEL_ID,
    external_name: 'Chef Sarah',
    access_token: 'ya29-token',
    refresh_token: '1//refresh',
    scopes: `https://www.googleapis.com/auth/youtube.readonly ${YOUTUBE_WRITE_SCOPE}`,
    expires_at: '2099-01-01T00:00:00.000Z',
    broken_reason: null,
    broken_at: null,
    ...overrides,
  };
}

function draftRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'd1',
    creator_id: 'c1',
    source: 'youtube',
    item_id: VIDEO_ID,
    published_meal_id: 'meal-1',
    status: 'approved',
    decided_at: '2026-08-01T10:00:00.000Z',
    draft: { name: 'Best Guacamole' },
    ...overrides,
  };
}

/** The creator row, the grant and one approved draft, all as real rows. */
function seedAll(creator: Record<string, unknown> = {}, drafts = [draftRow()]) {
  fakeDb.seed('creators', [{ id: 'c1', youtube_append_opt_in: true, ...creator }]);
  fakeDb.seed('creator_platform_accounts', [grantRow()]);
  fakeDb.seed('creator_import_drafts', drafts);
}

/**
 * YouTube, with one video on the creator's own channel.
 *
 * `writes` collects every PUT body, so a test can assert on what would land on
 * the channel — and, more usefully, on the fact that nothing did.
 */
function youtube(description = 'Ingredients:\n2 avocados', channelId = CHANNEL_ID) {
  const writes: Array<Record<string, any>> = [];
  let current = description;

  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === 'PUT') {
      const body = JSON.parse(String(init.body));
      writes.push(body);
      // The channel now says what we wrote, which is what makes a second call
      // in the same test see the state the first one produced.
      current = body.snippet.description;
      return new Response('{}', { headers: { 'content-type': 'application/json' } });
    }
    if (url === VIDEOS_URL) {
      return new Response(
        JSON.stringify({
          items: [{ id: VIDEO_ID, snippet: { title: 'Best Guacamole', description: current, categoryId: '26', channelId } }],
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;

  return { impl, writes, description: () => current };
}

beforeEach(() => {
  fakeDb.reset();
});

// ── Gate 1 and 2: the connection and the consent flag ────────────────────────

describe('youtube-append — nothing is written without consent and a connection', () => {
  it('refuses, and writes nothing, when the append flag is off', async () => {
    seedAll({ youtube_append_opt_in: false });
    const { impl, writes } = youtube();

    const result = await appendMealioLink({ supabase, fetchImpl: impl }, 'c1', 'd1', 'admin-1');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(403);
    expect(result.error).toMatch(/separate permissions/i);
    // The assertion that matters. A version that returns 403 and PUTs anyway
    // would pass on the status alone.
    expect(writes).toEqual([]);
  });

  it('refuses, and writes nothing, when there is no connected channel', async () => {
    fakeDb.seed('creators', [{ id: 'c1', youtube_append_opt_in: true }]);
    fakeDb.seed('creator_platform_accounts', []);
    fakeDb.seed('creator_import_drafts', [draftRow()]);
    const { impl, writes } = youtube();

    const result = await appendMealioLink({ supabase, fetchImpl: impl }, 'c1', 'd1', 'admin-1');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/no connected YouTube channel/i);
    expect(writes).toEqual([]);
  });

  it('refuses a grant made without the write scope', async () => {
    fakeDb.seed('creators', [{ id: 'c1', youtube_append_opt_in: true }]);
    fakeDb.seed('creator_platform_accounts', [
      grantRow({ scopes: 'https://www.googleapis.com/auth/youtube.readonly' }),
    ]);
    fakeDb.seed('creator_import_drafts', [draftRow()]);
    const { impl, writes } = youtube();

    const result = await appendMealioLink({ supabase, fetchImpl: impl }, 'c1', 'd1', 'admin-1');

    expect(result.ok).toBe(false);
    expect(writes).toEqual([]);
  });

  it('offers nothing at all when consent is off — a refusal, never an empty list', async () => {
    seedAll({ youtube_append_opt_in: false });

    const result = await listAppendableMeals(supabase, 'c1');

    // "Nothing to link" and "not allowed to write" are opposite facts. An empty
    // list for the second sends an operator looking for imports that exist.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(403);
  });
});

// ── Gate 3: the meal came from one of their videos ───────────────────────────

describe('youtube-append — only meals imported from their own videos are offered', () => {
  it('offers a published meal that came from a video', async () => {
    seedAll();

    const result = await listAppendableMeals(supabase, 'c1');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.meals).toHaveLength(1);
    expect(result.meals[0]).toMatchObject({
      draftId: 'd1',
      mealName: 'Best Guacamole',
      videoId: VIDEO_ID,
      videoUrl: `https://www.youtube.com/watch?v=${VIDEO_ID}`,
      mealUrl: MEAL_URL,
    });
  });

  it('never offers a meal that did not come from one of their videos', async () => {
    seedAll({}, [
      // Imported from their blog. `creator_source_items` records a website URL
      // as the item id, and there is no video behind it to write to.
      draftRow({ id: 'd-web', source: 'website', item_id: 'chefsarah.test/guacamole' }),
      // Approved but the publish failed, so there is no meal to link to.
      draftRow({ id: 'd-nomeal', published_meal_id: null }),
      // Still waiting in the queue. Nothing is live under the creator's name.
      draftRow({ id: 'd-pending', status: 'pending_review' }),
    ]);

    const result = await listAppendableMeals(supabase, 'c1');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The original ticket's fuzzy title matching is gone: if admin sync did not
    // import the meal *from* the video, it is simply not on the list.
    expect(result.meals).toEqual([]);
  });

  it('says when there are more linkable meals than it will show, and keeps the newest', async () => {
    // 201 approved video imports, plus one with no `decided_at` — an older or
    // hand-fixed row. Postgres sorts NULLs *first* on a DESC order, so the
    // undated row used to take the head of the 200-row window and push a
    // just-approved meal out of it.
    seedAll({}, [
      draftRow({ id: 'd-undated', item_id: 'vid00undated', published_meal_id: 'meal-undated', decided_at: null }),
      ...Array.from({ length: 201 }, (_, i) =>
        draftRow({
          id: `d-${i}`,
          item_id: `vid${String(i).padStart(9, '0')}`,
          published_meal_id: `meal-${i}`,
          decided_at: `2026-08-01T${String(i % 24).padStart(2, '0')}:00:00.000Z`,
        }),
      ),
    ]);

    const result = await listAppendableMeals(supabase, 'c1');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.meals).toHaveLength(200);
    // There is no cursor past the ceiling, so the only remedy is saying so —
    // silently, a creator past 200 has their older imports become unlinkable
    // with the screen showing nothing about it.
    expect(result.truncated).toBe(true);
    // And the undated row sorts to the tail, where the limit drops it, rather
    // than to the head where it costs a recently approved meal its place.
    expect(result.meals.some((meal) => meal.mealId === 'meal-undated')).toBe(false);
  });

  it('refuses a write for a meal that did not come from a video, and writes nothing', async () => {
    seedAll({}, [draftRow({ source: 'website', item_id: 'chefsarah.test/guacamole' })]);
    const { impl, writes } = youtube();

    const result = await appendMealioLink({ supabase, fetchImpl: impl }, 'c1', 'd1', 'admin-1');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/did not come from one of this creator’s YouTube videos/i);
    expect(writes).toEqual([]);
  });

  it('refuses a draft belonging to another creator, under this creator’s grant', async () => {
    seedAll({}, [draftRow({ creator_id: 'c2' })]);
    const { impl, writes } = youtube();

    const result = await appendMealioLink({ supabase, fetchImpl: impl }, 'c1', 'd1', 'admin-1');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(404);
    expect(writes).toEqual([]);
  });

  it('refuses when YouTube says the video is on somebody else’s channel', async () => {
    seedAll();
    // The row says this video is theirs and YouTube disagrees. The grant is what
    // decides — a record can be wrong and a channel id from Google cannot.
    const { impl, writes } = youtube('Ingredients:\n2 avocados', 'UCzzzzzzzzzzzzzzzzzzzzzz');

    const result = await appendMealioLink({ supabase, fetchImpl: impl }, 'c1', 'd1', 'admin-1');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/not on this creator’s connected channel/i);
    expect(writes).toEqual([]);
    // The `videos.list` that produced the disagreement was charged. A refusal
    // reporting nothing is how the screen's total drifts below Google's.
    expect(result.quotaUnits).toBe(YOUTUBE_QUOTA.videosList);
  });

  it('refuses, and reports its spend, when the link will not fit', async () => {
    seedAll();
    // Long enough that the link cannot be added, short enough that the read is
    // not itself suspect — the truncation guard sits at 5,000 exactly.
    const { impl, writes } = youtube('x'.repeat(4_990));

    const result = await appendMealioLink({ supabase, fetchImpl: impl }, 'c1', 'd1', 'admin-1');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/5000-character limit/);
    expect(writes).toEqual([]);
    expect(result.quotaUnits).toBe(YOUTUBE_QUOTA.videosList);
  });

  it('refuses a description that came back at YouTube’s own maximum, rather than writing it back', async () => {
    seedAll();
    const { impl, writes } = youtube('x'.repeat(5_000));

    const result = await appendMealioLink({ supabase, fetchImpl: impl }, 'c1', 'd1', 'admin-1');

    // `videos.update` replaces the part, so the description read here is the one
    // the video ends up with. A read arriving at exactly the documented ceiling
    // is where a truncation would cut, and the two are indistinguishable — so it
    // is refused, and the refusal says why rather than a comment saying it might
    // happen.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/cut short/i);
    expect(writes).toEqual([]);
  });

  it('refuses when YouTube reported no category for the video', async () => {
    seedAll();
    const writes: Array<Record<string, any>> = [];
    const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        writes.push(JSON.parse(String(init.body)));
        return new Response('{}', { headers: { 'content-type': 'application/json' } });
      }
      return new Response(
        // A `videos.list` that came back with no `categoryId` at all.
        JSON.stringify({ items: [{ id: VIDEO_ID, snippet: { title: 'Best Guacamole', description: 'x', channelId: CHANNEL_ID } }] }),
        { headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const result = await appendMealioLink({ supabase, fetchImpl: impl }, 'c1', 'd1', 'admin-1');

    // `categoryId` is required on the update, so defaulting it to '22' re-files
    // somebody's recipe video as People & Blogs — a second, silent edit made on
    // the strength of a field the read did not return.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/People & Blogs/);
    expect(writes).toEqual([]);
    // The read was spent even though the write never happened.
    expect(result.quotaUnits).toBe(YOUTUBE_QUOTA.videosList);
  });
});

// ── The two rules the ticket states outright ─────────────────────────────────

describe('youtube-append — appending twice adds one link', () => {
  it('writes the link, then writes nothing the second time', async () => {
    seedAll();
    const { impl, writes, description } = youtube();

    const first = await appendMealioLink({ supabase, fetchImpl: impl }, 'c1', 'd1', 'admin-1');
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.written).toBe(true);
    expect(description()).toBe(`Ingredients:\n2 avocados\n\n${MEALIO_LINK_INTRO}\n${MEAL_URL}`);
    expect(first.quotaUnits).toBe(YOUTUBE_QUOTA.videosList + YOUTUBE_QUOTA.videosUpdate);

    const second = await appendMealioLink({ supabase, fetchImpl: impl }, 'c1', 'd1', 'admin-1');
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    // One write, not two. The description is the record: the read-modify-write
    // sees the state the previous write produced, so no bookkeeping row can
    // disagree with the channel.
    expect(second.written).toBe(false);
    expect(writes).toHaveLength(1);
    expect(description().match(new RegExp(MEAL_URL, 'g'))).toHaveLength(1);
    // And the no-op costs the read rather than the read plus a 50-unit write.
    expect(second.quotaUnits).toBe(YOUTUBE_QUOTA.videosList);
  });

  it('sends the title and category back untouched, because the update replaces the part', async () => {
    seedAll();
    const { impl, writes } = youtube();

    await appendMealioLink({ supabase, fetchImpl: impl }, 'c1', 'd1', 'admin-1');

    // A write that sent only the description would blank the creator's title.
    expect(writes[0].snippet.title).toBe('Best Guacamole');
    expect(writes[0].snippet.categoryId).toBe('26');
  });
});

describe('youtube-append — revoking consent stops the next write and retracts nothing', () => {
  it('leaves the link that was already written and refuses the next one', async () => {
    seedAll();
    const { impl, writes, description } = youtube();

    const first = await appendMealioLink({ supabase, fetchImpl: impl }, 'c1', 'd1', 'admin-1');
    expect(first.ok).toBe(true);
    const afterFirstWrite = description();
    expect(afterFirstWrite).toContain(MEAL_URL);

    // The creator turns description editing off. Persisted state, not a mock
    // return value — this is exactly what `PATCH /api/creator/youtube` writes.
    fakeDb.patch('creators', 'c1', { youtube_append_opt_in: false });
    fakeDb.seed('creator_import_drafts', [draftRow({ id: 'd2', published_meal_id: 'meal-2' })]);

    const second = await appendMealioLink({ supabase, fetchImpl: impl }, 'c1', 'd2', 'admin-1');

    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.status).toBe(403);
    // Future appends stop; the one already written stays. We cannot un-tell a
    // viewer, and silently editing the description again is another write
    // nobody asked for.
    expect(writes).toHaveLength(1);
    expect(description()).toBe(afterFirstWrite);
    // And the screen stops offering anything at all, rather than offering a
    // button that would refuse.
    await expect(listAppendableMeals(supabase, 'c1')).resolves.toMatchObject({ ok: false });
  });
});
