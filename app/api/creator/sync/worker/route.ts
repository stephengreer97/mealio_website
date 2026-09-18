import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';
import { requireAuth } from '@/lib/requireAuth';
import { advanceRun, summariseRun } from '@/lib/admin-sync';

/**
 * POST /api/creator/sync/worker — move a creator's own run forward by one chunk
 * (MEAL-101).
 *
 * The same resumable worker the admin screen drives: take a lease, import what
 * fits in the budget, write the outcomes, let go. Called in a loop by the sync
 * section while a run is unfinished, and swept by the daily cron for runs whose
 * creator closed the tab — so a closed tab delays a back-catalogue import rather
 * than abandoning it half done.
 *
 * Two things this route sets that the admin one does not:
 *
 *   - **Ownership.** The run has to belong to the caller's creator row before
 *     `advanceRun` is allowed near it. Without that, a run id is a bearer token
 *     for spending money on somebody else's catalogue.
 *   - **`reviewBy: 'creator'`.** The drafts land in the creator's own review
 *     queue, because the creator ticked the boxes and is the one waiting. This
 *     is where "and come back for review" is actually made true.
 *
 * `gateMode` is left at its `manual` default, which is the truth here: a person
 * picked this post and is watching the run, so an `unsure` verdict is worth
 * attempting. The poller is the one that has to read a maybe as a no.
 */

// One chunk is `CHUNK_BUDGET_MS` of starting waves plus the wave that starts
// last, which can take `ITEM_WORST_CASE_MS` (`lib/admin-sync.ts`): 190s. At 60
// Vercel killed the worker mid-wave, and the posts it was holding came back
// `skipped` on the next chunk. Must equal `WORKER_MAX_DURATION_MS`; a test reads
// this line to hold it there, because route config has to be a literal.
export const maxDuration = 300;

export async function POST(request: NextRequest) {
  const user = await requireAuth(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: { runId?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const runId = typeof body.runId === 'string' ? body.runId : '';
  if (!runId) return NextResponse.json({ error: 'runId is required' }, { status: 400 });

  const supabase = createServerSupabaseClient();
  const { data: creator } = await supabase
    .from('creators')
    .select('id')
    .eq('user_id', user.userId)
    .maybeSingle();

  if (!creator) return NextResponse.json({ error: 'Run not found' }, { status: 404 });

  // Ownership first, and as a filter rather than a comparison afterwards. "Not
  // yours" and "does not exist" answer the same, so neither confirms the other.
  const { data: owned } = await supabase
    .from('creator_sync_runs')
    .select('id')
    .eq('id', runId)
    .eq('creator_id', creator.id)
    .maybeSingle();

  if (!owned) return NextResponse.json({ error: 'Run not found' }, { status: 404 });

  const run = await advanceRun({ supabase, reviewBy: 'creator' }, runId);
  if (!run) return NextResponse.json({ error: 'Run not found' }, { status: 404 });

  return NextResponse.json({ run, totals: summariseRun(run) });
}
