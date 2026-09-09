import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeDb, deleteUser } from '../helpers/supabase-mock';
import { jsonRequest } from '../helpers/request';

vi.mock('@/lib/supabase', async () =>
  (await import('../helpers/supabase-mock')).mockSupabaseModule());
vi.mock('@/lib/logger', () => ({ log: vi.fn() }));

import { DELETE } from '@/app/api/account/delete/route';
import { clearRevocationCache, createAccessToken } from '@/lib/tokens';

/**
 * A deleted account stops being a person and keeps being a data point.
 *
 * The tables behind retention and LTV all cascaded from `user_profiles`, so a
 * user who churned and then deleted took their whole history with them. A cohort
 * that was 400 people in March reads as 380 today and 350 next year, and the
 * retention curve computed over it bends upward for a reason that has nothing to
 * do with the product. The same deletion moved the saves total on the admin page
 * for a month that had already ended.
 *
 * WHAT THESE TESTS CAN AND CANNOT PROVE. They pin the ROUTE: that it stops
 * issuing the deletes, that it writes the cohort anchor first, and that personal
 * content still goes. They cannot pin the DATABASE — `app_opens` and
 * `automation_runs` were never deleted by this route at all, they were cascaded
 * away by foreign keys, and the fake has no foreign keys to cascade. Those rows
 * survive only once
 * `supabase/migrations/20260908000001_preserve_analytics_on_delete.sql` has been
 * run, and nothing in this file would notice if it had not been.
 */

const USER = 'u1';

/** The profile the tombstone is copied out of, plus the revocation read. */
function seedUser(profile: Record<string, unknown> = {}) {
  clearRevocationCache();
  fakeDb.queue('user_profiles', { data: { tokens_invalidated_at: null } });
  fakeDb.seed('user_profiles', [{
    id: USER,
    email: 'someone@example.com',
    display_name: 'Someone',
    created_at: '2026-03-04T00:00:00.000Z',
    acquisition_source: 'chefsarah',
    subscribed_at: '2026-04-01T00:00:00.000Z',
    subscription_tier: 'paid',
    stripe_customer_id: 'cus_123',
    ...profile,
  }]);
  fakeDb.seed('creators', []);
  fakeDb.seed('deleted_users', []);
}

async function del() {
  const token = await createAccessToken(USER, 'someone@example.com');
  return DELETE(jsonRequest('/api/account/delete', { method: 'DELETE', token }));
}

beforeEach(() => { fakeDb.reset(); });

