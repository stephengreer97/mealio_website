import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';
import { requireAdmin } from '@/lib/requireAdmin';
import { log } from '@/lib/logger';
import { isNewSubscriberAlertOn, setNewSubscriberAlert } from '@/lib/new-subscriber-alert';

// Operator emails that can be switched off from the admin dashboard.
//
//   GET   /api/admin/notification-settings                 → { newSubscriber: boolean }
//   PATCH /api/admin/notification-settings { newSubscriber } → { newSubscriber: boolean }

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const admin = await requireAdmin(request);
  if (!admin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  try {
    return NextResponse.json({ newSubscriber: await isNewSubscriberAlertOn(createServerSupabaseClient()) });
  } catch (error) {
    log({ event: 'ADMIN:NOTIFICATION_SETTINGS', status: 'error', userId: admin.userId, reason: String(error), detail: 'read' });
    return NextResponse.json({ error: 'Failed to load' }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  const admin = await requireAdmin(request);
  if (!admin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const body = await request.json().catch(() => ({}));
  if (typeof body?.newSubscriber !== 'boolean') {
    return NextResponse.json({ error: 'newSubscriber must be true or false' }, { status: 400 });
  }

  const { error } = await setNewSubscriberAlert(createServerSupabaseClient(), body.newSubscriber);
  if (error) {
    log({ event: 'ADMIN:NOTIFICATION_SETTINGS', status: 'error', userId: admin.userId, reason: error.message, detail: 'write' });
    return NextResponse.json({ error: 'Failed to save' }, { status: 500 });
  }
  log({ event: 'ADMIN:NOTIFICATION_SETTINGS', status: 'success', userId: admin.userId, detail: `newSubscriber=${body.newSubscriber}` });
  return NextResponse.json({ newSubscriber: body.newSubscriber });
}
