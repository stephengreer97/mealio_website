import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { fakeDb } from '../helpers/supabase-mock';
import { importedGuacamole } from '../helpers/import-ui-fixtures';
import type { CreatorMealDraft, ImportConfidence, ImportSuccess } from '@/lib/import/types';

/**
 * Captured rather than anonymous, because the audit trail is one of the things
 * under test. `DraftDeps.role` changes the event name and nothing else, and an
 * anonymous `vi.fn()` here is what let that distinction be silently deleted:
 * forcing every event back to the `ADMIN:` names left the whole suite green.
 */
const log = vi.fn();
vi.mock('@/lib/logger', () => ({ log: (...args: unknown[]) => log(...args) }));

const sendCreatorSyncPublishedEmail = vi.fn();
vi.mock('@/lib/email', () => ({
  sendCreatorSyncPublishedEmail: (...args: unknown[]) => sendCreatorSyncPublishedEmail(...args),
}));

// Never reached in this suite. Present so "transactional, not marketing" is an
// assertion rather than a claim: `marketing_opt_out` must not be able to
// suppress a creator being told nine recipes went live under their name.
const sendMarketingEmail = vi.fn();
vi.mock('@/lib/marketing-email', () => ({
  sendMarketingEmail: (...args: unknown[]) => sendMarketingEmail(...args),
}));

// Reached only by the tests that approve through the *real* publisher, where a
// stand-in photo would otherwise be copied into storage.
vi.mock('@/lib/photos', () => ({
  resolvePhotoUrl: vi.fn(async (url: string | undefined) => url ?? null),
}));

import {
  approveDraft,
  cancelDraft,
  editDraft,
  countPendingDrafts,
  draftBelongsToCreator,
  editableDraft,
  listAllPendingDrafts,
  listDraftQueue,
  listHandedOverDrafts,
  notifyApproved,
  queueOf,
  reclaimDraft,
  reviewDraft,
  sendDraftToCreator,
  stripEditedConfidence,
  type DraftDeps,
  type ImportDraft,
  type PendingDraft,
} from '@/lib/import-drafts';

/**
 * The admin review queue's engine (MEAL-91).
 *
 * The properties under test are the ones the ticket exists for:
 *
 *   - **Approve is the only path to Discover.** Nothing else in this file may
 *     reach `publishCreatorMeal`, and the tests assert the publisher was not
 *     called rather than only checking a status string.
 *   - **Delete marks, never removes.** A `.delete()` on this table would let the
 *     next sync of the same post re-import it and ask again.
 *   - **Nothing ends up in neither queue.** Send to creator is refused while the
 *     creator's queue does not exist, and anything an operator handed over
 *     before it was switched off is still listed and can be taken back.
 *   - **Editing drops our verification of what was edited.** A green is a claim
 *     about the *model's* value; it must not end up vouching for a human's.
 */

const supabase = fakeDb as unknown as SupabaseClient;

let guacamole: ImportSuccess;

/** The row `creator_import_drafts` hands back, with the creator join `loadDraft` asks for. */
function draftRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'd1',
    creator_id: 'c1',
    source_url: 'https://chefsarah.test/guacamole',
    source: 'website',
    item_id: 'guid-1',
    sync_run_id: 'r1',
    draft: guacamole.draft,
    confidence: guacamole.confidence,
    status: 'pending_review',
    review_by: 'admin',
    edited_at: null,
    decided_at: null,
    decided_by: null,
    published_meal_id: null,
    created_at: '2026-08-02T10:00:00.000Z',
    creators: {
      id: 'c1',
      display_name: 'Chef Sarah',
      user_id: 'u1',
      user_profiles: { email: 'sarah@chefsarah.test' },
    },
    ...overrides,
  };
}

/** The list query's row shape — a narrower join than the single-draft read. */
function queueRow(overrides: Record<string, unknown> = {}) {
  const row = draftRow(overrides) as Record<string, unknown>;
  return { ...row, creators: { display_name: 'Chef Sarah' } };
}

function deps(overrides: Partial<DraftDeps> = {}): DraftDeps {
  return {
    supabase,
    publisher: vi.fn(async () => ({ id: 'meal-1', name: 'Best Guacamole' })) as unknown as DraftDeps['publisher'],
    now: () => 1_800_000_000_000,
    ...overrides,
  };
}

/** The last update written to a table, as the route would have sent it. */
function lastUpdate(table: string) {
  return fakeDb.calls.filter((c) => c.table === table && c.method === 'update').at(-1)?.args[0];
}

/** The event names logged so far, in order. */
function loggedEvents(): string[] {
  return log.mock.calls.map((call) => (call[0] as { event: string }).event);
}

beforeEach(async () => {
  fakeDb.reset();
  sendCreatorSyncPublishedEmail.mockReset();
  sendMarketingEmail.mockReset();
  guacamole = await importedGuacamole();
  // After the fixture, not before: building it runs the import pipeline, which
  // logs a `CREATOR:MEAL_IMPORT` of its own that has nothing to do with a
  // decision.
  log.mockReset();
});

// ── Presentation ─────────────────────────────────────────────────────────────

describe('reviewDraft — exceptions only', () => {
  /** `reviewDraft` takes an `ImportDraft`; this is one built from a stored row. */
  function asDraft(overrides: Partial<ImportDraft> = {}): ImportDraft {
    return {
      id: 'd1',
      creatorId: 'c1',
      creatorName: 'Chef Sarah',
      sourceUrl: 'https://chefsarah.test/guacamole',
      source: 'website',
      itemId: 'guid-1',
      syncRunId: 'r1',
      draft: guacamole.draft,
      confidence: guacamole.confidence,
      status: 'pending_review',
      reviewBy: 'admin',
      editedAt: null,
      decidedAt: null,
      decidedBy: null,
      publishedMealId: null,
      createdAt: '2026-08-02T10:00:00.000Z',
      ...overrides,
    };
  }

  it('says nothing about a field that verified, and calls out the ones that did not', async () => {
    const { states, summary } = reviewDraft(asDraft());

    // The fixture lands a field on every level on purpose, including a
    // deliberate hallucination, so these are real outcomes and not constants.
    expect(states.name?.confidence.level).toBe('green');
    expect(summary.verified).toBeGreaterThan(0);
    expect(summary.needALook).toBeGreaterThan(0);
    // Verified and flagged are exhaustive: every field the draft touched is in
    // exactly one of the two, so the count on screen adds up.
    expect(summary.verified + summary.needALook).toBe(summary.total);
  });

  it('flags every field when no assessment was ever recorded, rather than implying we checked', async () => {
    // Only rows written before MEAL-91 can be in this state. "We have no record
    // of checking this" must not render as nine silent, apparently-verified
    // fields — silence is a claim, and here we have nothing to claim.
    const { summary } = reviewDraft(asDraft({ confidence: null }));
    expect(summary.verified).toBe(0);
    expect(summary.needALook).toBe(summary.total);
  });
});

