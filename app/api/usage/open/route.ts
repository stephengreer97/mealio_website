import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';
import { verifyAccessToken, extractTokenFromHeader } from '@/lib/tokens';
import { log } from '@/lib/logger';

// POST /api/usage/open — records a signed-up user opening the app/website.
// Session-level: clients dedupe (mobile 30-min gate, web sessionStorage flag).
export async function POST(request: NextRequest) {
  const token = extractTokenFromHeader(request.headers.get('authorization'));
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const decoded = await verifyAccessToken(token);
  if (!decoded) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const source = body?.source === 'app' ? 'app' : 'web';
  const platform = typeof body?.platform === 'string' ? body.platform.slice(0, 20) : null;
  const appVersion = typeof body?.appVersion === 'string' ? body.appVersion.slice(0, 40) : null;

  const supabase = createServerSupabaseClient();
  const { error } = await supabase.from('app_opens').insert({
    user_id: decoded.userId,
    source,
    platform,
    app_version: appVersion,
  });

  if (error) {
    log({ event: 'USAGE:OPEN', status: 'error', userId: decoded.userId, error });
    return NextResponse.json({ error: 'Failed to log open' }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
