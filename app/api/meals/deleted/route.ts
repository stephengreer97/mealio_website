import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';
import { verifyAccessToken, extractTokenFromHeader } from '@/lib/tokens';
import { log } from '@/lib/logger';
import { fetchAllPages } from '@/lib/paged-select';

async function getUser(request: NextRequest) {
  const token = extractTokenFromHeader(request.headers.get('authorization'));
  if (!token) return null;
  return verifyAccessToken(token);
}

// GET /api/meals/deleted — return soft-deleted meals for the authenticated user
export async function GET(request: NextRequest) {
  const decoded = await getUser(request);
  if (!decoded) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = createServerSupabaseClient();

  // Paged, for the same reason as the live list in `../route.ts`. This one is
  // arguably worse to truncate: soft-deleted meals accumulate and are never
  // cleaned up, so this is the table most likely to pass 1000 rows first, and a
  // restorable meal that does not appear here cannot be restored at all.
  const read = await fetchAllPages<Record<string, any>>((from, to) =>
    supabase
      .from('meals')
      .select('*')
      .eq('user_id', decoded.userId)
      .eq('is_active', false)
      .order('id', { ascending: true })
      .range(from, to));

  if (read.error) {
    log({ event: 'MEAL:GET_DELETED', status: 'error', userId: decoded.userId, error: read.error });
    return NextResponse.json({ error: read.error.message }, { status: 500 });
  }

  // Most-recently-deleted first, the order this screen has always shown. Sorted
  // here because the walk above pages on `id` — `updated_at` is not unique.
  const meals = [...read.rows].sort((a, b) =>
    String(b.updated_at ?? '').localeCompare(String(a.updated_at ?? '')));

  if (!read.complete) {
    log({
      event: 'MEAL:GET_DELETED', status: 'error', userId: decoded.userId,
      detail: `incomplete read after ${meals.length} meals`,
    });
  }

  return NextResponse.json({ meals });
}
