import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';
import { requireAdmin } from '@/lib/requireAdmin';
import { isPlatformSource } from '@/lib/creator-sources';
import { buildCatalog } from '@/lib/admin-sync';

/**
 * POST /api/admin/sync/catalog — everything a creator's source publishes.
 *
 * The checklist behind Mode 2 (MEAL-90). Feed metadata only: title, date, link,
 * and the already-imported marker read from `creator_source_items`. **No page
 * fetches and no model calls** — opening this on a 200-post blog costs the feed
 * request and one database query, which is what makes the screen safe to open
 * out of curiosity.
 *
 * Request:  { creatorId: string, source: 'website' | ... }
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

  let body: { creatorId?: unknown; source?: unknown };
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
  const catalog = await buildCatalog({ supabase }, creator, body.source);

  return NextResponse.json({ catalog }, { status: catalog.ok ? 200 : 422 });
}