describe('DELETE /api/account/delete — what survives', () => {
  it('keeps the saves and the subscription events, and still deletes the profile', async () => {
    seedUser();
    fakeDb.seed('preset_meal_saves', [
      { id: 's1', user_id: USER, preset_meal_id: 'm1', saved_at: '2026-05-01T00:00:00.000Z' },
      { id: 's2', user_id: 'someone-else', preset_meal_id: 'm1', saved_at: '2026-05-02T00:00:00.000Z' },
    ]);
    fakeDb.seed('subscription_events', [
      { id: 'e1', user_id: USER, event: 'payment_succeeded', amount_cents: 499, currency: 'usd' },
    ]);

    const res = await del();
    expect(res.status).toBe(200);

    // The point of the change: behaviour and money outlive the person.
    expect(fakeDb.rows('preset_meal_saves').map((r) => r.id).sort()).toEqual(['s1', 's2']);
    expect(fakeDb.rows('subscription_events')).toHaveLength(1);
    // And the account is genuinely gone from both places it lived.
    expect(fakeDb.rows('user_profiles')).toHaveLength(0);
    expect(deleteUser).toHaveBeenCalledWith(USER);
  });

  it('writes the cohort anchor, and nothing identifying with it', async () => {
    seedUser();
    await del();

    const [tomb] = fakeDb.rows('deleted_users');
    expect(tomb).toMatchObject({
      user_id: USER,
      signed_up_at: '2026-03-04T00:00:00.000Z',
      acquisition_source: 'chefsarah',
      subscribed_at: '2026-04-01T00:00:00.000Z',
      subscription_tier: 'paid',
    });
    expect(typeof tomb.deleted_at).toBe('string');

    // The whole reason a tombstone is acceptable at all. If any of these ever
    // appears here, this table has quietly become a copy of the user.
    for (const field of ['email', 'display_name', 'phone', 'stripe_customer_id', 'stripe_subscription_id']) {
      expect(tomb).not.toHaveProperty(field);
    }
    expect(JSON.stringify(tomb)).not.toContain('someone@example.com');
    expect(JSON.stringify(tomb)).not.toContain('cus_123');
  });

  it('still deletes the personal content', async () => {
    seedUser();
    fakeDb.seed('meals', [{ id: 'm1', user_id: USER }, { id: 'm2', user_id: 'other' }]);
    fakeDb.seed('remembered_devices', [{ id: 'd1', user_id: USER }]);
    fakeDb.seed('otp_codes', [{ id: 'o1', user_id: USER }]);
    fakeDb.seed('creator_follows', [{ id: 'f1', user_id: USER }]);
    fakeDb.seed('creator_applications', [{ id: 'a1', user_id: USER }]);

    await del();

    expect(fakeDb.rows('meals').map((r) => r.id)).toEqual(['m2']);
    expect(fakeDb.rows('remembered_devices')).toHaveLength(0);
    expect(fakeDb.rows('otp_codes')).toHaveLength(0);
    expect(fakeDb.rows('creator_follows')).toHaveLength(0);
    expect(fakeDb.rows('creator_applications')).toHaveLength(0);
  });

  it('scrubs the email log rather than keeping the address', async () => {
    seedUser();
    fakeDb.seed('email_sends', [{ id: 'x1', user_id: USER, email: 'someone@example.com', type: 'welcome' }]);

    await del();

    // Kept for aggregate reporting, detached and scrubbed. Unlike the saves, this
    // row HAS an address in it, which is why it loses its uuid as well.
    const [row] = fakeDb.rows('email_sends');
    expect(row.email).toBe('[deleted]');
    expect(row.user_id).toBeNull();
  });

  it('says which migration is missing when the profile delete is blocked', async () => {
    // The one way this fails that is not a bug in the route: the code shipped
    // before the migration. `preset_meal_saves.user_id` is NO ACTION, so it
    // blocks rather than cascades, and until the constraint is dropped every
    // deletion lands here. "Failed to delete account" is a sentence nobody can
    // act on; the log line has to name the file.
    seedUser();
    // Queues are FIFO per table and win over the seeded rows, so every
    // `user_profiles` read on the way down has to be fed before the error can
    // land on the delete itself: the token check, the revocation check, then the
    // tombstone's own read.
    fakeDb.queue('user_profiles', { data: { tokens_invalidated_at: null } });
    fakeDb.queue('user_profiles', { data: { created_at: '2026-03-04T00:00:00.000Z' } });
    fakeDb.queue('user_profiles', {
      error: { message: 'update or delete on table "user_profiles" violates foreign key constraint' },
    });

    const res = await del();

    expect(res.status).toBe(500);
    const { log } = await import('@/lib/logger');
    const blamed = (log as unknown as { mock: { calls: Array<[Record<string, unknown>]> } }).mock.calls
      .map(([arg]) => String(arg.detail ?? ''))
      .find((d) => d.includes('foreign key'));
    expect(blamed).toContain('20260908000001_preserve_analytics_on_delete.sql');
  });

  it('deletes the account even when the tombstone cannot be written', async () => {
    // The ordering that is not close: deletion is the obligation, the analytics
    // are the convenience. A tombstone failure must never leave someone unable to
    // delete their account.
    seedUser();
    fakeDb.queue('deleted_users', { error: { message: 'relation does not exist' } });

    const res = await del();

    expect(res.status).toBe(200);
    expect(fakeDb.rows('user_profiles')).toHaveLength(0);
    expect(deleteUser).toHaveBeenCalledWith(USER);
  });
});
