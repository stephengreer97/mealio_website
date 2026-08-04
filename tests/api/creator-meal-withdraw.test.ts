import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeDb } from '../helpers/supabase-mock';

vi.mock('@/lib/supabase', async () =>
  (await import('../helpers/supabase-mock')).mockSupabaseModule());
vi.mock('@/lib/logger', () => ({ log: vi.fn() }));

import { createServerSupabaseClient } from '@/lib/supabase';
import { withdrawImportedItem } from '@/lib/creator-meals';

/**
 * What happens to a post when the meal made from it is deleted.
 *
 * The record used to say `imported` forever, so the post could never be
 * imported again — the catalogue showed it as already in and the server refused
 * it. A creator deleting a meal to redo it lost the post it came from.
 *
 * Clearing the row would have been worse. The same table tells the poller what
 * it has already seen, and it treats any record as seen whatever the status —
 * so an empty row means the next poll finds an unrecognised post, imports it,
 * the creator deletes it again, and round it goes.
 */
beforeEach(() => {
  fakeDb.reset();
  fakeDb.seed('creators', [{ id: 'c1', user_id: 'u1' }]);
});

describe('withdrawImportedItem', () => {
  it('marks the post withdrawn rather than clearing the record', async () => {
    fakeDb.seed('creator_import_drafts', [
      { id: 'd1', creator_id: 'c1', source: 'website', item_id: 'chefsarah.test/post-1', published_meal_id: 'm1' },
    ]);
    fakeDb.seed('creator_source_items', [
      { creator_id: 'c1', source: 'website', item_id: 'chefsarah.test/post-1', status: 'imported' },
    ]);

    await withdrawImportedItem(createServerSupabaseClient() as never, 'c1', 'm1');

    const row = fakeDb.rows('creator_source_items')[0] as Record<string, unknown>;
    // Still a record — the poller reads its presence, not its status, so this is
    // what stops an automatic re-import the creator did not ask for.
    expect(row.status).toBe('withdrawn');
  });

  it('leaves a row that is not this meal’s to rewrite', async () => {
    fakeDb.seed('creator_import_drafts', [
      { id: 'd1', creator_id: 'c1', source: 'website', item_id: 'post-1', published_meal_id: 'm1' },
    ]);
    fakeDb.seed('creator_source_items', [
      { creator_id: 'c1', source: 'website', item_id: 'post-1', status: 'rejected' },
    ]);

    await withdrawImportedItem(createServerSupabaseClient() as never, 'c1', 'm1');

    // A gate rejection is permanent and belongs to the post, not to the meal.
    expect((fakeDb.rows('creator_source_items')[0] as Record<string, unknown>).status).toBe('rejected');
  });

  it('does nothing for a meal that was never imported', async () => {
    // Published by hand: no draft, so no post to put back on the shelf.
    fakeDb.seed('creator_source_items', [
      { creator_id: 'c1', source: 'website', item_id: 'post-1', status: 'imported' },
    ]);

    await withdrawImportedItem(createServerSupabaseClient() as never, 'c1', 'm1');

    expect((fakeDb.rows('creator_source_items')[0] as Record<string, unknown>).status).toBe('imported');
  });
});
