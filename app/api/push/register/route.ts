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
export async function POST(request: NextRequest) {
  const user = await requireAuth(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const token = typeof body?.token === 'string' ? body.token.trim() : '';

  // Reject anything that isn't an ExponentPushToken here rather than at send
  // time, where one junk row would sit in the table failing quietly.
  if (!Expo.isExpoPushToken(token)) {
    return NextResponse.json({ error: 'Invalid Expo push token' }, { status: 400 });
  }

  const supabase = createServerSupabaseClient();
  const now = new Date().toISOString();

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
    { onConflict: 'token' },
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

  log({
    event: 'PUSH:REGISTER',
    status: 'success',
    userId: user.userId,
    detail: previous && previous !== token ? 'rotated' : 'registered',
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
