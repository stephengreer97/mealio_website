'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { safeRedirectPath } from '@/lib/safe-redirect';

export default function SocialCallbackPage() {
  const router = useRouter();

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    // The access token is delivered via a short-lived, JS-readable cookie
    // (mealio_oauth_token) instead of the URL to avoid history/Referer/log leaks.
    //
    // ONLY the cookie. This page used to fall back to ?token= when the cookie
    // was missing, so anyone could send a link carrying THEIR OWN token and the
    // victim would be silently signed in to the attacker's account, saving
    // meals and store logins into it. The cookie can only have been set by our
    // own OAuth callback on this origin, which is what makes it trustworthy.
    const cookieToken = document.cookie
      .split('; ')
      .find((c) => c.startsWith('mealio_oauth_token='))
      ?.split('=')[1];
    const token = cookieToken ? decodeURIComponent(cookieToken) : null;
    // Consume the handoff cookie immediately.
    if (cookieToken) {
      document.cookie = 'mealio_oauth_token=; Max-Age=0; path=/auth/social-callback';
    }
    const userEncoded = params.get('user');
    const redirect = params.get('redirect') || '/discover';
    const error = params.get('error');

    if (error) {
      const messages: Record<string, string> = {
        oauth_cancelled: 'Sign in was cancelled.',
        oauth_failed: 'Sign in failed. Please try again.',
        apple_no_email: 'Apple did not share your email. Please allow email access and try again.',
      };
      router.replace(`/signin?error=${encodeURIComponent(messages[error] || 'Sign in failed.')}`);
      return;
    }

    if (!token || !userEncoded) {
      router.replace('/signin');
      return;
    }

    try {
      const user = JSON.parse(Buffer.from(userEncoded, 'base64').toString('utf-8'));
      localStorage.setItem('accessToken', token);
      localStorage.setItem('user', JSON.stringify(user));

      router.replace(safeRedirectPath(redirect));
    } catch {
      router.replace('/signin');
    }
  }, [router]);

  return (
    <div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--bg)' }}>
      <div className="text-center">
        <div style={{ fontFamily: 'var(--font-pacifico), cursive', color: 'var(--brand)', fontSize: '26px', marginBottom: '16px' }}>Mealio</div>
        <p style={{ color: 'var(--text-2)', fontSize: '14px' }}>Signing you in…</p>
      </div>
    </div>
  );
}
