import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeDb } from '../helpers/supabase-mock';
import { jsonRequest } from '../helpers/request';

vi.mock('@/lib/supabase', async () =>
  (await import('../helpers/supabase-mock')).mockSupabaseModule());
vi.mock('@/lib/logger', () => ({ log: vi.fn() }));

import { POST, DELETE } from '@/app/api/push/register/route';
import { createAccessToken, clearRevocationCache } from '@/lib/tokens';

const TOKEN_A = 'ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]';
const TOKEN_B = 'ExponentPushToken[bbbbbbbbbbbbbbbbbbbbbb]';

function call(table: string, method: string) {
  return fakeDb.calls.find((c) => c.table === table && c.method === method);
}

describe('POST /api/push/register', () => {
  beforeEach(() => { fakeDb.reset(); clearRevocationCache(); });

  it('401 without a bearer token', async () => {
    const res = await POST(jsonRequest('/api/push/register', { body: { token: TOKEN_A } }));
    expect(res.status).toBe(401);
  });

  it('400 for anything that is not an Expo push token', async () => {
    const token = await createAccessToken('user-1', 'a@b.test');
    const res = await POST(jsonRequest('/api/push/register', { token, body: { token: 'fcm-token-from-somewhere' } }));
    expect(res.status).toBe(400);
    expect(call('push_tokens', 'upsert')).toBeUndefined();
  });

  it('upserts per account and device so a relaunch refreshes the row instead of adding one', async () => {
    const token = await createAccessToken('user-1', 'a@b.test');
    fakeDb.seed('push_tokens', []);

    const res = await POST(jsonRequest('/api/push/register', {
      token,
      body: { token: TOKEN_A, platform: 'ios', deviceName: "Steve's iPhone" },
    }));
    await POST(jsonRequest('/api/push/register', { token, body: { token: TOKEN_A, platform: 'ios' } }));

    expect(res.status).toBe(200);
    expect(fakeDb.rows('push_tokens')).toHaveLength(1);
    expect(fakeDb.rows('push_tokens')[0]).toMatchObject({
      user_id: 'user-1',
      token: TOKEN_A,
      platform: 'ios',
      revoked_at: null,
    });
    expect(call('push_tokens', 'upsert')!.args[1]).toEqual({ onConflict: 'user_id,token' });
  });

  it('un-revokes on re-register, so a reinstalled device starts receiving again', async () => {
    const token = await createAccessToken('user-1', 'a@b.test');
    fakeDb.seed('push_tokens', [{ user_id: 'user-1', token: TOKEN_A, revoked_at: '2026-07-01T00:00:00.000Z' }]);

    await POST(jsonRequest('/api/push/register', { token, body: { token: TOKEN_A } }));

    expect(fakeDb.rows('push_tokens')).toHaveLength(1);
    expect(fakeDb.rows('push_tokens')[0].revoked_at).toBeNull();
  });

  it('hands a shared device over by retiring the other account, not by rewriting its row', async () => {
    // user-2 signed out of this handset and user-1 signed in — or user-1 found
    // user-2's token in a crash report. The server cannot tell those apart, so
    // what it must not do is silently move user_id and leave no trace: both
    // halves of the handover have to be on the record, and user-2's next launch
    // has to be able to take the device back.
    const token = await createAccessToken('user-1', 'a@b.test');
    fakeDb.seed('push_tokens', [
      { user_id: 'user-2', token: TOKEN_A, revoked_at: null, last_seen_at: '2026-07-01T00:00:00.000Z' },
    ]);

    const res = await POST(jsonRequest('/api/push/register', { token, body: { token: TOKEN_A } }));

    expect(res.status).toBe(200);
    const rows = fakeDb.rows('push_tokens');
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.user_id === 'user-2')!.revoked_at).toEqual(expect.any(String));
    expect(rows.find((r) => r.user_id === 'user-1')!.revoked_at).toBeNull();
  });

  it('does not retire the caller’s own row on the way in', async () => {
    const token = await createAccessToken('user-1', 'a@b.test');
    fakeDb.seed('push_tokens', [
      { user_id: 'user-1', token: TOKEN_A, revoked_at: null, last_seen_at: '2026-07-01T00:00:00.000Z' },
      { user_id: 'user-2', token: TOKEN_B, revoked_at: null, last_seen_at: '2026-07-01T00:00:00.000Z' },
    ]);

    await POST(jsonRequest('/api/push/register', { token, body: { token: TOKEN_A } }));

    // Own row refreshed; an unrelated account's unrelated device untouched.
    expect(fakeDb.rows('push_tokens')[0].revoked_at).toBeNull();
    expect(fakeDb.rows('push_tokens')[1].revoked_at).toBeNull();
  });

  it('500s rather than enrolling on top of a claim it could not retire', async () => {
    // Two live rows on one handset means both accounts get the other's push.
    const token = await createAccessToken('user-1', 'a@b.test');
    fakeDb.queue('push_tokens', { error: { message: 'timeout' } });   // displace
    const res = await POST(jsonRequest('/api/push/register', { token, body: { token: TOKEN_A } }));
    expect(res.status).toBe(500);
    expect(call('push_tokens', 'upsert')).toBeUndefined();
  });

  it('revokes the previous token on rotation rather than leaving two live rows', async () => {
    const token = await createAccessToken('user-1', 'a@b.test');
    fakeDb.seed('push_tokens', [
      { user_id: 'user-1', token: TOKEN_A, revoked_at: null, last_seen_at: '2026-07-01T00:00:00.000Z' },
    ]);

    const res = await POST(jsonRequest('/api/push/register', {
      token,
      body: { token: TOKEN_B, previousToken: TOKEN_A },
    }));

    expect(res.status).toBe(200);
    const rows = fakeDb.rows('push_tokens');
    expect(rows.find((r) => r.token === TOKEN_A)!.revoked_at).toEqual(expect.any(String));
    expect(rows.find((r) => r.token === TOKEN_B)!.revoked_at).toBeNull();
  });

  it('scopes the rotation cleanup to the caller — a token string alone must not retire someone else’s device', async () => {
    const token = await createAccessToken('user-1', 'a@b.test');
    fakeDb.seed('push_tokens', [
      { user_id: 'user-2', token: TOKEN_A, revoked_at: null, last_seen_at: '2026-07-01T00:00:00.000Z' },
    ]);

    await POST(jsonRequest('/api/push/register', { token, body: { token: TOKEN_B, previousToken: TOKEN_A } }));

    expect(fakeDb.rows('push_tokens').find((r) => r.user_id === 'user-2')!.revoked_at).toBeNull();
  });

  it('does not revoke when the token has not actually changed', async () => {
    const token = await createAccessToken('user-1', 'a@b.test');
    fakeDb.seed('push_tokens', [
      { user_id: 'user-1', token: TOKEN_A, revoked_at: null, last_seen_at: '2026-07-01T00:00:00.000Z' },
    ]);

    await POST(jsonRequest('/api/push/register', { token, body: { token: TOKEN_A, previousToken: TOKEN_A } }));

    expect(fakeDb.rows('push_tokens')).toHaveLength(1);
    expect(fakeDb.rows('push_tokens')[0].revoked_at).toBeNull();
  });

  it('500s when the upsert fails, so the app knows to retry', async () => {
    const token = await createAccessToken('user-1', 'a@b.test');
    fakeDb.queue('push_tokens', { error: null });                      // displace
    fakeDb.queue('push_tokens', { error: { message: 'unique violation' } });
    const res = await POST(jsonRequest('/api/push/register', { token, body: { token: TOKEN_A } }));
    expect(res.status).toBe(500);
  });

  it('still succeeds when only the rotation cleanup fails — the new token is already live', async () => {
    const token = await createAccessToken('user-1', 'a@b.test');
    fakeDb.queue('push_tokens', { error: null });                      // displace
    fakeDb.queue('push_tokens', { error: null });                      // upsert
    fakeDb.queue('push_tokens', { error: { message: 'timeout' } });    // revoke previous
    const res = await POST(jsonRequest('/api/push/register', {
      token,
      body: { token: TOKEN_B, previousToken: TOKEN_A },
    }));
    expect(res.status).toBe(200);
  });
});

describe('DELETE /api/push/register', () => {
  beforeEach(() => { fakeDb.reset(); clearRevocationCache(); });

  it('401 without a bearer token', async () => {
    const res = await DELETE(jsonRequest('/api/push/register', { method: 'DELETE', body: { token: TOKEN_A } }));
    expect(res.status).toBe(401);
  });

  it('400 without a token', async () => {
    const token = await createAccessToken('user-1', 'a@b.test');
    const res = await DELETE(jsonRequest('/api/push/register', { method: 'DELETE', token, body: {} }));
    expect(res.status).toBe(400);
  });

  it('revokes this user’s device immediately, without waiting for a receipt', async () => {
    const token = await createAccessToken('user-1', 'a@b.test');
    const res = await DELETE(jsonRequest('/api/push/register', { method: 'DELETE', token, body: { token: TOKEN_A } }));

    expect(res.status).toBe(200);
    expect(call('push_tokens', 'update')!.args[0]).toHaveProperty('revoked_at');
    const eqs = fakeDb.calls.filter((c) => c.table === 'push_tokens' && c.method === 'eq').map((c) => c.args);
    expect(eqs).toEqual([['token', TOKEN_A], ['user_id', 'user-1']]);
  });
});
