import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeDb } from '../helpers/supabase-mock';
import { jsonRequest } from '../helpers/request';
import { importedGuacamole } from '../helpers/import-ui-fixtures';
import type { ImportSuccess } from '@/lib/import/types';

vi.mock('@/lib/supabase', async () =>
  (await import('../helpers/supabase-mock')).mockSupabaseModule());
vi.mock('@/lib/logger', () => ({ log: vi.fn() }));

const revalidateTag = vi.fn();
vi.mock('next/cache', () => ({ revalidateTag: (...args: unknown[]) => revalidateTag(...args) }));

/**
 * The publisher and the notifier are mocked at the module boundary rather than
 * injected, because the point of these tests is what the *route* reaches for.
 * A guard that returns 403 while the work has already happened is the failure
 * mode being tested against, and it is only visible from out here.
 */
const publishCreatorMeal = vi.fn();
vi.mock('@/lib/creator-meals', () => ({
  publishCreatorMeal: (...args: unknown[]) => publishCreatorMeal(...args),
}));

const sendCreatorSyncPublishedEmail = vi.fn();
vi.mock('@/lib/email', () => ({
  sendCreatorSyncPublishedEmail: (...args: unknown[]) => sendCreatorSyncPublishedEmail(...args),
}));

const sendMarketingEmail = vi.fn();
vi.mock('@/lib/marketing-email', () => ({
  sendMarketingEmail: (...args: unknown[]) => sendMarketingEmail(...args),
}));

import { GET, PATCH, POST } from '@/app/api/admin/import-drafts/route';
import { clearRevocationCache, createAccessToken } from '@/lib/tokens';

/**
 * The HTTP surface of the admin review queue (MEAL-91).
 *
 * Every endpoint here either publishes under a creator's name, emails that
 * creator, or changes whose decision a recipe is. So the admin guard is tested
 * on each one, and tested to stop **the work** — no publish, no email, no write
 * — rather than only to return 403.
 */

let guacamole: ImportSuccess;
let token: string;

function asAdmin(isAdmin = true) {
  clearRevocationCache();
  fakeDb.queue('user_profiles', { data: { tokens_invalidated_at: null } });
  fakeDb.queue('user_profiles', { data: { is_admin: isAdmin } });
}

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
    creators: { id: 'c1', display_name: 'Chef Sarah', user_id: 'u1', user_profiles: { email: 'sarah@chefsarah.test' } },
    ...overrides,
  };
}

/**
 * Stores the rows a decision reads and writes.
 *
 * Stored rather than queued: every decision is now a conditional write, so what
 * matters is which rows the predicate matched — a canned result cannot express
 * that, and a batch of two would have handed the second draft's row back as the
 * first one's update result.
 */
function storeDrafts(...rows: Array<Record<string, unknown>>) {
  fakeDb.seed('creator_import_drafts', rows);
}

/** Nothing was published, nobody was told, and no row was touched. */
function nothingHappened() {
  expect(publishCreatorMeal).not.toHaveBeenCalled();
  expect(sendCreatorSyncPublishedEmail).not.toHaveBeenCalled();
  expect(revalidateTag).not.toHaveBeenCalled();
  expect(fakeDb.calls.some((c) => c.table === 'creator_import_drafts')).toBe(false);
  expect(fakeDb.calls.some((c) => c.table === 'preset_meals')).toBe(false);
}

beforeEach(async () => {
  fakeDb.reset();
  publishCreatorMeal.mockReset();
  publishCreatorMeal.mockResolvedValue({ id: 'meal-1', name: 'Best Guacamole' });
  sendCreatorSyncPublishedEmail.mockReset();
  sendMarketingEmail.mockReset();
  revalidateTag.mockReset();
  guacamole = await importedGuacamole();
  token = await createAccessToken('admin-1', 'admin@mealio.co');
});

// ── The guard ────────────────────────────────────────────────────────────────

