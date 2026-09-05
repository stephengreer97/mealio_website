import { Expo, type ExpoPushMessage, type ExpoPushReceipt, type ExpoPushTicket } from 'expo-server-sdk';
import { mayNotify, type NotificationCategory, type NotificationPrefs } from './notification-prefs';
import { createServerSupabaseClient } from '@/lib/supabase';
import { log } from '@/lib/logger';
import { fetchAllPages, chunkIds } from '@/lib/paged-select';

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

/**
 * Hard TTL on a queued receipt. Expo keeps one for about a day, so a row older
 * than this can never tell us anything again and exists only to be cleared.
 */
const RECEIPT_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * How many ids may ride in one `.in()` filter.
 *
 * PostgREST filters go in the QUERY STRING, not the body, so an id list is URL
 * length. Measured against supabase-js: 2000 ticket ids is a 78 KB DELETE URL
 * and 2000 Expo tokens is a 96 KB PATCH URL. Supabase fronts PostgREST with
 * Cloudflare and Kong, which reject URIs in the 8–16 KB range — so an unchunked
 * sweep does not slow down, it 414s, and every filtered write in this module
 * silently stops working the day a send gets big enough. 100 ids is under 5 KB
 * for both shapes, which leaves room for the rest of the URL and for a proxy
 * stricter than we measured.
 */
const FILTER_CHUNK = 100;

function chunked<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

type Supabase = ReturnType<typeof createServerSupabaseClient>;

/**
 * Marks `tokens` revoked and returns how many ROWS that actually changed.
 *
 * Not the number of tokens handed in: a token already revoked by the ticket
 * path, by DELETE /api/push/register, or by a concurrent sweep matches nothing.
 * The cron reports this as `pushTokensPruned`, and a count that includes rows
 * it did not touch is the one number an operator has for "is the prune state
 * machine working" saying yes when it isn't.
 *
 * `notSeenSince` guards the receipt path: a receipt describes a device as it
 * was at SEND time, and a device that has registered again since is live. The
 * two are indistinguishable by token alone — a reinstall gets the same address
 * back — so without the guard a sweep can revoke a device that came back, which
 * costs the user a notification cycle and does not self-heal at all if they
 * have since opted out locally.
 */
async function revokeTokens(
  supabase: Supabase,
  tokens: string[],
  reason: string,
  opts: { notSeenSince?: string } = {},
): Promise<number> {
  if (tokens.length === 0) return 0;

  let revoked = 0;
  for (const batch of chunked(tokens, FILTER_CHUNK)) {
    let query = supabase
      .from('push_tokens')
      .update({ revoked_at: new Date().toISOString() })
      .in('token', batch)
      .is('revoked_at', null);
    if (opts.notSeenSince) query = query.lt('last_seen_at', opts.notSeenSince);

    // .select() so the count is the rows PostgREST changed, not our guess.
    const { data, error } = await query.select('token');
    if (error) {
      // Keep going: one failed batch should cost that batch, not the rest.
      log({ event: 'PUSH:REVOKE', status: 'error', error, detail: reason });
      continue;
    }
    revoked += data?.length ?? 0;
  }

  log({ event: 'PUSH:REVOKE', status: 'success', detail: `${revoked}/${tokens.length} ${reason}` });
  return revoked;
}

