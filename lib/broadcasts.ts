import { createServerSupabaseClient } from '@/lib/supabase';

// A single broadcast notice. Multiple can be active at once (e.g. two targeting
// different stores). Stored as a JSON array under the app_settings `broadcasts`
// key (no dedicated table needed for this low-volume admin content).
export interface Broadcast {
  id: string;
  message: string;
  stores: string[];      // store IDs; empty = everyone
  forceShow: boolean;    // show on every launch even if the user dismissed it
  createdAt: string;
}

const KEY = 'broadcasts';

function isBroadcast(b: unknown): b is Broadcast {
  return !!b && typeof (b as Broadcast).id === 'string' && typeof (b as Broadcast).message === 'string';
}

export async function readBroadcasts(): Promise<Broadcast[]> {
  const supabase = createServerSupabaseClient();
  const { data } = await supabase.from('app_settings').select('value').eq('key', KEY).single();
  if (!data?.value) return [];
  try {
    const parsed = JSON.parse(data.value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isBroadcast).map((b) => ({
      id: b.id,
      message: b.message,
      stores: Array.isArray(b.stores) ? b.stores.filter((s: unknown) => typeof s === 'string') : [],
      forceShow: !!b.forceShow,
      createdAt: b.createdAt ?? '',
    }));
  } catch {
    return [];
  }
}

export async function writeBroadcasts(list: Broadcast[]): Promise<void> {
  const supabase = createServerSupabaseClient();
  await supabase.from('app_settings').upsert({ key: KEY, value: JSON.stringify(list) });
}
