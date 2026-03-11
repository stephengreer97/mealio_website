'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

type Status = 'loading' | 'success' | 'error';

export default function VerifyEmailPage() {
  const router = useRouter();
  const [status, setStatus] = useState<Status>('loading');
  const [errorMessage, setErrorMessage] = useState('');
  const ran = useRef(false); // guard against React StrictMode double-invoke

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;

    // Safety net: never leave the user on an infinite spinner
    const timeout = setTimeout(() => {
      setErrorMessage('Verification timed out. Please try clicking the link again or request a new one.');
      setStatus('error');
    }, 15000);

    async function handleVerification() {
      try {
        // Supabase implicit flow: tokens in the hash fragment
        //   success: #access_token=...&type=signup (or type=email in newer Supabase)
        //   failure: #error=access_denied&error_code=otp_expired&...
        const hashParams = new URLSearchParams(window.location.hash.slice(1));

        if (hashParams.get('error')) {
          const desc = hashParams.get('error_description')?.replace(/\+/g, ' ');
          setErrorMessage(
            desc
              ? `${desc}. Please request a new verification email.`
              : 'Your verification link is invalid or has expired. Please request a new one.'
          );
          setStatus('error');
          return;
        }

        const accessToken = hashParams.get('access_token');
        // Supabase uses 'signup' in older versions and 'email' in newer ones
        const type = hashParams.get('type');
        const isVerificationToken = type === 'signup' || type === 'email';

        if (!accessToken || !isVerificationToken) {
          setErrorMessage('Your verification link is invalid or has expired. Please request a new one.');
          setStatus('error');
          return;
        }

        const response = await fetch('/api/auth/complete-verification', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ supabaseAccessToken: accessToken }),
        });

        const data = await response.json();

        if (!response.ok) {
          setErrorMessage(data.error || 'Verification failed. Please try again.');
          setStatus('error');
          return;
        }

        localStorage.setItem('accessToken', data.accessToken);
        localStorage.setItem('refreshToken', data.refreshToken);
        localStorage.setItem('user', JSON.stringify(data.user));

        // Notify the extension content script so it can forward the tokens
        // to the background service worker immediately, without waiting for a
        // full page refresh (which would re-run content-mealio-web.js).
        window.dispatchEvent(new CustomEvent('mealio:authChange', {
          detail: { accessToken: data.accessToken, refreshToken: data.refreshToken, user: data.user },
        }));

        setStatus('success');

        // Try to open the mobile app with the token. If the app is not installed
        // (or the user is on desktop) this is a no-op and we fall back to /discover.
        window.location.href = `mealio://verified?token=${encodeURIComponent(data.accessToken)}`;
        setTimeout(() => router.push('/discover'), 1500);
      } catch (err) {
        console.error('Verification error:', err);
        setErrorMessage('Something went wrong. Please try again.');
        setStatus('error');
      } finally {
        clearTimeout(timeout);
      }
    }

    handleVerification();

    return () => clearTimeout(timeout);
  }, [router]);

  return (
    <div className="min-h-screen bg-gradient-to-br from-red-50 via-white to-blue-50 flex items-center justify-center">
      <div className="bg-white rounded-2xl shadow-xl p-10 max-w-md w-full text-center">
        <div className="mb-8" style={{ fontFamily: 'var(--font-pacifico), cursive' }}>
          <span style={{ fontSize: '42px', lineHeight: '0.85', display: 'inline-block', verticalAlign: 'middle', textShadow: '2px 3px 0px rgba(0,0,0,0.12)', color: '#dd0031' }}>M</span>
          <span style={{ fontSize: '32px', textShadow: '1px 2px 0px rgba(0,0,0,0.1)', color: '#dd0031' }}>ealio</span>
        </div>

        {status === 'loading' && (
          <>
            <div className="w-12 h-12 border-4 border-red-600 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
            <h2 className="text-xl font-bold text-gray-900 mb-2">Verifying your email…</h2>
            <p className="text-gray-500 text-sm">Just a moment</p>
          </>
        )}

        {status === 'success' && (
          <>
            <div className="w-14 h-14 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <svg className="w-7 h-7 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <h2 className="text-xl font-bold text-gray-900 mb-2">Email verified!</h2>
            <p className="text-gray-500 text-sm">Redirecting you to your dashboard…</p>
          </>
        )}

        {status === 'error' && (
          <>
            <div className="w-14 h-14 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <svg className="w-7 h-7 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </div>
            <h2 className="text-xl font-bold text-gray-900 mb-3">Verification failed</h2>
            <p className="text-gray-500 text-sm mb-6">{errorMessage}</p>
            <button
              onClick={() => router.push('/')}
              className="w-full bg-red-600 text-white py-3 rounded-lg font-semibold hover:bg-red-700 transition"
            >
              Back to Sign In
            </button>
          </>
        )}
      </div>
    </div>
  );
}
