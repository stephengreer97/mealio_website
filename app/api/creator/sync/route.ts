import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';
import { requireAuth } from '@/lib/requireAuth';
import { log } from '@/lib/logger';
import {
  creatorSourceBlockedReason,
  CREATOR_SELECTION_MAX,
  isPlatformSource,
} from '@/lib/creator-sources';
import { buildSelectionItems, summariseRun, toSyncRun } from '@/lib/admin-sync';

/**
 * The creator importing their own back catalogue (MEAL-101).
 *
 * POST — create a run from the items they ticked off their catalogue.
 * GET  — a run's progress (`?runId=`), for resuming after a closed tab.
 *
 * The same `creator_sync_runs` engine the admin screen drives, with two
 * differences that matter and are both deliberate:
 *
 *   1. **The run is scoped to the caller's own creator row**, resolved from
 *      their token. There is no `creatorId` in the body to get wrong.
 *   2. **Its drafts land in the creator's own review queue** (`review_by =
 *      'creator'`, set by the worker). They chose the posts and they are the one
 *      waiting on them; routing their own back catalogue through an operator's
 *      queue would make an import they asked for sit behind somebody else's
 *      afternoon.
 *
 * Nothing here publishes. A run produces `creator_import_drafts` rows waiting in
 * the review queue, which is where "comes back for review" is made true.
 */

/** Everything the engine reads off the row. */
const CREATOR_FIELDS = 'id, user_id, display_name, website_url, youtube_url, instagram_url, tiktok_url, feed_url';

export async function POST(request: NextRequest) {
  const user = await requireAuth(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: { source?: unknown; items?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!isPlatformSource(body.source)) {
    return NextResponse.json({ error: 'source must be website, youtube, instagram or tiktok' }, { status: 400 });
  }
  const blocked = creatorSourceBlockedReason(body.source);
  if (blocked) return NextResponse.json({ error: blocked }, { status: 400 });

  const supabase = createServerSupabaseClient();
  const { data: creator } = await supabase
    .from('creators')
    .select(CREATOR_FIELDS)
    .eq('user_id', user.userId)
    .maybeSingle();

  if (!creator) {
    return NextResponse.json({ error: 'Only approved creators can import a back catalogue.' }, { status: 403 });
  }

  // The cap is enforced here, not only counted on screen. A number rendered
  // beside a checkbox is a courtesy; this is the limit.
  const selection = buildSelectionItems(creator, body.source, body.items, CREATOR_SELECTION_MAX);
  if (!selection.ok) {
    return NextResponse.json({ error: selection.error }, { status: 400 });
  }

  const { data: run, error } = await supabase
    .from('creator_sync_runs')
    .insert({
      creator_id: creator.id,
      source: body.source,
      mode: 'catalog',
      status: 'queued',
      // The creator's own user id. `requested_by` is who asked for this, and for
      // a back-catalogue import that is genuinely them.
      requested_by: user.userId,
      items: selection.items,
    })
    .select()
    .single();

  if (error || !run) {
    log({ event: 'CREATOR:SYNC_RUN', status: 'error', userId: user.userId, email: user.email, error });
    return NextResponse.json({ error: error?.message ?? 'Could not start that import.' }, { status: 500 });
  }

  log({
    event: 'CREATOR:SYNC_RUN',
    status: 'pending',
    userId: user.userId,
    email: user.email,
    detail: `run=${run.id} creator=${creator.id} source=${body.source} items=${selection.items.length}`,
  });

  return NextResponse.json({ run: toSyncRun(run) }, { status: 201 });
}

export async function GET(request: NextRequest) {
  const user = await requireAuth(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const runId = request.nextUrl.searchParams.get('runId');
  if (!runId) return NextResponse.json({ error: 'runId is required' }, { status: 400 });

  const supabase = createServerSupabaseClient();
  const { data: creator } = await supabase
    .from('creators')
    .select('id')
    .eq('user_id', user.userId)
    .maybeSingle();

  if (!creator) return NextResponse.json({ error: 'Run not found' }, { status: 404 });

  // Filtered on the caller's own creator id in the query, rather than fetched
  // and then compared: a run id is a uuid somebody else's tab knows, and "not
  // yours" and "does not exist" get the same answer so neither confirms the
  // other exists.
  const { data } = await supabase
    .from('creator_sync_runs')
    .select('*')
    .eq('id', runId)
    .eq('creator_id', creator.id)
    .maybeSingle();

  if (!data) return NextResponse.json({ error: 'Run not found' }, { status: 404 });

  const run = toSyncRun(data as Record<string, any>);
  return NextResponse.json({ run, totals: summariseRun(run) });
}
