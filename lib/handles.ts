// Shared creator-handle rules. A handle is a creator's immutable referral path
// (mealio.co/<handle>). Used by the apply route, admin approval, creator/me, the
// public [handle] page, and the attribution middleware so there is one source of
// truth for format + reserved words.

export const HANDLE_RE = /^[a-z0-9_-]{3,30}$/;

// Top-level route names (and a few brand/system words) that must never be claimed
// as a handle, so the /<handle> catch-all can't shadow a real page.
export const RESERVED_HANDLES = new Set<string>([
  'about', 'account', 'admin', 'api', 'app', 'check-email', 'creator', 'discover',
  'fonts', 'forgot-password', 'help', 'mail', 'meal', 'mealio', 'my-meals', 'pricing',
  'privacy', 'reset-password', 'robots', 'sitemap', 'signout', 'support', 'terms',
  'verify-email', 'www',
]);

/** Lowercase + trim; the canonical stored form of a handle. */
export function normalizeHandle(raw: string | null | undefined): string {
  return (raw ?? '').toLowerCase().trim();
}

/** True when `raw` normalizes to a well-formed, non-reserved handle. */
export function isValidHandle(raw: string | null | undefined): boolean {
  const h = normalizeHandle(raw);
  return HANDLE_RE.test(h) && !RESERVED_HANDLES.has(h);
}