/**
 * Sends `message` to every live device belonging to `userIds`.
 *
 * A push_tokens row exists only because that DEVICE was granted OS permission
 * and registered while this account was signed in, and it is revoked the moment
 * either stops being true — so "has an unrevoked row" IS the opt-in check, and
 * there is no path here that sends to anyone else. No rows means no send, not a
 * fallback.
 *
 * Consent is device-scoped, not account-scoped, and deliberately so: the OS
 * grant and the in-app opt-out both live on the handset. On a shared phone that
 * means the second person to sign in inherits the first person's grant without
 * seeing a prompt, and inherits their opt-out without seeing a reason. That is
 * the same bargain every app on the device makes with the OS permission model,
 * but it is NOT "this user asked for notifications" — do not read it as one.
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

  // Chunked and paged, because both ceilings bite here and this function is the
  // one that fans out widest. `ids` is however many users a caller wants to
  // notify — a broadcast is every user — and each user has a row PER DEVICE, so
  // the row count is a multiple of the id count. Unbounded, the read silently
  // stopped at 1000 tokens and the send reported full success for the devices it
  // never saw: `devices` counts what came back, so there was no number anywhere
  // in the result that disagreed with the truth.
  const rows: Array<{ token: string }> = [];
  for (const chunk of chunkIds(ids)) {
    const read = await fetchAllPages<{ token: string }>((from, to) =>
      supabase
        .from('push_tokens')
        .select('token')
        .in('user_id', chunk)
        .is('revoked_at', null)
        .order('token', { ascending: true })
        .range(from, to));

    if (read.error) {
      log({ event: 'PUSH:SEND', status: 'error', error: read.error, detail: 'token lookup' });
      return result;
    }
    if (!read.complete) {
      // Refusing beats notifying an arbitrary subset: a push that reaches some of
      // a user's devices and not others is indistinguishable, from the outside,
      // from one that worked.
      log({
        event: 'PUSH:SEND', status: 'error', detail:
          `token lookup incomplete after ${rows.length + read.rows.length} tokens`,
      });
      return result;
    }
    rows.push(...read.rows);
  }

  // A malformed token can only get here by having been written before this
  // check existed; drop it rather than letting one bad row reject a whole chunk.
  const tokens = rows
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
 *
 * That per-id dequeue is chunked (see FILTER_CHUNK) and can still fail per
 * batch, so it is backed by a TTL purge that deletes by created_at RANGE — one
 * short URL whatever the row count. The selection window is oldest-first, so
 * without that backstop a batch of rows the dequeue could not delete would sit
 * at the head of it forever and, once there were enough of them, no receipt
 * written after would ever be read again.
 */
export async function checkPushReceipts(
  opts: { client?: PushClient; now?: Date } = {},
): Promise<{ checked: number; revoked: number }> {
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - RECEIPT_SETTLE_MS).toISOString();

  const supabase = createServerSupabaseClient();

  // Before selecting, not after: a row past the TTL cannot be acted on, and
  // leaving it in place would let it occupy this run's window too.
  const { error: purgeErr } = await supabase
    .from('push_receipts')
    .delete()
    .lt('created_at', new Date(now.getTime() - RECEIPT_MAX_AGE_MS).toISOString());
  if (purgeErr) log({ event: 'PUSH:RECEIPTS', status: 'error', error: purgeErr, detail: 'ttl purge' });

  const { data, error } = await supabase
    .from('push_receipts')
    .select('ticket_id, token, created_at')
    .lt('created_at', cutoff)
    .order('created_at')
    .limit(RECEIPT_SWEEP_LIMIT);

  if (error) {
    log({ event: 'PUSH:RECEIPTS', status: 'error', error });
    return { checked: 0, revoked: 0 };
  }

  const rows = (data ?? []) as Array<{ ticket_id: string; token: string; created_at: string }>;
  if (rows.length === 0) return { checked: 0, revoked: 0 };

  const rowByTicket = new Map(rows.map((r) => [r.ticket_id, r]));
  const client = opts.client ?? getClient();
  // Keyed by the receipt's created_at — the moment the send happened — because
  // that is what a token has to have gone quiet since to count as dead. Rows
  // from one send share a timestamp, so this is a handful of keys per sweep.
  const deadBySentAt = new Map<string, Set<string>>();
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
      const row = rowByTicket.get(ticketId);
      if (receipt.details?.error === 'DeviceNotRegistered' && row) {
        const bucket = deadBySentAt.get(row.created_at) ?? new Set<string>();
        bucket.add(row.token);
        deadBySentAt.set(row.created_at, bucket);
      } else {
        log({ event: 'PUSH:RECEIPTS', status: 'failed', reason: receipt.details?.error ?? 'unknown', detail: receipt.message });
      }
    }
  }

  let revoked = 0;
  for (const [sentAt, tokens] of deadBySentAt) {
    revoked += await revokeTokens(supabase, [...tokens], 'DeviceNotRegistered (receipt)', { notSeenSince: sentAt });
  }

  for (const batch of chunked(done, FILTER_CHUNK)) {
    const { error: deleteErr } = await supabase.from('push_receipts').delete().in('ticket_id', batch);
    if (deleteErr) log({ event: 'PUSH:RECEIPTS', status: 'error', error: deleteErr, detail: 'dequeue' });
  }

  log({ event: 'PUSH:RECEIPTS', status: 'success', detail: `checked=${done.length} revoked=${revoked}` });
  return { checked: done.length, revoked };
}

