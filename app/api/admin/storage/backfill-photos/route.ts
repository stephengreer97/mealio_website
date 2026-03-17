import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';
import { requireAdmin } from '@/lib/requireAdmin';
import { resolvePhotoUrl } from '@/lib/photos';
import { log } from '@/lib/logger';

export const maxDuration = 300;

const PROXY_PATH = '/api/meals/pixabay-image';

function isProxyUrl(url: string | null): boolean {
  if (!url) return false;
  try {
    return new URL(url).pathname === PROXY_PATH;
  } catch {
    return false;
  }
}

// POST /api/admin/storage/backfill-photos
// Re-resolves expired Pixabay proxy URLs to permanent Supabase Storage URLs
// for all rows in `meals` and `preset_meals`.
export async function POST(request: NextRequest) {
  const admin = await requireAdmin(request);
  if (!admin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const supabase = createServerSupabaseClient();

  // Fetch all rows that have a proxy photo URL
  const [mealsRes, presetRes] = await Promise.all([
    supabase.from('meals').select('id, user_id, photo_url').not('photo_url', 'is', null),
    supabase.from('preset_meals').select('id, creator_id, photo_url').not('photo_url', 'is', null),
  ]);

  const mealRows = (mealsRes.data ?? []).filter(r => isProxyUrl(r.photo_url));
  const presetRows = (presetRes.data ?? []).filter(r => isProxyUrl(r.photo_url));
  const total = mealRows.length + presetRows.length;

  let processed = 0;
  let skipped = 0;
  let errors = 0;

  // Process meals 5 at a time
  for (let i = 0; i < mealRows.length; i += 5) {
    const batch = mealRows.slice(i, i + 5);
    await Promise.all(batch.map(async (row) => {
      try {
        const resolved = await resolvePhotoUrl(row.photo_url, row.user_id);
        if (!resolved || resolved === row.photo_url) { skipped++; return; }
        const { error } = await supabase.from('meals').update({ photo_url: resolved }).eq('id', row.id);
        if (error) { errors++; return; }
        processed++;
      } catch {
        errors++;
      }
    }));
  }

  // Process preset_meals 5 at a time (use admin userId for storage path)
  for (let i = 0; i < presetRows.length; i += 5) {
    const batch = presetRows.slice(i, i + 5);
    await Promise.all(batch.map(async (row) => {
      try {
        const resolved = await resolvePhotoUrl(row.photo_url, admin.userId);
        if (!resolved || resolved === row.photo_url) { skipped++; return; }
        const { error } = await supabase.from('preset_meals').update({ photo_url: resolved }).eq('id', row.id);
        if (error) { errors++; return; }
        processed++;
      } catch {
        errors++;
      }
    }));
  }

  log({ event: 'STORAGE:BACKFILL', status: 'success', userId: admin.userId, detail: `photos: ${processed} resolved, ${skipped} skipped, ${errors} errors of ${total} total` });
  return NextResponse.json({ total, processed, skipped, errors });
}
