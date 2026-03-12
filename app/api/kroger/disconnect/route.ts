import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';
import { verifyAccessToken, extractTokenFromHeader } from '@/lib/tokens';
import { log } from '@/lib/logger';

export const dynamic = 'force-dynamic';

/**
 * POST /api/kroger/disconnect
 * Clears the stored Kroger refresh token and location for the user.
 */
export async function POST(request: NextRequest) {
  const token = extractTokenFromHeader(request.headers.get('authorization'));
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const decoded = await verifyAccessToken(token);
  if (!decoded) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const supabase = createServerSupabaseClient();
  await supabase
    .from('user_profiles')
    .update({
      kroger_refresh_token: null,
      kroger_location_id: null,
      kroger_location_name: null,
      kroger_connected_at: null,
    })
    .eq('id', decoded.userId);

  log({ event: 'KROGER:DISCONNECT', status: 'success', userId: decoded.userId });
  return NextResponse.json({ success: true });
}
