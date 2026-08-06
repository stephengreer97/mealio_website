import { NextRequest, NextResponse } from 'next/server';
import { createHash } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createServerSupabaseClient } from '@/lib/supabase';
import { requireAdmin } from '@/lib/requireAdmin';
import { log } from '@/lib/logger';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const BASE_URL = 'https://etaracmlewdvzpcjrgru.supabase.co/storage/v1/object/public/meal-photos/';

/**
 * How this backfill is bounded, and why the bound is in two places.
 *
 * MEAL-129: the `photo_hashes` read had no bound, so PostgREST returned the first
 * `db-max-rows` — 1000 — with no error and nothing saying it had truncated, and the
 * route reported **success**. Two distinct wrongs came out of that one line: the
 * job was incomplete, and `knownUrls` was a partial skip-list, so objects already
 * hashed were re-downloaded and re-hashed and counted as `processed`. The number the
 * operator read was inflated by the same bug that made the job short.
 *
 * `list_storage_objects` is a set-returning function, and PostgREST applies
 * `db-max-rows` to those exactly as it does to a table — so the object list capped
 * at 1000 too, and `total` was capped with it. Both are paged now.
 *
 * Scanning and working are bounded separately, for the same reason as in
 * `backfill-photos`: listing is cheap and pages to exhaustion, while hashing
 * downloads every object and cannot finish an arbitrary backlog inside
 * `maxDuration`. A run that exceeds 300s returns no JSON at all, which is a worse
 * answer than a partial one that says it is partial. So the batch is explicit and
 * the response says how many are left.
 */
const SCAN_PAGE_ROWS = 1000;
const MAX_SCAN_PAGES = 50;
const MAX_PER_RUN = 500;

/**
 * Every object in the bucket, paged to exhaustion.
 *
 * Ordered on `name`, which is unique within a bucket — an offset walk without an
 * ORDER BY may repeat one object and skip another, and a skipped object is one that
 * never gets hashed however many times the backfill is run.
 */
async function listAllObjects(
  supabase: SupabaseClient,
): Promise<{ objects: Array<{ name: string; size: number }>; complete: boolean; error: { message: string } | null }> {
  const objects: Array<{ name: string; size: number }> = [];

  for (let page = 0; page < MAX_SCAN_PAGES; page++) {
    const { data, error } = await supabase
      .rpc('list_storage_objects', { bucket: 'meal-photos' })
      .select('name, size')
      .order('name', { ascending: true })
      .range(page * SCAN_PAGE_ROWS, page * SCAN_PAGE_ROWS + SCAN_PAGE_ROWS - 1);

    if (error) return { objects, complete: false, error };

    const batch = (data ?? []) as Array<{ name: string; size: number }>;
    objects.push(...batch);
    if (batch.length < SCAN_PAGE_ROWS) return { objects, complete: true, error: null };
  }

  return { objects, complete: false, error: null };
}

/**
 * Every URL already hashed, paged to exhaustion, ordered on the primary key.
 *
 * This is the skip-list, so a short read here does not merely slow the job down —
 * it makes the route redo work it has already done and report it as progress.
 */
async function fetchKnownUrls(
  supabase: SupabaseClient,
): Promise<{ urls: Set<string>; complete: boolean }> {
  const urls = new Set<string>();

  for (let page = 0; page < MAX_SCAN_PAGES; page++) {
    const { data, error } = await supabase
      .from('photo_hashes')
      .select('hash, url')
      .order('hash', { ascending: true })
      .range(page * SCAN_PAGE_ROWS, page * SCAN_PAGE_ROWS + SCAN_PAGE_ROWS - 1);

    if (error) return { urls, complete: false };

    const batch = (data ?? []) as Array<{ url: string }>;
    for (const row of batch) urls.add(row.url);
    if (batch.length < SCAN_PAGE_ROWS) return { urls, complete: true };
  }

  return { urls, complete: false };
}

export async function POST(request: NextRequest) {
  const admin = await requireAdmin(request);
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const supabase = createServerSupabaseClient();

  const { objects: storageObjects, complete: listComplete, error: listError } = await listAllObjects(supabase);

  if (listError) {
    log({ event: 'STORAGE:BACKFILL', status: 'error', userId: admin.userId, error: listError });
    return NextResponse.json({ error: listError.message }, { status: 500 });
  }

  // Find URLs already in photo_hashes so we can skip them
  const { urls: knownUrls, complete: knownComplete } = await fetchKnownUrls(supabase);

  const candidates = storageObjects.filter(obj => !knownUrls.has(`${BASE_URL}${obj.name}`));
  const scanComplete = listComplete && knownComplete;

  // The explicit batch.
  const toProcess = candidates.slice(0, MAX_PER_RUN);
  const remaining = candidates.length - toProcess.length;

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

  // Finished only when both scans saw everything AND the batch covered every
  // candidate they found. Anything else used to be reported as success.
  const complete = scanComplete && remaining === 0;

  log({
    event: 'STORAGE:BACKFILL',
    status: complete ? 'success' : 'error',
    userId: admin.userId,
    detail: `processed=${processed} skipped=${skipped} errors=${errors}`
      + ` remaining=${remaining} scan=${scanComplete ? 'complete' : 'TRUNCATED'}`,
  });

  return NextResponse.json({
    processed,
    skipped,
    errors,
    /** Objects in the bucket. Now the real count, not the first page of them. */
    total: storageObjects.length,
    /** Unhashed objects found but deliberately not attempted this run. */
    remaining,
    /** False when another run is required — the operator is told, not left to guess. */
    complete,
    /**
     * False when either scan hit `MAX_SCAN_PAGES`, so `total` and `remaining` are
     * floors rather than counts. Distinct from `complete`: that asks for another
     * run, this asks for somebody to look at why there are 50k objects.
     */
    scanComplete,
    /** The bound in force, so the numbers above are interpretable without the source. */
    batchLimit: MAX_PER_RUN,
  });
}
