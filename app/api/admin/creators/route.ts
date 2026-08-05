import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';
import { requireAdmin } from '@/lib/requireAdmin';
import { log } from '@/lib/logger';
import {
  checkPollingInvariants,
  describeHostMismatch,
  isPrimarySource,
  normalizePlatformUrl,
} from '@/lib/creator-sources';
import { pollHealthByCreator } from '@/lib/poll-health';

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

/**
 * The columns the admin UI needs. Kept in one place so GET and PATCH agree.
 *
 * `import_paused_reason` / `import_paused_at` are here because the Sources tab
 * renders them: a paused import used to exist only as an email and a log line,
 * and "why is this creator not being polled?" three months later had no answer
 * once the email was gone.
 */
const CREATOR_FIELDS =
  'id, display_name, handle, website_url, youtube_url, instagram_url, tiktok_url, primary_source, import_opt_in, feed_url, import_paused_reason, import_paused_at';

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

  const creatorRows = (data ?? []) as Array<{ id: string; primary_source?: string | null }>;
  const creatorIds = creatorRows.map((row) => row.id);
  // Which source each creator is actually polled on. `creator_source_state` is
  // keyed `(creator_id, source)` and the PATCH below never deletes the row for a
  // source it moves a creator off, so without this the row rendered is whichever
  // of the leftovers came back last — and the tab would report a creator on
  // YouTube as a Website that stopped working months ago.
  const primarySource = new Map(creatorRows.map((row) => [row.id, row.primary_source ?? null]));

  // Which platforms each creator has connected, and which of those connections
  // have stopped working (MEAL-74). Two reasons this belongs on the list an
  // operator already reads: a connected channel can be synced with no link on
  // the row at all, and a broken grant is otherwise indistinguishable from a
  // creator who simply published nothing.
  //
  // Deliberately selected column by column: `select *` on this table would
  // carry refresh tokens into an admin response.
  //
  // Poll health alongside it (MEAL-96): a fixed handful of queries for the whole
  // page, so the Sources tab stays one request no matter how many creators it
  // lists. Both reads are independent of each other, hence in parallel.
  const [{ data: accounts }, health] = await Promise.all([
    supabase
      .from('creator_platform_accounts')
      .select('creator_id, platform, external_id, external_name, broken_reason, broken_at'),
    pollHealthByCreator(supabase, creatorIds, primarySource),
  ]);

  const byCreator = new Map<string, Array<Record<string, unknown>>>();
  for (const row of (accounts ?? []) as Array<Record<string, any>>) {
    const list = byCreator.get(row.creator_id) ?? [];
    list.push({
      platform: row.platform,
      externalId: row.external_id ?? null,
      externalName: row.external_name ?? null,
      brokenReason: row.broken_reason ?? null,
      brokenAt: row.broken_at ?? null,
    });
    byCreator.set(row.creator_id, list);
  }

  const creators = ((data ?? []) as Array<Record<string, any>>).map((creator) => ({
    ...creator,
    connections: byCreator.get(creator.id) ?? [],
    pollHealth: health.get(creator.id) ?? null,
  }));

  return NextResponse.json({ creators });
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

  // The creator's OAuth grants, because for YouTube, Instagram and TikTok the
  // grant *is* the thing that gets polled — the channel id comes off it and
  // never off a link (MEAL-79 / 82 / 83). Read here rather than left out so this
  // route and the creator's own picker judge a row on the same evidence; without
  // it an operator would be refused for a creator who has connected properly and
  // never pasted a link, which the poller reads perfectly well.
  const { data: accounts } = await supabase
    .from('creator_platform_accounts')
    .select('platform')
    .eq('creator_id', id);
  const grants = ((accounts ?? []) as Array<{ platform: string }>).map((row) => row.platform);

  // Judged on the row this request would leave behind, not the fields it sent —
  // and by the same function the creator's own link editor calls (MEAL-94), so
  // the two paths cannot drift into disagreeing about what a pollable creator is.
  const resulting = { ...creator, ...update };
  const verdict = checkPollingInvariants(resulting, body.importOptIn === true, grants);
  if (!verdict.ok) {
    return NextResponse.json({ error: verdict.error }, { status: 400 });
  }
  // Written only when the verdict *changed* it — clearing the source turns the
  // switch off with it. Otherwise a request that never mentioned import stays a
  // request that never mentioned import, in the row and in the log line.
  if (verdict.importOptIn !== (resulting.import_opt_in === true)) {
    update.import_opt_in = verdict.importOptIn;
  }

  // Turning the switch back on is an operator saying they have looked, which is
  // the answer the pause record was waiting for. Left behind it would have the
  // Sources tab report a paused import beside a creator that is being polled —
  // and the next operator would have to work out which of the two to believe.
  // Only on the write that turns it on: a request that never touched the switch
  // must not quietly erase why it is off.
  if (update.import_opt_in === true) {
    update.import_paused_reason = null;
    update.import_paused_at = null;
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
