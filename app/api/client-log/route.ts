import { NextRequest, NextResponse } from 'next/server';
import { verifyAccessToken, extractTokenFromHeader } from '@/lib/tokens';
import { log } from '@/lib/logger';

export const dynamic = 'force-dynamic';

/**
 * POST /api/client-log
 * Mobile app logs client-side events here for server-side storage.
 * Body: { level: 'error' | 'warn' | 'info', event: string, detail?: string, error?: string }
 */
export async function POST(request: NextRequest) {
  const token = extractTokenFromHeader(request.headers.get('authorization'));
  const decoded = token ? await verifyAccessToken(token) : null;

  try {
    const body = await request.json();
    const { level, event, detail, error: errorMsg } = body ?? {};

    if (!event || typeof event !== 'string') {
      return NextResponse.json({ error: 'event is required' }, { status: 400 });
    }

    const status = level === 'error' ? 'error' : level === 'warn' ? 'failed' : 'success';

    log({
      event: 'CLIENT:ERROR',
      status,
      userId: decoded?.userId,
      email: decoded?.email,
      reason: event.slice(0, 64),
      detail: detail ? String(detail).slice(0, 256) : undefined,
      error: errorMsg ? new Error(String(errorMsg)) : undefined,
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: 'Bad request' }, { status: 400 });
  }
}