describe('listDraftQueue', () => {
  it('asks only for what is pending in this queue, and puts the flagged first', async () => {
    const clean: ImportConfidence = {
      ...guacamole.confidence,
      // Every field verified and every ingredient row with it.
      recipe: { ...guacamole.confidence.name },
      difficulty: { ...guacamole.confidence.name },
      tags: { ...guacamole.confidence.name },
      story: { ...guacamole.confidence.name },
      serves: { ...guacamole.confidence.name },
      photoUrl: { ...guacamole.confidence.name },
      ingredients: guacamole.confidence.ingredients.map(() => ({ ...guacamole.confidence.name })),
    };
    const cleanDraft: CreatorMealDraft = { ...guacamole.draft, story: 'A story.', serves: '4' };

    fakeDb.queue('creator_import_drafts', {
      data: [
        queueRow({ id: 'tidy', draft: cleanDraft, confidence: clean, created_at: '2026-08-01T00:00:00.000Z' }),
        queueRow({ id: 'messy' }),
      ],
    });

    const rows = await listDraftQueue(supabase, 'admin');

    // Most-flagged first, so an operator sees where the work is without opening
    // anything — even though the clean one is older.
    expect(rows.map((row) => row.id)).toEqual(['messy', 'tidy']);
    expect(rows[0].summary.needALook).toBeGreaterThan(0);
    expect(rows[1].summary.needALook).toBe(0);

    // The queue's own filters, which are the first two on this table. The
    // duplicate check (MEAL-98) queries it again afterwards — for this creator's
    // other pending drafts — so asserting the whole list would be asserting that
    // feature's shape from here.
    const filters = fakeDb.calls.filter((c) => c.table === 'creator_import_drafts' && c.method === 'eq');
    expect(filters.slice(0, 2).map((c) => c.args)).toEqual([['status', 'pending_review'], ['review_by', 'admin']]);
  });

  it('attaches the duplicate a draft repeats, for the screen and the email', async () => {
    // MEAL-98/107. Seeded rather than queued: `listDraftQueue` hits
    // `creator_import_drafts` twice — once for the queue, once for duplicate
    // candidates — and FIFO queued results cannot tell those apart. Seeding
    // gives both queries real filter evaluation.
    fakeDb.seed('creator_import_drafts', [queueRow({ id: 'short' })]);
    fakeDb.seed('preset_meals', [{
      id: 'live-1',
      creator_id: 'c1',
      name: 'Best Guacamole',
      // The same dish already on Discover.
      ingredients: (guacamole.draft.ingredients ?? []).map((i) => ({ ingredientName: i.ingredientName })),
    }]);

    const rows = await listDraftQueue(supabase, 'admin');

    expect(rows).toHaveLength(1);
    expect(rows[0].duplicates[0]?.name).toBe('Best Guacamole');
    expect(rows[0].duplicates[0]?.kind).toBe('published');
  });

  it('never offers a draft as a duplicate of itself', async () => {
    // It matches perfectly, so without the guard every row in the queue flags —
    // the most confident wrong answer this feature can give.
    fakeDb.seed('creator_import_drafts', [queueRow({ id: 'only' })]);
    fakeDb.seed('preset_meals', []);

    const rows = await listDraftQueue(supabase, 'admin');

    expect(rows[0].duplicates).toEqual([]);
  });

  it('reads the creator queue with the same code, keyed the other way', async () => {
    fakeDb.queue('creator_import_drafts', { data: [queueRow({ review_by: 'creator' })] });
    await listDraftQueue(supabase, 'creator');
    const filters = fakeDb.calls.filter((c) => c.table === 'creator_import_drafts' && c.method === 'eq');
    expect(filters.map((c) => c.args)).toContainEqual(['review_by', 'creator']);
  });
});

describe('the creator queue is scoped to one creator', () => {
  it('returns only that creator’s drafts', async () => {
    // `review_by = 'creator'` is true of every poller draft in the table, for
    // every creator on the platform. Without the creator filter the queue would
    // hand each of them everyone else's unpublished recipes.
    fakeDb.seed('creator_import_drafts', [
      queueRow({ id: 'mine', review_by: 'creator', creator_id: 'c1' }),
      queueRow({ id: 'theirs', review_by: 'creator', creator_id: 'c2' }),
    ]);

    const rows = await listDraftQueue(supabase, 'creator', { creatorId: 'c1' });

    expect(rows.map((row) => row.id)).toEqual(['mine']);
  });

  it('counts what is waiting on them, and nothing else', async () => {
    fakeDb.seed('creator_import_drafts', [
      queueRow({ id: 'a', review_by: 'creator', creator_id: 'c1' }),
      queueRow({ id: 'b', review_by: 'creator', creator_id: 'c1' }),
      // Already decided — out of the queue and out of the badge.
      queueRow({ id: 'c', review_by: 'creator', creator_id: 'c1', status: 'cancelled' }),
      // Still an operator's to decide; not waiting on this creator at all.
      queueRow({ id: 'd', review_by: 'admin', creator_id: 'c1' }),
      queueRow({ id: 'e', review_by: 'creator', creator_id: 'c2' }),
    ]);

    expect(await countPendingDrafts(supabase, 'c1')).toBe(2);
  });

  it('asks the database for a count rather than for the recipes', async () => {
    // Every portal load and every app foreground calls this, and a draft is a
    // jsonb recipe. Fetching rows to call `.length` on them is the version of
    // this that works fine until a creator has forty.
    fakeDb.seed('creator_import_drafts', [queueRow({ review_by: 'creator', creator_id: 'c1' })]);
    await countPendingDrafts(supabase, 'c1');

    const select = fakeDb.calls.find((c) => c.table === 'creator_import_drafts' && c.method === 'select');
    expect(select?.args[1]).toMatchObject({ head: true, count: 'exact' });
  });
});

describe('draftBelongsToCreator — whose recipe is this', () => {
  it('says yes only for the owner', async () => {
    fakeDb.seed('creator_import_drafts', [draftRow()]);
    expect(await draftBelongsToCreator(supabase, 'd1', 'c1')).toBe(true);
    expect(await draftBelongsToCreator(supabase, 'd1', 'c2')).toBe(false);
  });

  it('fails closed on a draft that does not exist', async () => {
    // A uuid in a request body is not evidence of anything. The safe answer to
    // "we cannot find this row" is no.
    fakeDb.seed('creator_import_drafts', []);
    expect(await draftBelongsToCreator(supabase, 'nope', 'c1')).toBe(false);
  });
});

// ── Approve ──────────────────────────────────────────────────────────────────

