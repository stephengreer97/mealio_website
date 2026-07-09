import { SignJWT, jwtVerify } from 'jose';
import { createHash, randomBytes } from 'crypto';
import { createServerSupabaseClient } from '@/lib/supabase';

function getJwtSecret(): Uint8Array {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET environment variable is not configured');
  }
  return new TextEncoder().encode(secret);
}

const ACCESS_TOKEN_EXPIRY = '90d';

export async function createAccessToken(userId: string, email: string) {
  const token = await new SignJWT({
    sub: userId,
    email,
    type: 'access'
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(ACCESS_TOKEN_EXPIRY)
    .sign(getJwtSecret());

  return token;
}

// ── Token revocation ─────────────────────────────────────────────────────────
// logout-all / password change / password reset / account deletion stamp
// user_profiles.tokens_invalidated_at; any access token issued before that
// instant is dead. verifyAccessToken enforces this on EVERY call, so all
// protected routes get revocation for free. A short per-user cache keeps it from
// adding a DB read to each request; clearRevocationCache() busts it immediately
// when an invalidation is written.
const revocationCache = new Map<string, { invalidatedAt: number | null; expires: number }>();
const REVOCATION_TTL_MS = 30_000;

export function clearRevocationCache(userId: string) {
  revocationCache.delete(userId);
}

async function getInvalidatedAt(userId: string): Promise<number | null> {
  const now = Date.now();
  const cached = revocationCache.get(userId);
  if (cached && cached.expires > now) return cached.invalidatedAt;
  try {
    const supabase = createServerSupabaseClient();
    const { data } = await supabase
      .from('user_profiles')
      .select('tokens_invalidated_at')
      .eq('id', userId)
      .single();
    const invalidatedAt = data?.tokens_invalidated_at ? new Date(data.tokens_invalidated_at).getTime() : null;
    revocationCache.set(userId, { invalidatedAt, expires: now + REVOCATION_TTL_MS });
    return invalidatedAt;
  } catch {
    // Fail open on a DB hiccup: a valid-signature token is still accepted rather
    // than locking everyone out. The JWT signature check already passed.
    return null;
  }
}

export async function verifyAccessToken(token: string) {
  try {
    const { payload } = await jwtVerify(token, getJwtSecret());
    if (payload.type !== 'access') throw new Error('Invalid token type');
    const userId = payload.sub as string;
    const issuedAt = payload.iat as number;
    const invalidatedAt = await getInvalidatedAt(userId);
    if (invalidatedAt && issuedAt * 1000 < invalidatedAt) return null;
    return { userId, email: payload.email as string, issuedAt };
  } catch {
    return null;
  }
}

/**
 * Checks whether an access token has been revoked via logout.
 * Requires a `tokens_invalidated_at` column on user_profiles.
 * Call this after verifyAccessToken for sensitive operations.
 */
export async function checkTokenRevoked(
  supabase: any,
  userId: string,
  issuedAt: number
): Promise<boolean> {
  const { data } = await supabase
    .from('user_profiles')
    .select('tokens_invalidated_at')
    .eq('id', userId)
    .single();

  if (!data?.tokens_invalidated_at) return false;
  return issuedAt * 1000 < new Date(data.tokens_invalidated_at).getTime();
}

export async function createSessionToken(userId: string, email: string): Promise<string> {
  return new SignJWT({ sub: userId, email, type: 'session' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('90d')
    .sign(getJwtSecret());
}

export async function verifySessionToken(token: string): Promise<{ userId: string; email: string } | null> {
  try {
    const { payload } = await jwtVerify(token, getJwtSecret());
    if (payload.type !== 'session') return null;
    return {
      userId: payload.sub as string,
      email: payload.email as string,
    };
  } catch {
    return null;
  }
}

export async function createRefreshToken(userId: string) {
  const randomToken = randomBytes(32).toString('hex');
  const token = await new SignJWT({
    sub: userId,
    token: randomToken,
    type: 'refresh'
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('90d')
    .sign(getJwtSecret());

  const tokenHash = hashToken(randomToken);

  return {
    token,
    tokenHash,
    expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000)
  };
}

export async function verifyRefreshToken(token: string) {
  try {
    const { payload } = await jwtVerify(token, getJwtSecret());
    if (payload.type !== 'refresh') throw new Error('Invalid token type');
    return {
      userId: payload.sub as string,
      token: payload.token as string
    };
  } catch {
    return null;
  }
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function createTwoFactorToken(userId: string) {
  return new SignJWT({ sub: userId, type: '2fa_pending' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(getJwtSecret());
}

export async function verifyTwoFactorToken(token: string) {
  try {
    const { payload } = await jwtVerify(token, getJwtSecret());
    if (payload.type !== '2fa_pending') return null;
    return { userId: payload.sub as string };
  } catch {
    return null;
  }
}

export function extractTokenFromHeader(authHeader: string | null): string | null {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  return authHeader.substring(7);
}
