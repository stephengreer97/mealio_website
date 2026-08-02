import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Expo, type ExpoPushMessage, type ExpoPushReceipt, type ExpoPushTicket } from 'expo-server-sdk';
import { fakeDb } from '../helpers/supabase-mock';

vi.mock('@/lib/supabase', async () =>
  (await import('../helpers/supabase-mock')).mockSupabaseModule());
vi.mock('@/lib/logger', () => ({ log: vi.fn() }));

import { sendPushToUsers, checkPushReceipts, type PushClient } from '@/lib/push';

const REAL = new Expo();

function pushToken(n: number): string {
  return `ExponentPushToken[device-${n}]`;
}

/**
 * Real chunking, stubbed transport. Chunk sizes are part of what we're testing,
 * so those two methods delegate to the SDK; nothing reaches exp.host.
 */
function stubClient(stubs: {
  send?: (messages: ExpoPushMessage[]) => Promise<ExpoPushTicket[]>;
  receipts?: (ids: string[]) => Promise<Record<string, ExpoPushReceipt>>;
}) {
  const send = vi.fn(stubs.send ?? (async (m: ExpoPushMessage[]) =>
    m.map((_, i) => ({ status: 'ok', id: `ticket-${i}` } as ExpoPushTicket))));
  const receipts = vi.fn(stubs.receipts ?? (async () => ({})));
  const client: PushClient = {
    chunkPushNotifications: (m) => REAL.chunkPushNotifications(m),
    chunkPushNotificationReceiptIds: (ids) => REAL.chunkPushNotificationReceiptIds(ids),
    sendPushNotificationsAsync: send,
    getPushNotificationReceiptsAsync: receipts,
  };
  return { client, send, receipts };
}

/** The update() call the revoke path makes, if it made one. */
function revokeCall(table: string) {
  return fakeDb.calls.find((c) => c.table === table && c.method === 'update');
}

