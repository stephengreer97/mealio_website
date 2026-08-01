import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';
import { verifyAccessToken, extractTokenFromHeader } from '@/lib/tokens';
import { log } from '@/lib/logger';
import { runImport } from '@/lib/import/pipeline';
import { formatTelemetry } from '@/lib/import/telemetry';

/**
 * POST /api/creator/import — paste a link, get a filled-in meal draft.
 *
 * The HTTP surface over the MEAL-70/71/72 pipeline. Creator-only: this endpoint
 * makes our server fetch a URL the caller chose, so it must never be reachable
 * by an anonymous client even though the fetcher itself is SSRF-hardened.
 *
 * Request:  { url: string }
 * Response: 200 with an ImportSuccess, or 422 with an ImportRejection.
 *
 * The response body is the pipeline's `ImportResult` verbatim — `draft` holds
 * exactly the nine fields `POST /api/creator/meals` accepts, and `confidence`
 * is index-aligned with `draft.ingredients`.
 */

// The fetch, gate and extraction calls run in series; the default 10s function
// budget is not enough.
export const maxDuration = 60;

async function getCreator(request: NextRequest) {
  const token = extractTokenFromHeader(request.headers.get('authorization'));
  if (!token) return null;
  const decoded = await verifyAccessToken(token);
  if (!decoded) return null;

  const supabase = createServerSupabaseClient();
  const { data: creator } = await supabase
    .from('creators')
    .select('id, display_name')
    .eq('user_id', decoded.userId)
    .maybeSingle();

  if (!creator) return null;
  return { creator, userId: decoded.userId };
}

export async function POST(request: NextRequest) {
  const auth = await getCreator(request);
  if (!auth) {
    return NextResponse.json({ error: 'Creator account required' }, { status: 403 });
  }

  let body: { url?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const url = typeof body.url === 'string' ? body.url.trim() : '';
  if (!url) {
    return NextResponse.json({ error: 'url is required' }, { status: 400 });
  }

  // The pipeline emits its own CREATOR:MEAL_IMPORT telemetry line (platform,
  // path, gate verdict, confidence spread); this sink only adds who asked.
  const result = await runImport(url, {
    mode: 'manual',
    telemetry: (event) =>
      log({
        event: 'CREATOR:MEAL_IMPORT',
        status: event.outcome === 'ok' ? 'success' : 'error',
        userId: auth.creator.id,
        detail: formatTelemetry(event),
      }),
  });

  // 422 rather than 200-with-a-status-field so a rejection is visible to
  // monitoring; the body is the same discriminated union either way.
  return NextResponse.json(result, { status: result.status === 'ok' ? 200 : 422 });
}
