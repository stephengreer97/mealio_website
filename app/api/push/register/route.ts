import { NextRequest, NextResponse } from 'next/server';
import { Expo } from 'expo-server-sdk';
import { createServerSupabaseClient } from '@/lib/supabase';
import { requireAuth } from '@/lib/requireAuth';
import { log } from '@/lib/logger';

// POST /api/push/register — register or refresh this device's Expo push token.
//   { token, platform?, deviceName?, previousToken? } -> { ok: true }
//
// One row per device (MEAL-88), so the app calls this on every launch: the token
// is the device's current address, not a one-time enrolment, and Expo rotates it
// after reinstalls and some OS updates. `token` is UNIQUE, so the upsert makes a
// repeat call idempotent instead of growing a row per launch.
//
// `previousToken` is what turns a rotation into a replacement: the client knows
// which token this device used to have, and the server can only tell rotation
// from "a second device" if it is told. Without it a rotating device leaves a
// live row behind that we would send to forever until Expo happened to report
// it dead.
/**
 * Enough to identify what arrived, and nothing that could be sent to.
 *
 * A push token addresses a DEVICE. Anyone holding one can push to that handset,
 * so it belongs in a log no more than a session cookie does. Length, the prefix
 * up to the opening bracket, and whether it closes are enough to tell an APNs
 * hex token from an empty string from a genuine Expo token that the validator
 * is wrong about.
 */
export function describeTokenShape(token: string): string {
  if (!token) return 'empty';
  const bracket = token.indexOf('[');
  const prefix = bracket > 0 ? token.slice(0, bracket + 1) : `${token.slice(0, 6)}…`;
  const closed = token.endsWith(']');
  // Names the two shapes worth telling apart on sight.
  const looksHex = /^[0-9a-f]+$/i.test(token);
  return `len=${token.length} prefix=${JSON.stringify(prefix)} closed=${closed}`
    + (looksHex ? ' looks=native-hex' : '');
}

export async function POST(request: NextRequest) {
  const user = await requireAuth(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const token = typeof body?.token === 'string' ? body.token.trim() : '';

  // Reject anything that isn't an ExponentPushToken here rather than at send
  // time, where one junk row would sit in the table failing quietly.
  if (!Expo.isExpoPushToken(token)) {
    // SAY WHAT SHAPE IT WAS, because this rejection used to log nothing at all.
    // A device reporting "Invalid Expo push token" with no record on the server
    // leaves you guessing between "the client sent a native APNs token", "it
    // sent an empty string", and "the validator is wrong" -- and those have
    // three different fixes. Measured on a real handset beats all three.
    //
    // NEVER THE TOKEN. It is the address of somebody's device: anyone holding
    // it can be sent a notification, and it belongs in a log no more than a
    // session cookie does. What goes in is the shape: how long, what it starts
    // with up to the bracket, and whether it closes.
    log({
      event: 'PUSH:REGISTER',
      status: 'error',
      userId: user.userId,
      detail: `rejected token: ${describeTokenShape(token)} platform=${
        typeof body?.platform === 'string' ? body.platform : '-'}`,
    });
    return NextResponse.json({ error: 'Invalid Expo push token' }, { status: 400 });
  }

  const supabase = createServerSupabaseClient();
  const now = new Date().toISOString();

  // A push token addresses a DEVICE, and devices change hands: a shared or
  // hand-me-down phone signs in as someone new and has to start receiving THEIR
  // notifications, so registering a token another account holds must succeed.
  //
  // What it must not do is silently rewrite that account's row. An upsert keyed
  // on the token alone would move `user_id` under them and leave nothing behind
  // saying it happened — so a handover and a takeover by someone who scraped a
  // token out of a crash report look identical, and neither is visible. Retire
  // the other account's claim first, as its own recorded write.
  //
  // This is not a defence against a leaked token: only the handset can prove it
  // holds one, and it has no way to. It bounds the damage instead — the
  // displaced row survives as revoked, the log names both accounts, and the
  // displaced user's next launch re-registers and takes the device back.
  const { data: displaced, error: displaceErr } = await supabase
    .from('push_tokens')
    .update({ revoked_at: now })
    .eq('token', token)
    .neq('user_id', user.userId)
    .is('revoked_at', null)
    .select('user_id');

  if (displaceErr) {
    // Fail closed. Enrolling on top of a claim we could not retire leaves two
    // accounts live on one handset, and both of them getting the other's push.
    log({ event: 'PUSH:REGISTER', status: 'error', userId: user.userId, error: displaceErr, detail: 'displace' });
    return NextResponse.json({ error: 'Failed to register device' }, { status: 500 });
  }

  const { error } = await supabase.from('push_tokens').upsert(
    {
      user_id: user.userId,
      token,
      platform: typeof body?.platform === 'string' ? body.platform.slice(0, 20) : null,
      device_name: typeof body?.deviceName === 'string' ? body.deviceName.slice(0, 120) : null,
      last_seen_at: now,
      // A device that comes back after being pruned (reinstall) must start
      // receiving again, so re-registering un-revokes.
      revoked_at: null,
    },
    // (user_id, token), not token: one row per account per device is what lets
    // the displaced row above survive alongside the new one.
    { onConflict: 'user_id,token' },
  );

  if (error) {
    log({ event: 'PUSH:REGISTER', status: 'error', userId: user.userId, error });
    return NextResponse.json({ error: 'Failed to register device' }, { status: 500 });
  }

  const previous = typeof body?.previousToken === 'string' ? body.previousToken.trim() : '';
  if (previous && previous !== token) {
    // Scoped to this user: a token string is a bearer-ish value, and without the
    // user_id guard any caller could retire another account's device.
    const { error: revokeErr } = await supabase
      .from('push_tokens')
      .update({ revoked_at: now })
      .eq('token', previous)
      .eq('user_id', user.userId);
    if (revokeErr) {
      // The new token is already live, so a failed cleanup is worth a log and
      // not a 500 — the receipt sweep prunes the stale row eventually anyway.
      log({ event: 'PUSH:REGISTER', status: 'failed', userId: user.userId, error: revokeErr, detail: 'rotate' });
    }
  }

  const took = displaced?.length ? ` displaced=${displaced.map((r: { user_id: string }) => r.user_id).join(',')}` : '';
  log({
    event: 'PUSH:REGISTER',
    status: 'success',
    userId: user.userId,
    detail: `${previous && previous !== token ? 'rotated' : 'registered'}${took}`,
  });
  return NextResponse.json({ ok: true });
}

// DELETE /api/push/register — stop sending to this device.
//   { token } -> { ok: true }
//
// The app calls this when the user turns notifications off or signs out, so an
// opt-out takes effect immediately rather than waiting for a delivery receipt.
export async function DELETE(request: NextRequest) {
  const user = await requireAuth(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const token = typeof body?.token === 'string' ? body.token.trim() : '';
  if (!token) return NextResponse.json({ error: 'token required' }, { status: 400 });

  const supabase = createServerSupabaseClient();
  const { error } = await supabase
    .from('push_tokens')
    .update({ revoked_at: new Date().toISOString() })
    .eq('token', token)
    .eq('user_id', user.userId);

  if (error) {
    log({ event: 'PUSH:UNREGISTER', status: 'error', userId: user.userId, error });
    return NextResponse.json({ error: 'Failed to unregister device' }, { status: 500 });
  }

  log({ event: 'PUSH:UNREGISTER', status: 'success', userId: user.userId });
  return NextResponse.json({ ok: true });
}
