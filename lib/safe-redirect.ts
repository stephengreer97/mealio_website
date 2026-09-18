/**
 * The path to send someone to after sign-in, or `fallback` when the one asked
 * for is not a same-origin relative path.
 *
 * `startsWith('/')` is not that test. Browsers read `//evil.com` as a
 * protocol-relative URL, and treat a backslash as a slash in the authority, so
 * `/\evil.com` goes off-site too; tabs and newlines inside a URL are stripped
 * before it is parsed, so a slash, a tab and `/evil.com` becomes `//evil.com`.
 * Any of those in a `redirect` parameter turns our sign-in page into a
 * trampoline to a lookalike.
 *
 * So: one leading slash, no backslash anywhere, no control characters, and the
 * result must still resolve to our own origin. Client and server both use it,
 * so it has no dependencies.
 */
export function safeRedirectPath(raw: unknown, fallback = '/discover'): string {
  if (typeof raw !== 'string' || raw.length === 0) return fallback;
  if (!raw.startsWith('/') || raw.startsWith('//')) return fallback;
  if (raw.includes('\\')) return fallback;
  if (CONTROL_CHARS.test(raw)) return fallback;
  try {
    const base = 'https://mealio.invalid';
    if (new URL(raw, base).origin !== base) return fallback;
  } catch {
    return fallback;
  }
  return raw;
}

// C0 controls and DEL, written as escapes so the source holds none of them.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
