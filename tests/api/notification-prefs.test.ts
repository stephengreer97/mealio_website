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
