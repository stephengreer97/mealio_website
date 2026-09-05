// MEAL-217. The layer that asks whether the user wants this.
//
// sendPushToUsers knows about devices and tokens and, as its own comment says,
// a device grant is NOT "this user asked for notifications". This is the layer
// that asks — and until this ticket nothing asked, because nothing sent.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Expo, type ExpoPushMessage, type ExpoPushTicket } from 'expo-server-sdk';
import { fakeDb } from '../helpers/supabase-mock';

vi.mock('@/lib/supabase', async () =>
  (await import('../helpers/supabase-mock')).mockSupabaseModule());
vi.mock('@/lib/logger', () => ({ log: vi.fn() }));

import { sendPushToCategory, type PushClient } from '@/lib/push';

const REAL = new Expo();

function stubClient() {
  const send = vi.fn(async (m: ExpoPushMessage[]) =>
    m.map((_, i) => ({ status: 'ok', id: `t-${i}` } as ExpoPushTicket)));
  const client: PushClient = {
    chunkPushNotifications: (m) => REAL.chunkPushNotifications(m),
    chunkPushNotificationReceiptIds: (ids) => REAL.chunkPushNotificationReceiptIds(ids),
    sendPushNotificationsAsync: send,
    getPushNotificationReceiptsAsync: vi.fn(async () => ({})),
  };
  return { client, send };
}

/** Prefs rows, then the token rows the sender reads after them. */
function given(profiles: Array<{ id: string; notification_prefs: unknown }>, tokens: string[]) {
  fakeDb.queue('user_profiles', { data: profiles, error: null });
  fakeDb.queue('push_tokens', { data: tokens.map((token) => ({ token })), error: null });
}

const MSG = { title: 'Mealio', body: 'hello' };

describe('sendPushToCategory', () => {
  beforeEach(() => fakeDb.reset());

  it('sends to a user with no stored preference', async () => {
    // Every account predates the column. Absent must mean yes, or the feature
    // ships to nobody.
    given([{ id: 'u1', notification_prefs: {} }], ['ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]']);
    const { client, send } = stubClient();
    const res = await sendPushToCategory(['u1'], 'broadcast', MSG, { client });
    expect(res.suppressed).toBe(0);
    expect(send).toHaveBeenCalled();
  });

  it('does not send to a user who turned that category off', async () => {
    given([{ id: 'u1', notification_prefs: { broadcast: false } }], ['ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]']);
    const { client, send } = stubClient();
    const res = await sendPushToCategory(['u1'], 'broadcast', MSG, { client });
    expect(res.suppressed).toBe(1);
    expect(res.devices).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it('sends to the ones who want it and not the ones who do not', async () => {
    given(
      [{ id: 'u1', notification_prefs: {} }, { id: 'u2', notification_prefs: { all: false } }],
      ['ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]'],
    );
    const { client } = stubClient();
    const res = await sendPushToCategory(['u1', 'u2'], 'broadcast', MSG, { client });
    expect(res.suppressed).toBe(1);
    // The token read is for the wanted ids only.
    const tokenRead = fakeDb.calls.find((c) => c.table === 'push_tokens');
    expect(JSON.stringify(tokenRead?.args ?? [])).not.toContain('u2');
  });

  it('FAILS CLOSED when the preference read fails', async () => {
    // A prefs read that errored is not consent. Sending anyway would push to
    // people who had turned this off, which is the one outcome this function
    // exists to prevent.
    fakeDb.queue('user_profiles', { data: null, error: { message: 'boom' } });
    const { client, send } = stubClient();
    const res = await sendPushToCategory(['u1'], 'broadcast', MSG, { client });
    expect(send).not.toHaveBeenCalled();
    expect(res.suppressed).toBe(1);
    expect(res.accepted).toBe(0);
  });

  it('stamps the category as the tap type, so consent and routing agree', async () => {
    // A notification that opts out under one name and lands under another is
    // worse than not sending it.
    given([{ id: 'u1', notification_prefs: {} }], ['ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]']);
    const { client, send } = stubClient();
    await sendPushToCategory(['u1'], 'creator_draft', MSG, { client });
    const sent = send.mock.calls[0][0][0] as ExpoPushMessage;
    expect((sent.data as Record<string, unknown>).type).toBe('creator_draft');
  });

  it('does nothing, and reads nothing, for an empty audience', async () => {
    const { client, send } = stubClient();
    const res = await sendPushToCategory([], 'broadcast', MSG, { client });
    expect(res).toEqual({ devices: 0, accepted: 0, revoked: 0, failed: 0, suppressed: 0 });
    expect(send).not.toHaveBeenCalled();
    expect(fakeDb.calls).toHaveLength(0);
  });
});

describe('a preference read that stopped short', () => {
  beforeEach(() => fakeDb.reset());

  it('sends to nobody rather than to everyone whose row fell off the end', async () => {
    // The failure mode the repository's select-bounds guard caught in this
    // function's first version. A truncated prefs read does not error: it
    // returns FEWER rows than there are users, and every user whose row is
    // missing reads as "no preference stored" — which correctly means consent.
    //
    // So a silent truncation turns into notifying people who opted out, and it
    // looks exactly like a successful send. Failing closed is the only safe
    // reading of an incomplete answer.
    fakeDb.queue('user_profiles', { data: null, error: { message: 'range not satisfiable' } });
    const { client, send } = stubClient();
    const res = await sendPushToCategory(['u1', 'u2'], 'broadcast', MSG, { client });
    expect(send).not.toHaveBeenCalled();
    expect(res.suppressed).toBe(2);
  });
});
