import { NextRequest, NextResponse } from 'next/server';
import { revalidateTag } from 'next/cache';
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
 */

// Two imports per chunk, each a fetch plus a gate call plus an extraction.
export const maxDuration = 60;

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

  const totals = summariseRun(run);
  // Once per chunk rather than once per meal: the Discover feed is cached for
  // ten minutes and a 200-item run would otherwise invalidate it 200 times.
  if (totals.imported > 0) revalidateTag('trending-meals', 'max');

  return NextResponse.json({ run, totals });
}
