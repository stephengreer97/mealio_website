import { NextRequest, NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createServerSupabaseClient } from '@/lib/supabase';
import { requireAdmin } from '@/lib/requireAdmin';
import { log } from '@/lib/logger';

export const dynamic = 'force-dynamic';

// Statuses that mean the email was actually handed to Resend (vs. skipped).
const ATTEMPTED_LIST = ['sent', 'delivered', 'opened', 'clicked', 'bounced', 'complained'];
const ATTEMPTED = new Set(ATTEMPTED_LIST);

/**
 * Rows one read asks for, and how many of those reads it is allowed.
 *
 * PostgREST answers a select with at most `db-max-rows` — 1000 on Supabase — and
 * **says nothing about having truncated**. That is what MEAL-128 was: this route
 * selected `email_sends` with no bound, so 1500 seeded sends reported
 * `totalSent = 1000`, and the open and click rates were then computed over an
 * arbitrary 1000 of them. The rates were not a smaller sample of the truth, they
 * were a BIASED one — membership was decided by physical row order, so the same
 * request could answer differently twice and neither answer said it was partial.
 *
 * Two rules, and this route uses both:
 *
 *  - A number Postgres can compute is asked of Postgres, with
 *    `{ count: 'exact', head: true }`. `db-max-rows` caps the ROWS in a response,
 *    not the count in `Content-Range`, so a count is bounded by nothing — and it
 *    beats shipping every row to Node to call `.length` on it.
 *  - A read that genuinely needs the rows is ORDERED and PAGED to exhaustion.
 *    The per-campaign funnel is such a read: it groups by `type`, and grouping
 *    cannot be done by a count without knowing every campaign name up front.
 *    Ordered on the primary key, because an OFFSET walk without an ORDER BY may
 *    repeat one row and skip another — which for a pair of counters is a number
 *    wrong in both directions at once.
 */
const PAGE_ROWS = 1000;
const MAX_PAGES = 50;

type SendRow = { type: string; status: string; opened_at: string | null; clicked_at: string | null };

/**
 * Every `email_sends` row the funnel needs, paged to exhaustion.
 *
 * `complete: false` means either a failed page or `MAX_PAGES`. Both make the
 * counts short, and a short funnel may not be reported as a funnel.
 */
async function fetchAllSends(
  supabase: SupabaseClient,
): Promise<{ rows: SendRow[]; complete: boolean }> {
  const rows: SendRow[] = [];

  for (let page = 0; page < MAX_PAGES; page++) {
    const { data, error } = await supabase
      .from('email_sends')
      .select('id, type, status, opened_at, clicked_at')
      .order('id', { ascending: true })
      .range(page * PAGE_ROWS, page * PAGE_ROWS + PAGE_ROWS - 1);

    if (error) return { rows, complete: false };

    const batch = (data ?? []) as SendRow[];
    rows.push(...batch);
    // A short page is the end of the table. A full page proves nothing either
    // way, so ask again.
    if (batch.length < PAGE_ROWS) return { rows, complete: true };
  }

  return { rows, complete: false };
}

// GET /api/admin/email-stats — per-campaign funnel + recent send log.
export async function GET(request: NextRequest) {
  const admin = await requireAdmin(request);
  if (!admin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const supabase = createServerSupabaseClient();

  // Which figures could not be read in full. Everything named here is returned as
  // `null` rather than as a smaller number, so the email tab cannot print a
  // partial funnel by forgetting to look. Convention borrowed from MEAL-127
  // rather than invented again.
  const incomplete: string[] = [];

  // The headline total, counted by Postgres rather than by measuring an array in
  // Node. This one is exact even when the row walk below is not: a count travels
  // in `Content-Range` and `db-max-rows` does not touch it.
  const { count: attemptedCount, error: countError } = await supabase
    .from('email_sends')
    .select('id', { count: 'exact', head: true })
    .in('status', ATTEMPTED_LIST);

  // Aggregate rows. opened_at / clicked_at are separate columns (not overwritten
  // by status), so open/click counts stay accurate even as status advances.
  const { rows, complete: sendsComplete } = await fetchAllSends(supabase);

  type Agg = {
    type: string; sent: number; bounced: number; complained: number;
    suppressed: number; error: number; opened: number; clicked: number;
  };
  const byType = new Map<string, Agg>();
  for (const r of rows) {
    const a = byType.get(r.type) ?? {
      type: r.type, sent: 0, bounced: 0, complained: 0, suppressed: 0, error: 0, opened: 0, clicked: 0,
    };
    if (ATTEMPTED.has(r.status)) a.sent++;
    if (r.status === 'bounced') a.bounced++;
    if (r.status === 'complained') a.complained++;
    if (r.status === 'suppressed') a.suppressed++;
    if (r.status === 'error') a.error++;
    if (r.opened_at) a.opened++;
    if (r.clicked_at) a.clicked++;
    byType.set(r.type, a);
  }

  const aggregated = [...byType.values()]
    .map((a) => {
      const delivered = Math.max(0, a.sent - a.bounced);
      return {
        ...a,
        delivered,
        openRate: delivered ? Math.round((a.opened / delivered) * 100) : 0,
        clickRate: delivered ? Math.round((a.clicked / delivered) * 100) : 0,
      };
    })
    .sort((x, y) => y.sent - x.sent);

  // Withheld outright when the row walk was short. A truncated read does not make
  // every campaign's numbers uniformly smaller — it drops whichever rows sat past
  // the cut, so the open and click RATES are wrong too, not just the counts. There
  // is no honest way to render that, so it is not rendered.
  const campaigns = sendsComplete ? aggregated : null;
  if (!sendsComplete) incomplete.push('campaigns');

  // Recent send log (searchable by email).
  const search = request.nextUrl.searchParams.get('email');
  let recentQuery = supabase
    .from('email_sends')
    .select('email, type, status, sent_at, opened_at, clicked_at')
    .order('sent_at', { ascending: false })
    .limit(50);
  if (search) recentQuery = recentQuery.ilike('email', `%${search}%`);
  const { data: recent } = await recentQuery;

  const { count: unsubscribes } = await supabase
    .from('user_profiles')
    .select('*', { count: 'exact', head: true })
    .eq('marketing_opt_out', true);

  // Straight from Postgres, not `campaigns.reduce(…)`. Summing the aggregate would
  // make the headline inherit the row walk's ceiling, which is exactly how 1500
  // sends came to be reported as 1000.
  const totalSent = countError ? null : (attemptedCount ?? 0);
  if (totalSent === null) incomplete.push('totalSent');

  if (incomplete.length > 0) {
    log({
      event: 'ADMIN:EMAIL_STATS',
      status: 'error',
      userId: admin.userId,
      email: admin.email,
      detail: `incomplete read: ${incomplete.join(',')}`,
    });
  }

  return NextResponse.json({
    // `null`, not `[]`: an empty list means "no campaigns have ever sent", which is
    // a different and equally actionable answer from "we could not read them".
    campaigns,
    totals: { totalSent, unsubscribes: unsubscribes ?? 0 },
    recent: recent ?? [],
    // Empty on a healthy response. Anything named here is `null` above, and the
    // tab renders a dash and a warning instead of a number that would understate.
    incomplete,
  });
}
