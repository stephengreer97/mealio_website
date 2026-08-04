import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';
import { requireAuth } from '@/lib/requireAuth';
import { log } from '@/lib/logger';
import {
  chooseCreatorSource,
  describeWebsiteImportFailure,
  normalizePlatformUrl,
} from '@/lib/creator-sources';
import { runViabilityCheck } from '@/lib/import/viability';

/**
 * POST /api/creator/website — a creator saving the site Mealio syncs from
 * (MEAL-101).
 *
 * The website half of the sync section: a box and a Save button. What Save does
 * is the whole point of the ticket — it runs **the full viability check**, the
 * one the admin already uses (`lib/import/viability.ts`): find the feed, read
 * the last ten posts, and ask the gate whether recipes can actually be
 * extracted from them.
 *
 * Deliberately not a reachability ping. "Your site answered a request" is not a
 * question anybody has, and a creator who passes that check and then imports
 * nothing forever is the exact failure MEAL-81 measured this way to prevent —
 * "no imports yet" and "no imports ever" look identical from the outside. It
 * takes a few seconds and spends a few cents on classification, and it answers
 * the question the creator is actually asking.
 *
 * On success it writes three things in one go, because from the creator's side
 * it is one action:
 *
 *   - `website_url`, normalised the way the application form normalises it;
 *   - `feed_url`, the feed the check actually read — the confirmation an
 *     operator used to give by hand is now given by the measurement itself,
 *     which is a stronger confirmation than a human squinting at a URL;
 *   - `primary_source` / `import_opt_in`, through `chooseCreatorSource`, so the
 *     one rule about what a creator may switch on holds here too.
 *
 * On failure it writes **nothing** and says why in the creator's terms
 * (`describeWebsiteImportFailure`). Never a status code: a creator handed
 * "403 on /feed" has been told nothing they can do anything about.
 */

// Feed discovery, up to ten page fetches and ten classifier calls, in series
// with each other. The same budget the admin's own check runs on.
export const maxDuration = 60;

/** The columns the source decision is judged against. */
const CREATOR_FIELDS =
  'id, website_url, youtube_url, instagram_url, tiktok_url, primary_source, import_opt_in, feed_url';

export async function POST(request: NextRequest) {
  const user = await requireAuth(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: { url?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const supabase = createServerSupabaseClient();
  const { data: creator } = await supabase
    .from('creators')
    .select(CREATOR_FIELDS)
    .eq('user_id', user.userId)
    .maybeSingle();

  if (!creator) {
    return NextResponse.json({ error: 'Only approved creators can set a sync source.' }, { status: 403 });
  }

  // Through the application form's own validator, so the two cannot drift into
  // accepting different things — and so a social link pasted into the website
  // box is caught here rather than surfacing as a viability check with no items.
  const link = normalizePlatformUrl('website', body.url);
  if (!link.ok) return NextResponse.json({ error: link.error }, { status: 400 });
  if (!link.url) {
    return NextResponse.json(
      { error: 'Type the address of your website or blog, then press Save.' },
      { status: 400 },
    );
  }
  const site = link.url;

  // Discovery runs fresh. Any `feed_url` already on the row was found for
  // whatever site was there before, and re-using it for a site the creator has
  // just typed is how a feed ends up paired with the wrong host.
  const report = await runViabilityCheck('website', site, { feedUrl: null });

  const refusal = describeWebsiteImportFailure(site, {
    outcome: report.outcome,
    reason: report.reason,
    checked: report.checked,
    passed: report.passed,
  });

  log({
    event: 'CREATOR:SOURCE_CHECK',
    status: refusal ? 'error' : 'success',
    userId: user.userId,
    email: user.email,
    // Creator-supplied, so JSON-quoted: a raw newline in either would forge a
    // log line.
    detail:
      `creator=${creator.id} source=website outcome=${report.outcome} reason=${report.reason ?? '-'} ` +
      `passed=${report.passed}/${report.checked} cost=$${report.costUsd.toFixed(4)} ` +
      `site=${JSON.stringify(site)} feed=${JSON.stringify(report.feed?.url ?? null)}`,
  });

  if (refusal) {
    // 200, not 4xx. Nothing was refused about the *request* — it was well formed
    // and we did the work it asked for; the answer is that this site cannot be
    // synced. A status code would have the client's generic error path swallow a
    // sentence that is the entire value of the call.
    return NextResponse.json({ ok: false, error: refusal, outcome: report.outcome });
  }

  // A viable website with no feed cannot happen — the probe reads the feed's
  // entries to get the items it gated — but the poller reads this column
  // forever after, so it is checked rather than asserted.
  const feedUrl = report.feed?.url ?? null;
  if (!feedUrl) {
    return NextResponse.json({
      ok: false,
      error:
        `We read posts from ${site} but could not settle on a feed to follow, so new posts would not reach us. ` +
        'Get in touch and we will look at it with you.',
      outcome: report.outcome,
    });
  }

  const resulting = { ...creator, website_url: site, feed_url: feedUrl };
  // The same rule the dropdown goes through. A creator saving a site they can be
  // read from *is* choosing it, so it is chosen here rather than made a second
  // press they have no reason to expect.
  const choice = chooseCreatorSource(resulting, 'website');
  if (!choice.ok) return NextResponse.json({ ok: false, error: choice.error }, { status: 400 });

  const update = { website_url: site, feed_url: feedUrl, ...choice.update };
  const { error } = await supabase.from('creators').update(update).eq('id', creator.id);
  if (error) {
    log({ event: 'CREATOR:SOURCE_CHECK', status: 'error', userId: user.userId, email: user.email, error });
    return NextResponse.json({ error: 'We checked your site but could not save it. Try again.' }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    websiteUrl: site,
    feedUrl,
    outcome: report.outcome,
    checked: report.checked,
    passed: report.passed,
    /**
     * What the creator is told on success, and it says what happens *next*
     * rather than congratulating them on a save.
     *
     * The baseline is the load-bearing half. The first poll marks everything
     * already published as seen instead of importing it (MEAL-75), so a creator
     * who is not told that watches nothing arrive and concludes the connection
     * did not work. The checklist below the box is what turns that from a
     * limitation into a choice, and this sentence is what sends them to it.
     */
    detail:
      report.outcome === 'partial'
        ? `${report.passed} of the ${report.checked} recent posts we read are recipes Mealio can import. We will ` +
          'watch this site and turn new recipe posts into drafts for you to review — the rest we will leave ' +
          'alone. Nothing you have already published is imported automatically; pick those below.'
        : `${report.passed} of the ${report.checked} recent posts we read are recipes Mealio can import. From now ` +
          'on new posts sync automatically and arrive as drafts for you to review before anything goes live. ' +
          'Nothing you have already published is imported automatically; pick those below.',
  });
}
