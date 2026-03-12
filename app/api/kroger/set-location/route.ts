import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';
import { verifyAccessToken, extractTokenFromHeader } from '@/lib/tokens';

export const dynamic = 'force-dynamic';

/**
 * POST /api/kroger/set-location
 * Body: { locationId, locationName }
 * Saves the user's preferred Kroger store location.
 */
export async function POST(request: NextRequest) {
  const token = extractTokenFromHeader(request.headers.get('authorization'));
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const decoded = await verifyAccessToken(token);
  if (!decoded) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json();
  const { locationId, locationName } = body ?? {};
  if (!locationId) return NextResponse.json({ error: 'locationId required' }, { status: 400 });

  const supabase = createServerSupabaseClient();
  const { error } = await supabase
    .from('user_profiles')
    .update({
      kroger_location_id: locationId,
      kroger_location_name: locationName ?? null,
    })
    .eq('id', decoded.userId);

  if (error) return NextResponse.json({ error: 'Failed to save location' }, { status: 500 });
  return NextResponse.json({ success: true, locationId, locationName });
}
