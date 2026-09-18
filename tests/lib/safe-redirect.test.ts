import { describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/logger', () => ({ log: vi.fn(), abbreviateUa: () => '' }));

import { safeRedirectPath } from '@/lib/safe-redirect';
import { GET as googleStart } from '@/app/api/auth/oauth/google/route';

/**
 * Every sign-in redirect used to be checked with `startsWith('/')`, which
 * `//evil.com` and `/\evil.com` both pass and both leave the site.
 */
describe('safeRedirectPath', () => {
  it.each([
    '/discover',
    '/meal/p/123?autoSave=1',
    '/my-meals#top',
  ])('keeps the same-origin path %s', (path) => {
    expect(safeRedirectPath(path)).toBe(path);
  });

  it.each([
    ['protocol-relative', '//evil.com'],
    ['protocol-relative with a path', '//evil.com/discover'],
    ['backslash authority', '/\\evil.com'],
    ['backslash anywhere', '/discover\\..\\\\evil.com'],
    ['tab that the URL parser strips', '/\t/evil.com'],
    ['newline', '/\n/evil.com'],
    ['absolute URL', 'https://evil.com'],
    ['javascript scheme', 'javascript:alert(1)'],
    ['relative without a slash', 'evil.com'],
    ['empty', ''],
  ])('refuses %s', (_label, path) => {
    expect(safeRedirectPath(path)).toBe('/discover');
  });

  it('refuses a non-string and uses the fallback it is given', () => {
    expect(safeRedirectPath(undefined)).toBe('/discover');
    expect(safeRedirectPath({ path: '/x' }, '/account')).toBe('/account');
  });
});

describe('where the redirect enters: /api/auth/oauth/google', () => {
  it('carries only a safe path through the OAuth state', async () => {
    vi.stubEnv('GOOGLE_CLIENT_ID', 'client');
    const res = await googleStart(new NextRequest('http://localhost/api/auth/oauth/google?redirect=%2F%2Fevil.com'));
    const state = new URL(res.headers.get('location')!).searchParams.get('state')!;
    expect(JSON.parse(Buffer.from(state, 'base64url').toString()).redirect).toBe('/discover');
    vi.unstubAllEnvs();
  });
});
