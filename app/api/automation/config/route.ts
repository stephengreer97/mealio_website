import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';
import { verifyAccessToken, extractTokenFromHeader } from '@/lib/tokens';
import { log } from '@/lib/logger';

// GET /api/automation/config
//
// Returns the active remote automation config for the mobile WebView cart engine:
//   { version: number, config: {...}, updatedAt: string }
//
// `config` is a PARTIAL override tree — only the keys that differ from the app's
// bundled defaults. The client deep-merges it over those defaults, so:
//   • an empty {} is valid and means "use the bundled config"
//   • a key an older client doesn't understand is ignored, not fatal
// Both properties are what make this safe to push without gating on app version.
//
// Auth is required (the app always has a token before it runs automation) so we
// aren't publishing our store selectors to anyone who curls the endpoint. A
// client that gets 401/5xx here falls back to its bundled config and still works,
// which is why failure paths are deliberately quiet.
//
// Supports conditional GET: send If-None-Match and get 304 when unchanged. The
// app polls this on every cold start, so the common case should cost no body.

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const token = extractTokenFromHeader(request.headers.get('authorization'));
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const decoded = await verifyAccessToken(token);
  if (!decoded) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const supabase = createServerSupabaseClient();
  const { data, error } = await supabase
    .from('automation_config')
    .select('version, config, created_at')
    .eq('is_active', true)
    .maybeSingle();

  if (error) {
    log({ event: 'AUTOMATION:CONFIG', status: 'error', userId: decoded.userId, error });
    return NextResponse.json({ error: 'Failed to load config' }, { status: 500 });
  }

  // No active row (migration not yet run, or someone deactivated everything).
  // Version 0 + empty overrides is the honest answer: it tells the client "there
  // is nothing to apply", which it treats exactly like the bundled default.
  const version = typeof data?.version === 'number' ? data.version : 0;
  const config = data?.config && typeof data.config === 'object' ? data.config : {};
  const updatedAt = data?.created_at ?? null;

  // Version alone identifies the payload: publishing always inserts a new version
  // and flips is_active, and rows are immutable once written.
  const etag = `"automation-config-v${version}"`;
  if (request.headers.get('if-none-match') === etag) {
    return new NextResponse(null, { status: 304, headers: { ETag: etag } });
  }

  return NextResponse.json(
    { version, config, updatedAt },
    {
      headers: {
        ETag: etag,
        // Short public-ish cache: config pushes should reach clients in minutes,
        // not hours, but we also don't want a cold-start stampede hitting the DB.
        'Cache-Control': 'private, max-age=60, stale-while-revalidate=300',
      },
    },
  );
}
