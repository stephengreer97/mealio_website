import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeDb } from '../helpers/supabase-mock';
import { jsonRequest } from '../helpers/request';

vi.mock('@/lib/supabase', async () =>
  (await import('../helpers/supabase-mock')).mockSupabaseModule());
vi.mock('@/lib/logger', () => ({ log: vi.fn(), abbreviateUa: () => undefined }));

const appendMealioLink = vi.fn();
const listAppendableMeals = vi.fn();
vi.mock('@/lib/youtube-append', () => ({
  appendMealioLink: (...args: unknown[]) => appendMealioLink(...args),
  listAppendableMeals: (...args: unknown[]) => listAppendableMeals(...args),
}));

import { GET, POST } from '@/app/api/admin/sync/append/route';
import { clearRevocationCache, createAccessToken } from '@/lib/tokens';

/**
 * The HTTP surface of the append half of MEAL-79.
 *
 * This endpoint edits somebody else's property, so the admin guard is tested to
 * stop the work happening rather than merely to return 403 — and the refusal
 * statuses are tested to survive the trip out, because 403 ("the creator has not
 * agreed") and 409 ("the connection cannot carry this") are different things for
 * an operator to do and flattening both to 400 loses that.
 */

function asAdmin(isAdmin = true) {
  clearRevocationCache();
  fakeDb.queue('user_profiles', { data: { tokens_invalidated_at: null } });
  fakeDb.queue('user_profiles', { data: { is_admin: isAdmin } });
}

beforeEach(async () => {
  fakeDb.reset();
  appendMealioLink.mockReset();
  listAppendableMeals.mockReset();
  process.env.JWT_SECRET = 'test-secret-key-at-least-32-characters-long';
});

async function adminToken() {
  return createAccessToken('admin-1', 'admin@mealio.co');
}

describe('GET /api/admin/sync/append', () => {
  it('403 for a non-admin, and nothing is even looked up', async () => {
    asAdmin(false);
    const res = await GET(jsonRequest('/api/admin/sync/append?creatorId=c1', { method: 'GET', token: await adminToken() }));
    expect(res.status).toBe(403);
    expect(listAppendableMeals).not.toHaveBeenCalled();
  });

  it('lists the meals that came from one of the creator’s videos', async () => {
    asAdmin();
    listAppendableMeals.mockResolvedValue({
      ok: true,
      meals: [{ draftId: 'd1', mealId: 'meal-1', mealName: 'Best Guacamole', videoId: 'vid0000000A' }],
    });

    const res = await GET(jsonRequest('/api/admin/sync/append?creatorId=c1', { method: 'GET', token: await adminToken() }));

    expect(res.status).toBe(200);
    expect((await res.json()).meals).toHaveLength(1);
  });

  it('passes the consent refusal through with its own status and sentence', async () => {
    asAdmin();
    listAppendableMeals.mockResolvedValue({
      ok: false,
      status: 403,
      error: 'This creator has not agreed to let Mealio edit their YouTube descriptions.',
    });

    const res = await GET(jsonRequest('/api/admin/sync/append?creatorId=c1', { method: 'GET', token: await adminToken() }));

    // The screen shows this sentence *instead of* a list, so it has to survive
    // the trip out intact and keep the status that says which gate was shut.
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/has not agreed/i);
  });
});

describe('POST /api/admin/sync/append', () => {
  it('403 for a non-admin, and no write is attempted', async () => {
    asAdmin(false);
    const res = await POST(jsonRequest('/api/admin/sync/append', {
      token: await adminToken(),
      body: { creatorId: 'c1', draftId: 'd1' },
    }));
    expect(res.status).toBe(403);
    expect(appendMealioLink).not.toHaveBeenCalled();
  });

  it('appends, and records who pressed the button', async () => {
    asAdmin();
    appendMealioLink.mockResolvedValue({
      ok: true, written: true, mealUrl: 'https://mealio.co/meal/p/meal-1', videoId: 'vid0000000A',
      quotaUnits: 51, detail: 'The Mealio link was added.',
    });

    const res = await POST(jsonRequest('/api/admin/sync/append', {
      token: await adminToken(),
      body: { creatorId: 'c1', draftId: 'd1' },
    }));

    expect(res.status).toBe(200);
    expect((await res.json()).written).toBe(true);
    // The actor rides along, because this edits a creator's own property and
    // every such write needs a line with a person on it.
    expect(appendMealioLink).toHaveBeenCalledWith(expect.anything(), 'c1', 'd1', 'admin-1');
  });

  it('reports "already there" as a success that wrote nothing', async () => {
    asAdmin();
    appendMealioLink.mockResolvedValue({
      ok: true, written: false, mealUrl: 'https://mealio.co/meal/p/meal-1', videoId: 'vid0000000A',
      quotaUnits: 1, detail: 'The link was already in this description, so nothing was written.',
    });

    const res = await POST(jsonRequest('/api/admin/sync/append', {
      token: await adminToken(),
      body: { creatorId: 'c1', draftId: 'd1' },
    }));

    // Pressing twice is not an error to show an operator in red.
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.written).toBe(false);
    expect(body.detail).toMatch(/already/i);
  });

  it('400 without both ids, and no write is attempted', async () => {
    asAdmin();
    const res = await POST(jsonRequest('/api/admin/sync/append', { token: await adminToken(), body: { creatorId: 'c1' } }));
    expect(res.status).toBe(400);
    expect(appendMealioLink).not.toHaveBeenCalled();
  });
});
