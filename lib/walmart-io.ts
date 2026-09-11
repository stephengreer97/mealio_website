import crypto from 'crypto';

/**
 * The Walmart IO affiliate API, signed.
 *
 * App-to-app auth with no client secret: a consumer id, a key version, and a
 * signature made with the private key whose public half is uploaded to
 * walmart.io. Walmart's own words, 2026-09-11: "Once you have a consumer ID and
 * a private key, you can generate an authentication signature and invoke the
 * APIs using any REST API client."
 *
 * THE SIGNATURE IS OVER THREE VALUES IN ONE ORDER. Consumer id, timestamp, key
 * version, newline-delimited with a trailing newline, sorted alphabetically by
 * header name (which is the order below). Signed SHA256/RSA, base64. It expires
 * after three minutes, so it is built per request and never cached.
 */
const BASE = 'https://developer.api.walmart.com/api-proxy/service/affil/product/v2/';

/** The endpoints this build is allowed to call. */
export const WALMART_IO_PATHS = ['taxonomy', 'search', 'items', 'stores'] as const;
export type WalmartIoPath = (typeof WALMART_IO_PATHS)[number];

function authHeaders(): Record<string, string> | null {
  const consumerId = process.env.WALMART_IO_CONSUMER_ID;
  const keyVersion = process.env.WALMART_IO_KEY_VERSION;
  const privateKey = (process.env.WALMART_IO_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  if (!consumerId || !keyVersion || !privateKey) return null;

  const timestamp = Date.now().toString();
  const payload = `${consumerId}\n${timestamp}\n${keyVersion}\n`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(payload), privateKey).toString('base64');

  return {
    'WM_CONSUMER.ID': consumerId,
    'WM_CONSUMER.INTIMESTAMP': timestamp,
    'WM_SEC.KEY_VERSION': keyVersion,
    'WM_SEC.AUTH_SIGNATURE': signature,
    Accept: 'application/json',
  };
}

export interface WalmartIoResult {
  ok: boolean;
  status: number | null;
  ms: number;
  /** Parsed JSON, or the first part of the body when it is not JSON. */
  body: unknown;
  /** Set when the credentials are missing or the request never completed. */
  error?: string;
}

export async function walmartIoCall(path: WalmartIoPath, query: Record<string, string> = {}): Promise<WalmartIoResult> {
  const headers = authHeaders();
  if (!headers) {
    return { ok: false, status: null, ms: 0, body: null, error: 'WALMART_IO_* not configured' };
  }

  const url = new URL(BASE + path);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);

  const started = Date.now();
  try {
    const response = await fetch(url, { headers });
    const text = await response.text();
    let body: unknown;
    try { body = JSON.parse(text); } catch { body = text.slice(0, 600); }
    return { ok: response.ok, status: response.status, ms: Date.now() - started, body };
  } catch (err) {
    return { ok: false, status: null, ms: Date.now() - started, body: null, error: String(err).slice(0, 200) };
  }
}
