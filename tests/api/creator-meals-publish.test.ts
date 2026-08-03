import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeDb } from '../helpers/supabase-mock';
import { jsonRequest } from '../helpers/request';

vi.mock('@/lib/supabase', async () =>
  (await import('../helpers/supabase-mock')).mockSupabaseModule());
vi.mock('@/lib/logger', () => ({ log: vi.fn() }));
vi.mock('next/cache', () => ({ revalidateTag: vi.fn() }));

import { POST } from '@/app/api/creator/meals/route';
import { clearRevocationCache, createAccessToken } from '@/lib/tokens';

/**
 * Publishing the same meal from the same link twice (MEAL-93).
 *
 * Warned, never blocked: a creator can legitimately publish two meals from one
 * page. So the tests below are about two different things that must both hold —
 * the *prompt*, which handles the deliberate case, and the *claim*, which
 * handles the double-click the prompt cannot see because the second request
 * arrives before the first has written anything.
 *
 * Asserted on `preset_meals` afterwards. "One meal, not two" is a statement
 * about the table, and no assertion on a call argument can make it.
 */

const URL_TYPED = 'chefsarah.test/guacamole';
const URL_STORED = 'https://chefsarah.test/guacamole';

function asUser() {
  clearRevocationCache();
  fakeDb.queue('user_profiles', { data: { tokens_invalidated_at: null } });
}

function seedCreator() {
  fakeDb.seed('creators', [{ id: 'c1', user_id: 'u1', display_name: 'Chef Sarah' }]);
  fakeDb.seed('preset_meals', []);
  fakeDb.seed('creator_source_items', []);
}

function publish(token: string, body: Record<string, unknown> = {}) {
  return POST(
    jsonRequest('/api/creator/meals', {
      method: 'POST',
      token,
      body: {
        name: 'Guacamole',
        ingredients: [{ ingredientName: 'avocado', qty: 2, unit: 'qty' }],
        source: URL_TYPED,
        ...body,
      },
    }),
  );
}

/** A meal already on the row, as `publishCreatorMeal` would have written it. */
function existingMeal(source: string, overrides: Record<string, unknown> = {}) {
  return { id: 'm1', name: 'Guacamole', author: 'Chef Sarah', creator_id: 'c1', source, ...overrides };
}

