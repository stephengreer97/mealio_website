import { NextRequest, NextResponse } from 'next/server';
import { verifyAccessToken, extractTokenFromHeader } from '@/lib/tokens';
import { sendBugReportEmail } from '@/lib/email';
import { log } from '@/lib/logger';

export const dynamic = 'force-dynamic';

const MAX_DESC = 4000;
const MAX_LOGS = 256 * 1024; // 256 KB

/**
 * Server-side safety net. The client already redacts (Option B), but never trust
 * the client with PII: strip obvious secrets/emails again before anything is
 * emailed off-platform.
 */
function scrub(s: string): string {
  return s
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '‹token›')
    .replace(/\bBearer\s+\S+/gi, 'Bearer ‹secret›')
    .replace(/((?:set-)?cookie"?\s*[:=]\s*).*/gi, '$1‹secret›')
    .replace(/("?(?:authorization|password|passwd|pwd|token|secret|access[_-]?token|refresh[_-]?token)"?\s*[:=]\s*)("?)[^",\s}]+/gi, '$1$2‹secret›')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '‹email›');
}

/**
 * POST /api/bug-report
 * Body: { description: string, logs?: string, context?: object, source?: 'app'|'web' }
 * Emails contact@mealio.co with the description, context, and redacted logs.
 */
export async function POST(request: NextRequest) {
  // Auth is optional — attach the user id if a valid token is present.
  const token = extractTokenFromHeader(request.headers.get('authorization'));
  const decoded = token ? await verifyAccessToken(token) : null;

  try {
    const body = await request.json();
    const description = String(body?.description ?? '').trim().slice(0, MAX_DESC);
    if (description.length < 5) {
      return NextResponse.json({ error: 'description is required' }, { status: 400 });
    }

    const source: 'app' | 'web' = body?.source === 'web' ? 'web' : 'app';
    const logs = body?.logs ? scrub(String(body.logs)).slice(0, MAX_LOGS) : undefined;

    const context: Record<string, unknown> = {
      ...(body?.context && typeof body.context === 'object' ? body.context : {}),
    };
    // Trust the verified token for the user id over anything in the body.
    if (decoded?.userId) context.userId = decoded.userId;

    await sendBugReportEmail({ description, context, logs, source });

    log({ event: 'BUG_REPORT', status: 'success', userId: decoded?.userId, reason: description.slice(0, 64) });
    return NextResponse.json({ ok: true });
  } catch (err) {
    log({ event: 'BUG_REPORT', status: 'error', error: err instanceof Error ? err : new Error(String(err)) });
    return NextResponse.json({ error: 'Could not submit report' }, { status: 500 });
  }
}
