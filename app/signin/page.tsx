'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import PasswordStrength from '@/components/PasswordStrength';

export default function SignIn() {
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
    const params = new URLSearchParams(window.location.search);
    const accessToken = localStorage.getItem('accessToken');
    if (accessToken) {
      const redirect = params.get('redirect');
      router.push(redirect && redirect.startsWith('/') ? redirect : '/discover');
    } else if (params.get('tab') === 'signup') {
      setActiveTab('signup');
    }
    const oauthError = params.get('error');
    if (oauthError) setError(oauthError);
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
      if (response.ok) { setResendStatus('sent'); setResendCooldown(60); }
      else setResendStatus('error');
    } catch { setResendStatus('error'); }
  };

  const getPostLoginRedirect = () => {
    const pendingToken = localStorage.getItem('pendingShareToken');
    if (pendingToken) {
      localStorage.removeItem('pendingShareToken');
      return `/meal/${pendingToken}?autoSave=1`;
    }
    const params = new URLSearchParams(window.location.search);
    const redirect = params.get('redirect');
    if (redirect && redirect.startsWith('/')) return redirect;
    return '/discover';
  };

  const notifyExtension = (authData: any) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chromeExt = (globalThis as any).chrome;
    if (chromeExt && chromeExt.runtime && chromeExt.runtime.sendMessage) {
      try {
        const extensionId = localStorage.getItem('mealioExtensionId') ||
                           process.env.NEXT_PUBLIC_EXTENSION_ID ||
                           'YOUR_EXTENSION_ID_HERE';
        if (extensionId === 'YOUR_EXTENSION_ID_HERE') return;
        chromeExt.runtime.sendMessage(extensionId, { action: 'loginSuccess', data: authData }, (response: any) => {
          if (chromeExt.runtime.lastError) console.log('Extension not responding:', chromeExt.runtime.lastError.message);
        });
      } catch {}
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

      if (activeTab === 'signup' && data.requiresVerification) {
        navigating = true;
        router.push(`/check-email?email=${encodeURIComponent(email)}`);
        return;
      }

      if (data.requiresVerification) {
        setNeedsVerification(true);
        setResendCooldown(60);
        setError('Please verify your email before logging in.');
        return;
      }

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
      if (res.ok) { setOtpResendStatus('sent'); setOtpResendCooldown(60); setOtpCode(''); }
      else setOtpResendStatus('error');
    } catch { setOtpResendStatus('error'); }
  };

  // ── 2FA screen ─────────────────────────────────────────────────────────────
  if (needsTwoFactor) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4" style={{ background: 'var(--bg)' }}>
        <div className="w-full max-w-sm rounded-2xl p-8" style={{ background: 'var(--surface-raised)', boxShadow: 'var(--shadow-md)', border: '1px solid var(--border)' }}>
          <div style={{ fontFamily: 'var(--font-pacifico), cursive', color: 'var(--brand)', fontSize: '26px', marginBottom: '24px', lineHeight: 1 }}>Mealio</div>
          <h2 className="text-xl font-bold mb-2" style={{ color: 'var(--text-1)' }}>Check your email</h2>
          <p className="text-sm mb-6 leading-relaxed" style={{ color: 'var(--text-2)' }}>
            We sent a 6-digit code to <strong style={{ color: 'var(--text-1)' }}>{email}</strong>. It expires in 10 minutes.
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
              className="w-full px-4 py-3 text-center text-2xl font-bold tracking-widest rounded-xl focus:outline-none transition-colors"
              style={{
                border: '1.5px solid var(--border)',
                background: 'var(--surface)',
                color: 'var(--text-1)',
                fontFamily: 'var(--font-mono, monospace)',
                letterSpacing: '0.25em',
              }}
              onFocus={e => (e.target.style.borderColor = 'var(--brand)')}
              onBlur={e => (e.target.style.borderColor = 'var(--border)')}
            />
            <label className="flex items-center gap-2.5 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={rememberDevice}
                onChange={e => setRememberDevice(e.target.checked)}
                className="w-4 h-4 rounded"
                style={{ accentColor: 'var(--brand)' }}
              />
              <span className="text-sm" style={{ color: 'var(--text-2)' }}>Remember this device for 30 days</span>
            </label>
            {error && (
              <div className="px-4 py-3 rounded-xl text-sm" style={{ background: 'var(--brand-light)', border: '1px solid var(--brand-border)', color: '#9f1239' }}>
                {error}
              </div>
            )}
            <button
              type="submit"
              disabled={loading || otpCode.length < 6}
              className="w-full text-white py-3 rounded-xl font-semibold disabled:opacity-50 transition-colors"
              style={{ background: 'var(--brand)' }}
              onMouseEnter={e => { if (!loading && otpCode.length >= 6) (e.currentTarget as HTMLElement).style.background = 'var(--brand-dark)'; }}
              onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = 'var(--brand)'}
            >
              {loading ? 'Verifying…' : 'Verify'}
            </button>
          </form>
          <div className="mt-4 text-center">
            {otpResendStatus === 'sent' && (
              <p className="text-sm mb-1" style={{ color: 'var(--success)' }}>New code sent!</p>
            )}
            {otpResendStatus === 'error' && (
              <p className="text-sm mb-1" style={{ color: 'var(--brand)' }}>Failed to resend. Try again.</p>
            )}
            <button
              type="button"
              onClick={handleOtpResend}
              disabled={otpResendStatus === 'sending' || otpResendCooldown > 0}
              className="text-sm disabled:opacity-50 transition-colors"
              style={{ color: 'var(--text-3)', background: 'none', border: 'none', cursor: 'pointer' }}
              onMouseEnter={e => (e.currentTarget as HTMLElement).style.color = 'var(--text-2)'}
              onMouseLeave={e => (e.currentTarget as HTMLElement).style.color = 'var(--text-3)'}
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

  // ── Main landing ───────────────────────────────────────────────────────────
  const inputStyle = {
    border: '1.5px solid var(--border)',
    background: 'var(--surface)',
    color: 'var(--text-1)',
    width: '100%',
    padding: '10px 14px',
    borderRadius: '10px',
    fontSize: '14px',
    outline: 'none',
    transition: 'border-color 0.15s',
  };

  const FEATURES = [
    { text: 'Works with 36 major grocery retailers' },
    { text: 'One-click add entire meals to your cart' },
    { text: 'Save and reuse your favorite recipes' },
    { text: 'Discover meals from your favorite creators' },
  ];

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg)' }}>
      {/* Header */}
      <header style={{ background: 'var(--surface-raised)', borderBottom: '1px solid var(--border)' }}>
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center gap-3">
          <div style={{ fontFamily: 'var(--font-pacifico), cursive', lineHeight: 1 }}>
            <span style={{ fontSize: '38px', lineHeight: '0.9', display: 'inline-block', verticalAlign: 'middle', color: 'var(--brand)' }}>M</span>
            <span style={{ fontSize: '28px', color: 'var(--brand)' }}>ealio</span>
          </div>
        </div>
      </header>

      <div className="max-w-6xl mx-auto px-6 py-12 md:py-20">
        <div className="grid md:grid-cols-2 gap-12 lg:gap-20 items-center">
          {/* Hero left */}
          <div>
            <h1 className="text-5xl font-bold mb-5 leading-tight" style={{ color: 'var(--text-1)', letterSpacing: '-0.02em' }}>
              Shop meals,<br />
              <span style={{ color: 'var(--brand)' }}>we'll fill</span> the cart
            </h1>
            <p className="text-lg mb-8 leading-relaxed" style={{ color: 'var(--text-2)' }}>
              Automatically add meal ingredients to your cart at all major grocery retailers.
            </p>
            <div className="flex flex-col gap-3">
              {FEATURES.map(feat => (
                <div key={feat.text} className="flex items-center gap-3">
                  <div
                    className="w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0"
                    style={{ background: 'var(--brand-light)', border: '1px solid var(--brand-border)' }}
                  >
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                      <path d="M2 5l2 2 4-4" stroke="var(--brand)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  </div>
                  <span className="text-sm" style={{ color: 'var(--text-2)' }}>{feat.text}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Auth card right */}
          <div className="rounded-2xl p-7" style={{ background: 'var(--surface-raised)', boxShadow: 'var(--shadow-md)', border: '1px solid var(--border)' }}>
            {/* Tab switcher */}
            <div className="flex gap-1 mb-6 p-1 rounded-xl" style={{ background: 'var(--surface)' }}>
              {(['login', 'signup'] as const).map(tab => (
                <button
                  key={tab}
                  onClick={() => handleTabChange(tab)}
                  className="flex-1 py-2 text-sm font-semibold rounded-lg transition-all"
                  style={activeTab === tab
                    ? { background: 'var(--surface-raised)', color: 'var(--text-1)', boxShadow: 'var(--shadow-sm)' }
                    : { background: 'transparent', color: 'var(--text-3)', border: 'none' }}
                >
                  {tab === 'login' ? 'Log In' : 'Sign Up'}
                </button>
              ))}
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              {activeTab === 'signup' && (
                <div className="flex gap-3">
                  {[
                    { label: 'First Name', value: firstName, onChange: setFirstName, placeholder: 'Jane' },
                    { label: 'Last Name',  value: lastName,  onChange: setLastName,  placeholder: 'Doe' },
                  ].map(f => (
                    <div key={f.label} className="flex-1">
                      <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--text-2)' }}>{f.label}</label>
                      <input
                        type="text"
                        value={f.value}
                        onChange={e => f.onChange(e.target.value)}
                        required
                        style={inputStyle}
                        placeholder={f.placeholder}
                        onFocus={e => (e.target.style.borderColor = 'var(--brand)')}
                        onBlur={e => (e.target.style.borderColor = 'var(--border)')}
                      />
                    </div>
                  ))}
                </div>
              )}

              <div>
                <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--text-2)' }}>Email</label>
                <input
                  type="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  required
                  style={inputStyle}
                  placeholder="you@example.com"
                  onFocus={e => (e.target.style.borderColor = 'var(--brand)')}
                  onBlur={e => (e.target.style.borderColor = 'var(--border)')}
                />
              </div>

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="block text-xs font-semibold" style={{ color: 'var(--text-2)' }}>Password</label>
                  {activeTab === 'login' && (
                    <button
                      type="button"
                      onClick={() => router.push('/forgot-password')}
                      className="text-xs font-medium transition-colors"
                      style={{ color: 'var(--brand)', background: 'none', border: 'none', cursor: 'pointer' }}
                    >
                      Forgot password?
                    </button>
                  )}
                </div>
                <input
                  type="password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  required
                  minLength={8}
                  style={inputStyle}
                  placeholder="••••••••"
                  onFocus={e => (e.target.style.borderColor = 'var(--brand)')}
                  onBlur={e => (e.target.style.borderColor = 'var(--border)')}
                />
                {activeTab === 'signup' && <PasswordStrength password={password} />}
              </div>

              {error && (
                <div className="px-4 py-3 rounded-xl text-sm" style={{ background: 'var(--brand-light)', border: '1px solid var(--brand-border)', color: '#9f1239' }}>
                  <p>{error}</p>
                  {needsVerification && (
                    <div className="mt-2">
                      {resendStatus === 'sent' && (
                        <p style={{ color: 'var(--success)' }} className="font-medium">Verification email sent! Check your inbox.</p>
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
                      {resendStatus === 'error' && <p className="mt-1">Failed to resend. Please try again.</p>}
                    </div>
                  )}
                </div>
              )}

              <button
                type="submit"
                disabled={loading}
                className="w-full text-white py-3 rounded-xl text-sm font-semibold disabled:opacity-50 transition-colors"
                style={{ background: 'var(--brand)' }}
                onMouseEnter={e => { if (!loading) (e.currentTarget as HTMLElement).style.background = 'var(--brand-dark)'; }}
                onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = 'var(--brand)'}
              >
                {loading ? 'Loading…' : activeTab === 'login' ? 'Log In' : 'Create Account'}
              </button>

              {activeTab === 'signup' && (
                <p className="text-xs text-center mt-3" style={{ color: 'var(--text-3)' }}>
                  By creating an account, you agree to our{' '}
                  <a href="/terms" className="underline" style={{ color: 'var(--text-2)' }}>Terms</a>
                  {' '}and{' '}
                  <a href="/privacy" className="underline" style={{ color: 'var(--text-2)' }}>Privacy Policy</a>.
                </p>
              )}
            </form>

            {/* Social login */}
            <div className="mt-5">
              <div className="flex items-center gap-3 mb-4">
                <div className="flex-1 h-px" style={{ background: 'var(--border)' }} />
                <span className="text-xs" style={{ color: 'var(--text-3)' }}>or continue with</span>
                <div className="flex-1 h-px" style={{ background: 'var(--border)' }} />
              </div>
              <div className="flex gap-3">
                <a
                  href={`/api/auth/oauth/google${typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('redirect') ? `?redirect=${encodeURIComponent(new URLSearchParams(window.location.search).get('redirect')!)}` : ''}`}
                  className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-medium transition-colors"
                  style={{ border: '1.5px solid var(--border)', background: 'var(--surface)', color: 'var(--text-1)', textDecoration: 'none' }}
                  onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = 'var(--surface-raised)'}
                  onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = 'var(--surface)'}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                    <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
                    <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                    <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/>
                    <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
                  </svg>
                  Google
                </a>
                <a
                  href={`/api/auth/oauth/apple${typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('redirect') ? `?redirect=${encodeURIComponent(new URLSearchParams(window.location.search).get('redirect')!)}` : ''}`}
                  className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-medium transition-colors"
                  style={{ border: '1.5px solid var(--border)', background: 'var(--surface)', color: 'var(--text-1)', textDecoration: 'none' }}
                  onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = 'var(--surface-raised)'}
                  onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = 'var(--surface)'}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.8-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z"/>
                  </svg>
                  Apple
                </a>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Footer links */}
      <div className="text-center py-8 flex items-center justify-center gap-4 flex-wrap">
        {['Help', 'Terms', 'Privacy', 'Contact'].map((link) => (
          <a
            key={link}
            href={link === 'Contact' ? 'mailto:contact@mealio.co' : `/${link.toLowerCase()}`}
            className="text-xs transition-colors"
            style={{ color: 'var(--text-3)', textDecoration: 'none' }}
            onMouseEnter={e => (e.currentTarget as HTMLElement).style.color = 'var(--text-2)'}
            onMouseLeave={e => (e.currentTarget as HTMLElement).style.color = 'var(--text-3)'}
          >
            {link}
          </a>
        ))}
      </div>
    </div>
  );
}