/**
 * Send a categorised notification, to the users who still want that category.
 *
 * MEAL-217. `sendPushToUsers` knows about devices and tokens and nothing about
 * consent — its own comment is careful to say that a device grant is NOT "this
 * user asked for notifications". This is the layer that asks.
 *
 * EVERY PRODUCT SEND SHOULD COME THROUGH HERE rather than calling
 * sendPushToUsers directly. The raw sender stays exported because a genuinely
 * uncategorised message may exist one day (an account-security notice is the
 * usual example, and is not a thing a user opts out of), but a feature reaching
 * for it should have to explain why.
 *
 * Filtering happens HERE and not in the token query, deliberately: the prefs
 * live on user_profiles and the tokens on push_tokens, and joining them in one
 * PostgREST call would tie the send path to a shape that is about to change.
 * Reading prefs for the id list first is one extra query on a path that already
 * makes several, and it keeps "who wants this" separate from "where do we send
 * it".
 */
export async function sendPushToCategory(
  userIds: string[],
  category: NotificationCategory,
  message: PushMessage,
  opts: { client?: PushClient } = {},
): Promise<PushSendResult & { suppressed: number }> {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (ids.length === 0) return { devices: 0, accepted: 0, revoked: 0, failed: 0, suppressed: 0 };

  const supabase = createServerSupabaseClient();
  const wanted: string[] = [];
  let suppressed = 0;

  // Chunked for the same reason the token read is: `ids` can be every user.
  for (const chunk of chunkIds(ids)) {
    // PAGED, not a bare select. A chunk can exceed PostgREST's 1000-row ceiling,
    // and a truncated read here does not fail — it returns FEWER preference rows
    // than there are users, and every user whose row fell off the end reads as
    // "no preference stored", which mayNotify correctly treats as consent.
    //
    // That is the exact fail-OPEN this function exists to prevent, arriving
    // silently and looking like a successful send. The repository's
    // select-bounds guard caught it; nothing else would have until someone
    // noticed opted-out users being notified.
    const read = await fetchAllPages<{ id: string; notification_prefs: unknown }>((from, to) =>
      supabase
        .from('user_profiles')
        .select('id, notification_prefs')
        .in('id', chunk)
        .order('id', { ascending: true })
        .range(from, to));

    if (read.error || !read.complete) {
      // FAIL CLOSED. A prefs read that failed or stopped short is not consent,
      // and sending anyway would push to people who had turned this off.
      log({
        event: 'PUSH:SEND', status: 'error', error: read.error ?? undefined,
        detail: read.error ? 'prefs lookup' : `prefs lookup incomplete after ${read.rows.length}`,
      });
      return { devices: 0, accepted: 0, revoked: 0, failed: 0, suppressed: ids.length };
    }

    const byId = new Map(read.rows.map((r) => [r.id, r.notification_prefs]));
    for (const id of chunk) {
      // A user with no row read is treated as opted IN, matching mayNotify's
      // rule that absent means on. A missing profile row is a data problem, not
      // a refusal.
      if (mayNotify(byId.get(id) as NotificationPrefs | undefined, category)) wanted.push(id);
      else suppressed += 1;
    }
  }

  if (wanted.length === 0) {
    return { devices: 0, accepted: 0, revoked: 0, failed: 0, suppressed };
  }

  const sent = await sendPushToUsers(wanted, {
    ...message,
    // The app switches on data.type to route a tap, and it must agree with the
    // category the user consented to — a notification that opts out under one
    // name and lands under another is worse than not sending it.
    data: { ...(message.data ?? {}), type: category },
  }, opts);

  return { ...sent, suppressed };
}
