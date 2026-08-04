import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';
import { requireAdmin } from '@/lib/requireAdmin';
import { log } from '@/lib/logger';
import { platformSourceForUrl, SOURCE_COLUMNS, type PlatformSource } from '@/lib/creator-sources';
import { sourceItemId } from '@/lib/creator-meals';
import { urlIdentity } from '@/lib/import/ssrf';
import {
  buildSelectionItems,
  CATALOG_MAX_ENTRIES,
  newSyncItem,
  retrySyncItem,
  summariseRun,
  toSyncRun,
  toSyncUrl,
  type SyncItem,
} from '@/lib/admin-sync';

/**
 * Admin sync runs (MEAL-90).
 *
 * POST  — create a run from one link or from a checklist selection. Enqueues
 *         only; the work is done by `/api/admin/sync/worker`, because 200 items
 *         will not finish inside a Vercel function and a request that dies
 *         halfway is a batch nobody can account for.
 * GET   — a run's progress (`?runId=`), or a creator's recent runs (`?creatorId=`).
 * PATCH — put one failed item back in the queue.
 *
 * Nothing here publishes (MEAL-91). A run produces drafts in the admin review
 * queue, where a human looks at each meal card and decides. The email announcing
 * what went live fires from Approve, which is the first moment anything has.
 */

/** A selection this size is already a ~$3 run; beyond it, sync in batches. */
const MAX_SELECTION = CATALOG_MAX_ENTRIES;

const CREATOR_FIELDS = 'id, user_id, display_name, website_url, youtube_url, instagram_url, tiktok_url, feed_url';

export async function POST(request: NextRequest) {
  const admin = await requireAdmin(request);
  if (!admin) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  let body: {
    creatorId?: unknown;
    mode?: unknown;
    url?: unknown;
    source?: unknown;
    items?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const creatorId = typeof body.creatorId === 'string' ? body.creatorId : '';
  if (!creatorId) {
    return NextResponse.json({ error: 'creatorId is required' }, { status: 400 });
  }
  if (body.mode !== 'link' && body.mode !== 'catalog') {
    return NextResponse.json({ error: "mode must be 'link' or 'catalog'" }, { status: 400 });
  }
  const mode = body.mode;

  // There is no notify flag on a run any more. A run publishes nothing, so
  // there is nothing to announce until an operator approves something — the
  // "email the creator" decision moved to the approve action with it.

  const supabase = createServerSupabaseClient();
  const { data: creator } = await supabase.from('creators').select(CREATOR_FIELDS).eq('id', creatorId).maybeSingle();
  if (!creator) {
    return NextResponse.json({ error: 'Creator not found' }, { status: 404 });
  }

  let source: PlatformSource;
  let items: SyncItem[];

  if (mode === 'link') {
    const url = toSyncUrl(body.url);
    if (!url) {
      return NextResponse.json({ error: 'That does not look like an http or https link.' }, { status: 400 });
    }
    // Derived, not asked for: the record has to land under the same source the
    // checklist and the poller would use for this post.
    source = platformSourceForUrl(url);
    // The URL is its own stable id here. A feed guid is better when we have one,
    // and a later catalog sync of the same post will match on it — but for a
    // pasted link the URL is the only identity available, so it is the *folded*
    // one: `http://x/p`, `https://x/p` and `https://www.x/p` are one post, and
    // three item_ids for it are three drafts and three published meals.
    //
    // Except where the source has an id of its own. A pasted YouTube link has to
    // key on the video id, because that is what the catalog, the uploads-feed
    // lookup that reads the video, and MEAL-79's relationship all use — keyed on
    // the URL the run cannot even find the video it was given.
    items = [newSyncItem({ itemId: sourceItemId(source, urlIdentity(url) ?? url), url })];
  } else {
    const requested = body.source;
    source = typeof requested === 'string' && requested in SOURCE_COLUMNS ? (requested as PlatformSource) : 'website';
    // Every rule about whose posts these are lives in `buildSelectionItems`,
    // shared with the creator's own checklist (MEAL-101). A guard enforced on
    // one of two routes that accept a selection is the guard not existing.
    const selection = buildSelectionItems(creator, source, body.items, MAX_SELECTION);
    if (!selection.ok) {
      return NextResponse.json({ error: selection.error }, { status: 400 });
    }
    items = selection.items;
  }

  const { data: run, error } = await supabase
    .from('creator_sync_runs')
    .insert({
      creator_id: creatorId,
      source,
      mode,
      status: 'queued',
      requested_by: admin.userId,
      items,
    })
    .select()
    .single();

  if (error || !run) {
    log({ event: 'ADMIN:SYNC_RUN', status: 'error', userId: admin.userId, email: admin.email, error });
    return NextResponse.json({ error: error?.message ?? 'Could not create the run' }, { status: 500 });
  }

  log({
    event: 'ADMIN:SYNC_RUN',
    status: 'pending',
    userId: admin.userId,
    email: admin.email,
    detail: `run=${run.id} creator=${creatorId} mode=${mode} source=${source} items=${items.length}`,
  });

  return NextResponse.json({ run: toSyncRun(run) }, { status: 201 });
}

export async function GET(request: NextRequest) {
  const admin = await requireAdmin(request);
  if (!admin) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const runId = request.nextUrl.searchParams.get('runId');
  const creatorId = request.nextUrl.searchParams.get('creatorId');
  const supabase = createServerSupabaseClient();

  if (runId) {
    const { data } = await supabase.from('creator_sync_runs').select('*').eq('id', runId).maybeSingle();
    if (!data) {
      return NextResponse.json({ error: 'Run not found' }, { status: 404 });
    }
    const run = toSyncRun(data);
    return NextResponse.json({ run, totals: summariseRun(run) });
  }

  if (!creatorId) {
    return NextResponse.json({ error: 'runId or creatorId is required' }, { status: 400 });
  }

  const { data } = await supabase
    .from('creator_sync_runs')
    .select('*')
    .eq('creator_id', creatorId)
    .order('created_at', { ascending: false })
    .limit(10);

  const runs = ((data ?? []) as Array<Record<string, any>>).map(toSyncRun);
  return NextResponse.json({ runs, totals: runs.map(summariseRun) });
}

export async function PATCH(request: NextRequest) {
  const admin = await requireAdmin(request);
  if (!admin) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  let body: { runId?: unknown; itemId?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const runId = typeof body.runId === 'string' ? body.runId : '';
  const itemId = typeof body.itemId === 'string' ? body.itemId : '';
  if (!runId || !itemId) {
    return NextResponse.json({ error: 'runId and itemId are required' }, { status: 400 });
  }

  const supabase = createServerSupabaseClient();
  const result = await retrySyncItem({ supabase }, runId, itemId);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }

  log({
    event: 'ADMIN:SYNC_ITEM',
    status: 'pending',
    userId: admin.userId,
    email: admin.email,
    detail: `run=${runId} retry item=${JSON.stringify(itemId)}`,
  });

  return NextResponse.json({ run: result.run, totals: summariseRun(result.run) });
}
