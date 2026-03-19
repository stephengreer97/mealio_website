import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { SignJWT, jwtVerify } from 'jose';

// ── Encryption ──────────────────────────────────────────────────────────────

const ALGORITHM = 'aes-256-gcm';

function getEncryptionKey(): Buffer {
  const keyHex = process.env.KROGER_TOKEN_ENCRYPTION_KEY;
  if (!keyHex) throw new Error('KROGER_TOKEN_ENCRYPTION_KEY not configured');
  const buf = Buffer.from(keyHex, 'hex');
  if (buf.length !== 32) throw new Error('KROGER_TOKEN_ENCRYPTION_KEY must be 32 bytes (64 hex chars)');
  return buf;
}

/** AES-256-GCM encrypt. Returns "ivHex:authTagHex:ciphertextHex". */
export function encryptKrogerToken(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

/** AES-256-GCM decrypt. Input must be "ivHex:authTagHex:ciphertextHex". */
export function decryptKrogerToken(encryptedData: string): string {
  const key = getEncryptionKey();
  const parts = encryptedData.split(':');
  if (parts.length !== 3) throw new Error('Invalid encrypted token format');
  const [ivHex, authTagHex, ciphertextHex] = parts;
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const ciphertext = Buffer.from(ciphertextHex, 'hex');
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

// ── OAuth State Token ────────────────────────────────────────────────────────

const JWT_SECRET = new TextEncoder().encode(
  process.env.JWT_SECRET || 'fallback-secret-change-in-production'
);

/** Create a short-lived state token to survive the OAuth round-trip. */
export async function createKrogerStateToken(userId: string, returnTo?: string, popup?: boolean, mobile?: boolean): Promise<string> {
  return new SignJWT({ sub: userId, type: 'kroger_state', ...(returnTo ? { returnTo } : {}), ...(popup ? { popup: true } : {}), ...(mobile ? { mobile: true } : {}) })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(JWT_SECRET);
}

export async function verifyKrogerStateToken(
  token: string
): Promise<{ userId: string; returnTo?: string; popup?: boolean; mobile?: boolean } | null> {
  try {
    const { payload } = await jwtVerify(token, JWT_SECRET);
    if (payload.type !== 'kroger_state') return null;
    return { userId: payload.sub as string, returnTo: payload.returnTo as string | undefined, popup: payload.popup as boolean | undefined, mobile: payload.mobile as boolean | undefined };
  } catch {
    return null;
  }
}

// ── Product match scoring ────────────────────────────────────────────────────

function normalizeText(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

const CRITICAL_WORDS = new Set([
  'organic', 'grass', 'fed', 'free', 'range', 'cage', 'large', 'small', 'jumbo',
  'medium', 'extra', 'spicy', 'mild', 'hot', 'sweet', 'whole', 'skim', 'nonfat',
  'lowfat', 'salted', 'unsalted', 'sodium', 'boneless', 'skinless', 'lean', 'ground',
]);

/**
 * Returns 0-100 score for how well a search term matches a product description.
 * If the search term contains critical words (organic, boneless, etc.) that are
 * absent from the description, returns 0 — indicating a review is needed.
 */
export function scoreProductMatch(searchTerm: string, description: string): number {
  const stripAvg = (s: string) => s.replace(/,\s*avg\s+[\d.]+\s*\w+\s*$/i, '').trim();
  const normSearch = normalizeText(stripAvg(searchTerm));
  const normDesc   = normalizeText(stripAvg(description));
  if (normSearch === normDesc) return 100;

  const searchWords = normSearch.split(' ').filter(Boolean);
  const descWordSet = new Set(normDesc.split(' ').filter(Boolean));

  // If the search term specifies a critical attribute, the description must have it too
  for (const w of searchWords) {
    if (CRITICAL_WORDS.has(w) && !descWordSet.has(w)) return 0;
  }

  const matchCount = searchWords.filter(w => descWordSet.has(w)).length;
  const matchPct   = matchCount / searchWords.length;
  if (matchPct < 0.7) return 0;

  return Math.min(99, Math.round(matchPct * 100)); // 100 reserved for exact string match only
}

// ── Kroger API helpers ───────────────────────────────────────────────────────

const KROGER_BASE = 'https://api.kroger.com/v1';

function krogerCredentials(): string {
  const clientId = process.env.KROGER_CLIENT_ID;
  const clientSecret = process.env.KROGER_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('Kroger API credentials not configured');
  return Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
}

/** Exchange authorization code for access + refresh tokens (user flow). */
export async function exchangeKrogerCode(
  code: string,
  redirectUri: string
): Promise<{ accessToken: string; refreshToken: string }> {
  const credentials = krogerCredentials();
  const res = await fetch(`${KROGER_BASE}/connect/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
    }).toString(),
    cache: 'no-store',
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Kroger token exchange failed: ${err}`);
  }
  const data = await res.json();
  return { accessToken: data.access_token, refreshToken: data.refresh_token };
}

/** Use a (decrypted) refresh token to get a fresh user access token.
 *  Also returns the new refresh token if Kroger rotated it (always store it). */
export async function refreshKrogerAccessToken(
  refreshToken: string
): Promise<{ accessToken: string; newRefreshToken: string | null }> {
  const credentials = krogerCredentials();
  const res = await fetch(`${KROGER_BASE}/connect/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }).toString(),
    cache: 'no-store',
  });
  if (!res.ok) throw new Error('Failed to refresh Kroger access token');
  const data = await res.json();
  return {
    accessToken: data.access_token,
    newRefreshToken: data.refresh_token ?? null,
  };
}

/** Fetch up to `limit` products from Kroger for a search term. */
export async function krogerSearchProducts(
  userAccessToken: string,
  term: string,
  locationId: string,
  limit = 5,
  _retry = 0
): Promise<Array<{ upc: string; description: string; size: string | null; averageWeightPerUnit: string | null; imageUrl: string | null; stockLevel: string | null; price: number | null; soldBy: string | null }>> {
  const truncatedTerm = term
    .replace(/,\s*avg\s+[\d.]+\s*\w+\s*$/i, '')  // strip weight suffix e.g. ", avg 5.1 lbs"
    .replace(/[™®©]/g, '')   // strip trademark symbols — Kroger counts each as a word
    .trim()
    .split(/\s+/)
    .slice(0, 8)
    .join(' ');
  const params = new URLSearchParams({
    'filter.term': truncatedTerm,
    'filter.locationId': locationId,
    'filter.limit': String(Math.min(limit, 10)),
  });
  const res = await fetch(`${KROGER_BASE}/products?${params}`, {
    headers: { Authorization: `Bearer ${userAccessToken}`, Accept: 'application/json' },
    cache: 'no-store',
  });
  if (!res.ok) return [];
  const data = await res.json();
  console.log('[Kroger:search] term (sent):', truncatedTerm, 'raw response:', JSON.stringify(data, null, 2));
  const products: any[] = data.data ?? [];

  // Retry once if empty — Kroger occasionally returns nothing on the first call
  if (products.length === 0 && _retry === 0) {
    await new Promise(r => setTimeout(r, 400));
    return krogerSearchProducts(userAccessToken, term, locationId, limit, 1);
  }

  return products
    .filter(p => {
      const f = p.fulfillment;
      if (!f) return true; // fulfillment not returned by this endpoint — don't filter
      return f.inStore || f.shipToHome || f.delivery || f.curbside;
    })
    .map(p => {
      const images: any[] = p.images ?? [];
      const featured = images.find((img: any) => img.featured) ?? images[0];
      const imageUrl: string | null = featured?.sizes?.find((s: any) => s.size === 'medium')?.url ?? null;
      const stockLevel: string | null = p.items?.[0]?.inventory?.stockLevel ?? null;
      const itemPrice = p.items?.[0]?.price;
      const soldBy: string | null = p.items?.[0]?.soldBy ?? null;
      const price: number | null = itemPrice?.promo ?? itemPrice?.regular ?? null;
      const size: string | null = p.items?.[0]?.size ?? null;
      const averageWeightPerUnit: string | null = p.itemInformation?.averageWeightPerUnit ?? null;
      return { upc: p.upc ?? p.productId, description: p.description ?? term, size, averageWeightPerUnit, imageUrl, stockLevel, price, soldBy };
    });
}

/** Search for a product at a given Kroger store. Returns the UPC, description, and exact flag or null. */
export async function krogerSearchProduct(
  userAccessToken: string,
  term: string,
  locationId: string
): Promise<{ upc: string; description: string; exact: boolean } | null> {
  const results = await krogerSearchProducts(userAccessToken, term, locationId, 1);
  if (results.length === 0) return null;
  const { upc, description } = results[0];
  return { upc, description, exact: scoreProductMatch(term, description) === 100 };
}

/** Add items to the user's Kroger cart. Returns true on success. */
export async function krogerAddToCart(
  userAccessToken: string,
  items: Array<{ upc: string; quantity: number; modality?: string }>
): Promise<boolean> {
  const res = await fetch(`${KROGER_BASE}/cart/add`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${userAccessToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      items: items.map((item) => ({
        upc: item.upc,
        quantity: item.quantity,
        modality: item.modality ?? 'PICKUP',
      })),
    }),
    cache: 'no-store',
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`Kroger cart API ${res.status}: ${errBody}`);
  }
  return true;
}
