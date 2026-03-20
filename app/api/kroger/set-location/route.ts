import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';
import { verifyAccessToken, extractTokenFromHeader } from '@/lib/tokens';
import { log } from '@/lib/logger';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const token = extractTokenFromHeader(request.headers.get('authorization'));
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const decoded = await verifyAccessToken(token);
  if (!decoded) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json();
  const { locationId, locationName, storeId } = body ?? {};
  if (!locationId) return NextResponse.json({ error: 'locationId required' }, { status: 400 });
  if (!storeId) return NextResponse.json({ error: 'storeId required' }, { status: 400 });

  const supabase = createServerSupabaseClient();

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('kroger_locations')
    .eq('id', decoded.userId)
    .single();

  const current = (profile?.kroger_locations ?? {}) as Record<string, { locationId: string; locationName: string | null }>;
  const updated = { ...current, [storeId]: { locationId, locationName: locationName ?? null } };

  const { error } = await supabase
    .from('user_profiles')
    .update({ kroger_locations: updated })
    .eq('id', decoded.userId);

  if (error) {
    log({ event: 'KROGER:SET_LOCATION', status: 'error', userId: decoded.userId, error });
    return NextResponse.json({ error: 'Failed to save location' }, { status: 500 });
  }
  log({ event: 'KROGER:SET_LOCATION', status: 'success', userId: decoded.userId, detail: `store=${storeId} location=${locationId} name="${locationName ?? ''}"` });
  return NextResponse.json({ success: true, locationId, locationName, storeId });
}
