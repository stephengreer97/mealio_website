import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';
import { requireAdmin } from '@/lib/requireAdmin';
import { log } from '@/lib/logger';
import {
  isPrimarySource,
  normalizePlatformUrl,
  SOURCE_COLUMNS,
  SOURCE_LABELS,
  type PlatformSource,
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

  // Validate the result of the change, not the change itself: a request that
  // only flips the opt-in has to be judged against the source already stored.
  const primarySource = body.primarySource !== undefined && isPrimarySource(body.primarySource)
    ? body.primarySource
    : (creator.primary_source ?? 'none');
  const importOptIn = typeof body.importOptIn === 'boolean' ? body.importOptIn : Boolean(creator.import_opt_in);

  const update: Record<string, unknown> = {};
  if (body.primarySource !== undefined) update.primary_source = primarySource;

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

  if (body.importOptIn !== undefined) {
    if (importOptIn) {
      // Nothing is polled until a source is chosen AND opt-in is true. Refusing
      // the incoherent combination here means the poller never has to wonder
      // what an opted-in creator with no source means.
      if (primarySource === 'none') {
        return NextResponse.json(
          { error: 'Choose a source of truth before turning import on — nothing is polled without one.' },
          { status: 400 },
        );
      }
      const link = creator[SOURCE_COLUMNS[primarySource as PlatformSource] as keyof typeof creator];
      if (!link) {
        return NextResponse.json(
          { error: `This creator has no ${SOURCE_LABELS[primarySource as PlatformSource]} link, so there is nothing to poll.` },
          { status: 400 },
        );
      }
      // For a website the feed URL *is* the thing polled, and it must be one a
      // human confirmed — that confirmation step is the whole defence against a
      // silently wrong discovery.
      const feedUrl = update.feed_url !== undefined ? update.feed_url : creator.feed_url;
      if (primarySource === 'website' && !feedUrl) {
        return NextResponse.json(
          { error: 'Confirm the discovered feed URL before turning import on.' },
          { status: 400 },
        );
      }
    }
    update.import_opt_in = importOptIn;
  }

  // Clearing the source turns polling off with it. Leaving an opt-in set against
  // 'none' would be a switch that means nothing today and the wrong thing the
  // day someone picks a source.
  if (update.primary_source === 'none') update.import_opt_in = false;

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: 'Nothing to update' }, { status: 400 });
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

/** Returns an operator-facing complaint when a feed URL is not on the creator's own site. */
function describeHostMismatch(websiteUrl: string, feedUrl: string): string | null {
  if (!websiteUrl) return 'Set the creator\'s website link before storing a feed URL.';
  let site: string;
  let feed: string;
  try {
    site = new URL(websiteUrl).hostname.toLowerCase();
    feed = new URL(feedUrl).hostname.toLowerCase();
  } catch {
    return 'Feed URL: that is not a URL we can fetch.';
  }
  if (feed === site || feed.endsWith(`.${site}`) || site.endsWith(`.${feed}`)) return null;
  return `That feed (${feed}) is not on the creator's own site (${site}). Refusing it: a feed on someone else's host would import their recipes under this creator's name.`;
}
