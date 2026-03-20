import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';
import { requireAdmin } from '@/lib/requireAdmin';
import { log } from '@/lib/logger';

// GET /api/admin/meals — list all preset meals with trending score
export async function GET(request: NextRequest) {
  const admin = await requireAdmin(request);
  if (!admin) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const supabase = createServerSupabaseClient();
  const { data, error } = await supabase.rpc('get_preset_meals_with_trending', {
    partner_only: false,
  });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ meals: data });
}

// DELETE /api/admin/meals — delete any preset meal
export async function DELETE(request: NextRequest) {
  const admin = await requireAdmin(request);
  if (!admin) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const body = await request.json();
  const { id } = body;

  if (!id) {
    return NextResponse.json({ error: 'id is required' }, { status: 400 });
  }

  const supabase = createServerSupabaseClient();
  const { error } = await supabase.from('preset_meals').delete().eq('id', id);

  if (error) {
    log({ event: 'ADMIN:MEAL_DELETE', status: 'error', userId: admin.userId, email: admin.email, detail: id, error });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  log({ event: 'ADMIN:MEAL_DELETE', status: 'success', userId: admin.userId, email: admin.email, detail: id });
  return NextResponse.json({ ok: true });
}
