'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function SocialCallbackPage() {
  const router = useRouter();

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get('token');
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

      window.dispatchEvent(new CustomEvent('mealio:authChange', {
        detail: { accessToken: token, user },
      }));

      router.replace(redirect.startsWith('/') ? redirect : '/discover');
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
