import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';
import { verifyAccessToken, extractTokenFromHeader } from '@/lib/tokens';
import { log } from '@/lib/logger';
import {
  NOTIFICATION_CATEGORIES, CATEGORY_LABEL, CATEGORY_DESCRIPTION, CREATOR_ONLY,
  sanitizePrefs, type NotificationPrefs,
} from '@/lib/notification-prefs';

// GET/PATCH /api/account/notification-prefs — MEAL-217.
//
// The user's own switches, on the SERVER. Before this the only control was a
// SecureStore boolean on the handset, which meant the send path could not see
// it: a user could turn notifications off and still be pushed to.
//
// GET also returns the CATALOGUE — the categories, their copy, and which of
// them apply to this account — so the app renders whatever the server currently
// sends rather than a list hard-coded into a build that may be months old. A
// category added here reaches every installed app without a release; one
// removed stops being offered, instead of leaving a dead switch behind.

export const dynamic = 'force-dynamic';

async function authed(request: NextRequest) {
  const token = extractTokenFromHeader(request.headers.get('authorization'));
  if (!token) return null;
  return verifyAccessToken(token);
}

export async function GET(request: NextRequest) {
  const decoded = await authed(request);
  if (!decoded) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const supabase = createServerSupabaseClient();
  const { data, error } = await supabase
    .from('user_profiles')
    .select('notification_prefs, is_creator')
    .eq('id', decoded.userId)
    .maybeSingle();

  if (error) {
    log({ event: 'ACCOUNT:NOTIFICATION_PREFS', status: 'error', userId: decoded.userId, error });
    return NextResponse.json({ error: 'Failed to read preferences' }, { status: 500 });
  }

  const isCreator = !!data?.is_creator;
  return NextResponse.json({
    prefs: (data?.notification_prefs ?? {}) as NotificationPrefs,
    // Only what this account can actually receive. A creator-only switch shown
    // to everyone is a control that does nothing for most people, which is the
    // same failure as an unwired flag.
    categories: NOTIFICATION_CATEGORIES
      .filter((c) => isCreator || !CREATOR_ONLY.has(c))
      .map((c) => ({ id: c, label: CATEGORY_LABEL[c], description: CATEGORY_DESCRIPTION[c] })),
  });
}

export async function PATCH(request: NextRequest) {
  const decoded = await authed(request);
  if (!decoded) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Body required' }, { status: 400 });
  }

  const supabase = createServerSupabaseClient();

  // MERGED, NOT REPLACED. The app sends the switch that changed, and a screen
  // that PUT the whole object would race itself: two toggles in quick
  // succession, and the second request — built from state the first had not yet
  // confirmed — silently reverts the first.
  const { data: existing, error: readErr } = await supabase
    .from('user_profiles')
    .select('notification_prefs')
    .eq('id', decoded.userId)
    .maybeSingle();

  if (readErr) {
    log({ event: 'ACCOUNT:NOTIFICATION_PREFS', status: 'error', userId: decoded.userId, error: readErr });
    return NextResponse.json({ error: 'Failed to read preferences' }, { status: 500 });
  }

  const merged: NotificationPrefs = {
    ...((existing?.notification_prefs ?? {}) as NotificationPrefs),
    ...sanitizePrefs(body),
  };

  const { error } = await supabase
    .from('user_profiles')
    .update({ notification_prefs: merged })
    .eq('id', decoded.userId);

  if (error) {
    log({ event: 'ACCOUNT:NOTIFICATION_PREFS', status: 'error', userId: decoded.userId, error });
    return NextResponse.json({ error: 'Failed to save preferences' }, { status: 500 });
  }

  return NextResponse.json({ ok: true, prefs: merged });
}
