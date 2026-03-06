import { SignJWT, jwtVerify } from 'jose';
import { createHash, randomBytes } from 'crypto';

const JWT_SECRET = new TextEncoder().encode(
  process.env.JWT_SECRET || 'fallback-secret-change-in-production'
);

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
    .sign(JWT_SECRET);

  return token;
}

export async function verifyAccessToken(token: string) {
  try {
    const { payload } = await jwtVerify(token, JWT_SECRET);
    if (payload.type !== 'access') throw new Error('Invalid token type');
    return {
      userId: payload.sub as string,
      email: payload.email as string
    };
  } catch (error) {
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
    .sign(JWT_SECRET);

  const tokenHash = hashToken(randomToken);

  return {
    token,
    tokenHash,
    expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000)
  };
}

export async function verifyRefreshToken(token: string) {
  try {
    const { payload } = await jwtVerify(token, JWT_SECRET);
    if (payload.type !== 'refresh') throw new Error('Invalid token type');
    return {
      userId: payload.sub as string,
      token: payload.token as string
    };
  } catch (error) {
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
    .sign(JWT_SECRET);
}

export async function verifyTwoFactorToken(token: string) {
  try {
    const { payload } = await jwtVerify(token, JWT_SECRET);
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
