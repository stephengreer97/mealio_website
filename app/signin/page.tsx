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

      if (!response.ok && data.requiresVerification) {
        setNeedsVerification(true);
        setResendCooldown(60);
        setError(data.error || 'Email not verified');
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
