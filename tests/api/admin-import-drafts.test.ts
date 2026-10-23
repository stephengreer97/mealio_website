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
// Publishing only — the decline's own write to `creator_source_items` goes to
// the fake database like every other write these tests inspect.
vi.mock('@/lib/creator-meals', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/creator-meals')>()),
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
    creators: { id: 'c1', display_name: 'Chef Sarah', user_id: 'u1', allow_admin_review: true, user_profiles: { email: 'sarah@chefsarah.test' } },
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

  it('reads every pending draft, whichever queue it is in', async () => {
    asAdmin();
    fakeDb.queue('creator_import_drafts', { data: [] });

    await GET(jsonRequest('/api/admin/import-drafts', { method: 'GET', token }));

    const filters = fakeDb.calls.filter((c) => c.table === 'creator_import_drafts' && c.method === 'eq');
    expect(filters.map((c) => c.args)).toEqual([['status', 'pending_review']]);
  });

  it('narrows to one creator with ?creatorId=, and says which creator it read', async () => {
    asAdmin();
    fakeDb.queue('creator_import_drafts', {
      data: [{ ...draftRow({ review_by: 'creator' }), creators: { display_name: 'Chef Sarah', allow_admin_review: true } }],
    });

    const body = await (await GET(jsonRequest('/api/admin/import-drafts?creatorId=c1', { method: 'GET', token }))).json();

    const filters = fakeDb.calls.filter((c) => c.table === 'creator_import_drafts' && c.method === 'eq');
    // The first query; the duplicate check that follows reads the same table.
    expect(filters.slice(0, 2).map((c) => c.args)).toEqual([['status', 'pending_review'], ['creator_id', 'c1']]);
    expect(body.creatorId).toBe('c1');
    expect(body.drafts.map((d: { id: string }) => d.id)).toEqual(['d1']);
    expect(body.drafts[0].adminMayDecide).toBe(true);
  });

  it('marks a draft the admin may not decide', async () => {
    asAdmin();
    fakeDb.queue('creator_import_drafts', {
      data: [{ ...draftRow({ review_by: 'creator' }), creators: { display_name: 'Chef Sarah', allow_admin_review: false } }],
    });

    const body = await (await GET(jsonRequest('/api/admin/import-drafts?creatorId=c1', { method: 'GET', token }))).json();

    expect(body.drafts[0].adminMayDecide).toBe(false);
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

  describe('a creator who has not allowed admin review', () => {
    const notAllowed = (over: Record<string, unknown> = {}) =>
      draftRow({
        creators: { id: 'c1', display_name: 'Chef Sarah', user_id: 'u1', allow_admin_review: false, user_profiles: { email: 'sarah@chefsarah.test' } },
        ...over,
      });

    it.each(['approve', 'delete'] as const)('refuses %s and touches nothing', async (action) => {
      asAdmin();
      storeDrafts(notAllowed());

      const body = await (await POST(jsonRequest('/api/admin/import-drafts', { token, body: { action, ids: ['d1'] } }))).json();

      expect(body.done).toBe(0);
      expect(body.errors[0]).toMatch(/not allowed Mealio admins/);
      expect(fakeDb.row('creator_import_drafts', 'd1')).toMatchObject({ status: 'pending_review', review_by: 'admin' });
      expect(publishCreatorMeal).not.toHaveBeenCalled();
    });

    it('refuses an edit with a 403', async () => {
      asAdmin();
      storeDrafts(notAllowed());

      const res = await PATCH(jsonRequest('/api/admin/import-drafts', {
        method: 'PATCH',
        token,
        body: { id: 'd1', draft: { ...guacamole.draft, serves: '6', ingredients: guacamole.draft.ingredients.map((row) => ({ ...row })) } },
      }));

      expect(res.status).toBe(403);
      expect(fakeDb.calls.some((c) => c.table === 'creator_import_drafts' && c.method === 'update')).toBe(false);
    });
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

  it('refuses more tags than a meal takes, and stores none of them', async () => {
    asAdmin();
    // The row the operator opened: the three tags the import settled on.
    storeDrafts(draftRow());
    const before = fakeDb.row('creator_import_drafts', 'd1')!.draft;

    const res = await PATCH(jsonRequest('/api/admin/import-drafts', {
      method: 'PATCH',
      token,
      body: {
        id: 'd1',
        draft: {
          ...guacamole.draft,
          ingredients: guacamole.draft.ingredients.map((row) => ({ ...row })),
          tags: ['Mexican', 'No Cook', 'Vegan', 'Healthy', 'Snack', 'Dip'],
        },
      },
    }));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/at most 3/);
    // The whole edit is refused rather than the tail of the list dropped: the
    // stored draft is byte-for-byte what it was, and nothing was published.
    expect(fakeDb.row('creator_import_drafts', 'd1')!.draft).toEqual(before);
    expect(publishCreatorMeal).not.toHaveBeenCalled();
  });

  it('counts the tags it would store, not the ones it was sent', async () => {
    asAdmin();
    storeDrafts(draftRow());

    // Six tags, but three of them are outside the picker's vocabulary and would
    // be dropped anyway. Refusing this would be refusing over nothing.
    const res = await PATCH(jsonRequest('/api/admin/import-drafts', {
      method: 'PATCH',
      token,
      body: {
        id: 'd1',
        draft: {
          ...guacamole.draft,
          ingredients: guacamole.draft.ingredients.map((row) => ({ ...row })),
          tags: ['Mexican', 'Artisanal', 'No Cook', 'Small Batch', 'Vegan', 'Farm To Table'],
        },
      },
    }));

    expect(res.status).toBe(200);
    expect(fakeDb.row('creator_import_drafts', 'd1')!.draft.tags).toEqual(['Mexican', 'No Cook', 'Vegan']);
  });

  it('400 without an id', async () => {
    asAdmin();
    const res = await PATCH(jsonRequest('/api/admin/import-drafts', { method: 'PATCH', token, body: { draft: {} } }));
    expect(res.status).toBe(400);
  });
});
