import { NextRequest } from 'next/server';
import { verifyAccessToken, extractTokenFromHeader } from '@/lib/tokens';

export interface AuthedUser {
  userId: string;
  email: string;
  issuedAt: number;
}

/**
 * Canonical request auth for protected routes. Verifies the bearer access token,
 * which now also enforces revocation (logout-all / password change / deletion) —
 * see verifyAccessToken. Returns the authed user, or null; the caller returns 401
 * on null.
 */
export async function requireAuth(request: NextRequest): Promise<AuthedUser | null> {
  const token = extractTokenFromHeader(request.headers.get('authorization'));
  if (!token) return null;
  return verifyAccessToken(token);
}