describe('sendPushToUsers', () => {
  beforeEach(() => { fakeDb.reset(); });

  it('sends nothing when the user has no device row — a non-opted-in user is not a fallback', async () => {
    const { client, send } = stubClient({});
    fakeDb.queue('push_tokens', { data: [] });

    const result = await sendPushToUsers(['user-1'], { title: 'Hi', body: 'There' }, { client });

    expect(send).not.toHaveBeenCalled();
    expect(result).toEqual({ devices: 0, accepted: 0, revoked: 0, failed: 0 });
  });

  it('sends nothing when there are no user ids at all', async () => {
    const { client, send } = stubClient({});
    const result = await sendPushToUsers([], { title: 'Hi', body: 'There' }, { client });
    expect(send).not.toHaveBeenCalled();
    expect(result.devices).toBe(0);
  });

  it('only queries unrevoked rows, so a pruned device is never targeted', async () => {
    const { client } = stubClient({});
    fakeDb.queue('push_tokens', { data: [{ token: pushToken(1) }] });
    fakeDb.queue('push_receipts', { error: null });

    await sendPushToUsers(['user-1'], { title: 'Hi', body: 'There' }, { client });

    const isCall = fakeDb.calls.find((c) => c.table === 'push_tokens' && c.method === 'is');
    expect(isCall?.args).toEqual(['revoked_at', null]);
  });

  it('sends one message per device and carries title, body and the routing data bag', async () => {
    const { client, send } = stubClient({});
    fakeDb.queue('push_tokens', { data: [{ token: pushToken(1) }, { token: pushToken(2) }] });
    fakeDb.queue('push_receipts', { error: null });

    const result = await sendPushToUsers(
      ['user-1'],
      { title: 'Draft ready', body: 'One recipe is waiting', data: { type: 'creator_draft', draftId: 'd1' } },
      { client },
    );

    const messages = send.mock.calls[0][0];
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      to: pushToken(1),
      title: 'Draft ready',
      body: 'One recipe is waiting',
      data: { type: 'creator_draft', draftId: 'd1' },
    });
    expect(result.accepted).toBe(2);
  });

  it('chunks at the SDK limit instead of posting one giant request', async () => {
    const { client, send } = stubClient({});
    const tokens = Array.from({ length: 150 }, (_, i) => ({ token: pushToken(i) }));
    fakeDb.queue('push_tokens', { data: tokens });
    fakeDb.queue('push_receipts', { error: null });

    const result = await sendPushToUsers(['user-1'], { title: 'Hi', body: 'There' }, { client });

    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0][0]).toHaveLength(100);
    expect(send.mock.calls[1][0]).toHaveLength(50);
    expect(result.accepted).toBe(150);
  });

  it('keeps going when one chunk throws — a transient Expo failure costs that chunk only', async () => {
    let call = 0;
    const { client, send } = stubClient({
      send: async (m) => {
        if (call++ === 0) throw new Error('502 from exp.host');
        return m.map((_, i) => ({ status: 'ok', id: `t${i}` } as ExpoPushTicket));
      },
    });
    fakeDb.queue('push_tokens', { data: Array.from({ length: 150 }, (_, i) => ({ token: pushToken(i) })) });
    fakeDb.queue('push_receipts', { error: null });

    const result = await sendPushToUsers(['user-1'], { title: 'Hi', body: 'There' }, { client });

    expect(send).toHaveBeenCalledTimes(2);
    expect(result.failed).toBe(100);
    expect(result.accepted).toBe(50);
  });

  it('queues a receipt row per accepted ticket, keyed back to the device it went to', async () => {
    const { client } = stubClient({
      send: async () => [
        { status: 'ok', id: 'ticket-a' },
        { status: 'ok', id: 'ticket-b' },
      ],
    });
    fakeDb.queue('push_tokens', { data: [{ token: pushToken(1) }, { token: pushToken(2) }] });
    fakeDb.queue('push_receipts', { error: null });

    await sendPushToUsers(['user-1'], { title: 'Hi', body: 'There' }, { client });

    const insert = fakeDb.calls.find((c) => c.table === 'push_receipts' && c.method === 'insert');
    expect(insert?.args[0]).toEqual([
      { ticket_id: 'ticket-a', token: pushToken(1) },
      { ticket_id: 'ticket-b', token: pushToken(2) },
    ]);
  });

  it('revokes immediately on a DeviceNotRegistered ticket', async () => {
    const { client } = stubClient({
      send: async () => [
        { status: 'ok', id: 'ticket-a' },
        { status: 'error', message: 'not registered', details: { error: 'DeviceNotRegistered' } },
      ],
    });
    fakeDb.queue('push_tokens', { data: [{ token: pushToken(1) }, { token: pushToken(2) }] });
    fakeDb.queue('push_receipts', { error: null });
    fakeDb.queue('push_tokens', { error: null });

    const result = await sendPushToUsers(['user-1'], { title: 'Hi', body: 'There' }, { client });

    expect(result.revoked).toBe(1);
    const inCall = fakeDb.calls.find((c) => c.table === 'push_tokens' && c.method === 'in' && c.args[0] === 'token');
    expect(inCall?.args[1]).toEqual([pushToken(2)]);
    expect(revokeCall('push_tokens')?.args[0]).toHaveProperty('revoked_at');
  });

  it('does NOT revoke on our own misconfiguration (InvalidCredentials), only on dead devices', async () => {
    const { client } = stubClient({
      send: async () => [
        { status: 'error', message: 'bad credentials', details: { error: 'InvalidCredentials' } },
      ],
    });
    fakeDb.queue('push_tokens', { data: [{ token: pushToken(1) }] });

    const result = await sendPushToUsers(['user-1'], { title: 'Hi', body: 'There' }, { client });

    expect(result.failed).toBe(1);
    expect(result.revoked).toBe(0);
    expect(revokeCall('push_tokens')).toBeUndefined();
  });

  it('drops a malformed token rather than letting it reject the whole chunk', async () => {
    const { client, send } = stubClient({});
    fakeDb.queue('push_tokens', { data: [{ token: 'not-a-push-token' }, { token: pushToken(1) }] });
    fakeDb.queue('push_receipts', { error: null });

    const result = await sendPushToUsers(['user-1'], { title: 'Hi', body: 'There' }, { client });

    expect(result.devices).toBe(1);
    expect(send.mock.calls[0][0]).toHaveLength(1);
  });

  it('gives up quietly when the token lookup itself fails', async () => {
    const { client, send } = stubClient({});
    fakeDb.queue('push_tokens', { error: { message: 'connection reset' } });

    const result = await sendPushToUsers(['user-1'], { title: 'Hi', body: 'There' }, { client });

    expect(send).not.toHaveBeenCalled();
    expect(result).toEqual({ devices: 0, accepted: 0, revoked: 0, failed: 0 });
  });
});

