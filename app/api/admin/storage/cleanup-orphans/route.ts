import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';
import { requireAdmin } from '@/lib/requireAdmin';
import { log } from '@/lib/logger';

export const dynamic = 'force-dynamic';

const BASE_URL = 'https://etaracmlewdvzpcjrgru.supabase.co/storage/v1/object/public/meal-photos/';

function toStoragePath(url: string | null | undefined): string | null {
  if (!url) return null;
  if (url.startsWith(BASE_URL)) return url.slice(BASE_URL.length);
  return null;
}

export async function POST(request: NextRequest) {
  const admin = await requireAdmin(request);
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const dryRun = request.nextUrl.searchParams.get('dryRun') === 'true';

  const supabase = createServerSupabaseClient();

  // List all storage objects via RPC
  const { data: objects, error: listError } = await supabase
    .rpc('list_storage_objects', { bucket: 'meal-photos' });

  if (listError) {
    log({ event: 'STORAGE:CLEANUP', status: 'error', userId: admin.userId, error: listError });
    return NextResponse.json({ error: listError.message }, { status: 500 });
  }

  const storageObjects: { name: string; size: number }[] = objects ?? [];

  // Collect all referenced photo_url values from all 4 tables in parallel
  // Include soft-deleted meals (is_active=false) — their photos are NOT orphans
  const [mealsRes, presetMealsRes, creatorsRes, applicationsRes] = await Promise.all([
    supabase.from('meals').select('photo_url'),
    supabase.from('preset_meals').select('photo_url'),
    supabase.from('creators').select('photo_url'),
    supabase.from('creator_applications').select('photo_url'),
  ]);

  const referencedPaths = new Set<string>();
  for (const row of [
    ...(mealsRes.data ?? []),
    ...(presetMealsRes.data ?? []),
    ...(creatorsRes.data ?? []),
    ...(applicationsRes.data ?? []),
  ]) {
    const path = toStoragePath(row.photo_url);
    if (path) referencedPaths.add(path);
  }

  // Find orphans
  const orphanObjects = storageObjects.filter(obj => !referencedPaths.has(obj.name));
  const orphanPaths = orphanObjects.map(o => o.name);
  const estimatedBytes = orphanObjects.reduce((sum, o) => sum + (o.size ?? 0), 0);

  if (dryRun) {
    log({ event: 'STORAGE:CLEANUP', status: 'success', userId: admin.userId, detail: `dry-run orphans=${orphanPaths.length}` });
    return NextResponse.json({ dryRun: true, orphanCount: orphanPaths.length, estimatedBytes, paths: orphanPaths });
  }

  // Delete in batches of 100
  let deleted = 0;
  for (let i = 0; i < orphanPaths.length; i += 100) {
    const batch = orphanPaths.slice(i, i + 100);
    const { error: deleteError } = await supabase.storage.from('meal-photos').remove(batch);
    if (deleteError) {
      log({ event: 'STORAGE:CLEANUP', status: 'error', userId: admin.userId, error: deleteError, detail: `batch ${i}` });
    } else {
      deleted += batch.length;
    }
  }

  log({ event: 'STORAGE:CLEANUP', status: 'success', userId: admin.userId, detail: `deleted=${deleted} estimatedBytes=${estimatedBytes}` });
  return NextResponse.json({ dryRun: false, deleted, estimatedBytes, paths: orphanPaths });
}
