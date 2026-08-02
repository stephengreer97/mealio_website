import { Expo, type ExpoPushMessage, type ExpoPushReceipt, type ExpoPushTicket } from 'expo-server-sdk';
import { createServerSupabaseClient } from '@/lib/supabase';
import { log } from '@/lib/logger';

/**
 * Expo push sending (MEAL-88).
 *
 * Deliberately shaped as "send this message to these users", not as "notify a
 * creator about a draft". The creator draft queue (MEAL-89) is the first caller
 * and the broadcast endpoints are the obvious second, so the only thing this
 * module knows about a message is its title, body and an opaque `data` bag that
 * the app's tap handler routes on.
 */

export interface PushMessage {
  title: string;
  body: string;
  /**
   * Opaque here; the mobile app switches on `data.type` to decide where a tap
   * lands. Keep it small — Expo caps the whole message at 4 KiB.
   */
  data?: Record<string, unknown>;
  badge?: number;
}

export interface PushSendResult {
  /** Live devices we had a token for. 0 means nobody in `userIds` opted in. */
  devices: number;
  /** Tickets Expo accepted; delivery itself is confirmed later by the receipt. */
  accepted: number;
  /** Tokens revoked on the spot because the ticket said DeviceNotRegistered. */
  revoked: number;
  /** Tickets rejected for any other reason, plus whole chunks that threw. */
  failed: number;
}

/**
 * The slice of the Expo client this module uses. Tests pass a stub so no suite
 * ever reaches exp.host.
 */
export type PushClient = Pick<
  Expo,
  | 'sendPushNotificationsAsync'
  | 'getPushNotificationReceiptsAsync'
  | 'chunkPushNotifications'
  | 'chunkPushNotificationReceiptIds'
>;

let sharedClient: PushClient | null = null;

function getClient(): PushClient {
  // EXPO_ACCESS_TOKEN is optional and unset today. Once "enhanced push security"
  // is turned on for the Expo project it becomes required, and without it every
  // send starts failing — so it is read here rather than baked in at import.
  if (!sharedClient) sharedClient = new Expo({ accessToken: process.env.EXPO_ACCESS_TOKEN });
  return sharedClient;
}

/** Receipts are not ready the instant a ticket comes back; Expo suggests ~15 min. */
const RECEIPT_SETTLE_MS = 15 * 60 * 1000;

/** Ceiling on one sweep so the daily cron cannot run away on a bad day. */
const RECEIPT_SWEEP_LIMIT = 2000;

type Supabase = ReturnType<typeof createServerSupabaseClient>;

async function revokeTokens(supabase: Supabase, tokens: string[], reason: string): Promise<number> {
  if (tokens.length === 0) return 0;
  const { error } = await supabase
    .from('push_tokens')
    .update({ revoked_at: new Date().toISOString() })
    .in('token', tokens)
    .is('revoked_at', null);
  if (error) {
    log({ event: 'PUSH:REVOKE', status: 'error', error, detail: reason });
    return 0;
  }
  log({ event: 'PUSH:REVOKE', status: 'success', detail: `${tokens.length} ${reason}` });
  return tokens.length;
}

/**
 * Sends `message` to every live device belonging to `userIds`.
 *
 * A push_tokens row exists only because the user granted OS permission and the
 * app registered the device, and it is revoked the moment that stops being true
 * — so "has an unrevoked row" IS the opt-in check, and there is no path here
 * that sends to anyone else. No rows means no send, not a fallback.
 */
