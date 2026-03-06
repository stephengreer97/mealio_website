import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';
import { requireAdmin } from '@/lib/requireAdmin';

function getQuarterBounds(year: number, q: number) {
  const startMonth = (q - 1) * 3;
  const start = new Date(year, startMonth, 1);
  const end   = new Date(year, startMonth + 3, 1); // exclusive upper bound
  return { start: start.toISOString(), end: end.toISOString() };
}

function getAvailableQuarters(): { year: number; q: number; label: string }[] {
  const now = new Date();
  const quarters = [];
  let year  = now.getFullYear();
  let q     = Math.floor(now.getMonth() / 3) + 1;

  for (let i = 0; i < 8; i++) {
    quarters.push({ year, q, label: `Q${q} ${year}` });
    q--;
    if (q === 0) { q = 4; year--; }
  }
  return quarters;
}

// GET /api/admin/stats?year=YYYY&q=N (defaults to current quarter)
export async function GET(request: NextRequest) {
  const admin = await requireAdmin(request);
  if (!admin) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const supabase = createServerSupabaseClient();
  const now = new Date();

  const currentYear = now.getFullYear();
  const currentQ    = Math.floor(now.getMonth() / 3) + 1;

  const paramYear = request.nextUrl.searchParams.get('year');
  const paramQ    = request.nextUrl.searchParams.get('q');

  const selectedYear = paramYear ? parseInt(paramYear) : currentYear;
  const selectedQ    = paramQ    ? parseInt(paramQ)    : currentQ;
  const isCurrent    = selectedYear === currentYear && selectedQ === currentQ;

  const { start: qtrStart, end: qtrEnd } = getQuarterBounds(selectedYear, selectedQ);
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const qtrStartMs = new Date(qtrStart).getTime();
  const qtrEndMs   = new Date(qtrEnd).getTime();

  // Platform-wide meal totals (personal meals created by users) — only for current quarter view
  const [saves30d, savesQtr, savesAll] = await Promise.all([
    isCurrent
      ? supabase.from('meals').select('id', { count: 'exact', head: true }).gte('created_at', thirtyDaysAgo)
      : Promise.resolve({ count: null }),
    supabase.from('meals').select('id', { count: 'exact', head: true })
      .gte('created_at', qtrStart).lt('created_at', qtrEnd),
    isCurrent
      ? supabase.from('meals').select('id', { count: 'exact', head: true })
      : Promise.resolve({ count: null }),
  ]);

  // User signup counts
  const [signups30d, signupsQtr, signupsAll] = await Promise.all([
    isCurrent
      ? supabase.from('user_profiles').select('id', { count: 'exact', head: true }).gte('created_at', thirtyDaysAgo)
      : Promise.resolve({ count: null }),
    supabase.from('user_profiles').select('id', { count: 'exact', head: true })
      .gte('created_at', qtrStart).lt('created_at', qtrEnd),
    isCurrent
      ? supabase.from('user_profiles').select('id', { count: 'exact', head: true })
      : Promise.resolve({ count: null }),
  ]);

  // Subscription events — fetch all, filter in memory for started/cancelled counts
  const { data: allSubEvents } = await supabase
    .from('subscription_events')
    .select('event, created_at');

  const thirtyDaysAgoMs = new Date(thirtyDaysAgo).getTime();

  let subsStarted30d = 0, subsStartedQtr = 0, subsStartedAll = 0;
  let subsCancelled30d = 0, subsCancelledQtr = 0, subsCancelledAll = 0;

  for (const evt of (allSubEvents ?? [])) {
    const evtMs = new Date((evt as { event: string; created_at: string }).created_at).getTime();
    const inQtr = evtMs >= qtrStartMs && evtMs < qtrEndMs;
    const in30d = evtMs >= thirtyDaysAgoMs;
    if ((evt as { event: string }).event === 'started') {
      subsStartedAll++;
      if (inQtr) subsStartedQtr++;
      if (in30d) subsStarted30d++;
    } else if ((evt as { event: string }).event === 'cancelled') {
      subsCancelledAll++;
      if (inQtr) subsCancelledQtr++;
      if (in30d) subsCancelled30d++;
    }
  }

  // All saves on creator meals — fetch all time once, filter in memory
  const { data: allCreatorSaves } = await supabase
    .from('preset_meal_saves')
    .select('saved_at, preset_meals!preset_meal_id!inner ( creator_id, creators!creator_id ( id, display_name ) )')
    .not('preset_meals.creator_id', 'is', null);

  type CreatorEntry = { name: string; qtrSaves: number; alltimeSaves: number };
  const creatorMap: Record<string, CreatorEntry> = {};

  let totalCreatorQtrSaves     = 0;
  let totalCreatorAlltimeSaves = 0;

  for (const row of (allCreatorSaves ?? [])) {
    const meal = (row as {
      saved_at: string;
      preset_meals?: { creator_id?: string; creators?: { id: string; display_name: string } | null };
    }).preset_meals;
    if (!meal?.creators) continue;

    const { id: creatorId, display_name: creatorName } = meal.creators;
    const savedAtMs = new Date((row as { saved_at: string }).saved_at).getTime();
    const inSelectedQtr = savedAtMs >= qtrStartMs && savedAtMs < qtrEndMs;

    if (!creatorMap[creatorId]) {
      creatorMap[creatorId] = { name: creatorName, qtrSaves: 0, alltimeSaves: 0 };
    }

    creatorMap[creatorId].alltimeSaves++;
    totalCreatorAlltimeSaves++;

    if (inSelectedQtr) {
      creatorMap[creatorId].qtrSaves++;
      totalCreatorQtrSaves++;
    }
  }

  const creators = Object.values(creatorMap).map(c => ({
    name:         c.name,
    qtrSaves:     c.qtrSaves,
    alltimeSaves: c.alltimeSaves,
    qtrPct:       totalCreatorQtrSaves     > 0 ? parseFloat((c.qtrSaves     / totalCreatorQtrSaves     * 100).toFixed(1)) : 0,
    alltimePct:   totalCreatorAlltimeSaves  > 0 ? parseFloat((c.alltimeSaves / totalCreatorAlltimeSaves  * 100).toFixed(1)) : 0,
    combinedSharePct: 0,
  }));

  for (const c of creators) {
    c.combinedSharePct = parseFloat(((c.qtrPct * 0.5) + (c.alltimePct * 0.5)).toFixed(1));
  }

  const leaderboard        = [...creators].sort((a, b) => b.combinedSharePct - a.combinedSharePct);
  const leaderboardQtr     = [...creators].sort((a, b) => b.qtrSaves - a.qtrSaves)
    .map(c => ({ name: c.name, saves: c.qtrSaves, pct: c.qtrPct }));
  const leaderboardAlltime = [...creators].sort((a, b) => b.alltimeSaves - a.alltimeSaves)
    .map(c => ({ name: c.name, saves: c.alltimeSaves, pct: c.alltimePct }));

  return NextResponse.json({
    isCurrent,
    quarterLabel: `Q${selectedQ} ${selectedYear}`,
    availableQuarters: getAvailableQuarters(),
    totals: {
      saves30d:                saves30d.count  ?? null,
      savesQtr:                savesQtr.count  ?? 0,
      savesAll:                savesAll.count  ?? null,
      totalCreatorQtrSaves,
      totalCreatorAlltimeSaves: isCurrent ? totalCreatorAlltimeSaves : null,
      signups30d:              isCurrent ? (signups30d.count ?? 0)  : null,
      signupsQtr:              signupsQtr.count ?? 0,
      signupsAll:              isCurrent ? (signupsAll.count ?? 0)  : null,
      subsStarted30d:          isCurrent ? subsStarted30d   : null,
      subsStartedQtr,
      subsStartedAll:          isCurrent ? subsStartedAll   : null,
      subsCancelled30d:        isCurrent ? subsCancelled30d : null,
      subsCancelledQtr,
      subsCancelledAll:        isCurrent ? subsCancelledAll : null,
      netNewPaid30d:           isCurrent ? subsStarted30d   - subsCancelled30d   : null,
      netNewPaidQtr:           subsStartedQtr  - subsCancelledQtr,
      netNewPaidAll:           isCurrent ? subsStartedAll   - subsCancelledAll   : null,
    },
    leaderboard:        isCurrent ? leaderboard        : null,
    leaderboardQtr,
    leaderboardAlltime: isCurrent ? leaderboardAlltime : null,
  });
}
