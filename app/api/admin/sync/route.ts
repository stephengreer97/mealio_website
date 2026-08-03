import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';
import { requireAdmin } from '@/lib/requireAdmin';
import { log } from '@/lib/logger';
import {
  isConnectedPlatform,
  isSameSite,
  platformSourceForUrl,
  SOURCE_COLUMNS,
  SOURCE_LABELS,
  type PlatformSource,
} from '@/lib/creator-sources';
import { normalizeUrl } from '@/lib/import/ssrf';
import { CATALOG_MAX_ENTRIES, retrySyncItem, summariseRun, toSyncRun, type SyncItem } from '@/lib/admin-sync';

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

/** A selection this size is already a $13 run; beyond it, sync in batches. */
const MAX_SELECTION = CATALOG_MAX_ENTRIES;

const CREATOR_FIELDS = 'id, user_id, display_name, website_url, youtube_url, instagram_url, tiktok_url, feed_url';

/**
 * `normalizeUrl` insists on a scheme, and an operator pasting `theirblog.com/x`
 * has given us a perfectly good link. Same leniency as the creator link fields.
 */
function toUrl(raw: unknown): string | null {
  const input = typeof raw === 'string' ? raw.trim() : '';
  if (!input) return null;
  return normalizeUrl(/^[a-z][a-z0-9+.-]*:/i.test(input) ? input : `https://${input}`);
}

function newItem(input: { itemId: string; url: string; title?: unknown; publishedAt?: unknown }): SyncItem {
  return {
    itemId: input.itemId,
    url: input.url,
    title: typeof input.title === 'string' ? input.title.slice(0, 300) : null,
    publishedAt: typeof input.publishedAt === 'string' ? input.publishedAt : null,
    status: 'pending',
    detail: null,
    draftId: null,
    mealName: null,
    needALook: null,
    photoUrl: null,
    ingredientCount: null,
    costUsd: 0,
  };
}

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
    const url = toUrl(body.url);
    if (!url) {
      return NextResponse.json({ error: 'That does not look like an http or https link.' }, { status: 400 });
    }
    // Derived, not asked for: the record has to land under the same source the
    // checklist and the poller would use for this post.
    source = platformSourceForUrl(url);
    // The URL is its own stable id here. A feed guid is better when we have one,
    // and a later catalog sync of the same post will match on it — but for a
    // pasted link the normalised URL is the only identity available.
    items = [newItem({ itemId: url, url })];
  } else {
    const requested = body.source;
    source = typeof requested === 'string' && requested in SOURCE_COLUMNS ? (requested as PlatformSource) : 'website';
    if (!Array.isArray(body.items) || body.items.length === 0) {
      return NextResponse.json({ error: 'Select at least one item.' }, { status: 400 });
    }
    if (body.items.length > MAX_SELECTION) {
      return NextResponse.json(
        { error: `That is ${body.items.length} items. Sync at most ${MAX_SELECTION} at a time.` },
        { status: 400 },
      );
    }

    // Every URL has to be on the creator's own site. The client got these rows
    // from their feed, so a cross-host entry means either a hijacked feed or a
    // hand-edited request — and publishing a stranger's recipe under a creator's
    // name is precisely the outcome MEAL-77 exists to prevent.
    //
    // The three connected platforms are exempt from the *link* requirement
    // because the account comes from the OAuth grant, so a creator who connected
    // properly can be synced with no `youtube_url` / `instagram_url` /
    // `tiktok_url` on their row at all. They are not exempt from the check: the
    // rules below are stricter, and the worker reads every item out of the
    // creator's own account listing by id whatever the URL claims.
    const site = (creator[SOURCE_COLUMNS[source] as keyof typeof creator] as string | null) || creator.feed_url;
    if (!site && !isConnectedPlatform(source)) {
      return NextResponse.json({ error: 'This creator has no link for that source.' }, { status: 400 });
    }

    items = [];
    for (const raw of body.items as Array<Record<string, unknown>>) {
      const url = toUrl(raw?.url);
      const itemId = typeof raw?.itemId === 'string' && raw.itemId ? raw.itemId : url;
      if (!url || !itemId) {
        return NextResponse.json({ error: 'Every selected item needs a URL.' }, { status: 400 });
      }
      if (source === 'website' && !isSameSite(site!, url)) {
        return NextResponse.json(
          { error: `${url} is not on this creator's own site. Refusing the whole selection.` },
          { status: 400 },
        );
      }
      // The recorded URL has to be the watch page for the very video id being
      // recorded. Otherwise `creator_source_items` ends up describing one video
      // with another's link, which is what MEAL-79 later reads to decide which
      // video a published meal came from.
      if (source === 'youtube' && url !== `https://www.youtube.com/watch?v=${itemId}`) {
        return NextResponse.json(
          { error: `${url} is not the watch page for video ${itemId}. Refusing the whole selection.` },
          { status: 400 },
        );
      }
      // Instagram and TikTok cannot get the same treatment: a permalink carries
      // a shortcode, not the media id, and there is no way to derive one from
      // the other. What can be insisted on is the host — a row claiming an
      // Instagram post lives on somebody else's domain is either a hand-edited
      // request or a bug, and either way it is not a URL to record under this
      // creator's name.
      if ((source === 'instagram' || source === 'tiktok') && platformSourceForUrl(url) !== source) {
        return NextResponse.json(
          { error: `${url} is not a ${SOURCE_LABELS[source]} link. Refusing the whole selection.` },
          { status: 400 },
        );
      }
      items.push(newItem({ itemId, url, title: raw?.title, publishedAt: raw?.publishedAt }));
    }
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