describe('checkPushReceipts', () => {
  beforeEach(() => { fakeDb.reset(); });

  it('does nothing when nothing has settled yet', async () => {
    const { client, receipts } = stubClient({});
    fakeDb.queue('push_receipts', { data: [] });

    const result = await checkPushReceipts({ client });

    expect(receipts).not.toHaveBeenCalled();
    expect(result).toEqual({ checked: 0, revoked: 0 });
  });

  it('only reads tickets older than the settle delay — a receipt asked for too early comes back empty', async () => {
    const { client } = stubClient({});
    fakeDb.queue('push_receipts', { data: [] });
    const now = new Date('2026-08-02T12:00:00.000Z');

    await checkPushReceipts({ client, now });

    const lt = fakeDb.calls.find((c) => c.table === 'push_receipts' && c.method === 'lt');
    expect(lt?.args).toEqual(['created_at', '2026-08-02T11:45:00.000Z']);
  });

  it('revokes the token behind a DeviceNotRegistered receipt and leaves the delivered one alone', async () => {
    const { client } = stubClient({
      receipts: async () => ({
        'ticket-a': { status: 'ok' },
        'ticket-b': { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } },
      }),
    });
    fakeDb.queue('push_receipts', {
      data: [
        { ticket_id: 'ticket-a', token: pushToken(1) },
        { ticket_id: 'ticket-b', token: pushToken(2) },
      ],
    });
    fakeDb.queue('push_tokens', { error: null });
    fakeDb.queue('push_receipts', { error: null });

    const result = await checkPushReceipts({ client });

    expect(result).toEqual({ checked: 2, revoked: 1 });
    const inCall = fakeDb.calls.find((c) => c.table === 'push_tokens' && c.method === 'in');
    expect(inCall?.args[1]).toEqual([pushToken(2)]);
  });

  it('dequeues every ticket it asked about, including ones Expo no longer knows', async () => {
    // 'ticket-b' is absent from the response — an expired receipt. If it stayed
    // queued the sweep would retry it every day forever.
    const { client } = stubClient({ receipts: async () => ({ 'ticket-a': { status: 'ok' } }) });
    fakeDb.queue('push_receipts', {
      data: [
        { ticket_id: 'ticket-a', token: pushToken(1) },
        { ticket_id: 'ticket-b', token: pushToken(2) },
      ],
    });
    fakeDb.queue('push_receipts', { error: null });

    const result = await checkPushReceipts({ client });

    expect(result.checked).toBe(2);
    const del = fakeDb.calls.find((c) => c.table === 'push_receipts' && c.method === 'delete');
    expect(del).toBeDefined();
    const inCall = fakeDb.calls.find((c) => c.table === 'push_receipts' && c.method === 'in');
    expect(inCall?.args[1]).toEqual(['ticket-a', 'ticket-b']);
  });

  it('leaves a chunk queued when the receipt fetch itself fails', async () => {
    const { client } = stubClient({ receipts: async () => { throw new Error('timeout'); } });
    fakeDb.queue('push_receipts', { data: [{ ticket_id: 'ticket-a', token: pushToken(1) }] });

    const result = await checkPushReceipts({ client });

    expect(result.checked).toBe(0);
    expect(fakeDb.calls.find((c) => c.table === 'push_receipts' && c.method === 'delete')).toBeUndefined();
  });

  it('chunks receipt ids at the SDK limit', async () => {
    const { client, receipts } = stubClient({});
    fakeDb.queue('push_receipts', {
      data: Array.from({ length: 700 }, (_, i) => ({ ticket_id: `t${i}`, token: pushToken(i) })),
    });
    fakeDb.queue('push_receipts', { error: null });

    await checkPushReceipts({ client });

    expect(receipts).toHaveBeenCalledTimes(3);
    expect(receipts.mock.calls[0][0]).toHaveLength(300);
    expect(receipts.mock.calls[2][0]).toHaveLength(100);
  });
});
