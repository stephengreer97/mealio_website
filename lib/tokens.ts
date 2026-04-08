import { SignJWT, jwtVerify } from 'jose';
import { createHash, randomBytes } from 'crypto';

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

export async function verifyAccessToken(token: string) {
  try {
    const { payload } = await jwtVerify(token, getJwtSecret());
    if (payload.type !== 'access') throw new Error('Invalid token type');
    return {
      userId: payload.sub as string,
      email: payload.email as string,
      issuedAt: payload.iat as number,
    };
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