export async function sendPushToUsers(
  userIds: string[],
  message: PushMessage,
  opts: { client?: PushClient } = {},
): Promise<PushSendResult> {
  const result: PushSendResult = { devices: 0, accepted: 0, revoked: 0, failed: 0 };

  const ids = [...new Set(userIds.filter(Boolean))];
  if (ids.length === 0) return result;

  const supabase = createServerSupabaseClient();
  const { data, error } = await supabase
    .from('push_tokens')
    .select('token')
    .in('user_id', ids)
    .is('revoked_at', null);

  if (error) {
    log({ event: 'PUSH:SEND', status: 'error', error, detail: 'token lookup' });
    return result;
  }

  // A malformed token can only get here by having been written before this
  // check existed; drop it rather than letting one bad row reject a whole chunk.
  const tokens = (data ?? [])
    .map((row: { token: string | null }) => row.token)
    .filter((t): t is string => Expo.isExpoPushToken(t));

  result.devices = tokens.length;
  if (tokens.length === 0) return result;

  // One message per token, never `to: [...]`. Tickets come back positionally, so
  // a 1:1 message↔token mapping is what lets a DeviceNotRegistered ticket name
  // the exact device to revoke.
  const messages: ExpoPushMessage[] = tokens.map((to) => ({
    to,
    title: message.title,
    body: message.body,
    sound: 'default',
    ...(message.data ? { data: message.data } : {}),
    ...(typeof message.badge === 'number' ? { badge: message.badge } : {}),
  }));

  const client = opts.client ?? getClient();
  const dead: string[] = [];
  const receipts: Array<{ ticket_id: string; token: string }> = [];

  for (const chunk of client.chunkPushNotifications(messages)) {
    let tickets: ExpoPushTicket[];
    try {
      tickets = await client.sendPushNotificationsAsync(chunk);
    } catch (err) {
      // One chunk failing must not drop the rest — a transient 5xx from Expo
      // should cost that chunk, not the whole broadcast.
      result.failed += chunk.length;
      log({ event: 'PUSH:SEND', status: 'error', error: err, detail: `chunk of ${chunk.length}` });
      continue;
    }

    tickets.forEach((ticket, i) => {
      const token = chunk[i]?.to as string;
      if (ticket.status === 'ok') {
        result.accepted += 1;
        if (token) receipts.push({ ticket_id: ticket.id, token });
        return;
      }
      result.failed += 1;
      if (ticket.details?.error === 'DeviceNotRegistered' && token) {
        dead.push(token);
      } else {
        // DeveloperError / InvalidCredentials are OUR misconfiguration, not a
        // dead device — revoking on those would silently delete real users'
        // subscriptions every time credentials lapse.
        log({ event: 'PUSH:SEND', status: 'failed', reason: ticket.details?.error ?? 'unknown', detail: ticket.message });
      }
    });
  }

  if (receipts.length > 0) {
    const { error: receiptErr } = await supabase.from('push_receipts').insert(receipts);
    if (receiptErr) {
      // The send still happened; we just lose the chance to prune from it.
      log({ event: 'PUSH:SEND', status: 'failed', error: receiptErr, detail: 'receipt queue insert' });
    }
  }

  result.revoked = await revokeTokens(supabase, dead, 'DeviceNotRegistered (ticket)');

  log({
    event: 'PUSH:SEND',
    status: result.failed > 0 ? 'failed' : 'success',
    detail: `users=${ids.length} devices=${result.devices} accepted=${result.accepted} revoked=${result.revoked} failed=${result.failed}`,
  });
  return result;
}

/**
 * Reads settled delivery receipts and revokes the tokens Expo reports as
 * DeviceNotRegistered — the uninstalled apps. Run from the daily cron.
 *
 * Every row selected is deleted whether or not Expo still knows the ticket:
 * receipts live about a day, so a row kept until it "succeeds" would be retried
 * forever.
 */
export async function checkPushReceipts(
  opts: { client?: PushClient; now?: Date } = {},
): Promise<{ checked: number; revoked: number }> {
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - RECEIPT_SETTLE_MS).toISOString();

  const supabase = createServerSupabaseClient();
  const { data, error } = await supabase
    .from('push_receipts')
    .select('ticket_id, token')
    .lt('created_at', cutoff)
    .order('created_at')
    .limit(RECEIPT_SWEEP_LIMIT);

  if (error) {
    log({ event: 'PUSH:RECEIPTS', status: 'error', error });
    return { checked: 0, revoked: 0 };
  }

  const rows = (data ?? []) as Array<{ ticket_id: string; token: string }>;
  if (rows.length === 0) return { checked: 0, revoked: 0 };

  const tokenByTicket = new Map(rows.map((r) => [r.ticket_id, r.token]));
  const client = opts.client ?? getClient();
  const dead: string[] = [];
  const done: string[] = [];

  for (const chunk of client.chunkPushNotificationReceiptIds(rows.map((r) => r.ticket_id))) {
    let batch: Record<string, ExpoPushReceipt>;
    try {
      batch = await client.getPushNotificationReceiptsAsync(chunk);
    } catch (err) {
      // Leave this chunk queued — it is still inside the receipt window, so the
      // next sweep gets another go.
      log({ event: 'PUSH:RECEIPTS', status: 'error', error, detail: `chunk of ${chunk.length}` });
      continue;
    }

    done.push(...chunk);
    for (const [ticketId, receipt] of Object.entries(batch)) {
      if (receipt.status !== 'error') continue;
      const token = tokenByTicket.get(ticketId);
      if (receipt.details?.error === 'DeviceNotRegistered' && token) {
        dead.push(token);
      } else {
        log({ event: 'PUSH:RECEIPTS', status: 'failed', reason: receipt.details?.error ?? 'unknown', detail: receipt.message });
      }
    }
  }

  const revoked = await revokeTokens(supabase, [...new Set(dead)], 'DeviceNotRegistered (receipt)');

  if (done.length > 0) {
    const { error: deleteErr } = await supabase.from('push_receipts').delete().in('ticket_id', done);
    if (deleteErr) log({ event: 'PUSH:RECEIPTS', status: 'error', error: deleteErr, detail: 'dequeue' });
  }

  log({ event: 'PUSH:RECEIPTS', status: 'success', detail: `checked=${done.length} revoked=${revoked}` });
  return { checked: done.length, revoked };
}
