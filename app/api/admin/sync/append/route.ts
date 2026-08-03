import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';
import { requireAdmin } from '@/lib/requireAdmin';
import { log } from '@/lib/logger';
import { appendMealioLink, listAppendableMeals } from '@/lib/youtube-append';

/**
 * Writing the Mealio link back into a creator's video descriptions (MEAL-79).
 *
 * GET  ?creatorId= — the published meals that came from one of their videos.
 * POST { creatorId, draftId } — append the link to that meal's video.
 *
 * The consent gate is **not here**. `assertAppendAllowed` is the single
 * enforcement point and both handlers reach it through `lib/youtube-append.ts`,
 * so a refusal is the same refusal on the listing and on the write. A gate
 * implemented once in the endpoint that lists and once in the endpoint that
 * writes is a gate with two versions of itself.
 *
 * The refusal statuses come back verbatim rather than being flattened to 400:
 * 403 means the creator has not agreed to description edits, 409 means the
 * connection cannot carry the write, and an operator does something different
 * about each.
 */

// A read of the video plus a write, against an API that occasionally takes its
// time. Well under the import budget, more than the 10s default.
export const maxDuration = 30;

export async function GET(request: NextRequest) {
  const admin = await requireAdmin(request);
  if (!admin) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const creatorId = request.nextUrl.searchParams.get('creatorId') ?? '';
  if (!creatorId) {
    return NextResponse.json({ error: 'creatorId is required' }, { status: 400 });
  }

  const supabase = createServerSupabaseClient();
  const result = await listAppendableMeals(supabase, creatorId);

  if (!result.ok) {
    // The sentence is the product here: the screen shows it instead of a list,
    // so it has to say which of the three gates was shut and what to do.
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json({ meals: result.meals });
}

export async function POST(request: NextRequest) {
  const admin = await requireAdmin(request);
  if (!admin) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  let body: { creatorId?: unknown; draftId?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const creatorId = typeof body.creatorId === 'string' ? body.creatorId : '';
  const draftId = typeof body.draftId === 'string' ? body.draftId : '';
  if (!creatorId || !draftId) {
    return NextResponse.json({ error: 'creatorId and draftId are required' }, { status: 400 });
  }

  const supabase = createServerSupabaseClient();
  const result = await appendMealioLink({ supabase }, creatorId, draftId, admin.userId);

  if (!result.ok) {
    log({
      event: 'ADMIN:YOUTUBE_APPEND',
      status: 'error',
      userId: admin.userId,
      email: admin.email,
      detail: `creator=${creatorId} draft=${draftId} status=${result.status}`,
      reason: result.error,
    });
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  return NextResponse.json({
    written: result.written,
    detail: result.detail,
    mealUrl: result.mealUrl,
    videoId: result.videoId,
    quotaUnits: result.quotaUnits,
  });
}
