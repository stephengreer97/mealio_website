import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';
import { verifyAccessToken, extractTokenFromHeader } from '@/lib/tokens';

export const dynamic = 'force-dynamic';

/**
 * GET /api/kroger/status
 * Returns the user's Kroger connection state.
 */
export async function GET(request: NextRequest) {
  const token = extractTokenFromHeader(request.headers.get('authorization'));
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const decoded = await verifyAccessToken(token);
  if (!decoded) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const supabase = createServerSupabaseClient();
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('kroger_refresh_token, kroger_location_id, kroger_location_name, kroger_connected_at')
    .eq('id', decoded.userId)
    .single();

  if (!profile?.kroger_refresh_token) {
    return NextResponse.json({ connected: false });
  }

  return NextResponse.json({
    connected: true,
    locationId: profile.kroger_location_id ?? null,
    locationName: profile.kroger_location_name ?? null,
    connectedAt: profile.kroger_connected_at ?? null,
  });
}
