'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

const MONTHLY_PRICE_ID = process.env.NEXT_PUBLIC_STRIPE_MONTHLY_PRICE_ID ?? '';
const ANNUAL_PRICE_ID  = process.env.NEXT_PUBLIC_STRIPE_ANNUAL_PRICE_ID  ?? '';

const MONTHLY_PRICE = process.env.NEXT_PUBLIC_LS_MONTHLY_PRICE ?? '3.49';
const ANNUAL_PRICE  = process.env.NEXT_PUBLIC_LS_ANNUAL_PRICE  ?? '29.99';

interface AuthUser {
  id: string;
  email: string;
  tier: string;
}

export default function PricingPage() {
  const router = useRouter();
  const [billing, setBilling] = useState<'monthly' | 'annual'>('monthly');
  const [user, setUser] = useState<AuthUser | null>(null);
  const [portalLoading, setPortalLoading] = useState(false);
  const [checkoutLoading, setCheckoutLoading] = useState(false);

  useEffect(() => {
    const token = localStorage.getItem('accessToken');
    if (!token) return;

    fetch('/api/auth/verify', {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data?.user) setUser(data.user); })
      .catch(() => {});
  }, []);

  const openManageSubscription = async () => {
    setPortalLoading(true);
    try {
      const token = localStorage.getItem('accessToken');
      const res = await fetch('/api/payments/portal', {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (data.portalUrl) {
        window.open(data.portalUrl, '_blank');
      } else {
        alert('Could not load billing portal. Please try again.');
      }
    } catch {
      alert('Could not load billing portal. Please try again.');
    } finally {
      setPortalLoading(false);
    }
  };

  const handleCheckout = async () => {
    const token = localStorage.getItem('accessToken');
    if (!token) { router.push('/'); return; }
    setCheckoutLoading(true);
    try {
      const priceId = billing === 'monthly' ? MONTHLY_PRICE_ID : ANNUAL_PRICE_ID;
      const res = await fetch('/api/payments/checkout', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ priceId }),
      });
      const data = await res.json();
      if (data.url) window.location.href = data.url;
    } finally {
      setCheckoutLoading(false);
    }
  };

  const isFullAccess = user?.tier === 'paid';
  const checkoutReady = !!(billing === 'monthly' ? MONTHLY_PRICE_ID : ANNUAL_PRICE_ID);

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200">
        <div className="max-w-5xl mx-auto px-4 py-4 flex justify-between items-center">
          <button
            onClick={() => router.back()}
            className="text-sm text-gray-600 hover:text-gray-900"
          >
            ← Back
          </button>
          <div style={{ fontFamily: 'var(--font-pacifico), cursive', lineHeight: 1 }}>
            <span style={{ fontSize: '36px', lineHeight: '0.85', display: 'inline-block', verticalAlign: 'middle', textShadow: '2px 3px 0px rgba(0,0,0,0.12)', color: '#dd0031' }}>M</span>
            <span style={{ fontSize: '28px', textShadow: '1px 2px 0px rgba(0,0,0,0.1)', color: '#dd0031' }}>ealio</span>
          </div>
          {user ? (
            <button onClick={() => router.push('/discover')} className="text-sm text-gray-600 hover:text-gray-900">
              Dashboard →
            </button>
          ) : (
            <button onClick={() => router.push('/')} className="text-sm text-red-600 font-semibold hover:text-red-700">
              Sign In
            </button>
          )}
        </div>
      </header>

      <div className="max-w-5xl mx-auto px-4 py-16">
        {/* Heading */}
        <div className="text-center mb-12">
          <h1 className="text-4xl font-bold text-gray-900 mb-4">Simple, honest pricing</h1>
          <p className="text-lg text-gray-600">
            Try Mealio free, then unlock unlimited meals when you&apos;re ready.
          </p>

          {/* Monthly / Annual toggle */}
          <div className="mt-8 inline-flex items-center bg-gray-100 rounded-full p-1">
            <button
              onClick={() => setBilling('monthly')}
              className={`px-5 py-2 rounded-full text-sm font-semibold transition ${
                billing === 'monthly' ? 'bg-white shadow text-gray-900' : 'text-gray-500'
              }`}
            >
              Monthly
            </button>
            <button
              onClick={() => setBilling('annual')}
              className={`px-5 py-2 rounded-full text-sm font-semibold transition flex items-center gap-2 ${
                billing === 'annual' ? 'bg-white shadow text-gray-900' : 'text-gray-500'
              }`}
            >
              Annual
              <span className="bg-green-100 text-green-700 text-xs font-bold px-2 py-0.5 rounded-full">
                Save 2 months
              </span>
            </button>
          </div>
        </div>

        {/* Plan cards */}
        <div className="grid md:grid-cols-2 gap-8 max-w-3xl mx-auto">

          {/* Free Trial */}
          <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-8 flex flex-col">
            <div className="mb-6">
              <h2 className="text-xl font-bold text-gray-900 mb-1">Free Trial</h2>
              <p className="text-sm text-gray-500">Try it out at no cost</p>
            </div>

            <div className="mb-6">
              <span className="text-4xl font-bold text-gray-900">$0</span>
              <span className="text-gray-500 ml-1">/ forever</span>
            </div>

            <ul className="space-y-3 mb-8 flex-1">
              {[
                'Up to 3 saved meals',
                'Add meals to cart automatically',
                'HEB, Walmart & Kroger support',
                'Preset meal library',
              ].map(f => (
                <li key={f} className="flex items-start gap-2 text-sm text-gray-700">
                  <svg className="w-4 h-4 text-gray-400 mt-0.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                  {f}
                </li>
              ))}
            </ul>

            <div className="py-3 text-center text-sm text-gray-500 border border-gray-200 rounded-xl">
              {user ? 'Your current plan' : 'No credit card required'}
            </div>
          </div>

          {/* Full Access */}
          <div className="bg-red-600 rounded-2xl shadow-lg p-8 flex flex-col relative overflow-hidden">
            <div className="absolute top-4 right-4 bg-white text-red-600 text-xs font-bold px-3 py-1 rounded-full">
              Most popular
            </div>

            <div className="mb-6">
              <h2 className="text-xl font-bold text-white mb-1">Full Access</h2>
              <p className="text-sm text-red-200">Unlimited meals, always</p>
            </div>

            <div className="mb-6">
              {billing === 'monthly' ? (
                <>
                  <span className="text-4xl font-bold text-white">${MONTHLY_PRICE}</span>
                  <span className="text-red-200 ml-1">/ month</span>
                </>
              ) : (
                <>
                  <span className="text-4xl font-bold text-white">${ANNUAL_PRICE}</span>
                  <span className="text-red-200 ml-1">/ year</span>
                  <p className="text-red-200 text-xs mt-1">
                    (${(parseFloat(ANNUAL_PRICE) / 12).toFixed(2)}/month, billed annually)
                  </p>
                </>
              )}
            </div>

            <ul className="space-y-3 mb-8 flex-1">
              {[
                'Unlimited saved meals',
                'Add meals to cart automatically',
                'HEB, Walmart & Kroger support',
                'Preset meal library',
                'Priority support',
              ].map(f => (
                <li key={f} className="flex items-start gap-2 text-sm text-white">
                  <svg className="w-4 h-4 text-red-200 mt-0.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                  {f}
                </li>
              ))}
            </ul>

            {isFullAccess ? (
              <>
                <button
                  onClick={openManageSubscription}
                  disabled={portalLoading}
                  className="w-full py-3 bg-white text-red-600 rounded-xl font-bold hover:bg-red-50 transition disabled:opacity-60"
                >
                  {portalLoading ? 'Loading...' : 'Manage Subscription'}
                </button>
                <p className="text-center text-red-200 text-xs mt-3">You&apos;re on Full Access ✓</p>
              </>
            ) : checkoutReady ? (
              <button
                onClick={handleCheckout}
                disabled={checkoutLoading}
                className="w-full py-3 bg-white text-red-600 rounded-xl font-bold hover:bg-red-50 transition disabled:opacity-60"
              >
                {checkoutLoading ? 'Loading...' : (user ? 'Upgrade Now' : 'Get Started')}
              </button>
            ) : (
              <button
                disabled
                className="w-full py-3 bg-white/50 text-red-400 rounded-xl font-bold cursor-not-allowed"
              >
                Coming Soon
              </button>
            )}
          </div>

        </div>

        {/* FAQ / reassurance */}
        <div className="mt-16 text-center">
          <p className="text-sm text-gray-500">
            Payments processed securely by{' '}
            <a href="https://stripe.com" target="_blank" rel="noopener noreferrer" className="underline">
              Stripe
            </a>
            . Cancel anytime from your billing portal. Questions?{' '}
            <a href="mailto:support@mealio.co" className="underline">support@mealio.co</a>
          </p>
        </div>
      </div>
    </div>
  );
}
