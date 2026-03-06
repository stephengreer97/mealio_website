import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';
import { verifyAccessToken, extractTokenFromHeader } from '@/lib/tokens';
import { log } from '@/lib/logger';

async function getUser(request: NextRequest) {
  const token = extractTokenFromHeader(request.headers.get('authorization'));
  if (!token) return null;
  return verifyAccessToken(token);
}

// POST /api/meals/[id]/share — generate (or return existing) share token for a meal
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const decoded = await getUser(request);
  if (!decoded) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  const supabase = createServerSupabaseClient();

  // Fetch the meal — ownership check included
  const { data: meal, error } = await supabase
    .from('meals')
    .select('id, share_token')
    .eq('id', id)
    .eq('user_id', decoded.userId)
    .single();

  if (error || !meal) {
    return NextResponse.json({ error: 'Meal not found' }, { status: 404 });
  }

  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? '').trim();

  // Idempotent — return existing token if already generated
  if (meal.share_token) {
    const shareUrl = `${appUrl}/meal/${meal.share_token}`;
    return NextResponse.json({ shareUrl });
  }

  // Generate a new share token
  const shareToken = crypto.randomUUID();

  const { error: updateError } = await supabase
    .from('meals')
    .update({ share_token: shareToken })
    .eq('id', id)
    .eq('user_id', decoded.userId);

  if (updateError) {
    log({ event: 'MEAL:UPDATE', status: 'error', userId: decoded.userId, detail: id, error: updateError });
    return NextResponse.json({ error: 'Failed to generate share link' }, { status: 500 });
  }

  const shareUrl = `${appUrl}/meal/${shareToken}`;
  log({ event: 'MEAL:UPDATE', status: 'success', userId: decoded.userId, detail: `share:${id}` });
  return NextResponse.json({ shareUrl });
}
