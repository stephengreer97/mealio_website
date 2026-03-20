import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';
import { requireAdmin } from '@/lib/requireAdmin';
import { log } from '@/lib/logger';

// PATCH /api/admin/broadcast — admin only, set or clear broadcast message
export async function PATCH(request: NextRequest) {
  const admin = await requireAdmin(request);
  if (!admin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { message } = await request.json();
  const supabase = createServerSupabaseClient();

  await supabase
    .from('app_settings')
    .upsert({ key: 'broadcast_message', value: message?.trim() || null });

  log({ event: 'ADMIN:BROADCAST', status: 'success', userId: admin.userId, email: admin.email, detail: message ? `set="${message.trim().slice(0, 50)}"` : 'cleared' });
  return NextResponse.json({ ok: true });
}