describe('the admin guard blocks the work, not just the response', () => {
  it('GET — a non-admin reads no queue', async () => {
    asAdmin(false);
    const res = await GET(jsonRequest('/api/admin/import-drafts', { method: 'GET', token }));
    expect(res.status).toBe(403);
    nothingHappened();
  });

  it('POST approve — a non-admin publishes nothing and emails nobody', async () => {
    asAdmin(false);
    // The row is queued so that a guard which ran *after* the read would still
    // find something to publish. It must never get that far.
    storeDrafts(draftRow());

    const res = await POST(jsonRequest('/api/admin/import-drafts', { token, body: { action: 'approve', ids: ['d1'] } }));

    expect(res.status).toBe(403);
    nothingHappened();
  });

  it('POST delete — a non-admin cannot decline someone else’s draft', async () => {
    asAdmin(false);
    storeDrafts(draftRow());
    const res = await POST(jsonRequest('/api/admin/import-drafts', { token, body: { action: 'delete', ids: ['d1'] } }));
    expect(res.status).toBe(403);
    nothingHappened();
  });

  it('POST send-to-creator — a non-admin cannot move a draft between queues', async () => {
    asAdmin(false);
    storeDrafts(draftRow());
    const res = await POST(jsonRequest('/api/admin/import-drafts', { token, body: { action: 'send-to-creator', ids: ['d1'] } }));
    expect(res.status).toBe(403);
    nothingHappened();
  });

  it('PATCH — a non-admin cannot rewrite a draft', async () => {
    asAdmin(false);
    storeDrafts(draftRow());

    const res = await PATCH(jsonRequest('/api/admin/import-drafts', {
      method: 'PATCH',
      token,
      body: { id: 'd1', draft: { name: 'Something else', ingredients: [{ ingredientName: 'x', qty: 1, unit: 'qty' }] } },
    }));

    expect(res.status).toBe(403);
    nothingHappened();
  });
});

// ── The queue ────────────────────────────────────────────────────────────────

