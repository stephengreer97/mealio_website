import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';
import { requireAdmin } from '@/lib/requireAdmin';
import { log } from '@/lib/logger';

// GET  /api/admin/canary        the per-store plans, plus recent results
// PUT  /api/admin/canary        { storeId, mealName?, enabled? }
//
// The out-of-stock and no-match items are NOT here any more. They are
// ingredients of the canary meal, which is the one place a meal's contents
// are described; having a second place meant the two could disagree about
// what was being tested, with this one winning silently.
//
// MEAL-7. The two CURATED canary lines per store, edited by hand.
//
// Only two fields are editable, and that is the design rather than a shortcut.
// The other three lines a canary runs -- a plain add, a by-weight item, and
// something nothing matches -- need no curation and live in code. Curation is
// required only where the answer depends on a particular store's shelves, and
// those go stale, which is exactly why they belong in a text box rather than in
// a deploy.
//
// A BLANK FIELD SKIPS THAT BRANCH. A canary that demands curation before it will
// run at all does not run.

export const dynamic = 'force-dynamic';

/** The tables may not exist yet. Say so plainly instead of 500ing. */
const MISSING = (e: unknown) => {
  const c = (e as { code?: string } | null)?.code;
  return c === '42P01' || c === 'PGRST205';
};

export async function GET(request: NextRequest) {
  const admin = await requireAdmin(request);
  if (!admin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const supabase = createServerSupabaseClient();
  // unbounded-select-ok: one row per STORE, and the whole catalogue is 40 stores.
  // A limit here would silently hide a store's plan rather than bound anything.
  const plans = await supabase.from('canary_plans').select('*').order('store_id');
  if (plans.error) {
    if (MISSING(plans.error)) {
      return NextResponse.json({ migrated: false, plans: [], runs: [] });
    }
    log({ event: 'ADMIN:CANARY', status: 'error', userId: admin.userId, error: plans.error });
    return NextResponse.json({ error: 'Failed to load canary plans' }, { status: 500 });
  }

  // Latest result per store, and enough history to see a pattern rather than a
  // single bad night.
  const runs = await supabase
    .from('canary_runs')
    .select('id, store_id, started_at, ran, skip_reason, passed, shape, lines')
    .order('started_at', { ascending: false })
    .limit(200);

  return NextResponse.json({
    migrated: true,
    plans: plans.data ?? [],
    runs: runs.error ? [] : (runs.data ?? []),
  });
}

export async function PUT(request: NextRequest) {
  const admin = await requireAdmin(request);
  if (!admin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const body = await request.json().catch(() => null);
  const storeId = typeof body?.storeId === 'string' ? body.storeId.trim() : '';
  if (!storeId) return NextResponse.json({ error: 'storeId required' }, { status: 400 });

  // Trimmed, and an empty string is stored as NULL: "   " in a text box means
  // the same as an empty one, and the skip logic reads NULL.
  const text = (v: unknown) => {
    if (typeof v !== 'string') return null;
    const t = v.trim();
    return t.length ? t.slice(0, 200) : null;
  };

  const supabase = createServerSupabaseClient();
  const { data, error } = await supabase
    .from('canary_plans')
    // ONLY WHAT WAS SENT. This used to write every column on every save, which
    // was harmless while the panel had a field for each one and fatal the moment
    // it did not: the item boxes are gone (the meal is where those lines belong
    // now), so a plain ON/OFF toggle would have posted no mealName and reset
    // every plan's meal to the literal 'Canary' -- and the runner selects the
    // meal BY NAME, so every store would have started looking for a meal that
    // does not exist.
    .upsert({
      store_id: storeId.slice(0, 60),
      ...(text(body?.mealName) ? { meal_name: text(body?.mealName) } : {}),
      ...(body?.enabled === undefined ? {} : { enabled: body.enabled !== false }),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'store_id' })
    .select()
    .single();

  if (error) {
    if (MISSING(error)) {
      return NextResponse.json({ error: 'Run supabase/RUN-NOW-canary.sql first' }, { status: 409 });
    }
    log({ event: 'ADMIN:CANARY', status: 'error', userId: admin.userId, error });
    return NextResponse.json({ error: 'Failed to save' }, { status: 500 });
  }
  return NextResponse.json({ plan: data });
}
