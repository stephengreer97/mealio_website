import { NextRequest, NextResponse } from 'next/server';
import { HANDLE_RE, RESERVED_HANDLES, normalizeHandle } from '@/lib/handles';

// Creator referral attribution: when someone visits mealio.co/<handle>, drop a
// `mealio_ref` cookie so we can credit the creator when that visitor later signs
// up (see app/api/auth/register/route.ts). Last-touch: overwrite each visit.
// The value is validated against a real creator handle at signup time, so a
// cookie set for a bogus single-segment path is harmless.
export function middleware(request: NextRequest) {
  const res = NextResponse.next();

  const seg = request.nextUrl.pathname.slice(1); // strip leading '/'
  if (seg && !seg.includes('/')) {
    const h = normalizeHandle(seg);
    if (HANDLE_RE.test(h) && !RESERVED_HANDLES.has(h)) {
      res.cookies.set('mealio_ref', h, {
        maxAge: 60 * 60 * 24 * 90, // 90 days
        sameSite: 'lax',
        path: '/',
      });
    }
  }

  return res;
}

export const config = {
  // Page paths only: skip /api, Next internals, and any file request (has a dot).
  matcher: ['/((?!api|_next|.*\\..*).*)'],
};
