import { createServerSupabaseClient } from '@/lib/supabase';
import { sendMarketingEmail } from '@/lib/marketing-email';
import { fetchAllPages, chunkIds } from '@/lib/paged-select';

// M2 lifecycle campaigns: the user upsell drip (C) and creator publish-reminders
// (B). Both are invoked once/day from /api/cron/daily and route every send
// through sendMarketingEmail() (suppression, idempotency, unsubscribe footer,
// email_sends logging). Copy was approved from rendered previews.

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'https://mealio.co';
const DAY = 86_400_000;

const p = (t: string) => `<p style="color:#666;font-size:14px;line-height:1.6;margin:0 0 16px;">${t}</p>`;
const btn = (href: string, t: string) =>
  `<a href="${href}" style="display:inline-block;background:#dd0031;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-size:14px;font-weight:600;margin-bottom:8px;">${t}</a>`;
const greet = (name?: string | null) => p(`Hi ${name || 'there'},`);

// ── Templates ────────────────────────────────────────────────────────────────

const UPSELL: Record<1 | 2 | 3, { subject: string; body: (name?: string | null) => string }> = {
  1: {
    subject: "You've saved a few meals. Ready for unlimited?",
    body: (name) =>
      greet(name) +
      p("You've been saving meals and filling carts with Mealio. Love to see it.") +
      p("Quick heads up: free accounts top out at <strong>3 saved meals</strong>. With <strong>Full Access</strong> you get <strong>unlimited saved meals</strong>, so you never have to delete one to make room for a new favorite.") +
      btn(`${APP_URL}/pricing`, 'See Full Access'),
  },
  2: {
    subject: 'Save every meal you love',
    body: (name) =>
      greet(name) +
      p("New creators and meals hit the Discover feed every week, but on the free plan you can only keep <strong>3</strong> at a time.") +
      p("<strong>Full Access</strong> unlocks <strong>unlimited saved meals</strong> so you can build your whole rotation, and your subscription helps pay the creators whose meals you save.") +
      btn(`${APP_URL}/pricing`, 'Upgrade to Full Access'),
  },
  3: {
    subject: 'Last call: unlimited meals on Mealio',
    body: (name) =>
      greet(name) +
      p("You've been with Mealio for a few weeks on the free plan. If it's earned a spot in your kitchen, <strong>Full Access</strong> gives you <strong>unlimited saved meals</strong> with no more juggling your 3.") +
      p("This is the last reminder we'll send about upgrading. You can do it anytime from your account.") +
      btn(`${APP_URL}/pricing`, 'Get Full Access'),
  },
};

const creatorFirstMealBody = (name?: string | null) =>
  greet(name) +
  p("You're approved as a Mealio creator, but you haven't published a meal yet. Your first one takes about two minutes and goes live on Discover immediately.") +
  p("Remember: you earn based on how often your meals get saved, and the feed favors fresh, regular publishing. The sooner you start, the sooner the saves add up.") +
  btn(`${APP_URL}/creator`, 'Publish your first meal');

const creatorReengageBody = (name?: string | null) =>
  greet(name) +
  p("It's been a couple of weeks since your last meal on Mealio. Publishing regularly keeps you in front of savers, and keeps your earnings growing.") +
  p("Got a go-to dinner this week? Add it in a couple of minutes and it's live right away.") +
  btn(`${APP_URL}/creator`, 'Publish a meal');

// ── C — user upsell drip (time-based on signup, free users only) ─────────────

const UPSELL_STEPS: Array<{ step: 1 | 2 | 3; day: number }> = [
  { step: 1, day: 4 },
  { step: 2, day: 12 },
  { step: 3, day: 28 },
];
const CATCHUP_WINDOW = 2; // days — covers a skipped daily cron run

/**
 * How much re-engage history the cadence check reads.
 *
 * Only has to be larger than the cap it enforces (3 sends since the last
 * publish). 50 is that with room to spare, and small enough that this stays one
 * cheap request inside a per-creator loop.
 */
const REENGAGE_HISTORY = 50;

export async function runUserUpsellDrip(): Promise<number> {
  const supabase = createServerSupabaseClient();
  let sent = 0;

  for (const { step, day } of UPSELL_STEPS) {
    // Account age in [day, day + CATCHUP_WINDOW): created_at between the two.
    const olderThan = new Date(Date.now() - (day + CATCHUP_WINDOW) * DAY).toISOString();
    const newerThan = new Date(Date.now() - day * DAY).toISOString();

    // Paged. `user_profiles` is the biggest table in the product and this is a
    // sweep over a slice of it, so the ceiling is not hypothetical here — it is
    // the first read in this file that will hit it. A truncated sweep is a set of
    // users who are silently never emailed and never retried: the window has
    // moved on by the next daily run, so the miss is permanent and invisible.
    const usersRead = await fetchAllPages<{ id: string; email: string; display_name: string }>((from, to) =>
      supabase
        .from('user_profiles')
        .select('id, email, display_name')
        .eq('subscription_tier', 'free')
        .eq('marketing_opt_out', false)
        .not('last_login_at', 'is', null) // engagement gate: must have signed in at least once
        .gte('created_at', olderThan)
        .lt('created_at', newerThan)
        .order('id', { ascending: true })
        .range(from, to));

    for (const u of usersRead.rows) {
      const res = await sendMarketingEmail({
        userId: u.id,
        to: u.email,
        type: `user_upsell_${step}`,
        dedupKey: `user_upsell_${step}:${u.id}`,
        subject: UPSELL[step].subject,
        bodyHtml: UPSELL[step].body(u.display_name),
      });
      if (res.status === 'sent') sent++;
    }
  }
  return sent;
}

