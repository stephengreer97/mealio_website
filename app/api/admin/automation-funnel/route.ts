import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';
import { requireAdmin } from '@/lib/requireAdmin';
import { aggregateFunnel, RunRow, StepRow } from '@/lib/automation-funnel';
import { log } from '@/lib/logger';

// GET /api/admin/automation-funnel?days=7[&storeId=heb]
//
// The per-store add-to-cart reliability dashboard. Answers the question the app
// previously couldn't without asking a user for their logs: what percent of adds
// confirmed, on which step runs die, and how slow each step is.
//
// Fetching and aggregation are deliberately separate — all the interesting logic
// lives in lib/automation-funnel.ts and is unit-tested there.

export const dynamic = 'force-dynamic';

const MAX_DAYS = 90;
// Supabase caps a single select; a busy week of steps can exceed it, so page.
const PAGE_SIZE = 1000;
const MAX_PAGES = 50;

export async function GET(request: NextRequest) {
  const admin = await requireAdmin(request);
  if (!admin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const daysParam = Number(request.nextUrl.searchParams.get('days'));
  const days = Number.isFinite(daysParam) && daysParam > 0 ? Math.min(Math.trunc(daysParam), MAX_DAYS) : 7;
  const storeId = request.nextUrl.searchParams.get('storeId');

  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const supabase = createServerSupabaseClient();

  try {
    let runsQuery = supabase
      .from('automation_runs')
      .select('store_id, outcome, status, items_requested, items_added')
      .gte('started_at', since);
    if (storeId) runsQuery = runsQuery.eq('store_id', storeId);

    // Paged step fetch: one window can hold far more step rows than run rows.
    const steps: StepRow[] = [];
    let page = 0;
    for (; page < MAX_PAGES; page++) {
      let q = supabase
        .from('automation_steps')
        .select('store_id, step, outcome, duration_ms, detail')
        .gte('occurred_at', since)
        .order('id', { ascending: true })
        .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
      if (storeId) q = q.eq('store_id', storeId);

      const { data, error } = await q;
      if (error) throw error;
      if (!data || data.length === 0) break;
      steps.push(...(data as StepRow[]));
      if (data.length < PAGE_SIZE) break;
    }

    const { data: runs, error: runsErr } = await runsQuery;
    if (runsErr) throw runsErr;

    const funnel = aggregateFunnel((runs ?? []) as RunRow[], steps);

    return NextResponse.json({
      days,
      since,
      // Surfaced so the dashboard can warn that it is showing a partial window
      // rather than silently under-reporting.
      truncated: page >= MAX_PAGES,
      stepRowsScanned: steps.length,
      stores: funnel,
      alerting: funnel.filter((s) => s.alerting).map((s) => s.storeId),
    });
  } catch (error) {
    log({ event: 'ADMIN:AUTOMATION_FUNNEL', status: 'error', userId: admin.userId, error });
    return NextResponse.json({ error: 'Failed to load funnel' }, { status: 500 });
  }
}
