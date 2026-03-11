import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';

// GET /api/broadcast — public, returns active broadcast message or null
export async function GET() {
  const supabase = createServerSupabaseClient();

  const { data } = await supabase
    .from('app_settings')
    .select('value')
    .eq('key', 'broadcast_message')
    .single();

  const message = data?.value?.trim() || null;
  return NextResponse.json({ message });
}
