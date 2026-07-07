import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';
import { requireAdmin } from '@/lib/requireAdmin';

export const dynamic = 'force-dynamic';

// Statuses that mean the email was actually handed to Resend (vs. skipped).
const ATTEMPTED = new Set(['sent', 'delivered', 'opened', 'clicked', 'bounced', 'complained']);

// GET /api/admin/email-stats — per-campaign funnel + recent send log.
export async function GET(request: NextRequest) {
  const admin = await requireAdmin(request);
  if (!admin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const supabase = createServerSupabaseClient();

  // Aggregate rows. opened_at / clicked_at are separate columns (not overwritten
  // by status), so open/click counts stay accurate even as status advances.
  const { data: rows } = await supabase
    .from('email_sends')
    .select('type, status, opened_at, clicked_at');

  type Agg = {
    type: string; sent: number; bounced: number; complained: number;
    suppressed: number; error: number; opened: number; clicked: number;
  };
  const byType = new Map<string, Agg>();
  for (const r of rows ?? []) {
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

  const campaigns = [...byType.values()]
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

  const totalSent = campaigns.reduce((n, c) => n + c.sent, 0);

  return NextResponse.json({
    campaigns,
    totals: { totalSent, unsubscribes: unsubscribes ?? 0 },
    recent: recent ?? [],
  });
}
