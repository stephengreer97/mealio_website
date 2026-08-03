import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeDb } from '../helpers/supabase-mock';
import { jsonRequest } from '../helpers/request';

vi.mock('@/lib/supabase', async () =>
  (await import('../helpers/supabase-mock')).mockSupabaseModule());
vi.mock('@/lib/logger', () => ({ log: vi.fn() }));
vi.mock('next/cache', () => ({ revalidateTag: vi.fn() }));

import { POST } from '@/app/api/creator/meals/route';
import { DELETE, PUT } from '@/app/api/creator/meals/[id]/route';
import { CLAIM_GRACE_MS } from '@/lib/creator-meals';
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
    // The claim the first meal is holding, which is the state a real second
    // publish arrives into. Seeded empty, the confirmed publish simply takes the
    // claim again and nothing distinguishes "skip the claim when a meal already
    // holds it" from "claim every time" — the flagship case of the ticket rides
    // on that skip.
    fakeDb.seed('creator_source_items', [{
      id: 'i1', creator_id: 'c1', source: 'website', item_id: URL_STORED, status: 'imported', draft_id: null,
      updated_at: new Date().toISOString(),
    }]);

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

  it('still warns a creator with more meals than one page holds', async () => {
    asUser();
    seedCreator();
    // Past PostgREST's default page an unbounded select silently returns the
    // first 1000 rows and says nothing about the rest, so the fold that decides
    // "already published" stops seeing the creator's recent work — for exactly
    // the creators most likely to publish the same link twice.
    fakeDb.seed('preset_meals', [
      ...Array.from({ length: 1200 }, (_, i) => existingMeal(`https://chefsarah.test/post-${i}`, {
        id: `m${i}`, name: `Meal ${i}`, created_at: `2024-01-01T00:00:${String(i % 60).padStart(2, '0')}.000Z`,
      })),
      existingMeal(URL_STORED, { id: 'newest', created_at: '2026-01-01T00:00:00.000Z' }),
    ]);

    const res = await publish(token);

    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/already published "Guacamole"/i);
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

  describe('the claim is the meal’s, and only for as long as the meal holds it', () => {
    /** The claim a hand publish leaves, as `claimPublishFromLink` writes it. */
    function heldClaim(itemId = URL_STORED) {
      return {
        id: 'i1', creator_id: 'c1', source: 'website', item_id: itemId,
        status: 'imported', draft_id: null, updated_at: new Date().toISOString(),
      };
    }

    it('lets a creator republish a link after deleting the meal that used it', async () => {
      asUser();
      seedCreator();
      fakeDb.seed('preset_meals', [existingMeal(URL_STORED)]);
      fakeDb.seed('creator_source_items', [heldClaim()]);

      // The ordinary reason to delete a published meal: a typo in the title, the
      // wrong photo. Nothing about it says the creator is finished with the link.
      const removed = await DELETE(
        jsonRequest('/api/creator/meals/m1', { method: 'DELETE', token }),
        { params: Promise.resolve({ id: 'm1' }) },
      );
      expect(removed.status).toBe(200);
      expect(fakeDb.rows('creator_source_items')).toHaveLength(0);

      asUser();
      const again = await publish(token);

      // Without the release this is a 409 that no confirmation can get past —
      // the escape hatch is gated on a meal that no longer exists — and the link
      // is unpublishable for the rest of the creator's life.
      expect(again.status).toBe(201);
      expect(fakeDb.rows('preset_meals')).toHaveLength(1);
    });

    it('leaves a sync’s own record alone when a meal is deleted', async () => {
      asUser();
      seedCreator();
      fakeDb.seed('preset_meals', [existingMeal(URL_STORED)]);
      // A draft in the review queue is the sync's, not this meal's. Deleting it
      // here would strand the draft.
      fakeDb.seed('creator_source_items', [{ ...heldClaim(), draft_id: 'd1' }]);

      await DELETE(
        jsonRequest('/api/creator/meals/m1', { method: 'DELETE', token }),
        { params: Promise.resolve({ id: 'm1' }) },
      );

      expect(fakeDb.row('creator_source_items', 'i1')?.draft_id).toBe('d1');
    });

    it('gives the old link back when a meal is edited onto a different one', async () => {
      asUser();
      seedCreator();
      fakeDb.seed('preset_meals', [existingMeal(URL_STORED)]);
      fakeDb.seed('creator_source_items', [heldClaim()]);

      const edited = await PUT(
        jsonRequest('/api/creator/meals/m1', {
          method: 'PUT', token, body: { source: 'chefsarah.test/guacamole-v2' },
        }),
        { params: Promise.resolve({ id: 'm1' }) },
      );

      expect(edited.status).toBe(200);
      // The meal points somewhere else now, so nothing is standing behind the
      // old claim and it must not go on refusing publishes from that page.
      expect(fakeDb.rows('creator_source_items')).toHaveLength(0);
    });

    it('keeps the claim when an edit does not touch the link', async () => {
      asUser();
      seedCreator();
      fakeDb.seed('preset_meals', [existingMeal(URL_STORED)]);
      fakeDb.seed('creator_source_items', [heldClaim()]);

      await PUT(
        jsonRequest('/api/creator/meals/m1', { method: 'PUT', token, body: { name: 'Guacamole, fixed' } }),
        { params: Promise.resolve({ id: 'm1' }) },
      );

      // A title fix is not a change of source. Dropping the claim here would
      // re-open the double-submit the claim exists to close.
      expect(fakeDb.rows('creator_source_items')).toHaveLength(1);
    });
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

    it('keys a YouTube publish on the video id the poller uses', async () => {
      asUser();
      seedCreator();

      await publish(token, { source: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' });

      // The bare id, not the URL. The catalog reads `creator_source_items` by
      // the id `parseUploadsFeed` produces, so a record filed under a URL is one
      // it never finds — the sync re-imports the video the creator published by
      // hand, which is the promise this record exists to keep. MEAL-79's
      // "this meal came from *that* video" relationship keys on it too.
      expect(fakeDb.rows('creator_source_items')[0]).toMatchObject({
        source: 'youtube',
        item_id: 'dQw4w9WgXcQ',
      });
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

    it('takes over a claim nothing came back for', async () => {
      asUser();
      seedCreator();
      // The failure no `catch` can see: a request claimed the link and was
      // killed before its insert. There is no meal, so the claim protects
      // nothing — and left standing it would refuse this link for ever, telling
      // the creator about a meal that does not exist.
      fakeDb.seed('creator_source_items', [{
        id: 'i1', creator_id: 'c1', source: 'website', item_id: URL_STORED, status: 'imported', draft_id: null,
        updated_at: new Date(Date.now() - CLAIM_GRACE_MS - 1000).toISOString(),
      }]);

      const res = await publish(token);

      expect(res.status).toBe(201);
      expect(fakeDb.rows('preset_meals')).toHaveLength(1);
      // Still one claim, now this publish's.
      expect(fakeDb.rows('creator_source_items')).toHaveLength(1);
    });

    it('still refuses a claim young enough to have a request behind it', async () => {
      asUser();
      seedCreator();
      // The other side of the same clock. A double-click's twin arrives inside
      // seconds, and taking the claim from it publishes the meal twice.
      fakeDb.seed('creator_source_items', [{
        id: 'i1', creator_id: 'c1', source: 'website', item_id: URL_STORED, status: 'imported', draft_id: null,
        updated_at: new Date(Date.now() - 2000).toISOString(),
      }]);

      expect((await publish(token)).status).toBe(409);
      expect(fakeDb.rows('preset_meals')).toHaveLength(0);
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