describe('approveDraft — the only path to Discover', () => {
  it('publishes the draft and records the decision and the actor', async () => {
    fakeDb.seed('creator_import_drafts', [draftRow()]);
    const publisher = vi.fn(async () => ({ id: 'meal-1', name: 'Best Guacamole' }));

    const result = await approveDraft(
      deps({ publisher: publisher as unknown as DraftDeps['publisher'] }),
      'd1',
      'admin-1',
    );

    expect(result.ok).toBe(true);
    // Attribution goes through the same insert the creator portal uses, so the
    // author name and the creator_id the profit share counts cannot drift.
    expect(publisher).toHaveBeenCalledWith(
      expect.anything(),
      { id: 'c1', display_name: 'Chef Sarah', user_id: 'u1' },
      guacamole.draft,
    );
    // The persisted row, not the arguments of the last update: the decision is
    // claimed and the meal id written by two separate writes now, and asserting
    // one call's shape would say nothing about where the row ended up.
    expect(fakeDb.row('creator_import_drafts', 'd1')).toMatchObject({
      status: 'approved',
      decided_by: 'admin-1',
      published_meal_id: 'meal-1',
      decided_at: '2027-01-15T08:00:00.000Z',
    });
  });

  it('records `edited` when an operator had changed something first', async () => {
    // Months later the row still answers "did a human rewrite what the model
    // produced?" — which is a different thing from "did a human approve it".
    fakeDb.seed('creator_import_drafts', [draftRow({ edited_at: '2026-08-02T11:00:00.000Z' })]);
    await approveDraft(deps(), 'd1', 'admin-1');
    expect(fakeDb.row('creator_import_drafts', 'd1')).toMatchObject({ status: 'edited' });
  });

  it('refuses to publish the same draft twice', async () => {
    // Two tabs, or a double-click. Publishing twice would put one recipe on
    // Discover twice under a creator's name.
    fakeDb.seed('creator_import_drafts', [draftRow({ status: 'approved' })]);
    const publisher = vi.fn();

    const result = await approveDraft(deps({ publisher: publisher as unknown as DraftDeps['publisher'] }), 'd1', 'admin-1');

    expect(result.ok).toBe(false);
    expect(publisher).not.toHaveBeenCalled();
  });

  it('refuses a draft that has been declined, so a decline is not undone by a stale tab', async () => {
    fakeDb.seed('creator_import_drafts', [draftRow({ status: 'cancelled' })]);
    const publisher = vi.fn();
    const result = await approveDraft(deps({ publisher: publisher as unknown as DraftDeps['publisher'] }), 'd1', 'admin-1');
    expect(result.ok).toBe(false);
    expect(publisher).not.toHaveBeenCalled();
  });

  it('leaves the draft pending when publishing fails, so it can be tried again', async () => {
    fakeDb.seed('creator_import_drafts', [draftRow()]);

    const result = await approveDraft(
      deps({ publisher: (async () => { throw new Error('duplicate key'); }) as unknown as DraftDeps['publisher'] }),
      'd1',
      'admin-1',
    );

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/duplicate key/);
    // The decision is claimed before the publish, so this is a rollback rather
    // than "nothing was written" — but the row has to land in the same place. A
    // draft left `approved` with no meal behind it has gone from the queue
    // without publishing, which nobody would ever see.
    expect(fakeDb.row('creator_import_drafts', 'd1')).toMatchObject({
      status: 'pending_review',
      published_meal_id: null,
      decided_by: null,
      decided_at: null,
    });
  });

  it('leaves the durable record alone — it already says everything it can', async () => {
    // It was written at sync time and says `imported`, pointing at this draft.
    // There is no meal column on that table, so an update here changed nothing
    // while its comment claimed the record now pointed at a live meal.
    fakeDb.seed('creator_import_drafts', [draftRow()]);
    await approveDraft(deps(), 'd1', 'admin-1');
    expect(fakeDb.calls.some((c) => c.table === 'creator_source_items')).toBe(false);
  });

  it('publishes once when two tabs approve the same draft at the same time', async () => {
    // Two admin tabs, or one tab whose fetch the browser retried. Both read
    // `pending_review` before either writes, and the read-check-write guard sees
    // nothing wrong: two `preset_meals` rows for one draft under a creator's
    // name, two Discover entries, two "your recipe is live" emails.
    fakeDb.seed('creator_import_drafts', [draftRow()]);
    let published = 0;
    const publisher = vi.fn(async () => ({ id: `meal-${++published}`, name: 'Best Guacamole' }));

    const [first, second] = await Promise.all([
      approveDraft(deps({ publisher: publisher as unknown as DraftDeps['publisher'] }), 'd1', 'admin-1'),
      approveDraft(deps({ publisher: publisher as unknown as DraftDeps['publisher'] }), 'd1', 'admin-2'),
    ]);

    expect(publisher).toHaveBeenCalledTimes(1);
    expect([first.ok, second.ok].filter(Boolean)).toHaveLength(1);
    const loser = first.ok ? second : first;
    expect(loser.ok === false && loser.error).toMatch(/already/i);
    expect(fakeDb.row('creator_import_drafts', 'd1')).toMatchObject({
      status: 'approved',
      published_meal_id: 'meal-1',
    });
  });

  /**
   * Everything above injects a stub publisher, which is the right shape for
   * asserting *who* gets called and in which order — and says nothing about
   * what happens when the real one refuses. The tag cap lives inside
   * `publishCreatorMeal`, so "approve no longer publishes an over-cap draft" is
   * a claim about the seam between these two functions and nothing was standing
   * on it: `deps.publisher` could have lost its default, or `approveDraft`
   * could have started trimming before the call, with the suite still green.
   *
   * So these two run the real publisher against the real fake database.
   */
  describe('the link back onto the creator\'s video (MEAL-78)', () => {
    it('appends after a YouTube draft publishes, whoever approved it', async () => {
      // Approving used to publish and stop. The description edit existed but had
      // exactly one caller — an admin pressing a button on the sync screen — so a
      // creator who had turned the setting on approved their own recipe and
      // nothing was written to their video.
      fakeDb.seed('creator_import_drafts', [draftRow({ source: 'youtube' })]);
      const appender: DraftDeps['appender'] = vi.fn(async () => ({
        ok: true as const, written: true, mealUrl: 'https://mealio.co/meal/p/meal-1',
        videoId: 'ZW9XmKyi4lI', quotaUnits: 51, detail: 'appended',
      }));

      const result = await approveDraft(deps({ appender }), 'd1', 'admin-1');

      expect(result.ok).toBe(true);
      expect(appender).toHaveBeenCalledTimes(1);
      // Called with the draft, so it can find the meal that was just published,
      // and with the actor, because this edits somebody else's property.
      expect(vi.mocked(appender!).mock.calls[0].slice(1)).toEqual(['c1', 'd1', 'admin-1']);
    });

    it('does not reach YouTube for a draft that did not come from it', async () => {
      // A website draft has no video to write to. Calling anyway would refuse,
      // but it would cost a read and a log line on every approval in the system
      // to say what the row already said.
      fakeDb.seed('creator_import_drafts', [draftRow({ source: 'website' })]);
      const appender: DraftDeps['appender'] = vi.fn();

      await approveDraft(deps({ appender }), 'd1', 'admin-1');

      expect(appender).not.toHaveBeenCalled();
    });

    it('publishes anyway when the append fails', async () => {
      // The meal is live and the link is a courtesy on top. Rolling a publish
      // back because a description could not be edited would be the tail wagging
      // the dog; refusing to publish because YouTube is down would be worse.
      fakeDb.seed('creator_import_drafts', [draftRow({ source: 'youtube' })]);
      const appender: DraftDeps['appender'] = vi.fn(async () => { throw new Error('YouTube said 503'); });

      const result = await approveDraft(deps({ appender }), 'd1', 'admin-1');

      expect(result.ok).toBe(true);
      expect(fakeDb.row('creator_import_drafts', 'd1')?.published_meal_id).toBe('meal-1');
    });

    it('leaves the consent gate to the appender rather than copying it', async () => {
      // The opt-in, the grant, the write scope and whose channel the video is on
      // are all decided in `appendMealioLink`. A refusal is a normal outcome
      // here — the setting is off unless a creator turned it on — and it must
      // not read as the approval having failed.
      fakeDb.seed('creator_import_drafts', [draftRow({ source: 'youtube' })]);
      const appender: DraftDeps['appender'] = vi.fn(async () => ({
        ok: false as const, status: 403, error: 'The creator has not turned this on.',
      }));

      const result = await approveDraft(deps({ appender }), 'd1', 'admin-1');

      expect(result.ok).toBe(true);
      expect(appender).toHaveBeenCalledTimes(1);
    });
  });

  describe('with the real publisher behind it', () => {
    /** No `publisher` override: `approveDraft` falls back to `publishCreatorMeal`. */
    function realDeps() {
      return { supabase, now: () => 1_800_000_000_000 } as DraftDeps;
    }

    it('refuses an over-cap draft and leaves it in the queue to be fixed', async () => {
      // The extraction prompt allows up to eight tags and older builds stored
      // whatever it returned, so this row is a real thing sitting in the queue.
      fakeDb.seed('creator_import_drafts', [draftRow({
        draft: {
          ...guacamole.draft,
          tags: ['Mexican', 'No Cook', 'Appetizer', 'Vegan', 'Healthy', 'Snack', 'Soup', 'Salad'],
        },
      })]);
      fakeDb.seed('preset_meals', []);

      const result = await approveDraft(realDeps(), 'd1', 'admin-1');

      expect(result.ok).toBe(false);
      expect(result.ok === false && result.error)
        .toBe('Publishing failed: That is 8 tags. A meal takes at most 3.');
      // Nothing reached Discover, and the draft is back where the operator can
      // deselect down to three and approve again.
      expect(fakeDb.rows('preset_meals')).toEqual([]);
      expect(fakeDb.row('creator_import_drafts', 'd1')).toMatchObject({
        status: 'pending_review',
        decided_by: null,
        decided_at: null,
        published_meal_id: null,
      });
      expect(sendCreatorSyncPublishedEmail).not.toHaveBeenCalled();
    });

    it('publishes a draft inside the cap, through that same path', async () => {
      // The other half of the seam: the refusal above is the cap firing, not
      // the real publisher failing for some unrelated reason.
      fakeDb.seed('creator_import_drafts', [draftRow()]);
      fakeDb.seed('preset_meals', []);

      const result = await approveDraft(realDeps(), 'd1', 'admin-1');

      expect(result.ok).toBe(true);
      const rows = fakeDb.rows('preset_meals');
      expect(rows).toHaveLength(1);
      expect(rows[0].tags).toEqual(['Mexican', 'No Cook', 'Appetizer']);
      expect(rows[0]).toMatchObject({ name: 'Best Guacamole', author: 'Chef Sarah', creator_id: 'c1' });
      expect(fakeDb.row('creator_import_drafts', 'd1')).toMatchObject({
        status: 'approved',
        decided_by: 'admin-1',
      });
    });
  });

  it.each([['approve first', true], ['decline first', false]] as const)(
    'lets exactly one of an approval and a decline win (%s)',
    async (_name, approveFirst) => {
      // The state the row must never reach: `cancelled`, so it has left the
      // queue as declined and nobody will look at it again, with a live meal on
      // Discover behind it that nobody will ever unpublish.
      fakeDb.seed('creator_import_drafts', [draftRow()]);
      const publisher = vi.fn(async () => ({ id: 'meal-1', name: 'Best Guacamole' }));
      const approve = () => approveDraft(deps({ publisher: publisher as unknown as DraftDeps['publisher'] }), 'd1', 'admin-1');
      const decline = () => cancelDraft(deps(), 'd1', 'admin-2');

      const results = await Promise.all(approveFirst ? [approve(), decline()] : [decline(), approve()]);

      expect(results.filter((result) => result.ok)).toHaveLength(1);
      const row = fakeDb.row('creator_import_drafts', 'd1')!;
      if (publisher.mock.calls.length > 0) {
        expect(row).toMatchObject({ status: 'approved', published_meal_id: 'meal-1' });
      } else {
        expect(row).toMatchObject({ status: 'cancelled', published_meal_id: null });
      }
    },
  );

});