describe('GET /api/admin/import-drafts', () => {
  it('returns what is waiting, with the flagged count that drives the grouping', async () => {
    asAdmin();
    fakeDb.queue('creator_import_drafts', {
      data: [{ ...draftRow(), creators: { display_name: 'Chef Sarah' } }],
    });

    const res = await GET(jsonRequest('/api/admin/import-drafts', { method: 'GET', token }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.totals).toMatchObject({ waiting: 1, flagged: 1 });
    // Rendered server-side so the rules that decide what gets called out live in
    // exactly one place.
    expect(body.drafts[0].review.summary.needALook).toBeGreaterThan(0);
    expect(body.drafts[0].draft.name).toBe('Best Guacamole');
  });

  it('asks only for drafts pending on the admin, then for what was handed away', async () => {
    asAdmin();
    fakeDb.queue('creator_import_drafts', { data: [] });
    fakeDb.queue('creator_import_drafts', { data: [] });

    await GET(jsonRequest('/api/admin/import-drafts', { method: 'GET', token }));

    const filters = fakeDb.calls.filter((c) => c.table === 'creator_import_drafts' && c.method === 'eq');
    expect(filters.map((c) => c.args)).toEqual([
      ['status', 'pending_review'], ['review_by', 'admin'],
      // The second query: rows an operator sent to a queue that does not exist.
      ['status', 'pending_review'], ['review_by', 'creator'],
    ]);
    expect(fakeDb.calls.some((c) => c.method === 'not' && c.args[0] === 'sent_to_creator_at')).toBe(true);
  });

  it('returns the handed-over drafts so none of them is invisible', async () => {
    asAdmin();
    fakeDb.queue('creator_import_drafts', { data: [] });
    fakeDb.queue('creator_import_drafts', {
      data: [{ ...draftRow({ review_by: 'creator', sent_to_creator_at: '2026-08-02T11:00:00.000Z' }), creators: { display_name: 'Chef Sarah' } }],
    });

    const body = await (await GET(jsonRequest('/api/admin/import-drafts', { method: 'GET', token }))).json();

    expect(body.totals).toMatchObject({ waiting: 0, handedOver: 1 });
    expect(body.handedOver[0].id).toBe('d1');
  });

  /**
   * `?scope=all` — the escape hatch.
   *
   * The two default queries are narrow on purpose, and the cost of that is a
   * pending draft in neither of them, which no screen shows to anyone. These
   * assert the mode reaches those rows, does not change the default, and tells
   * the client which mode the payload is from.
   */
  describe('?scope=all', () => {
    it('does not run the third query, or claim a count, unless it is asked for', async () => {
      asAdmin();
      fakeDb.queue('creator_import_drafts', { data: [] });
      fakeDb.queue('creator_import_drafts', { data: [] });

      const body = await (await GET(jsonRequest('/api/admin/import-drafts', { method: 'GET', token }))).json();

      expect(fakeDb.calls.filter((c) => c.table === 'creator_import_drafts' && c.method === 'select')).toHaveLength(2);
      expect(body.scope).toBe('default');
      expect(body.unqueued).toEqual([]);
      // `null`, not `0`: nobody counted. A zero would read as "checked, none".
      expect(body.totals.allPending).toBeNull();
      expect(body.totals.unqueued).toBeNull();
      // Same for the completeness claim — no page was read, so there is nothing
      // to say about whether it held everything.
      expect(body.totals.truncated).toBeNull();
      expect(body.totals.limit).toBeNull();
    });

    it('surfaces a pending draft that neither default query returns', async () => {
      asAdmin();
      // The poller's own row: `review_by` defaults to 'creator' and nothing ever
      // set `sent_to_creator_at`, so the admin query skips it, the handed-over
      // query skips it, and the creator queue that would show it does not exist.
      const stranded = { ...draftRow({ id: 'd-poll', review_by: 'creator' }), creators: { display_name: 'Chef Sarah' } };
      fakeDb.queue('creator_import_drafts', { data: [] });
      fakeDb.queue('creator_import_drafts', { data: [] });
      fakeDb.queue('creator_import_drafts', { data: [stranded] });

      const res = await GET(jsonRequest('/api/admin/import-drafts?scope=all', { method: 'GET', token }));
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.scope).toBe('all');
      expect(body.unqueued.map((row: { id: string }) => row.id)).toEqual(['d-poll']);
      expect(body.totals).toMatchObject({
        waiting: 0, handedOver: 0, allPending: 1, unqueued: 1, truncated: false, limit: 500,
      });
      // Named, attributed and placed — enough to decide whether to take it back.
      expect(body.unqueued[0]).toEqual({
        id: 'd-poll',
        name: 'Best Guacamole',
        sourceUrl: 'https://chefsarah.test/guacamole',
        creatorName: 'Chef Sarah',
      });
    });

    it('sends three strings a row, not a recipe apiece', async () => {
      // The list draws a name, a creator and a host, and posts the id back. The
      // full `draft` and `confidence` jsonb plus a computed review is ~6 KB a row
      // — megabytes at the cap — for a section with no card to open.
      asAdmin();
      const stranded = { ...draftRow({ id: 'd-poll', review_by: 'creator' }), creators: { display_name: 'Chef Sarah' } };
      fakeDb.queue('creator_import_drafts', { data: [] });
      fakeDb.queue('creator_import_drafts', { data: [] });
      fakeDb.queue('creator_import_drafts', { data: [stranded] });

      const body = await (await GET(jsonRequest('/api/admin/import-drafts?scope=all', { method: 'GET', token }))).json();

      expect(Object.keys(body.unqueued[0]).sort()).toEqual(['creatorName', 'id', 'name', 'sourceUrl']);
      expect(JSON.stringify(body.unqueued[0]).length).toBeLessThan(500);
    });

    it('asks on status alone, with no review_by and no sent_to_creator_at', async () => {
      asAdmin();
      fakeDb.queue('creator_import_drafts', { data: [] });
      fakeDb.queue('creator_import_drafts', { data: [] });
      fakeDb.queue('creator_import_drafts', { data: [] });

      await GET(jsonRequest('/api/admin/import-drafts?scope=all', { method: 'GET', token }));

      const eqs = fakeDb.calls.filter((c) => c.table === 'creator_import_drafts' && c.method === 'eq').map((c) => c.args);
      expect(eqs).toEqual([
        ['status', 'pending_review'], ['review_by', 'admin'],
        ['status', 'pending_review'], ['review_by', 'creator'],
        // The third query: no second filter, so nothing pending can be missed.
        ['status', 'pending_review'],
      ]);
    });

    it('does not repeat a row the operator can already see', async () => {
      asAdmin();
      const mine = { ...draftRow({ id: 'd1' }), creators: { display_name: 'Chef Sarah' } };
      const handed = {
        ...draftRow({ id: 'd2', review_by: 'creator', sent_to_creator_at: '2026-08-02T11:00:00.000Z' }),
        creators: { display_name: 'Chef Sarah' },
      };
      const stranded = { ...draftRow({ id: 'd3', review_by: 'creator' }), creators: { display_name: 'Chef Sarah' } };
      fakeDb.queue('creator_import_drafts', { data: [mine] });
      fakeDb.queue('creator_import_drafts', { data: [handed] });
      fakeDb.queue('creator_import_drafts', { data: [mine, handed, stranded] });

      const body = await (await GET(jsonRequest('/api/admin/import-drafts?scope=all', { method: 'GET', token }))).json();

      // `unqueued` is only what neither list above holds, so the screen can say
      // which rows are on it solely because the mode is on — three pending, one
      // of them extra.
      expect(body.unqueued.map((row: { id: string }) => row.id)).toEqual(['d3']);
      expect(body.totals).toMatchObject({ waiting: 1, handedOver: 1, allPending: 3, unqueued: 1 });
    });

    /**
     * The page boundary, from the route's side.
     *
     * The whole premise of this mode is that pending poller drafts accumulate
     * and nothing drains them, so passing a page size is the steady state. Two
     * things must not happen: the response must not report its own page length
     * as a total, and rows the *other* two queries truncated away must not be
     * relabelled "in no queue at all".
     */
    describe('past the page size', () => {
      /** `n` pending rows, distinct and ordered, so a limit cuts deterministically. */
      function many(n: number, prefix: string, overrides: Record<string, unknown> = {}) {
        return Array.from({ length: n }, (_, i) => ({
          ...draftRow({
            id: `${prefix}-${String(i).padStart(4, '0')}`,
            created_at: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString(),
            ...overrides,
          }),
          creators: { display_name: 'Chef Sarah' },
        }));
      }

      it('reports the real total and says the page did not hold it', async () => {
        asAdmin();
        // One more pending draft than the escape hatch reads in a page.
        storeDrafts(...many(501, 'poll', { review_by: 'creator' }));

        const body = await (await GET(jsonRequest('/api/admin/import-drafts?scope=all', { method: 'GET', token }))).json();

        expect(body.unqueued).toHaveLength(500);
        // Not 500: the count comes from the database over the same WHERE clause,
        // so it is a total rather than the length of what fitted.
        expect(body.totals.allPending).toBe(501);
        expect(body.totals).toMatchObject({ unqueued: 500, truncated: true, limit: 500 });
      });

      it('does not call the admin’s own overflow “in no queue at all”', async () => {
        asAdmin();
        // `listDraftQueue` stops at 200, so ten of these are absent from the
        // admin list while still being the admin's own work. Subtracting one
        // list's ids from another's puts them under "In no queue at all", where
        // Take it back then fails with "already in your queue".
        storeDrafts(
          ...many(210, 'mine', { review_by: 'admin' }),
          ...many(1, 'poll', { review_by: 'creator' }),
        );

        const body = await (await GET(jsonRequest('/api/admin/import-drafts?scope=all', { method: 'GET', token }))).json();

        expect(body.totals.waiting).toBe(200);
        expect(body.unqueued.map((row: { id: string }) => row.id)).toEqual(['poll-0000']);
        expect(body.totals).toMatchObject({ allPending: 211, unqueued: 1, truncated: false });
      });

      it('does not call a handed-over row past its own page stranded either', async () => {
        asAdmin();
        // Same failure on the other narrow list: `listHandedOverDrafts` stops at
        // 200 too, and its overflow is still handed over, not unqueued.
        storeDrafts(
          ...many(205, 'sent', { review_by: 'creator', sent_to_creator_at: '2026-08-02T11:00:00.000Z' }),
          ...many(1, 'poll', { review_by: 'creator' }),
        );

        const body = await (await GET(jsonRequest('/api/admin/import-drafts?scope=all', { method: 'GET', token }))).json();

        expect(body.totals.handedOver).toBe(200);
        expect(body.unqueued.map((row: { id: string }) => row.id)).toEqual(['poll-0000']);
      });
    });

    it('is behind the admin guard like everything else here', async () => {
      asAdmin(false);
      const res = await GET(jsonRequest('/api/admin/import-drafts?scope=all', { method: 'GET', token }));
      expect(res.status).toBe(403);
      expect(fakeDb.calls.some((c) => c.table === 'creator_import_drafts')).toBe(false);
    });
  });
});

