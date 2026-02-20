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

  useEffect(() => {
    if (resendCooldown <= 0) return;
    const id = setTimeout(() => setResendCooldown(c => c - 1), 1000);
    return () => clearTimeout(id);
  }, [resendCooldown]);

  useEffect(() => {
    // Check if already logged in
    const accessToken = localStorage.getItem('accessToken');
    if (accessToken) {
      router.push('/dashboard');
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

      if (!response.ok) throw new Error(data.error || 'Authentication failed');

      localStorage.setItem('accessToken', data.accessToken);
      localStorage.setItem('refreshToken', data.refreshToken);
      localStorage.setItem('user', JSON.stringify(data.user));
      notifyExtension(data);
      window.dispatchEvent(new CustomEvent('mealio:authChange', {
        detail: { accessToken: data.accessToken, refreshToken: data.refreshToken, user: data.user },
      }));
      navigating = true;
      router.push('/dashboard');
    } catch (err: any) {
      setError(err.message);
    } finally {
      // Only re-enable the button on error — on success the page navigates away,
      // so leaving loading=true prevents a second click during the transition.
      if (!navigating) setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-red-50 via-white to-blue-50">
      <header className="bg-white border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-4 py-4 flex items-center gap-3">
          <div style={{ fontFamily: 'var(--font-pacifico), cursive', lineHeight: 1, letterSpacing: '0.5px' }}>
            <span style={{ fontSize: '42px', lineHeight: '0.85', display: 'inline-block', verticalAlign: 'middle', textShadow: '2px 3px 0px rgba(0,0,0,0.12)', color: '#dd0031' }}>M</span>
            <span style={{ fontSize: '32px', textShadow: '1px 2px 0px rgba(0,0,0,0.1)', color: '#dd0031' }}>ealio</span>
          </div>
        </div>
      </header>

      <div className="max-w-7xl mx-auto px-4 py-12">
        <div className="grid md:grid-cols-2 gap-12 items-center">
          <div>
            <h2 className="text-5xl font-bold text-gray-900 mb-6">
              Save time on<br />grocery shopping
            </h2>
            <p className="text-xl text-gray-600 mb-8">
              Automatically add meal ingredients to your cart at HEB, Walmart, and Kroger.
            </p>
          </div>

          <div className="bg-white rounded-2xl shadow-xl p-8">
            <div className="flex gap-4 mb-6">
              <button
                onClick={() => handleTabChange('login')}
                className={`flex-1 py-2 font-semibold rounded-lg transition ${
                  activeTab === 'login' ? 'bg-red-600 text-white' : 'bg-gray-100 text-gray-600'
                }`}
              >
                Log In
              </button>
              <button
                onClick={() => handleTabChange('signup')}
                className={`flex-1 py-2 font-semibold rounded-lg transition ${
                  activeTab === 'signup' ? 'bg-red-600 text-white' : 'bg-gray-100 text-gray-600'
                }`}
              >
                Sign Up
              </button>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              {activeTab === 'signup' && (
                <div className="flex gap-3">
                  <div className="flex-1">
                    <label className="block text-sm font-medium text-gray-700 mb-2">First Name</label>
                    <input
                      type="text"
                      value={firstName}
                      onChange={(e) => setFirstName(e.target.value)}
                      required
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-transparent"
                      placeholder="Jane"
                    />
                  </div>
                  <div className="flex-1">
                    <label className="block text-sm font-medium text-gray-700 mb-2">Last Name</label>
                    <input
                      type="text"
                      value={lastName}
                      onChange={(e) => setLastName(e.target.value)}
                      required
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-transparent"
                      placeholder="Doe"
                    />
                  </div>
                </div>
              )}

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Email</label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-transparent"
                  placeholder="you@example.com"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Password</label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={8}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-transparent"
                  placeholder="••••••••"
                />
                {activeTab === 'signup' && (
                  <p className="text-xs text-gray-500 mt-1">At least 8 characters</p>
                )}
                {activeTab === 'login' && (
                  <div className="text-right mt-1">
                    <button
                      type="button"
                      onClick={() => router.push('/forgot-password')}
                      className="text-xs text-red-600 hover:text-red-700 font-medium"
                    >
                      Forgot password?
                    </button>
                  </div>
                )}
              </div>

              {error && (
                <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">
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
                className="w-full bg-red-600 text-white py-3 rounded-lg font-semibold hover:bg-red-700 disabled:opacity-50"
              >
                {loading ? 'Loading...' : activeTab === 'login' ? 'Log In' : 'Create Account'}
              </button>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}
