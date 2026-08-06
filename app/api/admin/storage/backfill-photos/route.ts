import { NextRequest, NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createServerSupabaseClient } from '@/lib/supabase';
import { requireAdmin } from '@/lib/requireAdmin';
import { resolvePhotoUrl } from '@/lib/photos';
import { log } from '@/lib/logger';

export const maxDuration = 300;

const PROXY_PATH = '/api/meals/pixabay-image';

/**
 * How this backfill is bounded, and why it is bounded in two different places.
 *
 * MEAL-129: both selects here had no bound, so PostgREST returned the first
 * `db-max-rows` — 1000 — with no error and nothing in the body saying it had
 * truncated, and the route then reported **success**. An operator got a green
 * result and an incomplete job with nothing to distinguish "finished" from "hit
 * the ceiling", and re-running did not help.
 *
 * The second-order problem was worse than the count. The SQL filter is "has a
 * photo" while the work filter is "that photo is a Pixabay URL", so a 1000-row
 * window could contain few or zero candidates while thousands sat past it — a run
 * that scanned nothing useful, processed nothing, and still said success. Which
 * means a bound on the SCAN and a bound on the WORK are separate facts:
 *
 *  - SCANNING is two columns per row and costs almost nothing, so it pages to
 *    exhaustion. Ordered on the primary key, because an OFFSET walk without an
 *    ORDER BY may repeat one row and skip another.
 *  - PROCESSING re-downloads an image and uploads it to Storage. That cannot page
 *    to exhaustion inside one request: `maxDuration` is 300s, and a run that
 *    exceeds it returns no JSON at all, which is a worse answer than a partial one
 *    honestly labelled. So the batch is explicit, and the response says how many
 *    are left and that it is not finished — a second run is obviously required
 *    rather than something the operator has to infer.
 */
const SCAN_PAGE_ROWS = 1000;
const MAX_SCAN_PAGES = 50;
const MAX_PER_RUN = 500;

/** Returns true for any Pixabay URL that resolvePhotoUrl can re-upload to Storage */
function isPixabayUrl(url: string | null): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    if (parsed.pathname === PROXY_PATH) return true;
    if (parsed.hostname === 'cdn.pixabay.com') return true;
    if (parsed.hostname === 'pixabay.com') return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * Every candidate row in one table, paged to exhaustion.
 *
 * `complete: false` means either a failed page or `MAX_SCAN_PAGES` — in both cases
 * there may be candidates this run never saw, which the caller has to say out loud
 * rather than fold into a success.
 */
async function scanCandidates(
  supabase: SupabaseClient,
  table: 'meals' | 'preset_meals',
  columns: string,
): Promise<{ rows: Array<Record<string, any>>; complete: boolean }> {
  const rows: Array<Record<string, any>> = [];

  for (let page = 0; page < MAX_SCAN_PAGES; page++) {
    const { data, error } = await supabase
      .from(table)
      .select(columns)
      .not('photo_url', 'is', null)
      .order('id', { ascending: true })
      .range(page * SCAN_PAGE_ROWS, page * SCAN_PAGE_ROWS + SCAN_PAGE_ROWS - 1);

    if (error) return { rows, complete: false };

    const batch = (data ?? []) as Array<Record<string, any>>;
    // Only the Pixabay ones are work. Kept as a Node filter rather than pushed
    // into SQL because it is three different URL shapes parsed properly, and a
    // `like '%pixabay%'` that disagreed with `isPixabayUrl` would mean a row
    // fetched and silently never processed.
    rows.push(...batch.filter((r) => isPixabayUrl(r.photo_url)));
    // A short page is the end of the table. A full page proves nothing either way,
    // so ask again.
    if (batch.length < SCAN_PAGE_ROWS) return { rows, complete: true };
  }

  return { rows, complete: false };
}

// POST /api/admin/storage/backfill-photos
// Re-resolves any Pixabay URL (proxy, cdn.pixabay.com, or pixabay.com direct) to
// a permanent Supabase Storage URL for rows in `meals` and `preset_meals`.
// Bounded per run — see MAX_PER_RUN. The response says whether it finished.
export async function POST(request: NextRequest) {
  const admin = await requireAdmin(request);
  if (!admin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const supabase = createServerSupabaseClient();

  const [mealsScan, presetScan] = await Promise.all([
    scanCandidates(supabase, 'meals', 'id, user_id, photo_url'),
    scanCandidates(supabase, 'preset_meals', 'id, creator_id, photo_url'),
  ]);

  const scanComplete = mealsScan.complete && presetScan.complete;
  // Every Pixabay URL the scan found. `total` has always meant this, and it is now
  // the truth rather than the truth-up-to-1000-rows-per-table.
  const total = mealsScan.rows.length + presetScan.rows.length;

  // The explicit batch. Meals first and preset meals with whatever is left, so the
  // split between the two tables never leaves one of them permanently unreached.
  const mealRows = mealsScan.rows.slice(0, MAX_PER_RUN);
  const presetRows = presetScan.rows.slice(0, Math.max(0, MAX_PER_RUN - mealRows.length));
  const attempted = mealRows.length + presetRows.length;
  const remaining = total - attempted;

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

  // Finished only when the scan saw the whole table AND the batch covered
  // everything it found. Anything else is a partial job, and this route used to
  // report those as success.
  const complete = scanComplete && remaining === 0;

  log({
    event: 'STORAGE:BACKFILL',
    status: complete ? 'success' : 'error',
    userId: admin.userId,
    detail: `photos: ${processed} resolved, ${skipped} skipped, ${errors} errors of ${total} found`
      + `; ${remaining} remaining, scan ${scanComplete ? 'complete' : 'TRUNCATED'}`,
  });

  return NextResponse.json({
    total,
    processed,
    skipped,
    errors,
    /** Candidates found but deliberately not attempted this run. */
    remaining,
    /** False when another run is required — the operator is told, not left to guess. */
    complete,
    /**
     * False when the scan itself hit `MAX_SCAN_PAGES`, so `total` is a floor rather
     * than a count. Distinct from `complete`, because these need different actions:
     * more runs versus somebody looking at why there are 50k candidates.
     */
    scanComplete,
    /** The bound in force, so the number above is interpretable without the source. */
    batchLimit: MAX_PER_RUN,
  });
}