// ── The email ────────────────────────────────────────────────────────────────

describe('notifyApproved', () => {
  const approved = (creatorId: string, mealId: string, name: string) => ({
    draftId: `draft-${mealId}`,
    creatorId,
    creatorName: creatorId === 'c1' ? 'Chef Sarah' : 'Chef Ada',
    creatorEmail: creatorId === 'c1' ? 'sarah@chefsarah.test' : 'ada@chefada.test',
    meal: { id: mealId, name },
  });

  it('sends one email per creator per batch, listing only what published', async () => {
    const result = await notifyApproved(deps({ notifier: sendCreatorSyncPublishedEmail as unknown as DraftDeps['notifier'] }), [
      approved('c1', 'meal-1', 'Guacamole'),
      approved('c1', 'meal-2', 'Black bean soup'),
      approved('c2', 'meal-3', 'Focaccia'),
    ]);

    expect(result.sent).toBe(2);
    expect(sendCreatorSyncPublishedEmail).toHaveBeenCalledTimes(2);
    expect(sendCreatorSyncPublishedEmail.mock.calls[0]).toEqual([
      'sarah@chefsarah.test',
      'Chef Sarah',
      [{ id: 'meal-1', name: 'Guacamole' }, { id: 'meal-2', name: 'Black bean soup' }],
    ]);
    // Transactional, never the campaign helper: marketing_opt_out must not be
    // able to suppress "nine recipes are live under your name".
    expect(sendMarketingEmail).not.toHaveBeenCalled();
  });

  it('sends nothing when nothing published', async () => {
    const result = await notifyApproved(deps({ notifier: sendCreatorSyncPublishedEmail as unknown as DraftDeps['notifier'] }), []);
    expect(result.sent).toBe(0);
    expect(sendCreatorSyncPublishedEmail).not.toHaveBeenCalled();
  });

  it('says plainly when a send failed — the meals are live either way', async () => {
    sendCreatorSyncPublishedEmail.mockRejectedValueOnce(new Error('Resend is down'));
    const result = await notifyApproved(
      deps({ notifier: sendCreatorSyncPublishedEmail as unknown as DraftDeps['notifier'] }),
      [approved('c1', 'meal-1', 'Guacamole')],
    );
    expect(result.sent).toBe(0);
    expect(result.errors[0]).toMatch(/NOT told/);
  });

  it('says so when a creator has no address rather than reporting a send', async () => {
    const result = await notifyApproved(
      deps({ notifier: sendCreatorSyncPublishedEmail as unknown as DraftDeps['notifier'] }),
      [{ ...approved('c1', 'meal-1', 'Guacamole'), creatorEmail: null }],
    );
    expect(result.sent).toBe(0);
    expect(result.errors[0]).toMatch(/no email address/);
    expect(sendCreatorSyncPublishedEmail).not.toHaveBeenCalled();
  });
});

// ── Send to creator ──────────────────────────────────────────────────────────

describe('sendDraftToCreator — the escape hatch, now that it lands somewhere', () => {
  it('moves the draft into the creator queue, still undecided', async () => {
    // The button was disabled until MEAL-89: `review_by = 'creator'` was read by
    // one query in this repository and it asked for `'admin'`, so flipping the
    // column moved a draft out of the only queue anybody read and into nothing.
    // `listDraftQueue(supabase, 'creator', { creatorId })` is the reader that
    // makes this a handoff rather than a trapdoor, and it is asserted below.
    fakeDb.seed('creator_import_drafts', [draftRow()]);

    const result = await sendDraftToCreator(deps(), 'd1', 'admin-1');

    expect(result.ok).toBe(true);
    expect(fakeDb.row('creator_import_drafts', 'd1')).toMatchObject({
      review_by: 'creator',
      sent_to_creator_by: 'admin-1',
      // Handing the decision over is not making it.
      status: 'pending_review',
      decided_at: null,
      decided_by: null,
    });
  });

  it('lands where the creator will actually find it', async () => {
    // The whole reason the button was switched off. A handoff that the creator's
    // own queue does not return is a recipe nobody can see and no later poll
    // re-imports, so this is asserted end to end rather than on the column.
    fakeDb.seed('creator_import_drafts', [draftRow()]);
    await sendDraftToCreator(deps(), 'd1', 'admin-1');

    const theirs = await listDraftQueue(supabase, 'creator', { creatorId: 'c1' });
    expect(theirs.map((row) => row.id)).toEqual(['d1']);
    expect(await countPendingDrafts(supabase, 'c1')).toBe(1);
  });

  it('refuses to hand over one that is already theirs', async () => {
    fakeDb.seed('creator_import_drafts', [draftRow({ review_by: 'creator' })]);
    const result = await sendDraftToCreator(deps(), 'd1', 'admin-1');
    expect(result.ok).toBe(false);
    expect(fakeDb.calls.some((c) => c.method === 'update')).toBe(false);
  });

  it('publishes nothing on the way — that is the whole point of the button', async () => {
    fakeDb.seed('creator_import_drafts', [draftRow()]);
    const publisher = vi.fn();
    await sendDraftToCreator(deps({ publisher: publisher as unknown as DraftDeps['publisher'] }), 'd1', 'admin-1');
    expect(publisher).not.toHaveBeenCalled();
    expect(sendCreatorSyncPublishedEmail).not.toHaveBeenCalled();
    expect(fakeDb.calls.some((c) => c.table === 'preset_meals')).toBe(false);
  });
});

