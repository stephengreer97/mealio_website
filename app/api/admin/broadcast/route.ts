import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/requireAdmin';
import { log } from '@/lib/logger';
import { readBroadcasts, writeBroadcasts, type Broadcast } from '@/lib/broadcasts';

// POST /api/admin/broadcast — admin only. Add a broadcast.
export async function POST(request: NextRequest) {
  const admin = await requireAdmin(request);
  if (!admin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { message, stores, forceShow } = await request.json();
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

  log({
    event: 'ADMIN:BROADCAST',
    status: 'success',
    userId: admin.userId,
    email: admin.email,
    detail: `add="${trimmed.slice(0, 50)}" stores=${storeList.length || 'all'} force=${!!forceShow}`,
  });
  return NextResponse.json({ ok: true, broadcast });
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
