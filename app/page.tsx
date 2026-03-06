'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function Home() {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<'login' | 'signup'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [needsVerification, setNeedsVerification] = useState(false);
  const [resendStatus, setResendStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [resendCooldown, setResendCooldown] = useState(0);
  const [needsTwoFactor, setNeedsTwoFactor] = useState(false);
  const [twoFactorToken, setTwoFactorToken] = useState('');
  const [otpCode, setOtpCode] = useState('');
  const [otpResendStatus, setOtpResendStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [otpResendCooldown, setOtpResendCooldown] = useState(0);
  const [rememberDevice, setRememberDevice] = useState(false);

  useEffect(() => {
    if (resendCooldown <= 0) return;
    const id = setTimeout(() => setResendCooldown(c => c - 1), 1000);
    return () => clearTimeout(id);
  }, [resendCooldown]);

  useEffect(() => {
    if (otpResendCooldown <= 0) return;
    const id = setTimeout(() => setOtpResendCooldown(c => c - 1), 1000);
    return () => clearTimeout(id);
  }, [otpResendCooldown]);

  useEffect(() => {
    // Check if already logged in
    const accessToken = localStorage.getItem('accessToken');
    if (accessToken) {
      const params = new URLSearchParams(window.location.search);
      const redirect = params.get('redirect');
      router.push(redirect && redirect.startsWith('/') ? redirect : '/discover');
    }
  }, [router]);

  const handleTabChange = (tab: 'login' | 'signup') => {
    setActiveTab(tab);
    setNeedsVerification(false);
    setResendStatus('idle');
    setError('');
    setFirstName('');
    setLastName('');
  };

  const handleResendVerification = async () => {
    setResendStatus('sending');
    try {
      const response = await fetch('/api/auth/resend-verification', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      if (response.ok) {
        setResendStatus('sent');
        setResendCooldown(60);
      } else {
        setResendStatus('error');
      }
    } catch {
      setResendStatus('error');
    }
  };

  const getPostLoginRedirect = () => {
    // If user came from a share link via "Create Account" button
    const pendingToken = localStorage.getItem('pendingShareToken');
    if (pendingToken) {
      localStorage.removeItem('pendingShareToken');
      return `/meal/${pendingToken}?autoSave=1`;
    }
    // If a redirect URL was passed as a query param (e.g. from the share page)
    const params = new URLSearchParams(window.location.search);
    const redirect = params.get('redirect');
    if (redirect && redirect.startsWith('/')) return redirect;
    return '/discover';
  };

  const notifyExtension = (authData: any) => {
    // Try to notify the extension about successful login
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chromeExt = (globalThis as any).chrome;
    if (chromeExt && chromeExt.runtime && chromeExt.runtime.sendMessage) {
      try {
        // Get extension ID from localStorage or environment variable
        // User can set this in their browser console: localStorage.setItem('mealioExtensionId', 'YOUR_EXTENSION_ID')
        const extensionId = localStorage.getItem('mealioExtensionId') ||
                           process.env.NEXT_PUBLIC_EXTENSION_ID ||
                           'YOUR_EXTENSION_ID_HERE';

        if (extensionId === 'YOUR_EXTENSION_ID_HERE') {
          console.log('ℹ️  Extension ID not configured. Set it with: localStorage.setItem("mealioExtensionId", "YOUR_ID")');
          return;
        }

        // When calling from a webpage, must provide extension ID as first argument
        chromeExt.runtime.sendMessage(
          extensionId,
          {
            action: 'loginSuccess',
            data: authData
          },
          (response: any) => {
            if (chromeExt.runtime.lastError) {
              console.log('Extension not installed or not responding:', chromeExt.runtime.lastError.message);
            } else {
              console.log('✅ Extension notified of login');
            }
          }
        );
      } catch (error) {
        console.log('Could not notify extension:', error);
      }
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setNeedsVerification(false);
    setResendStatus('idle');
    setLoading(true);

    let navigating = false;
    try {
      const endpoint = activeTab === 'login' ? '/api/auth/login' : '/api/auth/register';
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          activeTab === 'signup'
            ? { email, password, firstName, lastName }
            : { email, password }
        ),
      });

      const data = await response.json();

      // Signup: redirect to check-email page
      if (activeTab === 'signup' && data.requiresVerification) {
        navigating = true;
        router.push(`/check-email?email=${encodeURIComponent(email)}`);
        return;
      }

      // Login blocked because email isn't verified yet
      if (!response.ok && data.requiresVerification) {
        setNeedsVerification(true);
        setResendCooldown(60);
        setError(data.error || 'Email not verified');
        return;
      }

      // 2FA required
      if (response.ok && data.requiresTwoFactor) {
        setTwoFactorToken(data.twoFactorToken);
        setNeedsTwoFactor(true);
        setOtpResendCooldown(60);
        return;
      }

      if (!response.ok) throw new Error(data.error || 'Authentication failed');

      localStorage.setItem('accessToken', data.accessToken);
      localStorage.setItem('refreshToken', data.refreshToken);
      localStorage.setItem('user', JSON.stringify(data.user));
      notifyExtension(data);
      window.dispatchEvent(new CustomEvent('mealio:authChange', {
        detail: { accessToken: data.accessToken, refreshToken: data.refreshToken, user: data.user },
      }));
      navigating = true;
      router.push(getPostLoginRedirect());
    } catch (err: any) {
      setError(err.message);
    } finally {
      // Only re-enable the button on error — on success the page navigates away,
      // so leaving loading=true prevents a second click during the transition.
      if (!navigating) setLoading(false);
    }
  };

  const handleOtpSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    let navigating = false;
    try {
      const res = await fetch('/api/auth/2fa/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ twoFactorToken, code: otpCode, rememberDevice }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || 'Verification failed'); return; }

      localStorage.setItem('accessToken', data.accessToken);
      localStorage.setItem('refreshToken', data.refreshToken);
      localStorage.setItem('user', JSON.stringify(data.user));
      notifyExtension(data);
      window.dispatchEvent(new CustomEvent('mealio:authChange', {
        detail: { accessToken: data.accessToken, refreshToken: data.refreshToken, user: data.user },
      }));
      navigating = true;
      router.push(getPostLoginRedirect());
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      if (!navigating) setLoading(false);
    }
  };

  const handleOtpResend = async () => {
    setOtpResendStatus('sending');
    try {
      const res = await fetch('/api/auth/2fa/resend', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ twoFactorToken }),
      });
      if (res.ok) {
        setOtpResendStatus('sent');
        setOtpResendCooldown(60);
        setOtpCode('');
      } else {
        setOtpResendStatus('error');
      }
    } catch {
      setOtpResendStatus('error');
    }
  };

  if (needsTwoFactor) {
    return (
      <div className="min-h-screen bg-wk-bg flex items-center justify-center px-4">
        <div className="bg-wk-card rounded-2xl p-8 w-full max-w-sm" style={{ boxShadow: 'var(--wk-shadow-md)', border: '1px solid var(--wk-border)' }}>
          <div style={{ fontFamily: 'var(--font-pacifico), cursive', color: 'var(--wk-red)', fontSize: '28px', marginBottom: '24px' }}>Mealio</div>
          <h2 className="text-xl font-bold text-wk-text mb-2">Check your email</h2>
          <p className="text-sm text-wk-text2 mb-6">
            We sent a 6-digit code to <strong>{email}</strong>. It expires in 10 minutes.
          </p>
          <form onSubmit={handleOtpSubmit} className="space-y-4">
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={6}
              value={otpCode}
              onChange={e => setOtpCode(e.target.value.replace(/\D/g, ''))}
              placeholder="000000"
              required
              autoFocus
              className="w-full px-4 py-3 text-center text-2xl font-bold tracking-widest rounded-lg focus:outline-none"
              style={{ border: '1px solid var(--wk-border)', background: 'var(--wk-surface)', color: 'var(--wk-text)' }}
            />
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={rememberDevice}
                onChange={e => setRememberDevice(e.target.checked)}
                className="w-4 h-4 rounded accent-wk-red"
              />
              <span className="text-sm text-wk-text2">Remember this device for 30 days</span>
            </label>
            {error && (
              <div className="px-4 py-3 rounded-lg text-sm" style={{ background: 'var(--wk-red-bg)', border: '1px solid #fecdd3', color: '#9f1239' }}>
                {error}
              </div>
            )}
            <button
              type="submit"
              disabled={loading || otpCode.length < 6}
              className="w-full text-white py-3 rounded-lg font-semibold disabled:opacity-50 transition-opacity"
              style={{ background: 'var(--wk-red)' }}
            >
              {loading ? 'Verifying…' : 'Verify'}
            </button>
          </form>
          <div className="mt-4 text-center">
            {otpResendStatus === 'sent' && (
              <p className="text-sm text-green-700 mb-1">New code sent!</p>
            )}
            {otpResendStatus === 'error' && (
              <p className="text-sm mb-1" style={{ color: 'var(--wk-red)' }}>Failed to resend. Try again.</p>
            )}
            <button
              type="button"
              onClick={handleOtpResend}
              disabled={otpResendStatus === 'sending' || otpResendCooldown > 0}
              className="text-sm text-wk-text3 hover:text-wk-text2 disabled:opacity-50 transition-colors"
            >
              {otpResendStatus === 'sending'
                ? 'Sending…'
                : otpResendCooldown > 0
                  ? `Resend code in ${otpResendCooldown}s`
                  : 'Resend code'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-wk-bg">
      <header style={{ background: 'var(--wk-card)', borderBottom: '1px solid var(--wk-border)' }}>
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center gap-3">
          <div style={{ fontFamily: 'var(--font-pacifico), cursive', lineHeight: 1, letterSpacing: '0.5px' }}>
            <span style={{ fontSize: '42px', lineHeight: '0.85', display: 'inline-block', verticalAlign: 'middle', textShadow: '2px 3px 0px rgba(0,0,0,0.10)', color: 'var(--wk-red)' }}>M</span>
            <span style={{ fontSize: '32px', textShadow: '1px 2px 0px rgba(0,0,0,0.08)', color: 'var(--wk-red)' }}>ealio</span>
          </div>
        </div>
      </header>

      <div className="max-w-6xl mx-auto px-6 py-16">
        <div className="grid md:grid-cols-2 gap-16 items-center">
          <div>
            <h2 className="text-5xl font-bold text-wk-text mb-6 leading-tight">
              Shop meals,<br />we'll fill the cart
            </h2>
            <p className="text-lg text-wk-text2 mb-8 leading-relaxed">
              Automatically add meal ingredients to your cart at all major grocery retailers.
            </p>
            <div className="flex flex-col gap-3">
              {[
                'Works with 36 major grocery retailers',
                'One-click add entire meals to your cart',
                'Save and reuse your favorite recipes',
                'Discover meals from your favorite creators',
              ].map(feat => (
                <div key={feat} className="flex items-center gap-3">
                  <div className="w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0" style={{ background: 'var(--wk-red-bg)', border: '1px solid #fecdd3' }}>
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2 5l2 2 4-4" stroke="#dd0031" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                  </div>
                  <span className="text-sm text-wk-text2">{feat}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-2xl p-8" style={{ background: 'var(--wk-card)', boxShadow: 'var(--wk-shadow-md)', border: '1px solid var(--wk-border)' }}>
            <div className="flex gap-2 mb-6 p-1 rounded-xl" style={{ background: 'var(--wk-surface)' }}>
              <button
                onClick={() => handleTabChange('login')}
                className="flex-1 py-2 text-sm font-semibold rounded-lg transition-all"
                style={activeTab === 'login'
                  ? { background: 'var(--wk-card)', color: 'var(--wk-text)', boxShadow: 'var(--wk-shadow)' }
                  : { background: 'transparent', color: 'var(--wk-text2)' }}
              >
                Log In
              </button>
              <button
                onClick={() => handleTabChange('signup')}
                className="flex-1 py-2 text-sm font-semibold rounded-lg transition-all"
                style={activeTab === 'signup'
                  ? { background: 'var(--wk-card)', color: 'var(--wk-text)', boxShadow: 'var(--wk-shadow)' }
                  : { background: 'transparent', color: 'var(--wk-text2)' }}
              >
                Sign Up
              </button>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              {activeTab === 'signup' && (
                <div className="flex gap-3">
                  <div className="flex-1">
                    <label className="block text-xs font-semibold text-wk-text2 mb-1.5">First Name</label>
                    <input
                      type="text"
                      value={firstName}
                      onChange={(e) => setFirstName(e.target.value)}
                      required
                      className="w-full px-3 py-2 rounded-lg text-sm focus:outline-none transition-colors"
                      style={{ border: '1px solid var(--wk-border)', background: 'var(--wk-surface)', color: 'var(--wk-text)' }}
                      placeholder="Jane"
                    />
                  </div>
                  <div className="flex-1">
                    <label className="block text-xs font-semibold text-wk-text2 mb-1.5">Last Name</label>
                    <input
                      type="text"
                      value={lastName}
                      onChange={(e) => setLastName(e.target.value)}
                      required
                      className="w-full px-3 py-2 rounded-lg text-sm focus:outline-none transition-colors"
                      style={{ border: '1px solid var(--wk-border)', background: 'var(--wk-surface)', color: 'var(--wk-text)' }}
                      placeholder="Doe"
                    />
                  </div>
                </div>
              )}

              <div>
                <label className="block text-xs font-semibold text-wk-text2 mb-1.5">Email</label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  className="w-full px-3 py-2 rounded-lg text-sm focus:outline-none transition-colors"
                  style={{ border: '1px solid var(--wk-border)', background: 'var(--wk-surface)', color: 'var(--wk-text)' }}
                  placeholder="you@example.com"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-wk-text2 mb-1.5">Password</label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={8}
                  className="w-full px-3 py-2 rounded-lg text-sm focus:outline-none transition-colors"
                  style={{ border: '1px solid var(--wk-border)', background: 'var(--wk-surface)', color: 'var(--wk-text)' }}
                  placeholder="••••••••"
                />
                {activeTab === 'signup' && (
                  <p className="text-xs text-wk-text3 mt-1">At least 8 characters</p>
                )}
                {activeTab === 'login' && (
                  <div className="text-right mt-1">
                    <button
                      type="button"
                      onClick={() => router.push('/forgot-password')}
                      className="text-xs font-medium transition-colors"
                      style={{ color: 'var(--wk-red)' }}
                    >
                      Forgot password?
                    </button>
                  </div>
                )}
              </div>

              {error && (
                <div className="px-4 py-3 rounded-lg text-sm" style={{ background: 'var(--wk-red-bg)', border: '1px solid #fecdd3', color: '#9f1239' }}>
                  <p>{error}</p>
                  {needsVerification && (
                    <div className="mt-2">
                      {resendStatus === 'sent' && (
                        <p className="text-green-700 font-medium">Verification email sent! Check your inbox.</p>
                      )}
                      <button
                        type="button"
                        onClick={handleResendVerification}
                        disabled={resendStatus === 'sending' || resendCooldown > 0}
                        className="underline font-medium disabled:opacity-50"
                      >
                        {resendStatus === 'sending'
                          ? 'Sending…'
                          : resendCooldown > 0
                            ? `Resend in ${resendCooldown}s`
                            : 'Resend verification email'}
                      </button>
                      {resendStatus === 'error' && (
                        <p className="mt-1">Failed to resend. Please try again.</p>
                      )}
                    </div>
                  )}
                </div>
              )}

              <button
                type="submit"
                disabled={loading}
                className="w-full text-white py-3 rounded-lg text-sm font-semibold disabled:opacity-50 transition-opacity"
                style={{ background: 'var(--wk-red)' }}
              >
                {loading ? 'Loading...' : activeTab === 'login' ? 'Log In' : 'Create Account'}
              </button>

              {activeTab === 'signup' && (
                <p className="text-xs text-center text-wk-text3 mt-3">
                  By creating an account, you agree to our{' '}
                  <a href="/terms" className="underline hover:text-wk-text2">Terms and Conditions</a>
                  {' '}and{' '}
                  <a href="/privacy" className="underline hover:text-wk-text2">Privacy Policy</a>.
                </p>
              )}
            </form>
          </div>
        </div>
      </div>

      <div className="text-center py-8 text-xs text-wk-text3 space-x-3">
        <a href="/about" className="hover:text-wk-text2 transition-colors">About</a>
        <span style={{ color: 'var(--wk-border)' }}>·</span>
        <a href="/help" className="hover:text-wk-text2 transition-colors">Help</a>
        <span style={{ color: 'var(--wk-border)' }}>·</span>
        <a href="/terms" className="hover:text-wk-text2 transition-colors">Terms</a>
        <span style={{ color: 'var(--wk-border)' }}>·</span>
        <a href="/privacy" className="hover:text-wk-text2 transition-colors">Privacy Policy</a>
        <span style={{ color: 'var(--wk-border)' }}>·</span>
        <a href="mailto:contact@mealio.co" className="hover:text-wk-text2 transition-colors">Contact</a>
      </div>
    </div>
  );
}