describe('drafts handed over — visible to the operator who let go of them', () => {
  /** Rows an operator sent to a creator who has not decided them yet. */
  const handedOver = (overrides: Record<string, unknown> = {}) =>
    draftRow({
      review_by: 'creator',
      sent_to_creator_at: '2026-08-02T11:00:00.000Z',
      sent_to_creator_by: 'admin-1',
      ...overrides,
    });

  it('lists what an operator handed over, so it is visible rather than gone', async () => {
    fakeDb.seed('creator_import_drafts', [handedOver()]);

    const stranded = await listHandedOverDrafts(supabase);

    expect(stranded.map((draft) => draft.id)).toEqual(['d1']);
    expect(stranded[0].summary.needALook).toBeGreaterThan(0);
  });

  it('leaves the poller’s own drafts alone — those are not stranded, they are the creator’s', async () => {
    // `review_by` defaults to 'creator' for every row the poller writes. Only a
    // draft an admin *sent* is one this screen has anything to say about.
    fakeDb.seed('creator_import_drafts', [draftRow({ review_by: 'creator' })]);
    expect(await listHandedOverDrafts(supabase)).toHaveLength(0);
  });

  /**
   * The escape hatch, and the reason it has to exist.
   *
   * `listDraftQueue('admin')` and `listHandedOverDrafts` are both narrower than
   * "pending", so between them is a gap that no screen reaches. These assert the
   * rows that fall into it come back — because the failure mode is not a wrong
   * count, it is a recipe nobody can ever see again.
   */
  describe('listAllPendingDrafts', () => {
    /** `n` pending poller drafts, oldest first, so a page boundary can be crossed. */
    function pending(n: number, overrides: Record<string, unknown> = {}) {
      return Array.from({ length: n }, (_, i) => queueRow({
        id: `d${String(i).padStart(4, '0')}`,
        review_by: 'creator',
        created_at: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString(),
        ...overrides,
      }));
    }

    it('returns the poller’s drafts, which neither normal query asks for', async () => {
      const poller = queueRow({ id: 'd-poll', review_by: 'creator' });
      fakeDb.seed('creator_import_drafts', [poller]);

      // Invisible to both of the queries the screen normally runs...
      expect(await listDraftQueue(supabase, 'admin')).toHaveLength(0);
      expect(await listHandedOverDrafts(supabase)).toHaveLength(0);
      // ...and reachable by the one that asks on status alone.
      expect((await listAllPendingDrafts(supabase)).drafts.map((d) => d.id)).toEqual(['d-poll']);
    });

    it('is not filtered on review_by or sent_to_creator_at at all', async () => {
      fakeDb.seed('creator_import_drafts', [
        queueRow({ id: 'a', review_by: 'admin' }),
        queueRow({ id: 'b', review_by: 'creator', sent_to_creator_at: '2026-08-02T11:00:00.000Z' }),
        queueRow({ id: 'c', review_by: 'creator' }),
      ]);

      const all = await listAllPendingDrafts(supabase);

      expect(all.drafts.map((d) => d.id).sort()).toEqual(['a', 'b', 'c']);
      const filters = fakeDb.calls.filter((c) => c.table === 'creator_import_drafts' && c.method === 'eq');
      expect(filters.map((c) => c.args)).toEqual([['status', 'pending_review']]);
      expect(fakeDb.calls.some((c) => c.method === 'not')).toBe(false);
    });

    it('still leaves decided drafts out — this widens the queue, it does not undo a decision', async () => {
      fakeDb.seed('creator_import_drafts', [
        queueRow({ id: 'gone', review_by: 'creator', status: 'cancelled' }),
        queueRow({ id: 'live', review_by: 'creator', status: 'approved' }),
        queueRow({ id: 'waiting', review_by: 'creator' }),
      ]);

      const all = await listAllPendingDrafts(supabase);
      expect(all.drafts.map((d) => d.id)).toEqual(['waiting']);
      // The count is over the same WHERE clause, so a decided draft is not in it
      // either — otherwise the screen would report work that no longer exists.
      expect(all.total).toBe(1);
    });

    it('carries what the stranded list draws, and nothing it does not', async () => {
      fakeDb.seed('creator_import_drafts', [queueRow({ review_by: 'creator' })]);

      const [row] = (await listAllPendingDrafts(supabase)).drafts;

      // Three strings and the id that takes it back.
      expect(row).toMatchObject({
        id: 'd1',
        name: 'Best Guacamole',
        sourceUrl: 'https://chefsarah.test/guacamole',
        creatorName: 'Chef Sarah',
      });
      // Not the recipe body and not a per-field assessment: this list has no card
      // to open, and shipping them is kilobytes a row to draw three strings.
      expect(row).not.toHaveProperty('draft');
      expect(row).not.toHaveProperty('confidence');
      expect(row).not.toHaveProperty('summary');
      expect(row).not.toHaveProperty('review');
    });

    /**
     * The page boundary — the thing that decides whether "nothing is unreachable"
     * is true or is a sentence on a screen.
     *
     * The escape hatch exists because pending poller drafts accumulate and no
     * queue drains them, so passing the limit is the steady state and not a
     * corner case. What must never happen is a page reporting its own length as
     * a total.
     */
    it('reports the database’s count, not the page length, past the limit', async () => {
      fakeDb.seed('creator_import_drafts', pending(12));

      const all = await listAllPendingDrafts(supabase, 5);

      expect(all.drafts).toHaveLength(5);
      // The oldest first, so the same rows are not the ones left behind forever.
      expect(all.drafts.map((d) => d.id)).toEqual(['d0000', 'd0001', 'd0002', 'd0003', 'd0004']);
      expect(all.total).toBe(12);
      expect(all.limit).toBe(5);
      expect(all.truncated).toBe(true);
    });

    it('counts every pending draft, whichever queue it is nominally in', async () => {
      // The count is what the banner reports as "pending in all", so it has to
      // span the two narrow queues as well as the gap between them.
      fakeDb.seed('creator_import_drafts', [
        ...pending(4, { review_by: 'admin' }).map((r, i) => ({ ...r, id: `admin-${i}` })),
        ...pending(3).map((r, i) => ({ ...r, id: `poll-${i}` })),
        queueRow({ id: 'decided', review_by: 'creator', status: 'cancelled' }),
      ]);

      const all = await listAllPendingDrafts(supabase, 2);

      expect(all.total).toBe(7);
      expect(all.truncated).toBe(true);
    });

    it('does not call a full read truncated', async () => {
      fakeDb.seed('creator_import_drafts', pending(5));

      const all = await listAllPendingDrafts(supabase, 5);

      expect(all.total).toBe(5);
      expect(all.drafts).toHaveLength(5);
      // Exactly the limit and exactly the count: everything is here, and the
      // screen is allowed to say so.
      expect(all.truncated).toBe(false);
    });

    it('asks the database to count, rather than counting the page', async () => {
      fakeDb.seed('creator_import_drafts', pending(3));
      await listAllPendingDrafts(supabase);

      const select = fakeDb.calls.find((c) => c.table === 'creator_import_drafts' && c.method === 'select')!;
      expect(select.args[1]).toMatchObject({ count: 'exact' });
    });

    /**
     * How a row is placed, and why it is not a set difference.
     *
     * The two narrow lists are capped at 200 each. Subtracting their ids from
     * this one's therefore calls the 201st row of the admin's own queue "in no
     * queue at all" — a false statement about a row the operator is looking at,
     * and one whose *Take it back* then fails with "already in your queue".
     * Reading `review_by` and `sent_to_creator_at` off the row cannot do that.
     */
    describe('queueOf', () => {
      const row = (over: Partial<PendingDraft>): PendingDraft => ({
        id: 'd1', name: 'Best Guacamole', sourceUrl: 'https://chefsarah.test/guacamole',
        creatorName: 'Chef Sarah', reviewBy: 'creator', sentToCreatorAt: null,
        createdAt: '2026-08-02T10:00:00.000Z', ...over,
      });

      it('places a row in the same list the query for it would', () => {
        expect(queueOf(row({ reviewBy: 'admin' }))).toBe('admin');
        expect(queueOf(row({ reviewBy: 'creator', sentToCreatorAt: '2026-08-02T11:00:00.000Z' }))).toBe('handed-over');
        expect(queueOf(row({ reviewBy: 'creator' }))).toBe('none');
      });

      it('places an admin row from beyond the admin queue’s page in the admin queue', () => {
        // The row a set difference gets wrong: pending, the operator's own, and
        // past the 200 that `listDraftQueue` returned.
        expect(queueOf(row({ id: 'd0201', reviewBy: 'admin' }))).toBe('admin');
      });
    });

    it('treats a missing count as “there may be more”, never as a total', async () => {
      // A proxy that dropped Content-Range, an older PostgREST: no count came
      // back and a full page is the only signal there is.
      fakeDb.queue('creator_import_drafts', {
        data: pending(2).map((r) => ({ ...r, creators: { display_name: 'Chef Sarah' } })),
        count: null,
      });

      const all = await listAllPendingDrafts(supabase, 2);

      expect(all.total).toBe(2);
      expect(all.truncated).toBe(true);
    });
  });

  it('takes one back into the admin queue', async () => {
    fakeDb.seed('creator_import_drafts', [handedOver()]);

    const result = await reclaimDraft(deps(), 'd1', 'admin-2');

    expect(result.ok).toBe(true);
    expect(fakeDb.row('creator_import_drafts', 'd1')).toMatchObject({
      review_by: 'admin',
      status: 'pending_review',
    });
    // Taking it back is not a decision about the recipe.
    expect(fakeDb.row('creator_import_drafts', 'd1')).toMatchObject({ decided_by: null, published_meal_id: null });
  });

  it('refuses to take back one that has been decided', async () => {
    fakeDb.seed('creator_import_drafts', [handedOver({ status: 'cancelled' })]);
    const result = await reclaimDraft(deps(), 'd1', 'admin-2');
    expect(result.ok).toBe(false);
    expect(fakeDb.calls.some((c) => c.method === 'update')).toBe(false);
  });
});

