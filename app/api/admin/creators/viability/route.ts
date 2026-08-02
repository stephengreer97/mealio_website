import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';
import { requireAdmin } from '@/lib/requireAdmin';
import { log } from '@/lib/logger';
import { isPlatformSource, SOURCE_COLUMNS, SOURCE_LABELS } from '@/lib/creator-sources';
import { runViabilityCheck } from '@/lib/import/viability';

/**
 * POST /api/admin/creators/viability — can this creator be imported at all?
 *
 * Takes one creator and one of their four links, pulls their last ~10 items and
 * runs each through the same gate the poller uses. Committing a creator to a
 * source without this is committing to a coin flip: a TikTok whose captions are
 * not recipes produces nothing, forever, and nobody finds out because "no
 * imports yet" and "no imports ever" look the same.
 *
 * Read-only on purpose. The discovered feed comes back for a human to look at
 * and is stored only when they PATCH it — a discovery is a guess made from a
 * hostname, and a silent wrong guess starts importing a stranger's recipes under
 * a creator's name.
 */

// Up to ten page fetches plus ten classifier calls in one request; the default
// 10s function budget is nowhere near enough.
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  const admin = await requireAdmin(request);
  if (!admin) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  let body: { id?: unknown; source?: unknown; feedUrl?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const id = typeof body.id === 'string' ? body.id : '';
  if (!id) {
    return NextResponse.json({ error: 'id is required' }, { status: 400 });
  }
  if (!isPlatformSource(body.source)) {
    return NextResponse.json({ error: 'source must be website, youtube, instagram or tiktok' }, { status: 400 });
  }
  const source = body.source;

  const supabase = createServerSupabaseClient();
  const { data: creator } = await supabase
    .from('creators')
    .select('id, display_name, website_url, youtube_url, instagram_url, tiktok_url, feed_url')
    .eq('id', id)
    .maybeSingle();

  if (!creator) {
    return NextResponse.json({ error: 'Creator not found' }, { status: 404 });
  }

  // The link comes from the creator's row, never from the request body: this
  // endpoint makes our server fetch a URL, and the set of URLs it will fetch
  // should be the set a creator actually gave us.
  const link = creator[SOURCE_COLUMNS[source] as keyof typeof creator];
  if (typeof link !== 'string' || !link) {
    return NextResponse.json(
      { error: `This creator has no ${SOURCE_LABELS[source]} link to check.` },
      { status: 400 },
    );
  }

  // A feed the operator has already confirmed is re-read rather than
  // re-discovered; re-deriving it would make the confirmation meaningless.
  const feedUrl = typeof body.feedUrl === 'string' && body.feedUrl.trim()
    ? body.feedUrl.trim()
    : (typeof creator.feed_url === 'string' ? creator.feed_url : null);

  const report = await runViabilityCheck(source, link, {
    feedUrl: source === 'website' ? feedUrl : null,
  });

  log({
    event: 'ADMIN:CREATOR_VIABILITY',
    status: report.outcome === 'viable' || report.outcome === 'partial' ? 'success' : 'error',
    userId: admin.userId,
    email: admin.email,
    // `link` and the feed URL are creator-supplied, so both are JSON-quoted —
    // a raw newline in either would forge a log line.
    detail:
      `creator=${id} source=${source} outcome=${report.outcome} ` +
      `passed=${report.passed}/${report.checked} cost=$${report.costUsd.toFixed(4)} ` +
      `link=${JSON.stringify(link)} feed=${JSON.stringify(report.feed?.url ?? null)}`,
  });

  return NextResponse.json({ report });
}
