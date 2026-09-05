import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/requireAdmin';
import { log } from '@/lib/logger';
import { readBroadcasts, writeBroadcasts, type Broadcast } from '@/lib/broadcasts';
import { createServerSupabaseClient } from '@/lib/supabase';
import { sendPushToCategory } from '@/lib/push';
import { fetchAllPages } from '@/lib/paged-select';

// POST /api/admin/broadcast — admin only. Add a broadcast.
export async function POST(request: NextRequest) {
  const admin = await requireAdmin(request);
  if (!admin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { message, stores, forceShow, push } = await request.json();
  const trimmed = (message ?? '').trim();
  if (!trimmed) return NextResponse.json({ error: 'Message required' }, { status: 400 });

  const storeList = Array.isArray(stores) ? stores.filter((s: unknown) => typeof s === 'string') : [];
  const broadcast: Broadcast = {
    id: crypto.randomUUID(),
    message: trimmed,
    stores: storeList,
    forceShow: !!forceShow,
    createdAt: new Date().toISOString(),
  };

  const list = await readBroadcasts();
  list.push(broadcast);
  await writeBroadcasts(list);

  // THE FIRST THING MEALIO ACTUALLY SENDS. MEAL-217.
  //
  // A broadcast has always been an in-app BANNER: it is written to app_settings
  // and rendered when the user next opens the app. Useful, and invisible to
  // anyone who does not. Pushing it is opt-IN per broadcast (`push: true`)
  // rather than automatic, because most broadcasts do not deserve an
  // interruption and a channel that interrupts for everything gets muted.
  //
  // Failure here does NOT fail the request. The banner is already written and
  // is the durable half; a push that could not be sent must not make the admin
  // think the broadcast did not happen.
  let pushed: Record<string, number> | null = null;
  if (push) {
    try {
      const supabase = createServerSupabaseClient();
      const read = await fetchAllPages<{ id: string }>((from, to) =>
        supabase.from('user_profiles').select('id').order('id', { ascending: true }).range(from, to));

      if (read.error || !read.complete) {
        // Refusing beats notifying an arbitrary slice: a broadcast that reached
        // the first thousand users looks, from the outside, exactly like one
        // that reached everyone.
        log({
          event: 'ADMIN:BROADCAST', status: 'error', userId: admin.userId,
          detail: `push skipped: user list incomplete after ${read.rows.length}`,
        });
      } else {
        const result = await sendPushToCategory(read.rows.map((r) => r.id), 'broadcast', {
          title: 'Mealio',
          body: trimmed.slice(0, 178),
          data: { broadcastId: broadcast.id },
        });
        pushed = {
          devices: result.devices, accepted: result.accepted,
          failed: result.failed, suppressed: result.suppressed,
        };
      }
    } catch (e) {
      log({ event: 'ADMIN:BROADCAST', status: 'error', userId: admin.userId, error: e });
    }
  }

  log({
    event: 'ADMIN:BROADCAST',
    status: 'success',
    userId: admin.userId,
    email: admin.email,
    detail: `add="${trimmed.slice(0, 50)}" stores=${storeList.length || 'all'} force=${!!forceShow}`
      + (pushed ? ` pushed=${pushed.accepted}/${pushed.devices} suppressed=${pushed.suppressed}` : ''),
  });
  return NextResponse.json({ ok: true, broadcast, pushed });
}

// DELETE /api/admin/broadcast — admin only. Remove a broadcast by id.
export async function DELETE(request: NextRequest) {
  const admin = await requireAdmin(request);
  if (!admin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { id } = await request.json();
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });

  const list = await readBroadcasts();
  await writeBroadcasts(list.filter((b) => b.id !== id));

  log({ event: 'ADMIN:BROADCAST', status: 'success', userId: admin.userId, email: admin.email, detail: `remove id=${id}` });
  return NextResponse.json({ ok: true });
}
