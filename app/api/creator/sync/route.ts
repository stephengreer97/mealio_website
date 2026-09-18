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
import { checkCreatorImportBudget } from '@/lib/import/creator-budget';

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

  // One run at a time per creator (review finding 6). Two runs over the same
  // catalogue race each other for the same posts and double what a creator can
  // spend in a sitting; the cap per run means nothing if runs can be stacked.
  // The active run goes back with the refusal, so the screen can put its Carry
  // on button up rather than leave a creator who lost the tab with no way back.
  const { data: active } = await supabase
    .from('creator_sync_runs')
    .select('*')
    .eq('creator_id', creator.id)
    .neq('status', 'done')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (active) {
    const activeRun = toSyncRun(active as Record<string, any>);
    return NextResponse.json(
      {
        error: 'An import is already under way. Carry it on, or wait for it to finish, before starting another.',
        run: activeRun,
        totals: summariseRun(activeRun),
      },
      { status: 409 },
    );
  }

  // A post the gate already read and called not-a-recipe, or whose draft a
  // person declined, is re-read only when the creator ticked it on purpose,
  // which the screen says with `reselect` (it keeps these out of "Tick the
  // newest", so any in a selection were ticked one at a time). Without the flag
  // they are dropped rather than paid for again to most likely hear the same no.
  const reselected = new Set(
    (body.items as Array<Record<string, unknown>>)
      .filter((entry) => entry?.reselect === true && typeof entry?.itemId === 'string')
      .map((entry) => entry.itemId as string),
  );
  // unbounded-select-ok: filtered to the selection's own item ids, which
  // buildSelectionItems caps at CREATOR_SELECTION_MAX (100), one row per id
  const { data: settledRows } = await supabase
    .from('creator_source_items')
    .select('item_id')
    .eq('creator_id', creator.id)
    .eq('source', body.source)
    .in('status', ['rejected', 'declined'])
    .in('item_id', selection.items.map((item) => item.itemId));
  const settled = new Set(((settledRows ?? []) as Array<{ item_id: string }>).map((row) => row.item_id));
  const items = selection.items.filter((item) => !settled.has(item.itemId) || reselected.has(item.itemId));
  if (items.length === 0) {
    return NextResponse.json(
      { error: 'Every post you selected was already read and did not look like a recipe. Tick one on its own to have it read again.' },
      { status: 400 },
    );
  }

  // A daily ceiling per creator, in imports and in dollars (review finding 6).
  const budget = await checkCreatorImportBudget(supabase, creator.id, items.length);
  if (!budget.ok) return NextResponse.json({ error: budget.error }, { status: 429 });

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
      items,
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
    detail:
      `run=${run.id} creator=${creator.id} source=${body.source} items=${items.length}` +
      (items.length < selection.items.length ? ` dropped=${selection.items.length - items.length} already-rejected` : ''),
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
