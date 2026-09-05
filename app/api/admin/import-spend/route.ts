import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';
import { requireAdmin } from '@/lib/requireAdmin';
import { fetchAllPages, type PageResult } from '@/lib/paged-select';
import { buildSpendView, type SpendRow } from '@/lib/import-spend';
import { log } from '@/lib/logger';

// GET /api/admin/import-spend?days=30 — MEAL-222.
//
// What imports cost over a window, split by creator vs user, with the median
// token shape per stage beside it.
//
// The medians are the point as much as the money. TYPICAL_IMPORT_TOKENS in
// lib/import/cost.ts was measured when extraction ran on Opus with adaptive
// thinking; it is Haiku now with thinking off and nobody re-measured the SHAPE.
// Pricing follows the model automatically, those token counts do not, so they
// are the one number in the import estimate that can be silently wrong. This
// endpoint is how that gets checked against fact rather than re-argued.

export const dynamic = 'force-dynamic';

const MAX_DAYS = 365;

export async function GET(request: NextRequest) {
  const admin = await requireAdmin(request);
  if (!admin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const daysParam = Number(request.nextUrl.searchParams.get('days'));
  const days = Number.isFinite(daysParam) && daysParam > 0
    ? Math.min(Math.trunc(daysParam), MAX_DAYS) : 30;
  const since = new Date(Date.now() - days * 86_400_000).toISOString();

  const supabase = createServerSupabaseClient();
  const read = await fetchAllPages<SpendRow>((from, to) =>
    supabase
      .from('recipe_imports')
      .select(
        'actor, outcome, stage, cached, gate_cost_usd, extract_cost_usd, total_cost_usd, '
        + 'gate_input_tokens, gate_output_tokens, extract_input_tokens, extract_output_tokens, id',
      )
      .gte('occurred_at', since)
      .order('id', { ascending: true })
      // Cast because `recipe_imports` is newer than the generated Supabase
      // types, which infer `GenericStringError[]` for a table they have never
      // heard of. The shape is asserted against real rows in
      // tests/lib/import-spend.test.ts rather than trusted from a type.
      .range(from, to) as unknown as PromiseLike<PageResult<SpendRow>>);

  if (read.error) {
    // A MISSING TABLE, not a missing column, is the likely failure here, and it
    // means one SQL file has not been run. Say which, the way the MEAL-219
    // route does, rather than returning a 500 the admin page renders as
    // "something broke".
    //
    // Both codes and the message: 42P01 is Postgres's undefined_table, PGRST205
    // is PostgREST's "could not find the table in the schema cache", and
    // PostgREST is what supabase-js actually talks to. Knowing only the
    // Postgres one is what made an identical guard never fire in MEAL-219.
    const code = (read.error as { code?: string }).code ?? '';
    const message = (read.error as { message?: string }).message ?? '';
    const missingTable = code === '42P01' || code === 'PGRST205' || code === 'PGRST204'
      || /relation .* does not exist|could not find the table|schema cache/i.test(message);
    log({ event: 'ADMIN:IMPORT_SPEND', status: 'error', userId: admin.userId, error: read.error });
    return NextResponse.json(
      missingTable
        ? {
            error: 'The MEAL-222 import accounting table is not in the database yet. '
              + 'Run supabase/migrations/20260906000001_recipe_imports.sql.',
            needsMigration: true,
          }
        : { error: 'Failed to read import spend' },
      { status: missingTable ? 409 : 500 },
    );
  }

  return NextResponse.json({
    days,
    since,
    // A prefix presented as a total is the failure the paged reads in this
    // repository are careful about. Say when the answer is one.
    truncated: !read.complete,
    rowsScanned: read.rows.length,
    ...buildSpendView(read.rows),
  });
}