describe('POST /api/creator/meals — the same link twice', () => {
  let token: string;

  beforeEach(async () => {
    fakeDb.reset();
    token = await createAccessToken('u1', 'sarah@chefsarah.test');
  });

  it('publishes normally the first time', async () => {
    asUser();
    seedCreator();

    const res = await publish(token);

    expect(res.status).toBe(201);
    expect(fakeDb.rows('preset_meals')).toHaveLength(1);
    expect(fakeDb.rows('preset_meals')[0].source).toBe(URL_STORED);
  });

  it('warns, and names the meal it found, on a second publish from the same link', async () => {
    asUser();
    seedCreator();
    fakeDb.seed('preset_meals', [existingMeal(URL_STORED)]);

    const res = await publish(token, { name: 'Guacamole again' });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toMatch(/already published "Guacamole" from this link/i);
    // Linked, not just named: the creator can open it and check rather than guess.
    expect(body.duplicate).toEqual({ id: 'm1', name: 'Guacamole' });
    expect(fakeDb.rows('preset_meals')).toHaveLength(1);
  });

  it('publishes on confirmation — two recipes from one page stays possible', async () => {
    asUser();
    seedCreator();
    fakeDb.seed('preset_meals', [existingMeal(URL_STORED)]);

    const res = await publish(token, { name: 'Guacamole, spicy', confirmDuplicate: true });

    expect(res.status).toBe(201);
    expect(fakeDb.rows('preset_meals').map((m) => m.name)).toEqual(['Guacamole', 'Guacamole, spicy']);
  });

  describe('URLs that differ only in spelling are the same link', () => {
    const SPELLINGS = [
      ['http vs https', 'http://chefsarah.test/guacamole'],
      ['a www. that is not', 'https://www.chefsarah.test/guacamole'],
      ['a tracking parameter', 'https://chefsarah.test/guacamole?utm_source=newsletter'],
      ['a trailing slash', 'https://chefsarah.test/guacamole/'],
      ['a fragment', 'https://chefsarah.test/guacamole#recipe'],
    ] as const;

    for (const [label, stored] of SPELLINGS) {
      it(`warns across ${label}`, async () => {
        asUser();
        seedCreator();
        fakeDb.seed('preset_meals', [existingMeal(stored)]);

        // Without `urlIdentity` these are three, four, five different meals and
        // the warning never fires — the same bug that produced duplicate drafts
        // in the admin sync.
        const res = await publish(token);

        expect(res.status).toBe(409);
        expect(fakeDb.rows('preset_meals')).toHaveLength(1);
      });
    }
  });

  it('warns only about this creator’s own meals', async () => {
    asUser();
    seedCreator();
    fakeDb.seed('preset_meals', [existingMeal(URL_STORED, { id: 'm9', creator_id: 'c2' })]);

    // Two creators publishing from one page is not a double-submit, and telling
    // one of them what the other published would be a leak besides.
    const res = await publish(token);

    expect(res.status).toBe(201);
    expect(fakeDb.rows('preset_meals')).toHaveLength(2);
  });

  it('publishes a meal with no link at all, every time', async () => {
    asUser();
    seedCreator();

    expect((await publish(token, { source: '' })).status).toBe(201);
    asUser();
    expect((await publish(token, { source: '' })).status).toBe(201);
    // Nothing to compare is not a duplicate. A creator typing their meals in
    // never trips this.
    expect(fakeDb.rows('preset_meals')).toHaveLength(2);
    expect(fakeDb.rows('creator_source_items')).toHaveLength(0);
  });

  describe('the race the prompt cannot see', () => {
    it('claims the link, so the record says who it belongs to', async () => {
      asUser();
      seedCreator();

      await publish(token);

      const [claim] = fakeDb.rows('creator_source_items');
      // Keyed exactly the way the one-link admin sync keys a pasted URL, on the
      // folded identity — which is what makes the UNIQUE constraint the decider.
      expect(claim).toMatchObject({
        creator_id: 'c1',
        source: 'website',
        item_id: URL_STORED,
        status: 'imported',
      });
      // No draft id: that is what marks the record as a hand publish rather than
      // one of the sync's, and it is how the two are told apart.
      expect(claim.draft_id ?? null).toBeNull();
    });

    it('refuses the twin of an in-flight publish, before any meal exists to warn about', async () => {
      asUser();
      seedCreator();
      // The state a double-click leaves between the two requests: the first has
      // claimed the link and has not yet inserted its meal, so `preset_meals` is
      // still empty and the prompt has nothing to find.
      fakeDb.seed('creator_source_items', [
        { id: 'i1', creator_id: 'c1', source: 'website', item_id: URL_STORED, status: 'imported', draft_id: null },
      ]);

      const res = await publish(token);

      expect(res.status).toBe(409);
      expect((await res.json()).error).toMatch(/published a moment ago/i);
      expect(fakeDb.rows('preset_meals')).toHaveLength(0);
    });

    it('does not let a pending sync draft block the creator publishing their own', async () => {
      asUser();
      seedCreator();
      // An operator drafted this post from the admin sync. A draft in the review
      // queue is not a published meal, and `imported` there carries a draft id —
      // which is what tells the two apart.
      fakeDb.seed('creator_source_items', [
        { id: 'i1', creator_id: 'c1', source: 'website', item_id: URL_STORED, status: 'imported', draft_id: 'd1' },
      ]);

      const res = await publish(token);

      expect(res.status).toBe(201);
      expect(fakeDb.rows('preset_meals')).toHaveLength(1);
      // And the sync's own record is left exactly as it was.
      expect(fakeDb.row('creator_source_items', 'i1')?.draft_id).toBe('d1');
    });

    it('claims a link the poller had only marked seen', async () => {
      asUser();
      seedCreator();
      fakeDb.seed('creator_source_items', [
        { id: 'i1', creator_id: 'c1', source: 'website', item_id: URL_STORED, status: 'seen', draft_id: null },
      ]);

      const res = await publish(token);

      expect(res.status).toBe(201);
      // Now imported, so a later sync of the same post skips it rather than
      // queueing the recipe the creator has already published by hand.
      expect(fakeDb.row('creator_source_items', 'i1')?.status).toBe('imported');
    });

    it('gives the link back when the publish itself fails', async () => {
      asUser();
      seedCreator();
      // A claim with no meal behind it would tell this creator for ever that
      // they had already published something that does not exist. The first
      // queued result answers the duplicate lookup; the second is the insert.
      fakeDb.queue('preset_meals', { data: [] });
      fakeDb.queue('preset_meals', { data: null, error: { message: 'insert exploded' } });

      const res = await publish(token);

      expect(res.status).toBe(500);
      expect(fakeDb.rows('creator_source_items')).toHaveLength(0);
    });

    it('gives a claimed sync record back to the status it had', async () => {
      asUser();
      seedCreator();
      fakeDb.seed('creator_source_items', [
        { id: 'i1', creator_id: 'c1', source: 'website', item_id: URL_STORED, status: 'failed', detail: 'Extraction failed.', draft_id: null },
      ]);
      fakeDb.queue('preset_meals', { data: [] });
      fakeDb.queue('preset_meals', { data: null, error: { message: 'insert exploded' } });

      await publish(token);

      // Restored rather than deleted: the retry sweep reads `failed`, and
      // dropping the row would lose the post instead of retrying it.
      expect(fakeDb.row('creator_source_items', 'i1')).toMatchObject({ status: 'failed', detail: 'Extraction failed.' });
    });
  });
});
