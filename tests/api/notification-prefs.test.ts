// MEAL-217. The user's switches, where the server can see them.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeDb } from '../helpers/supabase-mock';
import { jsonRequest } from '../helpers/request';

vi.mock('@/lib/supabase', async () =>
  (await import('../helpers/supabase-mock')).mockSupabaseModule());
vi.mock('@/lib/logger', () => ({ log: vi.fn() }));

import { GET, PATCH } from '@/app/api/account/notification-prefs/route';
import { createAccessToken } from '@/lib/tokens';

const URL = '/api/account/notification-prefs';

describe('GET /api/account/notification-prefs', () => {
  let token: string;
  beforeEach(async () => {
    fakeDb.reset();
    token = await createAccessToken('user-1', 'a@b.test');
  });

  it('401 without a token', async () => {
    expect((await GET(jsonRequest(URL, {}) as never)).status).toBe(401);
  });

  it('returns the stored prefs and the catalogue', async () => {
    fakeDb.seed('user_profiles', [{ id: 'user-1', notification_prefs: { broadcast: false }, is_creator: false }]);
    const res = await GET(jsonRequest(URL, { token }) as never);
    const json = await res.json();
    expect(json.prefs).toEqual({ broadcast: false });
    // The catalogue comes from the SERVER, so a category added later reaches an
    // installed app without a release, and one removed stops being offered
    // rather than leaving a dead switch behind.
    expect(json.categories.map((c: { id: string }) => c.id)).toEqual(['broadcast']);
    expect(json.categories[0].label).toBeTruthy();
  });

  it('hides a creator-only category from a non-creator', async () => {
    fakeDb.seed('user_profiles', [{ id: 'user-1', notification_prefs: {}, is_creator: false }]);
    const json = await (await GET(jsonRequest(URL, { token }) as never)).json();
    expect(json.categories.map((c: { id: string }) => c.id)).not.toContain('creator_draft');
  });

  it('offers it to a creator', async () => {
    fakeDb.seed('user_profiles', [{ id: 'user-1', notification_prefs: {}, is_creator: true }]);
    const json = await (await GET(jsonRequest(URL, { token }) as never)).json();
    expect(json.categories.map((c: { id: string }) => c.id)).toContain('creator_draft');
  });

  it('treats a user with no row as opted in, not as broken', async () => {
    fakeDb.seed('user_profiles', []);
    const json = await (await GET(jsonRequest(URL, { token }) as never)).json();
    expect(json.prefs).toEqual({});
  });
});

describe('PATCH /api/account/notification-prefs', () => {
  let token: string;
  beforeEach(async () => {
    fakeDb.reset();
    token = await createAccessToken('user-1', 'a@b.test');
  });

  // SEEDED, so this reads what the table actually holds after the write rather
  // than what the route passed to update(). A canned result proves a branch was
  // taken; it cannot tell a correct conditional write from one whose predicate
  // is misspelled — see the mock's own header.
  const stored = () => fakeDb.rows('user_profiles')[0]?.notification_prefs;

  it('MERGES rather than replacing', async () => {
    // The screen sends the switch that changed. A PUT of the whole object would
    // race itself: two toggles in quick succession and the second request,
    // built from state the first had not confirmed, silently reverts it.
    fakeDb.seed('user_profiles', [{ id: 'user-1', notification_prefs: { creator_draft: false } }]);
    await PATCH(jsonRequest(URL, { token, body: { broadcast: false } }) as never);
    expect(stored()).toEqual({ creator_draft: false, broadcast: false });
  });

  it('turns one back on without touching the others', async () => {
    fakeDb.seed('user_profiles', [{ id: 'user-1', notification_prefs: { broadcast: false, creator_draft: false } }]);
    await PATCH(jsonRequest(URL, { token, body: { broadcast: true } }) as never);
    expect(stored()).toEqual({ broadcast: true, creator_draft: false });
  });

  it('refuses to store a key nothing reads', async () => {
    fakeDb.seed('user_profiles', [{ id: 'user-1', notification_prefs: {} }]);
    await PATCH(jsonRequest(URL, { token, body: { broadcast: false, spam: false } }) as never);
    expect(stored()).toEqual({ broadcast: false });
  });

  it('401 without a token', async () => {
    expect((await PATCH(jsonRequest(URL, { body: { all: false } }) as never)).status).toBe(401);
  });
});

// ── When the migration has not been run ──────────────────────────────────────
//
// This is what Stephen actually hit: tapping "Show me my notifications" logged
//
//   ERROR [api] unexpected error: /api/account/notification-prefs → 500
//                                 Failed to read preferences
//
// The column was not there. A bare 500 sends someone looking at the send path
// or at push credentials, and the fix is one SQL file. The route should say
// which, and a 409 rather than a 500 so the app can tell "not set up yet" from
// "broken".
describe('when the notification_prefs column is missing', () => {
  let token: string;
  beforeEach(async () => {
    fakeDb.reset();
    token = await createAccessToken('user-1', 'a@b.test');
  });

  const missingColumn = {
    data: null,
    error: { code: 'PGRST204', message: "Could not find the 'notification_prefs' column of 'user_profiles' in the schema cache" },
  };

  it('GET answers 409 and names the migration file', async () => {
    fakeDb.queue('user_profiles', missingColumn);
    const res = await GET(jsonRequest('/api/account/notification-prefs', { method: 'GET', token }) as never);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.needsMigration).toBe(true);
    expect(body.error).toContain('20260905000003_notification_prefs.sql');
  });

  it('PATCH answers 409 too, rather than looking like a failed save', async () => {
    fakeDb.queue('user_profiles', missingColumn);
    const res = await PATCH(jsonRequest('/api/account/notification-prefs', {
      method: 'PATCH', token, body: { broadcast: false },
    }) as never);
    expect(res.status).toBe(409);
    expect((await res.json()).needsMigration).toBe(true);
  });

  it('a REAL failure is still a 500, so the two stay distinguishable', async () => {
    // The whole point of the guard is telling "not migrated" from "broken". If
    // every error became a 409 the distinction would be gone in the other
    // direction.
    fakeDb.queue('user_profiles', { data: null, error: { code: '08006', message: 'connection failure' } });
    const res = await GET(jsonRequest('/api/account/notification-prefs', { method: 'GET', token }) as never);
    expect(res.status).toBe(500);
  });
});
