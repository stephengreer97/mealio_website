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
    fetch('/api/auth/verify', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data?.user) setUser(data.user); })
      .catch(() => {});
  }, []);

  const openManageSubscription = async () => {
    setPortalLoading(true);
    try {
      const token = localStorage.getItem('accessToken');
      const res = await fetch('/api/payments/portal', { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      if (data.portalUrl) window.open(data.portalUrl, '_blank');
      else alert('Could not load billing portal. Please try again.');
    } catch { alert('Could not load billing portal. Please try again.'); }
    finally { setPortalLoading(false); }
  };

  const handleCheckout = async () => {
    const token = localStorage.getItem('accessToken');
    if (!token) { router.push('/signin'); return; }
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
    } finally { setCheckoutLoading(false); }
  };

  const isFullAccess = user?.tier === 'paid';
  const checkoutReady = !!(billing === 'monthly' ? MONTHLY_PRICE_ID : ANNUAL_PRICE_ID);

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg)' }}>
      {/* Header */}
      <header style={{ background: 'var(--surface-raised)', borderBottom: '1px solid var(--border)' }}>
        <div className="max-w-5xl mx-auto px-5 py-4 flex justify-between items-center">
          <button
            onClick={() => router.back()}
            className="text-sm transition-colors flex items-center gap-1.5"
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-2)' }}
            onMouseEnter={e => (e.currentTarget as HTMLElement).style.color = 'var(--text-1)'}
            onMouseLeave={e => (e.currentTarget as HTMLElement).style.color = 'var(--text-2)'}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6"/>
            </svg>
            Back
          </button>
          <div style={{ fontFamily: 'var(--font-pacifico), cursive', lineHeight: 1 }}>
            <span style={{ fontSize: '32px', lineHeight: '0.9', display: 'inline-block', verticalAlign: 'middle', color: 'var(--brand)' }}>M</span>
            <span style={{ fontSize: '24px', color: 'var(--brand)' }}>ealio</span>
          </div>
          {user ? (
            <button
              onClick={() => router.push('/discover')}
              className="text-sm transition-colors flex items-center gap-1"
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-2)' }}
              onMouseEnter={e => (e.currentTarget as HTMLElement).style.color = 'var(--text-1)'}
              onMouseLeave={e => (e.currentTarget as HTMLElement).style.color = 'var(--text-2)'}
            >
              Dashboard
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="9 18 15 12 9 6"/>
              </svg>
            </button>
          ) : (
            <button
              onClick={() => router.push('/discover')}
              className="text-sm font-semibold transition-colors"
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--brand)' }}
            >
              Sign In
            </button>
          )}
        </div>
      </header>

      <div className="max-w-4xl mx-auto px-5 py-14">
        {/* Heading */}
        <div className="text-center mb-12">
          <h1 className="text-4xl font-bold mb-3" style={{ color: 'var(--text-1)', letterSpacing: '-0.02em' }}>Simple, honest pricing</h1>
          <p className="text-lg" style={{ color: 'var(--text-2)' }}>
            Try Mealio free, then unlock unlimited meals when you&apos;re ready.
          </p>

          {/* Billing toggle */}
          <div className="mt-8 inline-flex items-center rounded-full p-1" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
            <button
              onClick={() => setBilling('monthly')}
              className="px-5 py-2 rounded-full text-sm font-semibold transition-all"
              style={billing === 'monthly'
                ? { background: 'var(--surface-raised)', color: 'var(--text-1)', boxShadow: 'var(--shadow-sm)' }
                : { background: 'transparent', color: 'var(--text-3)', border: 'none', cursor: 'pointer' }}
            >
              Monthly
            </button>
            <button
              onClick={() => setBilling('annual')}
              className="px-5 py-2 rounded-full text-sm font-semibold transition-all flex items-center gap-2"
              style={billing === 'annual'
                ? { background: 'var(--surface-raised)', color: 'var(--text-1)', boxShadow: 'var(--shadow-sm)' }
                : { background: 'transparent', color: 'var(--text-3)', border: 'none', cursor: 'pointer' }}
            >
              Annual
              <span className="text-xs font-bold px-2 py-0.5 rounded-full" style={{ background: '#dcfce7', color: '#166534' }}>
                Save 2 months
              </span>
            </button>
          </div>
        </div>

        {/* Plan cards */}
        <div className="grid md:grid-cols-2 gap-6 max-w-3xl mx-auto">

          {/* Free */}
          <div className="rounded-2xl p-8 flex flex-col" style={{ background: 'var(--surface-raised)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-sm)' }}>
            <div className="mb-5">
              <h2 className="text-lg font-bold mb-1" style={{ color: 'var(--text-1)' }}>Free Trial</h2>
              <p className="text-sm" style={{ color: 'var(--text-3)' }}>Try it out at no cost</p>
            </div>

            <div className="mb-6">
              <span className="text-4xl font-bold" style={{ color: 'var(--text-1)' }}>$0</span>
              <span className="text-sm ml-1" style={{ color: 'var(--text-3)' }}>/ forever</span>
            </div>

            <ul className="space-y-3 mb-8 flex-1">
              {[
                'Up to 3 saved meals',
                'Add meals to cart automatically',
                'Preset meal library',
              ].map(f => (
                <li key={f} className="flex items-start gap-2.5 text-sm" style={{ color: 'var(--text-2)' }}>
                  <svg className="flex-shrink-0 mt-0.5" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--border-strong)' }}>
                    <path d="M20 6L9 17l-5-5"/>
                  </svg>
                  {f}
                </li>
              ))}
            </ul>

            <div className="py-3 text-center text-sm rounded-xl" style={{ border: '1.5px solid var(--border)', color: 'var(--text-3)' }}>
              {user ? 'Your current plan' : 'No credit card required'}
            </div>
          </div>

          {/* Full Access */}
          <div className="rounded-2xl p-8 flex flex-col relative overflow-hidden" style={{ background: 'var(--brand)' }}>
            <div className="absolute top-4 right-4 text-xs font-bold px-3 py-1 rounded-full" style={{ background: 'rgba(255,255,255,0.15)', color: '#fff' }}>
              Most popular
            </div>

            <div className="mb-5">
              <h2 className="text-lg font-bold mb-1 text-white">Full Access</h2>
              <p className="text-sm" style={{ color: 'rgba(255,255,255,0.65)' }}>Unlimited meals, always</p>
            </div>

            <div className="mb-6">
              {billing === 'monthly' ? (
                <>
                  <span className="text-4xl font-bold text-white">${MONTHLY_PRICE}</span>
                  <span className="text-sm ml-1" style={{ color: 'rgba(255,255,255,0.65)' }}>/ month</span>
                </>
              ) : (
                <>
                  <span className="text-4xl font-bold text-white">${ANNUAL_PRICE}</span>
                  <span className="text-sm ml-1" style={{ color: 'rgba(255,255,255,0.65)' }}>/ year</span>
                  <p className="text-xs mt-1" style={{ color: 'rgba(255,255,255,0.65)' }}>
                    (${(parseFloat(ANNUAL_PRICE) / 12).toFixed(2)}/month, billed annually)
                  </p>
                </>
              )}
            </div>

            <ul className="space-y-3 mb-8 flex-1">
              {[
                'Unlimited saved meals',
                'Add meals to cart automatically',
                'Preset meal library',
                'Priority support',
              ].map(f => (
                <li key={f} className="flex items-start gap-2.5 text-sm text-white">
                  <svg className="flex-shrink-0 mt-0.5" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'rgba(255,255,255,0.65)' }}>
                    <path d="M20 6L9 17l-5-5"/>
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
                  className="w-full py-3 rounded-xl font-bold disabled:opacity-60 transition-colors text-sm"
                  style={{ background: '#fff', color: 'var(--brand)', border: 'none', cursor: 'pointer' }}
                  onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = 'var(--brand-light)'}
                  onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = '#fff'}
                >
                  {portalLoading ? 'Loading...' : 'Manage Subscription'}
                </button>
                <p className="text-center text-xs mt-3" style={{ color: 'rgba(255,255,255,0.65)' }}>You&apos;re on Full Access</p>
              </>
            ) : checkoutReady ? (
              <button
                onClick={handleCheckout}
                disabled={checkoutLoading}
                className="w-full py-3 rounded-xl font-bold disabled:opacity-60 transition-colors text-sm"
                style={{ background: '#fff', color: 'var(--brand)', border: 'none', cursor: 'pointer' }}
                onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = 'var(--brand-light)'}
                onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = '#fff'}
              >
                {checkoutLoading ? 'Loading...' : (user ? 'Upgrade Now' : 'Get Started')}
              </button>
            ) : (
              <button
                disabled
                className="w-full py-3 rounded-xl font-bold cursor-not-allowed text-sm"
                style={{ background: 'rgba(255,255,255,0.25)', color: 'rgba(255,255,255,0.5)', border: 'none' }}
              >
                Coming Soon
              </button>
            )}
          </div>

        </div>

        {/* Trust signals */}
        <div className="mt-12 text-center">
          <p className="text-sm" style={{ color: 'var(--text-3)' }}>
            Payments processed securely by{' '}
            <a href="https://stripe.com" target="_blank" rel="noopener noreferrer"
              className="underline transition-colors"
              style={{ color: 'var(--text-2)' }}
            >
              Stripe
            </a>
            . Cancel anytime from your billing portal. Questions?{' '}
            <a href="mailto:support@mealio.co"
              className="underline transition-colors"
              style={{ color: 'var(--text-2)' }}
            >
              support@mealio.co
            </a>
          </p>
        </div>
      </div>
    </div>
  );
}
