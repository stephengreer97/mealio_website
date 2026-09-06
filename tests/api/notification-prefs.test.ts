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
    fakeDb.seed('user_profiles', [{ id: 'user-1', notification_prefs: { broadcast: false } }]);
    fakeDb.seed('creators', []);
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
    fakeDb.seed('user_profiles', [{ id: 'user-1', notification_prefs: {} }]);
    fakeDb.seed('creators', []);
    const json = await (await GET(jsonRequest(URL, { token }) as never)).json();
    expect(json.categories.map((c: { id: string }) => c.id)).not.toContain('creator_draft');
  });

  it('offers it to a creator', async () => {
    fakeDb.seed('user_profiles', [{ id: 'user-1', notification_prefs: {} }]);
    // A ROW IN `creators`, which is what makes someone a creator. There is no
    // `user_profiles.is_creator` and there never was; this test used to seed one
    // and the fake happily returned it, which is how the bug shipped.
    fakeDb.seed('creators', [{ id: 'c1', user_id: 'user-1' }]);
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

// ── The bug this file did not catch, and why ────────────────────────────────
//
// Stephen, on an iPhone with the migration already run: "Could not load your
// settings." The GET selected `notification_prefs, is_creator`, and
// `user_profiles.is_creator` DOES NOT EXIST. This route was the only place in
// either repository that named it; every other caller asks the `creators` table
// keyed on `user_id`.
//
// The suite passed anyway because it SEEDED the phantom column. The fake stores
// whatever you hand it, so a test that invents a column proves the code can read
// a column it invented. [[supabase-mock-diverges-from-postgrest]]: right where
// it has been exercised, silently wrong where it has not.
//
// Two tests below, and neither can be satisfied by seeding harder. One asserts
// against the columns the route ASKS FOR, and one drives the creator case from
// the table that actually decides it.
describe('the columns this route depends on', () => {
  let token: string;
  beforeEach(async () => {
    fakeDb.reset();
    token = await createAccessToken('user-1', 'a@b.test');
  });

  it('asks user_profiles for nothing but notification_prefs', async () => {
    // The fake records every select. Asserting on the REQUEST rather than the
    // response is what makes this immune to the seeding problem: a column that
    // does not exist cannot be smuggled in by a fixture.
    fakeDb.seed('user_profiles', [{ id: 'user-1', notification_prefs: {} }]);
    fakeDb.seed('creators', []);
    await GET(jsonRequest('/api/account/notification-prefs', { method: 'GET', token }) as never);

    const selects = (fakeDb.calls as Array<{ table: string; method: string; args: unknown[] }>)
      .filter((c) => c.table === 'user_profiles' && c.method === 'select')
      .map((c) => String(c.args[0]));
    expect(selects.length).toBeGreaterThan(0);
    expect(selects.join(' ')).not.toContain('is_creator');
  });

  it('decides creator from a `creators` row, not from a profile flag', async () => {
    fakeDb.seed('user_profiles', [{ id: 'user-1', notification_prefs: {} }]);
    fakeDb.seed('creators', [{ id: 'c1', user_id: 'user-1' }]);
    const body = await (await GET(jsonRequest('/api/account/notification-prefs', { method: 'GET', token }) as never)).json();
    expect(body.categories.map((c: { id: string }) => c.id)).toContain('creator_draft');
  });

  it('still answers when the creators lookup fails, rather than losing the screen', async () => {
    // Failing open on purpose. Not knowing whether someone is a creator should
    // cost them one switch they may not need, not the whole settings screen.
    fakeDb.seed('user_profiles', [{ id: 'user-1', notification_prefs: {} }]);
    fakeDb.queue('creators', { data: null, error: { code: '08006', message: 'connection failure' } });
    const res = await GET(jsonRequest('/api/account/notification-prefs', { method: 'GET', token }) as never);
    expect(res.status).toBe(200);
    expect((await res.json()).categories.length).toBeGreaterThan(0);
  });
});

// The guard that hid it. It claimed the MEAL-217 migration for ANY missing
// column, so a route asking for a column no migration would ever add told
// Stephen to run one he had already run. A diagnostic that can only say one
// thing will say it when it is false.
describe('the migration hint is about ITS OWN column', () => {
  let token: string;
  beforeEach(async () => {
    fakeDb.reset();
    token = await createAccessToken('user-1', 'a@b.test');
  });

  it('claims the migration only when notification_prefs is the missing one', async () => {
    fakeDb.queue('user_profiles', {
      data: null,
      error: { code: 'PGRST204', message: "Could not find the 'notification_prefs' column of 'user_profiles' in the schema cache" },
    });
    expect((await GET(jsonRequest('/api/account/notification-prefs', { method: 'GET', token }) as never)).status).toBe(409);
  });

  it('does NOT claim it for a different missing column', async () => {
    fakeDb.queue('user_profiles', {
      data: null,
      error: { code: 'PGRST204', message: "Could not find the 'is_creator' column of 'user_profiles' in the schema cache" },
    });
    const res = await GET(jsonRequest('/api/account/notification-prefs', { method: 'GET', token }) as never);
    expect(res.status).toBe(500);
  });
});
