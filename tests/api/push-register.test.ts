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

  it('upserts on the token so a relaunch refreshes the row instead of adding one', async () => {
    const token = await createAccessToken('user-1', 'a@b.test');
    const res = await POST(jsonRequest('/api/push/register', {
      token,
      body: { token: TOKEN_A, platform: 'ios', deviceName: "Steve's iPhone" },
    }));

    expect(res.status).toBe(200);
    const upsert = call('push_tokens', 'upsert')!;
    expect(upsert.args[0]).toMatchObject({
      user_id: 'user-1',
      token: TOKEN_A,
      platform: 'ios',
      device_name: "Steve's iPhone",
      revoked_at: null,
    });
    expect(upsert.args[1]).toEqual({ onConflict: 'token' });
  });

  it('un-revokes on re-register, so a reinstalled device starts receiving again', async () => {
    const token = await createAccessToken('user-1', 'a@b.test');
    await POST(jsonRequest('/api/push/register', { token, body: { token: TOKEN_A } }));
    expect(call('push_tokens', 'upsert')!.args[0].revoked_at).toBeNull();
  });

  it('revokes the previous token on rotation rather than leaving two live rows', async () => {
    const token = await createAccessToken('user-1', 'a@b.test');
    const res = await POST(jsonRequest('/api/push/register', {
      token,
      body: { token: TOKEN_B, previousToken: TOKEN_A },
    }));

    expect(res.status).toBe(200);
    const update = call('push_tokens', 'update')!;
    expect(update.args[0]).toHaveProperty('revoked_at');
    const eqs = fakeDb.calls.filter((c) => c.table === 'push_tokens' && c.method === 'eq').map((c) => c.args);
    // Scoped to the caller — a token string alone must not retire someone else's device.
    expect(eqs).toEqual([['token', TOKEN_A], ['user_id', 'user-1']]);
  });

  it('does not revoke when the token has not actually changed', async () => {
    const token = await createAccessToken('user-1', 'a@b.test');
    await POST(jsonRequest('/api/push/register', { token, body: { token: TOKEN_A, previousToken: TOKEN_A } }));
    expect(call('push_tokens', 'update')).toBeUndefined();
  });

  it('500s when the upsert fails, so the app knows to retry', async () => {
    const token = await createAccessToken('user-1', 'a@b.test');
    fakeDb.queue('push_tokens', { error: { message: 'unique violation' } });
    const res = await POST(jsonRequest('/api/push/register', { token, body: { token: TOKEN_A } }));
    expect(res.status).toBe(500);
  });

  it('still succeeds when only the rotation cleanup fails — the new token is already live', async () => {
    const token = await createAccessToken('user-1', 'a@b.test');
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
