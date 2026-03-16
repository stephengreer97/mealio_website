'use client';

import { Suspense, useState, useEffect } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';

function CheckEmailContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const email = searchParams.get('email') || 'your email address';
  const [resendStatus, setResendStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [countdown, setCountdown] = useState(60);

  useEffect(() => {
    if (countdown <= 0) return;
    const id = setTimeout(() => setCountdown(c => c - 1), 1000);
    return () => clearTimeout(id);
  }, [countdown]);

  const handleResend = async () => {
    setResendStatus('sending');
    try {
      const response = await fetch('/api/auth/resend-verification', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      if (response.ok) {
        setResendStatus('sent');
        setCountdown(60);
      } else {
        setResendStatus('error');
      }
    } catch {
      setResendStatus('error');
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-red-50 via-white to-blue-50 flex items-center justify-center">
      <div className="bg-white rounded-2xl shadow-xl p-10 max-w-md w-full text-center">
        <div className="mb-8" style={{ fontFamily: 'var(--font-pacifico), cursive' }}>
          <span style={{ fontSize: '42px', lineHeight: '0.85', display: 'inline-block', verticalAlign: 'middle', textShadow: '2px 3px 0px rgba(0,0,0,0.12)', color: '#dd0031' }}>M</span>
          <span style={{ fontSize: '32px', textShadow: '1px 2px 0px rgba(0,0,0,0.1)', color: '#dd0031' }}>ealio</span>
        </div>

        <div className="w-16 h-16 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-6">
          <svg className="w-8 h-8 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
          </svg>
        </div>

        <h2 className="text-2xl font-bold text-gray-900 mb-3">Check your email</h2>
        <p className="text-gray-500 text-sm mb-2">We sent a verification link to:</p>
        <p className="font-semibold text-gray-900 mb-4 break-all">{email}</p>
        <p className="text-sm text-gray-400 mb-8">
          Click the link in the email to complete your account setup. The link expires in 24 hours.
        </p>

        <div className="space-y-3">
          {resendStatus === 'sent' && (
            <div className="bg-green-50 border border-green-200 text-green-700 px-4 py-3 rounded-lg text-sm font-medium">
              Verification email resent! Check your inbox.
            </div>
          )}

          <button
            onClick={handleResend}
            disabled={resendStatus === 'sending' || countdown > 0}
            className="w-full bg-gray-100 text-gray-700 py-3 rounded-lg font-medium hover:bg-gray-200 disabled:opacity-50 transition"
          >
            {resendStatus === 'sending'
              ? 'Sending…'
              : countdown > 0
                ? `Resend in ${countdown}s`
                : 'Resend verification email'}
          </button>

          {resendStatus === 'error' && (
            <p className="text-sm text-red-600">Failed to resend. Please try again in a moment.</p>
          )}

          <button
            onClick={() => router.push('/signin')}
            className="w-full text-gray-400 py-2 text-sm hover:text-gray-600 transition"
          >
            Back to sign in
          </button>
        </div>
      </div>
    </div>
  );
}

// useSearchParams() requires a Suspense boundary in Next.js App Router
export default function CheckEmailPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center">
        <div className="w-8 h-8 border-4 border-red-600 border-t-transparent rounded-full animate-spin" />
      </div>
    }>
      <CheckEmailContent />
    </Suspense>
  );
}
