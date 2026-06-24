import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';
import { requireAdmin } from '@/lib/requireAdmin';
import { log } from '@/lib/logger';

// PATCH /api/admin/broadcast — admin only. Set or clear the broadcast message and
// its optional store targeting. An empty/absent `stores` list = show to everyone.
export async function PATCH(request: NextRequest) {
  const admin = await requireAdmin(request);
  if (!admin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { message, stores } = await request.json();
  const supabase = createServerSupabaseClient();

  const trimmed = message?.trim() || null;
  const storeList = Array.isArray(stores) ? stores.filter((s: unknown) => typeof s === 'string') : [];
  // Only persist targeting when there is actually a message + selected stores, so a
  // stale filter can't linger after the message is cleared.
  const storesValue = trimmed && storeList.length > 0 ? JSON.stringify(storeList) : null;

  await supabase.from('app_settings').upsert([
    { key: 'broadcast_message', value: trimmed },
    { key: 'broadcast_stores', value: storesValue },
  ]);

  log({
    event: 'ADMIN:BROADCAST',
    status: 'success',
    userId: admin.userId,
    email: admin.email,
    detail: trimmed ? `set="${trimmed.slice(0, 50)}" stores=${storeList.length || 'all'}` : 'cleared',
  });
  return NextResponse.json({ ok: true });
}
