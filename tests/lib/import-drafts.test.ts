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

import {
  approveDraft,
  cancelDraft,
  editDraft,
  editableDraft,
  listDraftQueue,
  notifyApproved,
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
 *   - **Send to creator moves the draft out of the admin's queue**, which is the
 *     escape hatch for "looks right, but I am not the person who cooked it".
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
    fakeDb.queue('creator_import_drafts', { data: draftRow() });
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
    expect(lastUpdate('creator_import_drafts')).toMatchObject({
      status: 'approved',
      decided_by: 'admin-1',
      published_meal_id: 'meal-1',
      decided_at: '2027-01-15T08:00:00.000Z',
    });
  });

  it('records `edited` when an operator had changed something first', async () => {
    // Months later the row still answers "did a human rewrite what the model
    // produced?" — which is a different thing from "did a human approve it".
    fakeDb.queue('creator_import_drafts', { data: draftRow({ edited_at: '2026-08-02T11:00:00.000Z' }) });
    await approveDraft(deps(), 'd1', 'admin-1');
    expect(lastUpdate('creator_import_drafts')).toMatchObject({ status: 'edited' });
  });

  it('refuses to publish the same draft twice', async () => {
    // Two tabs, or a double-click. Publishing twice would put one recipe on
    // Discover twice under a creator's name.
    fakeDb.queue('creator_import_drafts', { data: draftRow({ status: 'approved' }) });
    const publisher = vi.fn();

    const result = await approveDraft(deps({ publisher: publisher as unknown as DraftDeps['publisher'] }), 'd1', 'admin-1');

    expect(result.ok).toBe(false);
    expect(publisher).not.toHaveBeenCalled();
  });

  it('refuses a draft that has been declined, so a decline is not undone by a stale tab', async () => {
    fakeDb.queue('creator_import_drafts', { data: draftRow({ status: 'cancelled' }) });
    const publisher = vi.fn();
    const result = await approveDraft(deps({ publisher: publisher as unknown as DraftDeps['publisher'] }), 'd1', 'admin-1');
    expect(result.ok).toBe(false);
    expect(publisher).not.toHaveBeenCalled();
  });

  it('leaves the draft pending when publishing fails, so it can be tried again', async () => {
    fakeDb.queue('creator_import_drafts', { data: draftRow() });

    const result = await approveDraft(
      deps({ publisher: (async () => { throw new Error('duplicate key'); }) as unknown as DraftDeps['publisher'] }),
      'd1',
      'admin-1',
    );

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/duplicate key/);
    // Nothing was written: a draft marked approved with no meal behind it would
    // vanish from the queue and never publish.
    expect(fakeDb.calls.some((c) => c.table === 'creator_import_drafts' && c.method === 'update')).toBe(false);
  });

  it('points the durable record at the meal it finally became', async () => {
    fakeDb.queue('creator_import_drafts', { data: draftRow() });
    await approveDraft(deps(), 'd1', 'admin-1');
    expect(lastUpdate('creator_source_items')).toMatchObject({ draft_id: 'd1' });
  });
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

describe('sendDraftToCreator — the escape hatch', () => {
  it('moves the draft into the creator’s queue and out of the admin’s', async () => {
    fakeDb.queue('creator_import_drafts', { data: draftRow() });

    const result = await sendDraftToCreator(deps(), 'd1', 'admin-1');

    expect(result.ok).toBe(true);
    const update = lastUpdate('creator_import_drafts');
    expect(update).toMatchObject({ review_by: 'creator', sent_to_creator_by: 'admin-1' });
    // The decision has been handed over, not made: the draft is still pending.
    expect(update).not.toHaveProperty('status');
    expect(update).not.toHaveProperty('decided_by');
  });

  it('publishes nothing on the way — that is the whole point of the button', async () => {
    fakeDb.queue('creator_import_drafts', { data: draftRow() });
    const publisher = vi.fn();
    await sendDraftToCreator(deps({ publisher: publisher as unknown as DraftDeps['publisher'] }), 'd1', 'admin-1');
    expect(publisher).not.toHaveBeenCalled();
    expect(sendCreatorSyncPublishedEmail).not.toHaveBeenCalled();
    expect(fakeDb.calls.some((c) => c.table === 'preset_meals')).toBe(false);
  });

  it('refuses one that is already the creator’s to decide', async () => {
    fakeDb.queue('creator_import_drafts', { data: draftRow({ review_by: 'creator' }) });
    const result = await sendDraftToCreator(deps(), 'd1', 'admin-1');
    expect(result.ok).toBe(false);
  });

  it('refuses one that has already been decided', async () => {
    fakeDb.queue('creator_import_drafts', { data: draftRow({ status: 'cancelled' }) });
    const result = await sendDraftToCreator(deps(), 'd1', 'admin-1');
    expect(result.ok).toBe(false);
    expect(fakeDb.calls.some((c) => c.table === 'creator_import_drafts' && c.method === 'update')).toBe(false);
  });
});

// ── Delete ───────────────────────────────────────────────────────────────────

describe('cancelDraft — declining is a state, not a deletion', () => {
  it('marks the row cancelled and never removes it', async () => {
    fakeDb.queue('creator_import_drafts', { data: draftRow() });

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
    fakeDb.queue('creator_import_drafts', { data: draftRow() });
    await cancelDraft(deps(), 'd1', 'admin-1');
    // Nothing here may reset `creator_source_items` back to something a sync
    // would treat as new.
    expect(fakeDb.calls.some((c) => c.table === 'creator_source_items')).toBe(false);
  });

  it('refuses to decline something already published', async () => {
    fakeDb.queue('creator_import_drafts', { data: draftRow({ status: 'approved', published_meal_id: 'meal-1' }) });
    const result = await cancelDraft(deps(), 'd1', 'admin-1');
    expect(result.ok).toBe(false);
    expect(fakeDb.calls.some((c) => c.table === 'creator_import_drafts' && c.method === 'update')).toBe(false);
  });
});

// ── Edit ─────────────────────────────────────────────────────────────────────

describe('editDraft', () => {
  it('saves the edit without deciding anything', async () => {
    fakeDb.queue('creator_import_drafts', { data: draftRow() });
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
    fakeDb.queue('creator_import_drafts', { data: draftRow() });
    const publisher = vi.fn();
    await editDraft(deps({ publisher: publisher as unknown as DraftDeps['publisher'] }), 'd1', guacamole.draft, 'admin-1');
    expect(publisher).not.toHaveBeenCalled();
    expect(fakeDb.calls.some((c) => c.table === 'preset_meals')).toBe(false);
  });

  it('refuses to edit a draft that has been decided', async () => {
    fakeDb.queue('creator_import_drafts', { data: draftRow({ status: 'cancelled' }) });
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

  it('strips a tag the picker does not have and a difficulty outside 1–5', () => {
    const result = editableDraft({ ...base, tags: ['Mexican', 'Artisanal'], difficulty: 9 });
    expect(result.ok && result.draft.tags).toEqual(['Mexican']);
    expect(result.ok && result.draft.difficulty).toBeNull();
  });

  it('forces a unit outside the editor’s vocabulary into a count', () => {
    // The cart cannot act on "1 knob", and the editor cannot display it. ("bunch"
    // used to be the example here; MEAL-89 gave the picker a cook's-units row, so
    // the case now needs a unit that really is outside the vocabulary.)
    const result = editableDraft({ ...base, ingredients: [{ ingredientName: 'butter', measure: '1', unit: 'knob', qty: 1 }] });
    expect(result.ok && result.draft.ingredients[0]).toMatchObject({ ingredientName: 'butter', unit: 'qty', qty: 1 });
  });
});
