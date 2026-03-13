import { NextRequest, NextResponse } from 'next/server';
import { createHash } from 'crypto';
import { createServerSupabaseClient } from '@/lib/supabase';
import { requireAdmin } from '@/lib/requireAdmin';
import { log } from '@/lib/logger';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const BASE_URL = 'https://etaracmlewdvzpcjrgru.supabase.co/storage/v1/object/public/meal-photos/';

export async function POST(request: NextRequest) {
  const admin = await requireAdmin(request);
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const supabase = createServerSupabaseClient();

  // List all storage objects
  const { data: objects, error: listError } = await supabase
    .rpc('list_storage_objects', { bucket: 'meal-photos' });

  if (listError) {
    log({ event: 'STORAGE:BACKFILL', status: 'error', userId: admin.userId, error: listError });
    return NextResponse.json({ error: listError.message }, { status: 500 });
  }

  const storageObjects: { name: string; size: number }[] = objects ?? [];

  // Find URLs already in photo_hashes so we can skip them
  const { data: existing } = await supabase.from('photo_hashes').select('url');
  const knownUrls = new Set((existing ?? []).map((r: { url: string }) => r.url));

  const toProcess = storageObjects.filter(obj => {
    const url = `${BASE_URL}${obj.name}`;
    return !knownUrls.has(url);
  });

  let processed = 0;
  let skipped = 0;
  let errors = 0;

  // Process 5 concurrently
  for (let i = 0; i < toProcess.length; i += 5) {
    const batch = toProcess.slice(i, i + 5);
    await Promise.all(batch.map(async (obj) => {
      const url = `${BASE_URL}${obj.name}`;
      try {
        const res = await fetch(url);
        if (!res.ok) { errors++; return; }
        const buffer = Buffer.from(await res.arrayBuffer());
        const hash = createHash('sha256').update(buffer).digest('hex');
        await supabase.from('photo_hashes').upsert({ hash, url }, { onConflict: 'hash', ignoreDuplicates: true });
        processed++;
      } catch {
        errors++;
      }
    }));
  }

  log({
    event: 'STORAGE:BACKFILL',
    status: 'success',
    userId: admin.userId,
    detail: `processed=${processed} skipped=${skipped} errors=${errors}`,
  });

  return NextResponse.json({ processed, skipped, errors, total: storageObjects.length });
}
