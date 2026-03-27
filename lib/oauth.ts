import { jwtVerify, createRemoteJWKSet, importPKCS8, SignJWT } from 'jose';
import { createServerSupabaseClient } from '@/lib/supabase';

// ── Google ──────────────────────────────────────────────────────────────────

const GOOGLE_JWKS = createRemoteJWKSet(
  new URL('https://www.googleapis.com/oauth2/v3/certs')
);

export async function verifyGoogleIdToken(idToken: string): Promise<{
  sub: string;
  email: string;
  email_verified: boolean;
  given_name?: string;
  family_name?: string;
  picture?: string;
} | null> {
  try {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (!clientId) throw new Error('GOOGLE_CLIENT_ID not configured');

    const validAudiences = [
      clientId,
      process.env.GOOGLE_IOS_CLIENT_ID,
      process.env.GOOGLE_ANDROID_CLIENT_ID,
    ].filter(Boolean) as string[];

    const { payload } = await jwtVerify(idToken, GOOGLE_JWKS, {
      issuer: ['https://accounts.google.com', 'accounts.google.com'],
      audience: validAudiences,
    });

    return {
      sub: payload.sub as string,
      email: payload.email as string,
      email_verified: payload.email_verified as boolean,
      given_name: payload.given_name as string | undefined,
      family_name: payload.family_name as string | undefined,
      picture: payload.picture as string | undefined,
    };
  } catch {
    return null;
  }
}

// ── Apple ───────────────────────────────────────────────────────────────────

const APPLE_JWKS = createRemoteJWKSet(
  new URL('https://appleid.apple.com/auth/keys')
);

export async function verifyAppleIdentityToken(identityToken: string, audience?: string): Promise<{
  sub: string;
  email: string | undefined;
  email_verified: boolean;
} | null> {
  try {
    const { payload } = await jwtVerify(identityToken, APPLE_JWKS, {
      issuer: 'https://appleid.apple.com',
      audience: audience ?? process.env.APPLE_SERVICE_ID ?? process.env.APPLE_BUNDLE_ID,
    });

    return {
      sub: payload.sub as string,
      email: payload.email as string | undefined,
      email_verified: !!(payload.email_verified),
    };
  } catch {
    return null;
  }
}

/**
 * Generate a short-lived Apple client_secret JWT.
 * Required for the server-side authorization_code exchange.
 */
export async function generateAppleClientSecret(): Promise<string> {
  const teamId = process.env.APPLE_TEAM_ID || '8XYA9SH887';
  const keyId = process.env.APPLE_KEY_ID!;
  const serviceId = process.env.APPLE_SERVICE_ID!;
  const privateKeyPem = (process.env.APPLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');

  const privateKey = await importPKCS8(privateKeyPem, 'ES256');

  return new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: keyId })
    .setIssuer(teamId)
    .setSubject(serviceId)
    .setAudience('https://appleid.apple.com')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
}

// ── Shared: upsert social user ───────────────────────────────────────────────

interface SocialUserParams {
  provider: 'google' | 'apple';
  providerId: string;
  email: string;
  firstName?: string;
  lastName?: string;
}

/**
 * Find or create a Mealio user for a verified social identity.
 * Returns { userId, email, tier, isAdmin }.
 */
export async function upsertSocialUser({
  provider,
  providerId,
  email,
  firstName,
  lastName,
}: SocialUserParams): Promise<{ userId: string; email: string; tier: string; isAdmin: boolean }> {
  const supabase = createServerSupabaseClient();
  const idColumn = provider === 'google' ? 'google_id' : 'apple_id';

  // 1. Look up by provider ID
  const { data: existing } = await supabase
    .from('user_profiles')
    .select('id, email, subscription_tier, is_admin')
    .eq(idColumn, providerId)
    .maybeSingle();

  if (existing) {
    await supabase
      .from('user_profiles')
      .update({ last_login_at: new Date().toISOString() })
      .eq('id', existing.id);
    return {
      userId: existing.id,
      email: existing.email,
      tier: existing.subscription_tier ?? 'free',
      isAdmin: existing.is_admin ?? false,
    };
  }

  // 2. Look up by email — link provider ID to existing account
  const { data: byEmail } = await supabase
    .from('user_profiles')
    .select('id, email, subscription_tier, is_admin')
    .eq('email', email)
    .maybeSingle();

  if (byEmail) {
    await supabase
      .from('user_profiles')
      .update({ [idColumn]: providerId, last_login_at: new Date().toISOString() })
      .eq('id', byEmail.id);
    return {
      userId: byEmail.id,
      email: byEmail.email,
      tier: byEmail.subscription_tier ?? 'free',
      isAdmin: byEmail.is_admin ?? false,
    };
  }

  // 3. Create new Supabase auth user + profile
  const displayName = [firstName, lastName].filter(Boolean).join(' ') || email.split('@')[0];
  const { data: newAuthUser, error: createError } = await supabase.auth.admin.createUser({
    email,
    email_confirm: true,
    user_metadata: { display_name: displayName, first_name: firstName, last_name: lastName },
  });

  if (createError || !newAuthUser?.user) {
    throw new Error(`Failed to create user: ${createError?.message}`);
  }

  const userId = newAuthUser.user.id;

  await supabase.from('user_profiles').upsert({
    id: userId,
    email,
    display_name: displayName,
    first_name: firstName ?? null,
    last_name: lastName ?? null,
    [idColumn]: providerId,
    subscription_tier: 'free',
    is_admin: false,
    last_login_at: new Date().toISOString(),
  });

  return { userId, email, tier: 'free', isAdmin: false };
}
