import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeDb } from '../helpers/supabase-mock';
import { jsonRequest } from '../helpers/request';

// vi.mock is hoisted above imports, so the factory must import the helper
// dynamically rather than close over the static import.
vi.mock('@/lib/supabase', async () =>
  (await import('../helpers/supabase-mock')).mockSupabaseModule());
const log = vi.fn();
vi.mock('@/lib/logger', () => ({ log: (...args: unknown[]) => log(...args) }));
vi.mock('@/lib/email', () => ({
  sendCreatorApprovedEmail: vi.fn(async () => {}),
  sendCreatorRejectedEmail: vi.fn(async () => {}),
}));

import { PATCH } from '@/app/api/admin/applications/route';
import { sendCreatorApprovedEmail, sendCreatorRejectedEmail } from '@/lib/email';
import { clearRevocationCache, createAccessToken } from '@/lib/tokens';

const APPLICATION = {
  user_id: 'user-1',
  display_name: 'Chef Sarah',
  photo_url: 'https://cdn.test/photo.jpg',
  handle: 'chefsarah',
  website_url: 'https://chefsarah.test/',
  youtube_url: null,
  instagram_url: 'https://instagram.com/chefsarah',
  tiktok_url: null,
  user_profiles: { email: 'sarah@test.co' },
};

describe('/api/admin/applications — approval carries the platform links', () => {
  let token: string;

  beforeEach(async () => {
    fakeDb.reset();
    log.mockClear();
    vi.mocked(sendCreatorApprovedEmail).mockReset().mockResolvedValue(undefined);
    vi.mocked(sendCreatorRejectedEmail).mockReset().mockResolvedValue(undefined);
    token = await createAccessToken('admin-1', 'admin@mealio.co');
    // Two `user_profiles` reads per admin request: the token revocation check
    // (memoised for 30s, hence the cache clear) and `is_admin`.
    clearRevocationCache();
    fakeDb.queue('user_profiles', { data: { tokens_invalidated_at: null } });
    fakeDb.queue('user_profiles', { data: { is_admin: true } });
    fakeDb.queue('creator_applications', { data: APPLICATION });
  });

  it('copies all four links onto the creator row', async () => {
    const res = await PATCH(jsonRequest('/api/admin/applications', {
      method: 'PATCH', token, body: { id: 'app-1', action: 'approve' },
    }));

    expect(res.status).toBe(200);
    const insert = fakeDb.calls.find((c) => c.table === 'creators' && c.method === 'insert')?.args[0];
    expect(insert).toMatchObject({
      website_url: 'https://chefsarah.test/',
      youtube_url: null,
      instagram_url: 'https://instagram.com/chefsarah',
      tiktok_url: null,
    });
  });

  it('does not start polling anyone', async () => {
    // Approval collects links; choosing which one to poll is a separate,
    // deliberate decision made after a viability check. The schema defaults
    // (`none` / false) must survive the insert untouched.
    await PATCH(jsonRequest('/api/admin/applications', {
      method: 'PATCH', token, body: { id: 'app-1', action: 'approve' },
    }));

    const insert = fakeDb.calls.find((c) => c.table === 'creators' && c.method === 'insert')?.args[0] as Record<string, unknown>;
    expect(insert).not.toHaveProperty('primary_source');
    expect(insert).not.toHaveProperty('import_opt_in');
    expect(insert).not.toHaveProperty('feed_url');
  });

  /**
   * The decision is already written when the email goes out.
   *
   * Resend reports a refusal in `{ error }` rather than by throwing, so
   * `lib/email.ts` throws on it — which means this route now sees failures it
   * never used to. It must not start failing requests over them: the applicant
   * is approved or rejected either way, and there is no re-run for an operator
   * to reach. What it must not do is what it used to do with `.catch(() => {})`
   * — treat an applicant who was never told as one who was.
   */
  describe('when the email is refused', () => {
    it('keeps the approval and logs it, rather than failing the request', async () => {
      vi.mocked(sendCreatorApprovedEmail).mockRejectedValueOnce(
        new Error('Resend refused the creator approved email: Suppressed recipient.'));

      const res = await PATCH(jsonRequest('/api/admin/applications', {
        method: 'PATCH', token, body: { id: 'app-1', action: 'approve' },
      }));

      // The creator row and the comped tier are already written.
      expect(res.status).toBe(200);
      expect(fakeDb.calls.some((c) => c.table === 'creators' && c.method === 'insert')).toBe(true);

      const logged = log.mock.calls.map(([entry]) => entry);
      expect(logged).toContainEqual(expect.objectContaining({
        event: 'ADMIN:APPLICATION_EMAIL', status: 'error', email: 'sarah@test.co',
      }));
    });

    it('does the same for a rejection', async () => {
      vi.mocked(sendCreatorRejectedEmail).mockRejectedValueOnce(
        new Error('Resend refused the creator declined email: Suppressed recipient.'));

      const res = await PATCH(jsonRequest('/api/admin/applications', {
        method: 'PATCH', token, body: { id: 'app-1', action: 'reject' },
      }));

      expect(res.status).toBe(200);
      expect(log.mock.calls.map(([entry]) => entry)).toContainEqual(expect.objectContaining({
        event: 'ADMIN:APPLICATION_EMAIL', status: 'error', detail: 'action=reject',
      }));
    });
  });
});
