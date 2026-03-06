import { NextRequest, NextResponse } from 'next/server';
import { verifyAccessToken, extractTokenFromHeader } from '@/lib/tokens';
import { log } from '@/lib/logger';

/**
 * GET /api/auth/session-status
 * Validates the access token sent in the Authorization header.
 * Used by the extension to confirm the token is still good.
 */
export async function GET(request: NextRequest) {
  try {
    const token = extractTokenFromHeader(request.headers.get('authorization'));
    if (!token) {
      return NextResponse.json({ valid: false });
    }

    const decoded = await verifyAccessToken(token);
    return NextResponse.json({ valid: !!decoded });
  } catch (error) {
    log({ event: 'AUTH:SESSION_STATUS', status: 'error', error });
    return NextResponse.json({ valid: false });
  }
}