// ── Which queue is deciding ──────────────────────────────────────────────────

/**
 * Queue membership governs **authority**, not only visibility.
 *
 * `review_by` used to be a read filter and nothing else: it decided what each
 * side was shown and never what either could write. So "Take it back" removed a
 * draft from the creator's queue and from their badge while leaving them able to
 * publish it — and a poller draft the operator had never been shown was equally
 * theirs to approve, given the id.
 *
 * The guarantee is the predicate in `decideDraft`, not the pre-read that words
 * the refusal: the race below is the case a pre-read cannot cover, because
 * `review_by` is precisely the column that changes under someone holding the
 * card open.
 */
describe('a decision is refused when the draft has moved to the other queue', () => {
  const theirs = (overrides: Record<string, unknown> = {}) => draftRow({ review_by: 'creator', ...overrides });

  it('a creator cannot publish a draft an operator has taken back', async () => {
    fakeDb.seed('creator_import_drafts', [draftRow({ review_by: 'admin' })]);
    const publisher = vi.fn();

    const result = await approveDraft(
      deps({ role: 'creator', publisher: publisher as unknown as DraftDeps['publisher'] }),
      'd1',
      'u1',
    );

    expect(result.ok).toBe(false);
    expect(publisher).not.toHaveBeenCalled();
    expect(fakeDb.row('creator_import_drafts', 'd1')).toMatchObject({ status: 'pending_review', review_by: 'admin' });
    // Said from their side rather than as a refusal: their recipe has not been
    // rejected, somebody else is looking at it. "Already decided in another tab"
    // would be both wrong and alarming.
    expect(result.ok === false && result.error).toMatch(/took that one back/i);
  });

  it('a creator cannot decline or edit one either', async () => {
    fakeDb.seed('creator_import_drafts', [draftRow({ review_by: 'admin' })]);

    const declined = await cancelDraft(deps({ role: 'creator' }), 'd1', 'u1');
    const edited = await editDraft(deps({ role: 'creator' }), 'd1', { ...guacamole.draft, serves: '99' }, 'u1');

    expect(declined.ok).toBe(false);
    expect(edited.ok).toBe(false);
    expect(fakeDb.row('creator_import_drafts', 'd1')).toMatchObject({ status: 'pending_review', edited_at: null });
  });

  it('an operator cannot decide one that is sitting in the creator’s queue', async () => {
    // The mirror, and the quieter half: a poller draft is `review_by='creator'`
    // and never appears on the admin screen, so deciding one means acting on a
    // recipe an operator was never shown.
    fakeDb.seed('creator_import_drafts', [theirs()]);
    const publisher = vi.fn();

    const result = await approveDraft(deps({ publisher: publisher as unknown as DraftDeps['publisher'] }), 'd1', 'admin-1');

    expect(result.ok).toBe(false);
    expect(publisher).not.toHaveBeenCalled();
    expect(fakeDb.row('creator_import_drafts', 'd1')).toMatchObject({ status: 'pending_review' });
    // Names the creator and the way out, because there is one: reclaim it.
    expect(result.ok === false && result.error).toMatch(/Chef Sarah[\s\S]*Take it back/);
  });

  /**
   * "Take it back", landing after the creator's read and before their write.
   *
   * The injected clock is the seam because it is called between the two — the
   * same trick `reconnectsMidFlight` uses in the token sweep's tests. This is
   * the case a pre-read cannot cover and the one the column actually produces:
   * the reviewer has the card open, so their read genuinely saw the draft as
   * theirs, and only the predicate on the write is left to refuse it.
   */
  const reclaimedMidFlight = () => {
    let done = false;
    return () => {
      if (!done) { fakeDb.patch('creator_import_drafts', 'd1', { review_by: 'admin' }); done = true; }
      return 1_800_000_000_000;
    };
  };

  it('publishes nothing when the reclaim lands between the creator’s read and their write', async () => {
    fakeDb.seed('creator_import_drafts', [theirs()]);
    const publisher = vi.fn(async () => ({ id: 'meal-1', name: 'Best Guacamole' }));

    const result = await approveDraft(
      deps({ role: 'creator', now: reclaimedMidFlight(), publisher: publisher as unknown as DraftDeps['publisher'] }),
      'd1',
      'u1',
    );

    expect(result.ok).toBe(false);
    // The one outcome that must not happen: a live meal on Discover for a draft
    // the operator believes is back in their queue, undecided.
    expect(publisher).not.toHaveBeenCalled();
    expect(fakeDb.row('creator_import_drafts', 'd1')).toMatchObject({
      status: 'pending_review',
      review_by: 'admin',
      published_meal_id: null,
      decided_by: null,
    });
  });

  it('saves no edit when the reclaim lands in the same gap', async () => {
    fakeDb.seed('creator_import_drafts', [theirs()]);

    const result = await editDraft(
      deps({ role: 'creator', now: reclaimedMidFlight() }),
      'd1',
      { ...guacamole.draft, name: 'Rewritten underneath them' },
      'u1',
    );

    expect(result.ok).toBe(false);
    expect(fakeDb.row('creator_import_drafts', 'd1')).toMatchObject({ edited_at: null });
    expect(fakeDb.row('creator_import_drafts', 'd1').draft.name).toBe(guacamole.draft.name);
  });

  it('still lets each side decide the drafts that really are waiting on it', async () => {
    // The predicate has to refuse the other queue without refusing the ordinary
    // case, which is every decision this feature exists for.
    fakeDb.seed('creator_import_drafts', [theirs(), draftRow({ id: 'd2', review_by: 'admin' })]);

    const byCreator = await cancelDraft(deps({ role: 'creator' }), 'd1', 'u1');
    const byAdmin = await cancelDraft(deps(), 'd2', 'admin-1');

    expect(byCreator.ok).toBe(true);
    expect(byAdmin.ok).toBe(true);
  });
});

// ── The audit trail ──────────────────────────────────────────────────────────

/**
 * `DraftDeps.role` and the log.
 *
 * MEAL-77's consent story turns on *who* decided. Every line in this file used
 * to say `ADMIN:`, so a creator approving their own recipe was recorded as an
 * operator publishing under their name — the exact distinction the audit trail
 * exists to make. Asserted here because it is the only visible effect of the
 * flag: no route response and no row carries it.
 */