// ── B — creator publish-reminders (activity-based on preset_meals) ────────────

export async function runCreatorReminders(): Promise<number> {
  const supabase = createServerSupabaseClient();

  // Every creator, paged.
  const creatorsRead = await fetchAllPages<{
    id: string; user_id: string; display_name: string; approved_at: string | null;
  }>((from, to) =>
    supabase
      .from('creators')
      .select('id, user_id, display_name, approved_at')
      .order('id', { ascending: true })
      .range(from, to));
  const creators = creatorsRead.rows;
  if (!creators.length) return 0;

  // The next two reads filter on an id list, so they are CHUNKED as well as
  // paged, and the chunking is the load-bearing half: ids travel in the query
  // string and 222 uuids in one `.in()` is an 8 KB URI that comes back 414 (see
  // `chunkIds`). A 414 arrives as `data: null`, which `?? []` turns into "this
  // creator has no profile" and "this creator has published nothing" — the
  // second of which sends a first-meal nudge to every creator who already
  // publishes. Past 222 creators this campaign would have mailed the whole
  // roster the wrong email.
  const profById = new Map<string, { id: string; email: string; marketing_opt_out: boolean }>();
  for (const chunk of chunkIds(creators.map((c) => c.user_id))) {
    const read = await fetchAllPages<{ id: string; email: string; marketing_opt_out: boolean }>((from, to) =>
      supabase
        .from('user_profiles')
        .select('id, email, marketing_opt_out')
        .in('id', chunk)
        .order('id', { ascending: true })
        .range(from, to));
    // Not `p` — that is the paragraph helper at the top of this file.
    for (const prof of read.rows) profById.set(prof.id, prof);
  }

  const pubs: Array<{ creator_id: string; created_at: string }> = [];
  for (const chunk of chunkIds(creators.map((c) => c.id))) {
    // Paged inside each chunk too, unlike the profile read above: that one returns
    // at most one row per id, this one returns one row per PUBLISHED MEAL, so a
    // chunk of 100 prolific creators can be thousands of rows on its own.
    const read = await fetchAllPages<{ creator_id: string; created_at: string }>((from, to) =>
      supabase
        .from('preset_meals')
        .select('creator_id, created_at')
        .in('creator_id', chunk)
        .order('id', { ascending: true })
        .range(from, to));
    pubs.push(...read.rows);
  }

  // Aggregate published-meal count + last-publish time per creator.
  const agg = new Map<string, { count: number; last: number }>();
  for (const m of pubs) {
    if (!m.creator_id) continue;
    const t = new Date(m.created_at).getTime();
    const a = agg.get(m.creator_id) ?? { count: 0, last: 0 };
    a.count++;
    if (t > a.last) a.last = t;
    agg.set(m.creator_id, a);
  }

  const now = Date.now();
  let sent = 0;

  for (const c of creators) {
    const prof = profById.get(c.user_id);
    if (!prof || prof.marketing_opt_out) continue;
    const a = agg.get(c.id) ?? { count: 0, last: 0 };

    // Never published → one nudge, 7+ days after approval.
    if (a.count === 0) {
      const approvedMs = c.approved_at ? new Date(c.approved_at).getTime() : now;
      if (now - approvedMs >= 7 * DAY) {
        const res = await sendMarketingEmail({
          userId: c.user_id,
          to: prof.email,
          type: 'creator_first_meal',
          dedupKey: `creator_first_meal:${c.id}`,
          subject: 'Ready to publish your first meal?',
          bodyHtml: creatorFirstMealBody(c.display_name),
        });
        if (res.status === 'sent') sent++;
      }
      continue;
    }

    // Published before → re-engage if idle 14+ days.
    if (now - a.last < 14 * DAY) continue;

    // Cadence: at most one per 21 days, capped at 3 — and reset by any new
    // publish (only count re-engage sends that came AFTER the last publish).
    // Bounded rather than paged, because the question only needs the recent end
    // of the list: the rows are newest-first and the two things read off them are
    // "are there three or more since the last publish" and "when was the most
    // recent". Any window comfortably larger than the cap of 3 gives the same
    // answer as the whole history would, so a small explicit limit is the honest
    // bound here — and paging a per-creator history inside a per-creator loop
    // would be a lot of requests to reach the same decision.
    const { data: prior } = await supabase
      .from('email_sends')
      .select('sent_at')
      .eq('user_id', c.user_id)
      .eq('type', 'creator_reengage')
      .order('sent_at', { ascending: false })
      .limit(REENGAGE_HISTORY);
    const sinceLastPublish = (prior ?? []).filter((r) => new Date(r.sent_at).getTime() > a.last);
    if (sinceLastPublish.length >= 3) continue;
    const lastReengageMs = sinceLastPublish[0] ? new Date(sinceLastPublish[0].sent_at).getTime() : 0;
    if (lastReengageMs && now - lastReengageMs < 21 * DAY) continue;

    const res = await sendMarketingEmail({
      userId: c.user_id,
      to: prof.email,
      type: 'creator_reengage',
      // Namespaced by publish-cycle (a.last) + sequence so it's unique across
      // cycles yet idempotent within a run.
      dedupKey: `creator_reengage:${c.id}:${Math.round(a.last / DAY)}:${sinceLastPublish.length + 1}`,
      subject: 'Your audience is waiting for your next meal',
      bodyHtml: creatorReengageBody(c.display_name),
    });
    if (res.status === 'sent') sent++;
  }
  return sent;
}