// ── Decisions ────────────────────────────────────────────────────────────────

describe('POST /api/admin/import-drafts', () => {
  it('approve publishes, invalidates the feed once, and emails the creator', async () => {
    asAdmin();
    storeDrafts(draftRow());

    const res = await POST(jsonRequest('/api/admin/import-drafts', { token, body: { action: 'approve', ids: ['d1'] } }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ done: 1, emailsSent: 1, errors: [] });
    expect(body.published).toEqual([{ id: 'meal-1', name: 'Best Guacamole' }]);
    expect(publishCreatorMeal).toHaveBeenCalledTimes(1);
    expect(revalidateTag).toHaveBeenCalledTimes(1);
    // Transactional, not marketing: marketing_opt_out must not suppress it.
    expect(sendMarketingEmail).not.toHaveBeenCalled();
  });

  it('emails once for a batch of approvals rather than once per meal', async () => {
    asAdmin();
    storeDrafts(draftRow({ id: 'd1' }), draftRow({ id: 'd2', item_id: 'guid-2' }));

    const res = await POST(jsonRequest('/api/admin/import-drafts', { token, body: { action: 'approve', ids: ['d1', 'd2'] } }));

    expect((await res.json()).done).toBe(2);
    expect(publishCreatorMeal).toHaveBeenCalledTimes(2);
    expect(sendCreatorSyncPublishedEmail).toHaveBeenCalledTimes(1);
    // And the Discover cache is invalidated once for the batch, not per meal.
    expect(revalidateTag).toHaveBeenCalledTimes(1);
  });

  it('notification defaults to on', async () => {
    asAdmin();
    storeDrafts(draftRow());
    await POST(jsonRequest('/api/admin/import-drafts', { token, body: { action: 'approve', ids: ['d1'] } }));
    expect(sendCreatorSyncPublishedEmail).toHaveBeenCalledTimes(1);
  });

  it('honours notification being turned off deliberately', async () => {
    asAdmin();
    storeDrafts(draftRow());
    await POST(jsonRequest('/api/admin/import-drafts', {
      token,
      body: { action: 'approve', ids: ['d1'], notifyCreator: false },
    }));
    // Still published — the creator just was not told, which the screen says.
    expect(publishCreatorMeal).toHaveBeenCalledTimes(1);
    expect(sendCreatorSyncPublishedEmail).not.toHaveBeenCalled();
  });

  it('sends no email when nothing published', async () => {
    asAdmin();
    // Refused before any write, so no slot for one.
    storeDrafts(draftRow({ status: 'cancelled' }));

    const res = await POST(jsonRequest('/api/admin/import-drafts', { token, body: { action: 'approve', ids: ['d1'] } }));

    const body = await res.json();
    expect(body.done).toBe(0);
    expect(body.errors[0]).toMatch(/already cancelled/i);
    expect(sendCreatorSyncPublishedEmail).not.toHaveBeenCalled();
    expect(revalidateTag).not.toHaveBeenCalled();
  });

  it('send-to-creator moves it to the creator queue without publishing anything', async () => {
    // A disabled button until MEAL-89, because nothing read `review_by =
    // 'creator'`. The far side is `/api/creator/import-drafts`, which is what
    // makes this a handoff rather than a one-way trapdoor.
    asAdmin();
    storeDrafts(draftRow());

    const res = await POST(jsonRequest('/api/admin/import-drafts', { token, body: { action: 'send-to-creator', ids: ['d1'] } }));

    expect(res.status).toBe(200);
    expect((await res.json()).done).toBe(1);
    expect(fakeDb.row('creator_import_drafts', 'd1')).toMatchObject({
      review_by: 'creator',
      // Handed over, not decided: it is still somebody's to say yes or no to.
      status: 'pending_review',
      decided_by: null,
      published_meal_id: null,
    });
    expect(publishCreatorMeal).not.toHaveBeenCalled();
    expect(sendCreatorSyncPublishedEmail).not.toHaveBeenCalled();
  });

  it('reclaim brings a handed-over draft back into the admin queue', async () => {
    asAdmin();
    storeDrafts(draftRow({ review_by: 'creator', sent_to_creator_at: '2026-08-02T11:00:00.000Z' }));

    const res = await POST(jsonRequest('/api/admin/import-drafts', { token, body: { action: 'reclaim', ids: ['d1'] } }));

    expect(res.status).toBe(200);
    expect((await res.json()).done).toBe(1);
    expect(fakeDb.row('creator_import_drafts', 'd1')).toMatchObject({ review_by: 'admin', status: 'pending_review' });
    expect(publishCreatorMeal).not.toHaveBeenCalled();
  });

  it('delete marks cancelled and issues no delete', async () => {
    asAdmin();
    storeDrafts(draftRow());

    const res = await POST(jsonRequest('/api/admin/import-drafts', { token, body: { action: 'delete', ids: ['d1'] } }));

    expect(res.status).toBe(200);
    const update = fakeDb.calls.filter((c) => c.table === 'creator_import_drafts' && c.method === 'update').at(-1);
    expect(update?.args[0]).toMatchObject({ status: 'cancelled', decided_by: 'admin-1' });
    // A removed row means the next sync or poll re-imports the same post and
    // asks again. A declined recipe has to stay declined.
    expect(fakeDb.calls.some((c) => c.method === 'delete')).toBe(false);
    expect(publishCreatorMeal).not.toHaveBeenCalled();
  });

  it('reports per-draft failures without sinking the rest of the batch', async () => {
    asAdmin();
    storeDrafts(draftRow({ id: 'd1' }), draftRow({ id: 'd2', status: 'approved' }));
    

    const body = await (await POST(jsonRequest('/api/admin/import-drafts', {
      token,
      body: { action: 'approve', ids: ['d1', 'd2'] },
    }))).json();

    expect(body.done).toBe(1);
    expect(body.errors).toHaveLength(1);
    expect(publishCreatorMeal).toHaveBeenCalledTimes(1);
  });

  it('rejects an action it does not have, and an empty selection', async () => {
    asAdmin();
    expect((await POST(jsonRequest('/api/admin/import-drafts', { token, body: { action: 'unpublish', ids: ['d1'] } }))).status).toBe(400);
    asAdmin();
    expect((await POST(jsonRequest('/api/admin/import-drafts', { token, body: { action: 'approve', ids: [] } }))).status).toBe(400);
    expect(publishCreatorMeal).not.toHaveBeenCalled();
  });

  it('refuses a batch too large to have been reviewed', async () => {
    asAdmin();
    const ids = Array.from({ length: 51 }, (_, i) => `d${i}`);
    const res = await POST(jsonRequest('/api/admin/import-drafts', { token, body: { action: 'approve', ids } }));
    expect(res.status).toBe(400);
    expect(publishCreatorMeal).not.toHaveBeenCalled();
  });
});

