import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';
import { requireAdmin } from '@/lib/requireAdmin';

// PATCH /api/admin/broadcast — admin only, set or clear broadcast message
export async function PATCH(request: NextRequest) {
  const admin = await requireAdmin(request);
  if (!admin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { message } = await request.json();
  const supabase = createServerSupabaseClient();

  await supabase
    .from('app_settings')
    .upsert({ key: 'broadcast_message', value: message?.trim() || null });

  return NextResponse.json({ ok: true });
}
