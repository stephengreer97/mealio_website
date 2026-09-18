import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';
import { requireAdmin } from '@/lib/requireAdmin';
import { advanceRun, summariseRun } from '@/lib/admin-sync';

/**
 * POST /api/admin/sync/worker — move one run forward by one chunk.
 *
 * The background job (MEAL-90), shaped for a platform that has no queue. A run
 * is a row; this endpoint takes a lease on it, imports what it can inside its
 * budget, writes the outcomes and lets go. Call it again and it carries on.
 *
 * Driven by the admin screen while the run is unfinished, and by the daily cron
 * for runs whose operator closed the tab. Both are safe to call concurrently:
 * the lease means only one worker is ever inside a run, so no post is imported
 * twice.
 *
 * Request:  { runId: string }
 * Response: 200 with the run and its totals — including the per-item gate
 *           rejections, which are what make "I selected 12 and got 9" legible.
 *
 * Nothing here reaches Discover (MEAL-91), so there is no cache to invalidate:
 * a chunk produces drafts waiting on a human, and `revalidateTag` moved to the
 * approve action where a meal actually becomes visible.
 */

// One chunk is `CHUNK_BUDGET_MS` of starting waves plus the wave that starts
// last, which can take `ITEM_WORST_CASE_MS` (`lib/admin-sync.ts`): 190s. At 60
// Vercel killed the worker mid-wave, and the posts it was holding came back
// `skipped` on the next chunk. Must equal `WORKER_MAX_DURATION_MS`; a test reads
// this line to hold it there, because route config has to be a literal.
export const maxDuration = 300;

export async function POST(request: NextRequest) {
  const admin = await requireAdmin(request);
  if (!admin) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  let body: { runId?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const runId = typeof body.runId === 'string' ? body.runId : '';
  if (!runId) {
    return NextResponse.json({ error: 'runId is required' }, { status: 400 });
  }

  const supabase = createServerSupabaseClient();
  const run = await advanceRun({ supabase }, runId);
  if (!run) {
    return NextResponse.json({ error: 'Run not found' }, { status: 404 });
  }

  return NextResponse.json({ run, totals: summariseRun(run) });
}
