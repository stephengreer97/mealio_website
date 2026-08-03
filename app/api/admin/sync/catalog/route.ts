import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';
import { requireAdmin } from '@/lib/requireAdmin';
import { isPlatformSource } from '@/lib/creator-sources';
import { buildCatalog } from '@/lib/admin-sync';
import { isUploadsPageToken } from '@/lib/youtube';

/**
 * POST /api/admin/sync/catalog — one window of what a creator's source publishes.
 *
 * The checklist behind Mode 2 (MEAL-90). Listing metadata only: title, date,
 * link, and the already-imported marker read from `creator_source_items`. **No
 * page fetches and no model calls** — opening this on a 200-post blog costs the
 * feed request and one database query, which is what makes the screen safe to
 * open out of curiosity.
 *
 * `pageToken` is the back-catalogue half of MEAL-79. YouTube is the only paged
 * source, and each call lists **one page**: an operator asks for the next 50 by
 * pressing a button, so a 300-video channel is not walked because somebody
 * opened a tab. That matters here in a way it did not for the other three —
 * YouTube listing spends units out of a shared daily budget.
 *
 * Request:  { creatorId: string, source: 'website' | ..., pageToken?: string }
 * Response: 200 with a CatalogResult, or 422 when the source cannot be listed.
 */

// One feed fetch (plus robots.txt) against a site that may be slow. Nowhere near
// the import budget, but more than the 10s default.
export const maxDuration = 30;

export async function POST(request: NextRequest) {
  const admin = await requireAdmin(request);
  if (!admin) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  let body: { creatorId?: unknown; source?: unknown; pageToken?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const creatorId = typeof body.creatorId === 'string' ? body.creatorId : '';
  if (!creatorId) {
    return NextResponse.json({ error: 'creatorId is required' }, { status: 400 });
  }
  if (!isPlatformSource(body.source)) {
    return NextResponse.json({ error: 'source must be website, youtube, instagram or tiktok' }, { status: 400 });
  }
  // Shape-checked before it is interpolated into a URL. The cursor cannot point
  // the listing at another channel — the playlist is resolved server-side from
  // the grant — but an unbounded string from a request body still has no
  // business reaching an outbound query.
  if (body.pageToken != null && !isUploadsPageToken(body.pageToken)) {
    return NextResponse.json({ error: 'pageToken is not a cursor YouTube issued' }, { status: 400 });
  }

  const supabase = createServerSupabaseClient();
  const { data: creator } = await supabase
    .from('creators')
    .select('id, user_id, display_name, website_url, youtube_url, instagram_url, tiktok_url, feed_url')
    .eq('id', creatorId)
    .maybeSingle();

  if (!creator) {
    return NextResponse.json({ error: 'Creator not found' }, { status: 404 });
  }

  // The links come from the creator's row, never from the request body: this
  // endpoint makes our server fetch a URL, and the set of URLs it will fetch
  // should be the set a creator actually gave us.
  const catalog = await buildCatalog({ supabase }, creator, body.source, {
    pageToken: typeof body.pageToken === 'string' ? body.pageToken : null,
  });

  return NextResponse.json({ catalog }, { status: catalog.ok ? 200 : 422 });
}
