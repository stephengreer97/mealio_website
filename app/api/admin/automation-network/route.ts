import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';
import { requireAdmin } from '@/lib/requireAdmin';
import { aggregateNetworkStats, summarize, type NetworkStepRow } from '@/lib/automation-network-stats';
import { log } from '@/lib/logger';

// GET /api/admin/automation-network?days=7[&storeId=heb]
//
// MEAL-219 phase 4. The automation tab rebuilt around what the rail does: HTTP
// statuses, the phase funnel, and how hard the retry policy is having to work.
//
// Separate from /automation-funnel rather than folded into it, deliberately.
// That endpoint answers a DOM-era question ("what share of adds confirmed on the
// first click") over a vocabulary of selectors and clicks. This one answers a
// network question over columns that did not exist a week ago. Merging them
// would mean one payload where half the fields are null for half the window,
// and a page that cannot say which half it is showing.
//
// Fetching here, aggregation in lib/automation-network-stats.ts, which is unit
// tested without a database.

export const dynamic = 'force-dynamic';

const MAX_DAYS = 90;
// The cap exists because this reads raw step rows, not a rollup. A busy window
// can be large, and a dashboard that times out is worse than one showing a
// truncated window it admits to.
const MAX_ROWS = 20000;

export async function GET(request: NextRequest) {
  const admin = await requireAdmin(request);
  if (!admin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const daysParam = Number(request.nextUrl.searchParams.get('days'));
  const days = Number.isFinite(daysParam) && daysParam > 0
    ? Math.min(Math.trunc(daysParam), MAX_DAYS) : 7;
  const storeId = request.nextUrl.searchParams.get('storeId');
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  try {
    const supabase = createServerSupabaseClient();
    let q = supabase
      .from('automation_steps')
      .select('store_id, step, outcome, code, http_status, phase, attempts, rail, occurred_at')
      .gte('occurred_at', since)
      .order('occurred_at', { ascending: false })
      .limit(MAX_ROWS);
    if (storeId) q = q.eq('store_id', storeId);

    const { data, error } = await q;
    if (error) throw error;

    const rows = (data ?? []) as NetworkStepRow[];
    const stores = aggregateNetworkStats(rows);

    return NextResponse.json({
      days,
      since,
      rowsScanned: rows.length,
      // Said out loud rather than left for someone to infer from a round number.
      truncated: rows.length >= MAX_ROWS,
      // The share of the window that predates MEAL-219. Every rate on this page
      // is computed over the rows that CAN answer, so this is how a reader knows
      // whether to trust them yet.
      coverage: {
        rowsWithStatus: rows.filter((r) => typeof r.http_status === 'number' && r.http_status > 0).length,
        rowsWithPhase: rows.filter((r) => !!r.phase).length,
        rowsWithAttempts: rows.filter((r) => typeof r.attempts === 'number').length,
      },
      stores,
      headlines: stores.map(summarize),
    });
  } catch (error) {
    log({ event: 'ADMIN:AUTOMATION_NETWORK', status: 'error', userId: admin.userId, error });
    return NextResponse.json({ error: 'Failed to load network stats' }, { status: 500 });
  }
}
