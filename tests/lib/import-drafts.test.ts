import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { fakeDb } from '../helpers/supabase-mock';
import { importedGuacamole } from '../helpers/import-ui-fixtures';
import type { CreatorMealDraft, ImportConfidence, ImportSuccess } from '@/lib/import/types';

vi.mock('@/lib/logger', () => ({ log: vi.fn() }));

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
  editableDraft,
  HANDOFF_UNAVAILABLE,
  listDraftQueue,
  listHandedOverDrafts,
  notifyApproved,
  reclaimDraft,
  reviewDraft,
  sendDraftToCreator,
  stripEditedConfidence,
  type DraftDeps,
  type ImportDraft,
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

beforeEach(async () => {
  fakeDb.reset();
  sendCreatorSyncPublishedEmail.mockReset();
  sendMarketingEmail.mockReset();
  guacamole = await importedGuacamole();
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

    const filters = fakeDb.calls.filter((c) => c.table === 'creator_import_drafts' && c.method === 'eq');
    expect(filters.map((c) => c.args)).toEqual([['status', 'pending_review'], ['review_by', 'admin']]);
  });

  it('reads the creator queue with the same code, keyed the other way', async () => {
    fakeDb.queue('creator_import_drafts', { data: [queueRow({ review_by: 'creator' })] });
    await listDraftQueue(supabase, 'creator');
    const filters = fakeDb.calls.filter((c) => c.table === 'creator_import_drafts' && c.method === 'eq');
    expect(filters.map((c) => c.args)).toContainEqual(['review_by', 'creator']);
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

describe('sendDraftToCreator — an escape hatch with nowhere to go', () => {
  it('refuses, and moves nothing, while there is no creator queue to hand to', async () => {
    // `review_by = 'creator'` is read by one query in this repository and it asks
    // for `'admin'`. Flipping the column moved a draft out of the only queue
    // anybody reads and into nothing: no creator endpoint, no creator screen, no
    // way back — and `creator_source_items` says `imported`, so no later sync
    // re-imports the post. The recipe was lost on the first click.
    fakeDb.seed('creator_import_drafts', [draftRow()]);

    const result = await sendDraftToCreator(deps(), 'd1', 'admin-1');

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/MEAL-89/);
    // Not a warning, a refusal: the row is untouched and still in the queue.
    expect(fakeDb.row('creator_import_drafts', 'd1')).toMatchObject({
      review_by: 'admin',
      status: 'pending_review',
    });
    expect(fakeDb.row('creator_import_drafts', 'd1')).not.toHaveProperty('sent_to_creator_at');
    expect(fakeDb.calls.some((c) => c.method === 'update')).toBe(false);
  });

  it('says nothing untrue about where the draft went', async () => {
    // The screen used to say "It is in their queue now, not yours."
    fakeDb.seed('creator_import_drafts', [draftRow()]);
    const result = await sendDraftToCreator(deps(), 'd1', 'admin-1');
    expect(result.ok === false && result.error).toMatch(/queue|nothing/i);
    expect(HANDOFF_UNAVAILABLE).not.toMatch(/in their queue/i);
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

describe('drafts already handed over — nothing is left in neither queue', () => {
  /** What production has: rows the button moved before it was switched off. */
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

  it('leaves the durable record alone, so a later sync still skips the post', async () => {
    fakeDb.seed('creator_import_drafts', [draftRow()]);
    await cancelDraft(deps(), 'd1', 'admin-1');
    // Nothing here may reset `creator_source_items` back to something a sync
    // would treat as new.
    expect(fakeDb.calls.some((c) => c.table === 'creator_source_items')).toBe(false);
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