// ── Edit ─────────────────────────────────────────────────────────────────────

describe('PATCH /api/admin/import-drafts', () => {
  it('saves an edit and hands back the re-rendered card, without publishing', async () => {
    asAdmin();
    storeDrafts(draftRow());

    const res = await PATCH(jsonRequest('/api/admin/import-drafts', {
      method: 'PATCH',
      token,
      body: {
        id: 'd1',
        draft: {
          ...guacamole.draft,
          serves: '6',
          ingredients: guacamole.draft.ingredients.map((row) => ({ ...row })),
        },
      },
    }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.draft.draft.serves).toBe('6');
    expect(body.draft.review.summary.total).toBeGreaterThan(0);
    expect(publishCreatorMeal).not.toHaveBeenCalled();
    expect(revalidateTag).not.toHaveBeenCalled();
  });

  it('refuses an edit that could not be published, while the operator is still looking at it', async () => {
    asAdmin();
    const res = await PATCH(jsonRequest('/api/admin/import-drafts', {
      method: 'PATCH',
      token,
      body: { id: 'd1', draft: { name: '', ingredients: [] } },
    }));

    expect(res.status).toBe(400);
    // Rejected before the row is even read, so a bad edit cannot half-apply.
    expect(fakeDb.calls.some((c) => c.table === 'creator_import_drafts')).toBe(false);
  });

  it('400 without an id', async () => {
    asAdmin();
    const res = await PATCH(jsonRequest('/api/admin/import-drafts', { method: 'PATCH', token, body: { draft: {} } }));
    expect(res.status).toBe(400);
  });
});
