import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';
import { requireAuth } from '@/lib/requireAuth';
import { isPlatformSource, creatorSourceBlockedReason } from '@/lib/creator-sources';
import { buildCatalog } from '@/lib/admin-sync';
import { isUploadsPageToken } from '@/lib/youtube';

/**
 * POST /api/creator/sync/catalog — what this creator has already published
 * (MEAL-101).
 *
 * The same listing the admin catalogue screen draws, scoped to the caller's own
 * creator row. `buildCatalog` is called rather than reimplemented — a second
 * copy of the listing rules is how the `item_id` a checklist writes drifts from
 * the one the poller reads, and then a post already imported is imported again.
 *
 * It exists because **the first poll baselines**: everything already published
 * is marked seen rather than imported (MEAL-75). Without this list, connecting a
 * source looks like nothing happened. With it, the back catalogue is something
 * the creator chooses from rather than something that either floods them or
 * silently never arrives.
 *
 * Listing metadata only — titles, dates, links and the already-imported marker.
 * No page is fetched and no model is called, which is what makes it safe to draw
 * for a 200-post blog on every visit to the portal.
 *
 * Request:  { source: 'website' | 'youtube' | …, pageToken?: string }
 * Response: 200 with a CatalogResult, or 422 when the source cannot be listed.
 */

// One feed fetch (plus robots.txt) against a site that may be slow.
export const maxDuration = 30;

/** Everything `buildCatalog` reads off the row. */
const CREATOR_FIELDS = 'id, user_id, display_name, website_url, youtube_url, instagram_url, tiktok_url, feed_url';

export async function POST(request: NextRequest) {
  const user = await requireAuth(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: { source?: unknown; pageToken?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!isPlatformSource(body.source)) {
    return NextResponse.json({ error: 'source must be website, youtube, instagram or tiktok' }, { status: 400 });
  }
  // A source no creator can use yet has nothing to list, and listing it would
  // spend a request to produce a confusing empty checklist under a dropdown
  // option that is disabled anyway.
  const blocked = creatorSourceBlockedReason(body.source);
  if (blocked) return NextResponse.json({ error: blocked }, { status: 400 });

  // Shape-checked before it reaches an outbound URL. None of these can point the
  // listing somewhere else — the playlist, the grant and the feed address are all
  // resolved server-side from the row — but an unbounded string out of a request
  // body still has no business being appended to one.
  //
  // Three shapes, checked separately rather than under one rule loose enough to
  // admit all of them: YouTube's is an opaque token, TikTok's is a creation time
  // in milliseconds, and a website's is a page number.
  if (body.pageToken != null) {
    const valid = body.source === 'tiktok' || body.source === 'website'
      ? typeof body.pageToken === 'string' && /^\d{1,19}$/.test(body.pageToken)
      : isUploadsPageToken(body.pageToken);
    if (!valid) {
      return NextResponse.json({ error: 'pageToken is not a cursor that source issued' }, { status: 400 });
    }
  }

  const supabase = createServerSupabaseClient();
  // By `user_id`, never by an id in the body. This endpoint makes our server
  // fetch a URL and read a grant, and the only creator either may belong to is
  // the one holding the token.
  const { data: creator } = await supabase
    .from('creators')
    .select(CREATOR_FIELDS)
    .eq('user_id', user.userId)
    .maybeSingle();

  if (!creator) {
    return NextResponse.json({ error: 'Only approved creators have a catalogue.' }, { status: 403 });
  }

  const catalog = await buildCatalog({ supabase }, creator, body.source, {
    pageToken: typeof body.pageToken === 'string' ? body.pageToken : null,
  });

  return NextResponse.json({ catalog }, { status: catalog.ok ? 200 : 422 });
}
