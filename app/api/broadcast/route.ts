import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';

// GET /api/broadcast — public. Returns the active broadcast message plus optional
// store targeting. `stores` is an array of store IDs; an empty array means the
// message is shown to everyone. When it has entries, only users with a saved meal
// at one of those stores should see it (enforced client-side in the mobile app).
export async function GET() {
  const supabase = createServerSupabaseClient();

  const { data } = await supabase
    .from('app_settings')
    .select('key, value')
    .in('key', ['broadcast_message', 'broadcast_stores']);

  const rows = data ?? [];
  const message = rows.find((r) => r.key === 'broadcast_message')?.value?.trim() || null;

  let stores: string[] = [];
  const storesRaw = rows.find((r) => r.key === 'broadcast_stores')?.value;
  if (storesRaw) {
    try {
      const parsed = JSON.parse(storesRaw);
      if (Array.isArray(parsed)) stores = parsed.filter((s) => typeof s === 'string');
    } catch {
      // malformed — treat as untargeted
    }
  }

  return NextResponse.json({ message, stores });
}
