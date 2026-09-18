/**
 * Accounts named in `MFA_EXEMPT_EMAILS` (comma-separated) skip the 2FA gate.
 *
 * This exists for external app-review teams — Google Play data safety review
 * signs in as a creator, and the OTP goes to an inbox they have no access to,
 * so the gate is an unopenable door rather than a second factor. It is a
 * temporary, env-scoped allowlist: point it at a dedicated review account with
 * no real data on it, and delete the variable once the review is signed off.
 *
 * Compare it against the address Supabase authenticated, not one that was
 * posted, so the allowlist can only ever match the account that actually just
 * signed in.
 */
export function isMfaExempt(email: string): boolean {
  return (process.env.MFA_EXEMPT_EMAILS ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
    .includes(email.trim().toLowerCase());
}