describe('who decided is recorded as who decided', () => {
  it('records a creator’s own decisions under CREATOR:', async () => {
    fakeDb.seed('creator_import_drafts', [draftRow({ review_by: 'creator' })]);

    await approveDraft(deps({ role: 'creator' }), 'd1', 'u1');
    fakeDb.seed('creator_import_drafts', [draftRow({ id: 'd2', review_by: 'creator' })]);
    await cancelDraft(deps({ role: 'creator' }), 'd2', 'u1');
    fakeDb.seed('creator_import_drafts', [draftRow({ id: 'd3', review_by: 'creator' })]);
    await editDraft(deps({ role: 'creator' }), 'd3', { ...guacamole.draft, serves: '6' }, 'u1');

    // The decline is two lines: the decision, then the post it frees up.
    expect(loggedEvents()).toEqual([
      'CREATOR:DRAFT_DECIDE', 'CREATOR:DRAFT_DECIDE', 'CREATOR:SOURCE_REJECT', 'CREATOR:DRAFT_EDIT',
    ]);
  });

  it('records an operator’s decisions under ADMIN:', async () => {
    fakeDb.seed('creator_import_drafts', [draftRow()]);

    await approveDraft(deps(), 'd1', 'admin-1');
    fakeDb.seed('creator_import_drafts', [draftRow({ id: 'd2' })]);
    await cancelDraft(deps(), 'd2', 'admin-1');
    fakeDb.seed('creator_import_drafts', [draftRow({ id: 'd3' })]);
    await editDraft(deps(), 'd3', { ...guacamole.draft, serves: '6' }, 'admin-1');

    expect(loggedEvents()).toEqual([
      'ADMIN:DRAFT_APPROVE', 'ADMIN:DRAFT_CANCEL', 'ADMIN:SOURCE_REJECT', 'ADMIN:DRAFT_EDIT',
    ]);
  });

  it('defaults to admin, because every caller before MEAL-89 was one', async () => {
    fakeDb.seed('creator_import_drafts', [draftRow()]);
    await approveDraft({ supabase, publisher: deps().publisher, now: () => 1_800_000_000_000 }, 'd1', 'admin-1');
    expect(loggedEvents()).toEqual(['ADMIN:DRAFT_APPROVE']);
  });

  it('names the actor, not just the side they are on', async () => {
    // "A creator decided this" is not the record MEAL-77 needs; "u1 decided this
    // draft, and it published meal-1" is.
    fakeDb.seed('creator_import_drafts', [draftRow({ review_by: 'creator' })]);

    await approveDraft(deps({ role: 'creator' }), 'd1', 'u1');

    expect(log).toHaveBeenCalledWith(expect.objectContaining({
      event: 'CREATOR:DRAFT_DECIDE',
      userId: 'u1',
      detail: expect.stringContaining('draft=d1'),
    }));
  });
});

// ── Delete ───────────────────────────────────────────────────────────────────

describe('cancelDraft — declining is a state, not a deletion', () => {
  it('marks the row cancelled and never removes it', async () => {
    fakeDb.seed('creator_import_drafts', [draftRow()]);

    const result = await cancelDraft(deps(), 'd1', 'admin-1');

    expect(result.ok).toBe(true);
    expect(lastUpdate('creator_import_drafts')).toMatchObject({ status: 'cancelled', decided_by: 'admin-1' });
    // The rule MEAL-75 already carries: `creator_source_items` still says this
    // post was imported, and a draft row that vanishes leaves that record
    // pointing at nothing — so the next sync or poll re-imports the same post
    // and asks a human about a recipe they already said no to.
    expect(fakeDb.calls.some((c) => c.method === 'delete')).toBe(false);
  });

  it('marks the post declined rather than leaving it looking imported (MEAL-99)', async () => {
    fakeDb.seed('creator_import_drafts', [draftRow()]);
    fakeDb.seed('creator_source_items', [
      { creator_id: 'c1', source: 'website', item_id: 'guid-1', status: 'imported', detail: null, draft_id: 'd1' },
    ]);

    await cancelDraft(deps(), 'd1', 'admin-1');

    // `imported` means a draft or a meal came of this, and after a decline
    // neither exists — the catalogue was showing the post as Already Imported
    // with nothing behind it, and refusing the tick.
    const [row] = fakeDb.rows('creator_source_items');
    // `declined`, not `rejected`: a person looked at a draft and said no, which
    // is a different answer from the gate refusing the page before any draft
    // existed. Both are offered back; only one had a human behind it.
    expect(row.status).toBe('declined');
    expect(row.detail).toMatch(/declined in review/i);
    // Still a row, though. The poller reads presence and not status, so the
    // record is what stops a declined post coming back on its own — deleting it
    // makes the next poll treat the post as new and import it again.
    expect(fakeDb.calls.some((c) => c.table === 'creator_source_items' && c.method === 'delete')).toBe(false);
    expect(loggedEvents()).toContain('ADMIN:SOURCE_REJECT');
  });

  it('only rewrites a row that still says imported', async () => {
    fakeDb.seed('creator_import_drafts', [draftRow()]);
    // Re-imported since, and the new import is not this decline's to overwrite.
    fakeDb.seed('creator_source_items', [
      { creator_id: 'c1', source: 'website', item_id: 'guid-1', status: 'failed', detail: 'Timed out.', draft_id: 'd1' },
    ]);

    await cancelDraft(deps(), 'd1', 'admin-1');

    expect(fakeDb.rows('creator_source_items')[0]).toMatchObject({ status: 'failed', detail: 'Timed out.' });
  });

  it('has nothing to mark for a draft made from a pasted link', async () => {
    // The one-link admin sync (MEAL-90) stores no source item, so there is no
    // row to move and no reason to go looking for one.
    fakeDb.seed('creator_import_drafts', [draftRow({ source: null, item_id: null })]);

    const result = await cancelDraft(deps(), 'd1', 'admin-1');

    expect(result.ok).toBe(true);
    expect(fakeDb.calls.some((c) => c.table === 'creator_source_items')).toBe(false);
  });

  it('records who declined it, so a creator is not logged as an operator', async () => {
    fakeDb.seed('creator_import_drafts', [draftRow({ review_by: 'creator' })]);
    fakeDb.seed('creator_source_items', [
      { creator_id: 'c1', source: 'website', item_id: 'guid-1', status: 'imported', detail: null, draft_id: 'd1' },
    ]);

    await cancelDraft(deps({ role: 'creator' }), 'd1', 'u1');

    expect(loggedEvents()).toContain('CREATOR:SOURCE_REJECT');
  });

  it('refuses to decline something already published', async () => {
    fakeDb.seed('creator_import_drafts', [draftRow({ status: 'approved', published_meal_id: 'meal-1' })]);
    const result = await cancelDraft(deps(), 'd1', 'admin-1');
    expect(result.ok).toBe(false);
    expect(fakeDb.calls.some((c) => c.table === 'creator_import_drafts' && c.method === 'update')).toBe(false);
  });
});

// ── Edit ─────────────────────────────────────────────────────────────────────

describe('editDraft', () => {
  it('saves the edit without deciding anything', async () => {
    fakeDb.seed('creator_import_drafts', [draftRow()]);
    const next: CreatorMealDraft = { ...guacamole.draft, serves: '6' };

    const result = await editDraft(deps(), 'd1', next, 'admin-1');

    expect(result.ok).toBe(true);
    const update = lastUpdate('creator_import_drafts');
    expect(update.draft).toEqual(next);
    expect(update.edited_at).toBe('2027-01-15T08:00:00.000Z');
    // Correcting a typo is not the same as saying the recipe is right. It stays
    // in the queue and still has to be approved.
    expect(update).not.toHaveProperty('status');
    expect(update).not.toHaveProperty('published_meal_id');
  });

  it('publishes nothing', async () => {
    fakeDb.seed('creator_import_drafts', [draftRow()]);
    const publisher = vi.fn();
    await editDraft(deps({ publisher: publisher as unknown as DraftDeps['publisher'] }), 'd1', guacamole.draft, 'admin-1');
    expect(publisher).not.toHaveBeenCalled();
    expect(fakeDb.calls.some((c) => c.table === 'preset_meals')).toBe(false);
  });

  it('refuses to edit a draft that has been decided', async () => {
    fakeDb.seed('creator_import_drafts', [draftRow({ status: 'cancelled' })]);
    const result = await editDraft(deps(), 'd1', guacamole.draft, 'admin-1');
    expect(result.ok).toBe(false);
    expect(fakeDb.calls.some((c) => c.table === 'creator_import_drafts' && c.method === 'update')).toBe(false);
  });
});

