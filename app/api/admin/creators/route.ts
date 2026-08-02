import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';
import { requireAdmin } from '@/lib/requireAdmin';
import { log } from '@/lib/logger';
import {
  describeHostMismatch,
  isPrimarySource,
  normalizePlatformUrl,
  SOURCE_COLUMNS,
  SOURCE_LABELS,
} from '@/lib/creator-sources';

/**
 * Creator sources: which of a creator's four links we poll (MEAL-81).
 *
 * GET  — every creator with their four links and current polling settings.
 * PATCH — set `primary_source`, `feed_url`, and the `import_opt_in` switch.
 *
 * The decision is manual by design. There are zero creators, so automated
 * cross-source ranking optimises for a population nobody has met, and picking
 * the source by hand is the same look at the same content the operator is
 * already doing to approve the application. It also deletes per-recipe identity,
 * cross-source dedupe and ranking outright: polling one source means a creator
 * who posts the same guacamole to a blog and a Reel never produces two meals.
 */

/** The columns the admin UI needs. Kept in one place so GET and PATCH agree. */
const CREATOR_FIELDS =
  'id, display_name, handle, website_url, youtube_url, instagram_url, tiktok_url, primary_source, import_opt_in, feed_url';

export async function GET(request: NextRequest) {
  const admin = await requireAdmin(request);
  if (!admin) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const supabase = createServerSupabaseClient();
  const { data, error } = await supabase
    .from('creators')
    .select(CREATOR_FIELDS)
    .order('created_at', { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ creators: data ?? [] });
}

export async function PATCH(request: NextRequest) {
  const admin = await requireAdmin(request);
  if (!admin) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  let body: { id?: unknown; primarySource?: unknown; importOptIn?: unknown; feedUrl?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const id = typeof body.id === 'string' ? body.id : '';
  if (!id) {
    return NextResponse.json({ error: 'id is required' }, { status: 400 });
  }
  if (body.primarySource !== undefined && !isPrimarySource(body.primarySource)) {
    return NextResponse.json({ error: 'primarySource must be website, youtube, instagram, tiktok or none' }, { status: 400 });
  }
  if (body.importOptIn !== undefined && typeof body.importOptIn !== 'boolean') {
    return NextResponse.json({ error: 'importOptIn must be a boolean' }, { status: 400 });
  }

  const supabase = createServerSupabaseClient();
  const { data: creator, error: fetchError } = await supabase
    .from('creators')
    .select(CREATOR_FIELDS)
    .eq('id', id)
    .maybeSingle();

  if (fetchError || !creator) {
    return NextResponse.json({ error: 'Creator not found' }, { status: 404 });
  }

  const update: Record<string, unknown> = {};
  if (body.primarySource !== undefined && isPrimarySource(body.primarySource)) {
    update.primary_source = body.primarySource;
  }

  if (body.feedUrl !== undefined) {
    const feedUrl = normalizePlatformUrl('website', body.feedUrl);
    if (!feedUrl.ok) {
      return NextResponse.json({ error: `Feed URL: ${feedUrl.error}` }, { status: 400 });
    }
    if (feedUrl.url) {
      // The feed has to belong to the site the creator gave us. Discovery is a
      // guess made from a hostname and this field is what the poller reads
      // forever after — a cross-host value here is how we would end up
      // importing a stranger's recipes under a creator's name.
      const website = typeof creator.website_url === 'string' ? creator.website_url : '';
      const mismatch = describeHostMismatch(website, feedUrl.url);
      if (mismatch) {
        return NextResponse.json({ error: mismatch }, { status: 400 });
      }
    }
    update.feed_url = feedUrl.url;
  }

  if (body.importOptIn !== undefined) update.import_opt_in = body.importOptIn;

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: 'Nothing to update' }, { status: 400 });
  }

  // ── Judge the row this request would leave behind, not the fields it sent ──
  //
  // Every invariant below is about a *combination* of columns, so validating
  // only the ones a request happened to mention validates nothing: the radio
  // button sends `primarySource` alone and the feed-confirm button sends
  // `feedUrl` alone, and either can walk an already-opted-in creator into a
  // state these lines exist to refuse — pointed at a source they have no link
  // for, or polling a website whose feed was just cleared.
  const resulting = { ...creator, ...update };
  const primarySource = isPrimarySource(resulting.primary_source) ? resulting.primary_source : 'none';

  // Clearing the source turns polling off with it. Leaving an opt-in set against
  // 'none' would be a switch that means nothing today and the wrong thing the
  // day someone picks a source. A request that explicitly asks for opt-in with
  // no source is a contradiction rather than an off switch, and is refused below.
  if (primarySource === 'none' && resulting.import_opt_in && body.importOptIn !== true) {
    update.import_opt_in = false;
    resulting.import_opt_in = false;
  }

  if (resulting.import_opt_in) {
    // Nothing is polled until a source is chosen AND opt-in is true. Refusing
    // the incoherent combination here means the poller never has to wonder
    // what an opted-in creator with no source means.
    if (primarySource === 'none') {
      return NextResponse.json(
        { error: 'Choose a source of truth before turning import on — nothing is polled without one.' },
        { status: 400 },
      );
    }
    const link = resulting[SOURCE_COLUMNS[primarySource] as keyof typeof resulting];
    if (!link) {
      return NextResponse.json(
        { error: `This creator has no ${SOURCE_LABELS[primarySource]} link, so there is nothing to poll.` },
        { status: 400 },
      );
    }
    // For a website the feed URL *is* the thing polled, and it must be one a
    // human confirmed — that confirmation step is the whole defence against a
    // silently wrong discovery.
    if (primarySource === 'website' && !resulting.feed_url) {
      return NextResponse.json(
        { error: 'Confirm the discovered feed URL before turning import on.' },
        { status: 400 },
      );
    }
  }

  const { error } = await supabase.from('creators').update(update).eq('id', id);
  if (error) {
    log({ event: 'ADMIN:CREATOR_SOURCE', status: 'error', userId: admin.userId, email: admin.email, error });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  log({
    event: 'ADMIN:CREATOR_SOURCE',
    status: 'success',
    userId: admin.userId,
    email: admin.email,
    detail: `creator=${id} ${Object.entries(update).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ')}`,
  });

  return NextResponse.json({ ok: true, creator: { ...creator, ...update } });
}
