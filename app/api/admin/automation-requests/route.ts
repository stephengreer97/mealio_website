import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';
import { requireAdmin } from '@/lib/requireAdmin';
import { fetchAllPages } from '@/lib/paged-select';
import { buildRequestView, type RequestRow } from '@/lib/automation-requests';
import { log } from '@/lib/logger';

// GET /api/admin/automation-requests?days=7 — MEAL-219.
//
// The network rail seen through HTTP codes: what each store answered, which
// PHASE of the run it answered it in, how often we had to ask twice, and
// whether asking twice worked.
//
// A separate route from automation-funnel on purpose. That one aggregates a DOM
// run — its vocabulary contains `add_click` and its confirm rate is measured
// against it — and the rows recorded under that vocabulary are still in the
// table and still worth reading. Two questions, two endpoints, rather than one
// endpoint whose answer means different things depending on when the row was
// written.
//
// Only rows carrying `http_status` or `phase` are selected, which is what makes
// this cheap: the partial indexes added in the same migration cover exactly
// those, so this never scans the pre-MEAL-219 majority of the table.

export const dynamic = 'force-dynamic';

const MAX_DAYS = 90;

export async function GET(request: NextRequest) {
  const admin = await requireAdmin(request);
  if (!admin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const daysParam = Number(request.nextUrl.searchParams.get('days'));
  const days = Number.isFinite(daysParam) && daysParam > 0
    ? Math.min(Math.trunc(daysParam), MAX_DAYS) : 7;
  const since = new Date(Date.now() - days * 86_400_000).toISOString();

  const supabase = createServerSupabaseClient();
  const read = await fetchAllPages<RequestRow>((from, to) =>
    supabase
      .from('automation_steps')
      .select('store_id, rail, phase, outcome, code, http_status, attempts, duration_ms, id')
      .gte('occurred_at', since)
      .not('phase', 'is', null)
      .order('id', { ascending: true })
      .range(from, to));

  if (read.error) {
    // A missing column means the MEAL-219 migration has not been run. Say so
    // plainly rather than returning a 500 the admin page renders as "something
    // broke" — the answer is one SQL file away and the message should say which.
    const missingColumn = (read.error as { code?: string }).code === '42703';
    log({ event: 'ADMIN:AUTOMATION_FUNNEL', status: 'error', userId: admin.userId, error: read.error });
    return NextResponse.json(
      missingColumn
        ? { error: 'The MEAL-219 telemetry columns are not in the database yet. Run supabase/migrations/20260905000001_automation_request_telemetry.sql.', needsMigration: true }
        : { error: 'Failed to read request telemetry' },
      { status: missingColumn ? 409 : 500 },
    );
  }

  return NextResponse.json({
    days,
    since,
    // A prefix presented as a total is the failure this whole module is careful
    // about. Say when the answer is one.
    truncated: !read.complete,
    rowsScanned: read.rows.length,
    stores: buildRequestView(read.rows),
  });
}
