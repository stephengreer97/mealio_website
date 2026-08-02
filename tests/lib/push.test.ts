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

/** A ticket id shaped like the uuid Expo actually returns — length matters. */
function ticketId(n: number): string {
  return `0b1a5e00-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

/** Live device rows for `user-1`, as they exist after a register. */
function deviceRows(count: number, over: Record<string, unknown> = {}) {
  return Array.from({ length: count }, (_, i) => ({
    user_id: 'user-1',
    token: pushToken(i),
    last_seen_at: '2026-08-01T00:00:00.000Z',
    revoked_at: null,
    ...over,
  }));
}

/** Queued receipts from a single send: one created_at, many devices. */
function receiptRows(count: number, sentAt: string) {
  return Array.from({ length: count }, (_, i) => ({
    ticket_id: ticketId(i),
    token: pushToken(i),
    created_at: sentAt,
  }));
}

const ok = (ids: string[]) => Object.fromEntries(ids.map((id) => [id, { status: 'ok' }])) as any;
const gone = (ids: string[]) => Object.fromEntries(
  ids.map((id) => [id, { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } }]),
) as any;

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
    fakeDb.seed('push_tokens', deviceRows(2));

    const result = await sendPushToUsers(['user-1'], { title: 'Hi', body: 'There' }, { client });

    // The effect, not the call: row 1 still live, row 2 carries a timestamp.
    expect(result.revoked).toBe(1);
    expect(fakeDb.rows('push_tokens')[0].revoked_at).toBeNull();
    expect(fakeDb.rows('push_tokens')[1].revoked_at).toEqual(expect.any(String));
    expect(revokeCall('push_tokens')?.args[0]).toHaveProperty('revoked_at');
  });

  it('reports the rows it actually revoked, not the tokens it was handed', async () => {
    // Both devices come back DeviceNotRegistered, but one was already retired
    // between the select and the revoke — by DELETE /api/push/register, or by a
    // send running concurrently with this one. The update matches one row.
    // Counting the input instead would make pushTokensPruned report work that
    // did not happen, which is the only number an operator has for "is the
    // prune state machine working".
    const { client } = stubClient({
      send: async (m) => {
        fakeDb.rows('push_tokens')[1].revoked_at = '2026-08-01T12:00:00.000Z';
        return m.map(() => ({
          status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' },
        } as ExpoPushTicket));
      },
    });
    fakeDb.seed('push_tokens', deviceRows(2));

    const result = await sendPushToUsers(['user-1'], { title: 'Hi', body: 'There' }, { client });

    expect(result.devices).toBe(2);
    expect(result.revoked).toBe(1);
  });

  it('chunks a mass revoke so it does not 414, and still counts every row', async () => {
    // 400 tokens in one .in() is a ~19 KB PATCH URL; the proxy in front of
    // PostgREST rejects it and the whole prune silently reports zero.
    const { client } = stubClient({
      send: async (m) => m.map(() => ({
        status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' },
      } as ExpoPushTicket)),
    });
    fakeDb.seed('push_tokens', deviceRows(400));

    const result = await sendPushToUsers(['user-1'], { title: 'Hi', body: 'There' }, { client });

    expect(result.revoked).toBe(400);
    expect(fakeDb.rows('push_tokens').every((r) => r.revoked_at !== null)).toBe(true);
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
  // These run against seeded tables rather than queued results, because every
  // bug this sweep has had was about what the queries DID — how many rows an
  // update matched, whether a delete's URL was short enough to send — and none
  // of that is visible in the shape of a call.
  const NOW = new Date('2026-08-02T12:00:00.000Z');
  const SENT = '2026-08-01T12:00:00.000Z';   // settled, well inside the TTL

  beforeEach(() => { fakeDb.reset(); });

  it('does nothing when nothing has settled yet', async () => {
    const { client, receipts } = stubClient({});
    fakeDb.seed('push_receipts', receiptRows(2, '2026-08-02T11:59:00.000Z'));

    const result = await checkPushReceipts({ client, now: NOW });

    expect(receipts).not.toHaveBeenCalled();
    expect(result).toEqual({ checked: 0, revoked: 0 });
    expect(fakeDb.rows('push_receipts')).toHaveLength(2);
  });

  it('only reads tickets older than the settle delay — a receipt asked for too early comes back empty', async () => {
    const { client } = stubClient({});
    fakeDb.seed('push_receipts', []);

    await checkPushReceipts({ client, now: NOW });

    // Two created_at bounds: the TTL purge, then the settle window.
    const lts = fakeDb.calls
      .filter((c) => c.table === 'push_receipts' && c.method === 'lt')
      .map((c) => c.args);
    expect(lts).toEqual([
      ['created_at', '2026-07-30T12:00:00.000Z'],
      ['created_at', '2026-08-02T11:45:00.000Z'],
    ]);
  });

  it('revokes the token behind a DeviceNotRegistered receipt and leaves the delivered one alone', async () => {
    const { client } = stubClient({
      receipts: async () => ({
        [ticketId(0)]: { status: 'ok' },
        [ticketId(1)]: { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } },
      }),
    });
    fakeDb.seed('push_receipts', receiptRows(2, SENT));
    fakeDb.seed('push_tokens', deviceRows(2));

    const result = await checkPushReceipts({ client, now: NOW });

    expect(result).toEqual({ checked: 2, revoked: 1 });
    expect(fakeDb.rows('push_tokens')[0].revoked_at).toBeNull();
    expect(fakeDb.rows('push_tokens')[1].revoked_at).toEqual(expect.any(String));
  });

  it('leaves a device that re-registered after the send alone', async () => {
    // Uninstall, receipt says DeviceNotRegistered, reinstall before the sweep —
    // Expo can hand the same address back. The receipt describes the device as
    // it was at SEND time, so last_seen_at is the only thing that separates a
    // dead device from one that came back, and revoking the live row costs the
    // user a notification cycle it will not get again.
    const { client } = stubClient({ receipts: async (ids) => gone(ids) });
    fakeDb.seed('push_receipts', receiptRows(1, SENT));
    fakeDb.seed('push_tokens', deviceRows(1, { last_seen_at: '2026-08-01T18:00:00.000Z' }));

    const result = await checkPushReceipts({ client, now: NOW });

    expect(result.revoked).toBe(0);
    expect(fakeDb.rows('push_tokens')[0].revoked_at).toBeNull();
  });

  it('dequeues every ticket it asked about, including ones Expo no longer knows', async () => {
    // The second ticket is absent from the response — an expired receipt. If it
    // stayed queued the sweep would retry it every day forever.
    const { client } = stubClient({ receipts: async () => ({ [ticketId(0)]: { status: 'ok' } }) });
    fakeDb.seed('push_receipts', receiptRows(2, SENT));

    const result = await checkPushReceipts({ client, now: NOW });

    expect(result.checked).toBe(2);
    expect(fakeDb.rows('push_receipts')).toEqual([]);
  });

  it('dequeues in chunks short enough to send — one .in() of a whole sweep is a URL no proxy accepts', async () => {
    // 600 ticket ids in a single DELETE filter is a ~22 KB URL (2000 is 78 KB).
    // It does not go slowly, it 414s: the rows are never deleted, the sweep
    // still reports success, and because the window is oldest-first they are
    // re-read and re-fail every day from then on.
    const { client } = stubClient({ receipts: async (ids) => ok(ids) });
    fakeDb.seed('push_receipts', receiptRows(600, SENT));

    const result = await checkPushReceipts({ client, now: NOW });

    expect(result.checked).toBe(600);
    expect(fakeDb.rows('push_receipts')).toEqual([]);
    for (const call of fakeDb.calls.filter((c) => c.table === 'push_receipts' && c.method === 'in')) {
      expect(call.args[1].length).toBeLessThanOrEqual(100);
    }
  });

  it('purges past the TTL first, so rows the dequeue cannot clear never wedge the window', async () => {
    // Expo has forgotten these and the fetch is failing, so nothing here will
    // ever be dequeued by ticket id. Oldest-first selection means that without
    // a range delete they would occupy the head of every future sweep until
    // there were enough of them to crowd out every receipt written after.
    const { client } = stubClient({ receipts: async () => { throw new Error('timeout'); } });
    fakeDb.seed('push_receipts', receiptRows(3, '2026-07-01T00:00:00.000Z'));

    const result = await checkPushReceipts({ client, now: NOW });

    expect(result).toEqual({ checked: 0, revoked: 0 });
    expect(fakeDb.rows('push_receipts')).toEqual([]);
  });

  it('leaves a chunk queued when the receipt fetch itself fails', async () => {
    const { client } = stubClient({ receipts: async () => { throw new Error('timeout'); } });
    fakeDb.seed('push_receipts', receiptRows(1, SENT));

    const result = await checkPushReceipts({ client, now: NOW });

    expect(result.checked).toBe(0);
    // Still inside the receipt window, so tomorrow's sweep gets another go.
    expect(fakeDb.rows('push_receipts')).toHaveLength(1);
  });

  it('chunks receipt ids at the SDK limit', async () => {
    const { client, receipts } = stubClient({});
    fakeDb.seed('push_receipts', receiptRows(700, SENT));

    await checkPushReceipts({ client, now: NOW });

    expect(receipts).toHaveBeenCalledTimes(3);
    expect(receipts.mock.calls[0][0]).toHaveLength(300);
    expect(receipts.mock.calls[2][0]).toHaveLength(100);
  });
});