describe('stripEditedConfidence', () => {
  it('drops our check of every field a human rewrote, and keeps the rest', async () => {
    // A green on `serves` is a claim that *the model's* value matched the source.
    // It says nothing about the number an operator typed over it, and leaving it
    // would have our verification vouching for their edit.
    const before = guacamole.draft;
    const after: CreatorMealDraft = { ...before, serves: '6' };

    const cleared = stripEditedConfidence(before, after, guacamole.confidence)!;

    expect(cleared.serves.level).toBe('red');
    expect(cleared.serves.reason).toMatch(/operator changed this/i);
    expect(cleared.name).toEqual(guacamole.confidence.name);
  });

  it('does not clear a row because its preparation was corrected (MEAL-165)', async () => {
    // The whole point of making prep editable is that a creator can delete one
    // the model invented. Doing so used to mark the row "an operator changed
    // this" — taking the green off its NAME and AMOUNT, which nobody touched,
    // dropping the draft out of "all verified", and moving it under the
    // creator's cursor in the queue's sort order. Fixing the field we asked
    // them to fix punished them for it.
    //
    // Sound because the assessment never read `prep` in the first place: the row
    // is graded on its product name and its amount (`pipeline.ts`), so an edit
    // to prep cannot invalidate a check that never covered it.
    const before: CreatorMealDraft = {
      ...guacamole.draft,
      ingredients: guacamole.draft.ingredients.map((row, i) =>
        (i === 1 ? { ...row, prep: 'julienned on a mandoline' } : row)),
    };
    const corrected: CreatorMealDraft = {
      ...before,
      ingredients: before.ingredients.map((row, i) => {
        if (i !== 1) return row;
        const { prep: _dropped, ...rest } = row;
        return rest;
      }),
    };

    const cleared = stripEditedConfidence(before, corrected, guacamole.confidence)!;

    expect(cleared.ingredients[1]).toEqual(guacamole.confidence.ingredients[1]);
    expect(cleared.ingredients[1].reason).not.toMatch(/operator changed this/i);
  });

  it('still clears a row when something the check DID cover changed', async () => {
    // The other side of the same line: prep is exempt because it is ungraded,
    // not because ingredient edits stopped mattering. A measure change on the
    // same row, with the prep edited too, must still clear it.
    const before: CreatorMealDraft = {
      ...guacamole.draft,
      ingredients: guacamole.draft.ingredients.map((row, i) =>
        (i === 1 ? { ...row, prep: 'finely diced' } : row)),
    };
    const after: CreatorMealDraft = {
      ...before,
      ingredients: before.ingredients.map((row, i) =>
        (i === 1 ? { ...row, prep: 'roughly chopped', measure: '2' } : row)),
    };

    const cleared = stripEditedConfidence(before, after, guacamole.confidence)!;

    expect(cleared.ingredients[1].reason).toMatch(/operator changed this/i);
  });

  it('follows the ingredient rows that actually changed, by index', async () => {
    const before = guacamole.draft;
    const after: CreatorMealDraft = {
      ...before,
      ingredients: before.ingredients.map((row, i) => (i === 1 ? { ...row, measure: '2' } : row)),
    };

    const cleared = stripEditedConfidence(before, after, guacamole.confidence)!;

    expect(cleared.ingredients[0]).toEqual(guacamole.confidence.ingredients[0]);
    expect(cleared.ingredients[1].reason).toMatch(/operator changed this/i);
    expect(cleared.ingredients[2]).toEqual(guacamole.confidence.ingredients[2]);
  });

  it('gives a newly added row no provenance at all', async () => {
    const before = guacamole.draft;
    const after: CreatorMealDraft = {
      ...before,
      ingredients: [...before.ingredients, { ingredientName: 'salt', qty: 1, productQty: 1, unit: 'qty', measure: null, searchTerm: null }],
    };

    const cleared = stripEditedConfidence(before, after, guacamole.confidence)!;
    expect(cleared.ingredients).toHaveLength(before.ingredients.length + 1);
    expect(cleared.ingredients.at(-1)!.level).toBe('red');
  });
});

// ── Validation ───────────────────────────────────────────────────────────────

describe('editableDraft — the same rules the publish form has', () => {
  const base = {
    name: 'Guacamole',
    ingredients: [{ ingredientName: 'avocados', measure: '4', unit: 'qty', qty: 4 }],
    source: 'https://chefsarah.test/guacamole',
  };

  it('accepts a well-formed edit', () => {
    const result = editableDraft({ ...base, serves: '2-4', difficulty: 2, tags: ['Mexican'] });
    expect(result.ok).toBe(true);
    expect(result.ok && result.draft).toMatchObject({ name: 'Guacamole', serves: '2-4', difficulty: 2, tags: ['Mexican'] });
  });

  it('refuses a draft with no name or no ingredients — neither can be published', () => {
    expect(editableDraft({ ...base, name: '  ' }).ok).toBe(false);
    expect(editableDraft({ ...base, ingredients: [] }).ok).toBe(false);
    expect(editableDraft({ ...base, ingredients: [{ ingredientName: '' }] }).ok).toBe(false);
  });

  it('refuses a serves that is a volume rather than a head count', () => {
    // The exact mistake `canonicalizeServes` exists to stop: "2 1/2 cups" is on
    // the page, so it would verify green, and it is not a number of people.
    const result = editableDraft({ ...base, serves: '2 1/2 cups' });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/number or a range/i);
  });

  it('refuses more tags than a meal takes rather than keeping the first three', () => {
    // Trimming here would be worse than refusing: the card renders three, so the
    // operator would see three of the six they picked and no sign of which.
    const result = editableDraft({ ...base, tags: ['Mexican', 'Vegan', 'Snack', 'Healthy'] });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/That is 4 tags\. A meal takes at most 3\./);
  });

  it('accepts exactly the cap, and counts duplicates once', () => {
    expect(editableDraft({ ...base, tags: ['Mexican', 'Vegan', 'Snack'] }).ok).toBe(true);
    // Four sent, three stored — the dedupe happens before the count, so a
    // repeated tag is not a reason to refuse an edit.
    const deduped = editableDraft({ ...base, tags: ['Mexican', 'mexican', 'Vegan', 'Snack'] });
    expect(deduped.ok && deduped.draft.tags).toEqual(['Mexican', 'Vegan', 'Snack']);
  });

  it('strips a tag the picker does not have and a difficulty outside 1–5', () => {
    const result = editableDraft({ ...base, tags: ['Mexican', 'Artisanal'], difficulty: 9 });
    expect(result.ok && result.draft.tags).toEqual(['Mexican']);
    expect(result.ok && result.draft.difficulty).toBeNull();
  });

  it('keeps a cook’s unit, and still folds one nothing can display', () => {
    // "1 bunch cilantro" now keeps its word: the cart searches by name and
    // counts packages with productQty, so the unit is display text and dropping
    // it lost something the source actually said.
    const kept = editableDraft({ ...base, ingredients: [{ ingredientName: 'cilantro', measure: '1', unit: 'bunch', qty: 1 }] });
    expect(kept.ok && kept.draft.ingredients[0]).toMatchObject({ ingredientName: 'cilantro', unit: 'bunches', measure: '1' });

    // "a knob of butter" still folds — knob is not a unit anything can show.
    const folded = editableDraft({ ...base, ingredients: [{ ingredientName: 'butter', measure: null, unit: 'knob', qty: 1 }] });
    expect(folded.ok && folded.draft.ingredients[0]).toMatchObject({ ingredientName: 'butter', unit: 'qty', qty: 1 });
  });
});

describe('a decline and a gate refusal are different answers', () => {
  it('does not need draft_id to tell them apart', async () => {
    // The old rule inferred it: a `rejected` row with a draft behind it was a
    // decline, one without was the gate. Sound in every path, and it made a
    // foreign key carry a meaning nothing in the schema mentioned — so clearing
    // `draft_id` would silently have turned every decline into a gate refusal.
    fakeDb.seed('creator_import_drafts', [draftRow()]);
    fakeDb.seed('creator_source_items', [
      { creator_id: 'c1', source: 'website', item_id: 'guid-1', status: 'imported', detail: null, draft_id: null },
    ]);

    await cancelDraft(deps(), 'd1', 'admin-1');

    const [row] = fakeDb.rows('creator_source_items');
    expect(row.status).toBe('declined');
  });
});
