'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

interface User {
  id: string;
  email: string;
  tier?: string;
  createdAt?: string;
}

export default function Dashboard() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [portalLoading, setPortalLoading] = useState(false);

  useEffect(() => {
    verifyAuth();
  }, []);

  const verifyAuth = async () => {
    try {
      const accessToken = localStorage.getItem('accessToken');
      if (!accessToken) {
        router.push('/');
        return;
      }

      const response = await fetch('/api/auth/verify', {
        headers: { 'Authorization': `Bearer ${accessToken}` }
      });

      if (!response.ok) {
        localStorage.clear();
        router.push('/');
        return;
      }

      const data = await response.json();
      setUser(data.user);
      setLoading(false);
    } catch (error) {
      localStorage.clear();
      router.push('/');
    }
  };

  const handleLogout = () => {
    router.push('/signout');
  };

  const openManageSubscription = async () => {
    setPortalLoading(true);
    try {
      const token = localStorage.getItem('accessToken');
      const res = await fetch('/api/payments/portal', {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (data.portalUrl) window.open(data.portalUrl, '_blank');
      else alert('Could not load billing portal. Please try again.');
    } catch {
      alert('Could not load billing portal. Please try again.');
    } finally {
      setPortalLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="w-16 h-16 border-4 border-red-600 border-t-transparent rounded-full animate-spin"></div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-4 py-4 flex justify-between items-center">
          <div className="flex items-center gap-3">
            <div style={{ fontFamily: 'var(--font-pacifico), cursive', lineHeight: 1, letterSpacing: '0.5px' }}>
              <span style={{ fontSize: '42px', lineHeight: '0.85', display: 'inline-block', verticalAlign: 'middle', textShadow: '2px 3px 0px rgba(0,0,0,0.12)', color: '#dd0031' }}>M</span>
              <span style={{ fontSize: '32px', textShadow: '1px 2px 0px rgba(0,0,0,0.1)', color: '#dd0031' }}>ealio</span>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => router.push('/account')}
              className="px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 rounded-lg transition"
            >
              Account
            </button>
            <button 
              onClick={handleLogout} 
              className="px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 rounded-lg transition"
            >
              Log Out
            </button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <div className="max-w-7xl mx-auto px-4 py-12">
        
        {/* Welcome Section */}
        <div className="bg-white rounded-xl shadow-sm p-8 mb-6">
          <div className="flex items-start gap-4">
            <div className="w-12 h-12 bg-gradient-to-br from-red-600 to-red-700 rounded-lg flex items-center justify-center flex-shrink-0">
              <span className="text-white text-2xl">👋</span>
            </div>
            <div className="flex-1">
              <h2 className="text-3xl font-bold text-gray-900 mb-2">Welcome back!</h2>
              <p className="text-gray-600">Your Mealio account is ready to use.</p>
            </div>
          </div>
        </div>

        {/* Quick Stats / Info Grid */}
        <div className="grid md:grid-cols-3 gap-6 mb-6">
          
          {/* Account Info */}
          <div className="bg-white rounded-xl shadow-sm p-6">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 bg-blue-100 rounded-lg flex items-center justify-center">
                <svg className="w-5 h-5 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                </svg>
              </div>
              <h3 className="font-semibold text-gray-900">Account</h3>
            </div>
            <p className="text-sm text-gray-600 mb-1">Email</p>
            <p className="font-medium text-gray-900 mb-3 break-all">{user?.email}</p>
            <button
              onClick={() => router.push('/account')}
              className="text-sm text-red-600 hover:text-red-700 font-medium"
            >
              Manage Account →
            </button>
          </div>

          {/* Subscription Status */}
          <div className="bg-white rounded-xl shadow-sm p-6">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 bg-green-100 rounded-lg flex items-center justify-center">
                <svg className="w-5 h-5 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
              <h3 className="font-semibold text-gray-900">Subscription</h3>
            </div>
            {user?.tier === 'paid' ? (
              <>
                <div className="bg-green-50 border border-green-200 rounded-lg p-3 mb-3">
                  <p className="text-sm font-medium text-green-900">Full Access</p>
                  <p className="text-xs text-green-700 mt-1">Unlimited saved meals</p>
                </div>
                <button
                  onClick={openManageSubscription}
                  disabled={portalLoading}
                  className="text-sm text-red-600 hover:text-red-700 font-medium disabled:opacity-50"
                >
                  {portalLoading ? 'Loading...' : 'Manage Subscription →'}
                </button>
              </>
            ) : (
              <>
                <div className="bg-gray-50 border border-gray-200 rounded-lg p-3 mb-3">
                  <p className="text-sm font-medium text-gray-900">Free Trial</p>
                  <p className="text-xs text-gray-600 mt-1">Up to 3 saved meals</p>
                </div>
                <button
                  onClick={() => router.push('/pricing')}
                  className="text-sm text-red-600 hover:text-red-700 font-medium"
                >
                  Upgrade to Full Access →
                </button>
              </>
            )}
          </div>

          {/* Extension Status */}
          <div className="bg-white rounded-xl shadow-sm p-6">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 bg-purple-100 rounded-lg flex items-center justify-center">
                <svg className="w-5 h-5 text-purple-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" />
                </svg>
              </div>
              <h3 className="font-semibold text-gray-900">Extension</h3>
            </div>
            <p className="text-sm text-gray-600 mb-3">Chrome extension ready to use</p>
            <a 
              href="https://chrome.google.com/webstore" 
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-red-600 hover:text-red-700 font-medium"
            >
              View in Chrome Store →
            </a>
          </div>

        </div>

        {/* Getting Started Section */}
        <div className="bg-gradient-to-br from-red-50 to-blue-50 rounded-xl p-8">
          <h3 className="text-2xl font-bold text-gray-900 mb-4">✨ Getting Started with Mealio</h3>
          
          <div className="space-y-4">
            
            {/* Step 1 */}
            <div className="bg-white rounded-lg p-5 flex items-start gap-4">
              <div className="w-8 h-8 bg-red-600 text-white rounded-full flex items-center justify-center font-bold flex-shrink-0">
                1
              </div>
              <div className="flex-1">
                <h4 className="font-semibold text-gray-900 mb-1">Install the Chrome Extension</h4>
                <p className="text-sm text-gray-600 mb-2">
                  Add the Mealio extension to your Chrome browser to start saving meals.
                </p>
                <button className="text-sm text-red-600 hover:text-red-700 font-medium">
                  Install Extension →
                </button>
              </div>
            </div>

            {/* Step 2 */}
            <div className="bg-white rounded-lg p-5 flex items-start gap-4">
              <div className="w-8 h-8 bg-red-600 text-white rounded-full flex items-center justify-center font-bold flex-shrink-0">
                2
              </div>
              <div className="flex-1">
                <h4 className="font-semibold text-gray-900 mb-1">Open Extension & Sign In</h4>
                <p className="text-sm text-gray-600">
                  Click the Mealio icon in your browser. You'll already be logged in automatically!
                </p>
              </div>
            </div>

            {/* Step 3 */}
            <div className="bg-white rounded-lg p-5 flex items-start gap-4">
              <div className="w-8 h-8 bg-red-600 text-white rounded-full flex items-center justify-center font-bold flex-shrink-0">
                3
              </div>
              <div className="flex-1">
                <h4 className="font-semibold text-gray-900 mb-1">Visit Your Favorite Grocery Store</h4>
                <p className="text-sm text-gray-600">
                  Go to HEB.com, Walmart.com, or Kroger.com and start saving meals.
                </p>
              </div>
            </div>

            {/* Step 4 */}
            <div className="bg-white rounded-lg p-5 flex items-start gap-4">
              <div className="w-8 h-8 bg-red-600 text-white rounded-full flex items-center justify-center font-bold flex-shrink-0">
                4
              </div>
              <div className="flex-1">
                <h4 className="font-semibold text-gray-900 mb-1">Record Your First Meal</h4>
                <p className="text-sm text-gray-600">
                  Click "Add Meal" in the extension, name it, then add items to your cart. Mealio tracks them all!
                </p>
              </div>
            </div>

          </div>
        </div>

        {/* Features Section */}
        <div className="mt-8 grid md:grid-cols-3 gap-6">
          
          <div className="bg-white rounded-xl shadow-sm p-6">
            <div className="w-12 h-12 bg-red-100 rounded-lg flex items-center justify-center mb-4">
              <svg className="w-6 h-6 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
              </svg>
            </div>
            <h3 className="font-semibold text-gray-900 mb-2">Save Your Meals</h3>
            <p className="text-sm text-gray-600">
              Create meal plans and Mealio remembers every ingredient. Upgrade for unlimited meals.
            </p>
          </div>

          <div className="bg-white rounded-xl shadow-sm p-6">
            <div className="w-12 h-12 bg-blue-100 rounded-lg flex items-center justify-center mb-4">
              <svg className="w-6 h-6 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
            </div>
            <h3 className="font-semibold text-gray-900 mb-2">One-Click Add to Cart</h3>
            <p className="text-sm text-gray-600">
              Add entire meals to your cart with a single click. No more searching for each ingredient.
            </p>
          </div>

          <div className="bg-white rounded-xl shadow-sm p-6">
            <div className="w-12 h-12 bg-green-100 rounded-lg flex items-center justify-center mb-4">
              <svg className="w-6 h-6 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 11-4 0 2 2 0 014 0z" />
              </svg>
            </div>
            <h3 className="font-semibold text-gray-900 mb-2">Multi-Store Support</h3>
            <p className="text-sm text-gray-600">
              Works with HEB, Walmart, and Kroger. Switch between stores seamlessly.
            </p>
          </div>

        </div>

        {/* Help Section */}
        <div className="mt-8 bg-white rounded-xl shadow-sm p-8">
          <h3 className="text-xl font-bold text-gray-900 mb-4">Need Help?</h3>
          <div className="grid md:grid-cols-2 gap-6">
            <div>
              <h4 className="font-semibold text-gray-900 mb-2">📚 Documentation</h4>
              <p className="text-sm text-gray-600 mb-2">
                Learn how to use all of Mealio's features with our guides.
              </p>
              <a href="#" className="text-sm text-red-600 hover:text-red-700 font-medium">
                View Docs →
              </a>
            </div>
            <div>
              <h4 className="font-semibold text-gray-900 mb-2">💬 Support</h4>
              <p className="text-sm text-gray-600 mb-2">
                Have questions? We're here to help you get the most out of Mealio.
              </p>
              <a href="#" className="text-sm text-red-600 hover:text-red-700 font-medium">
                Contact Support →
              </a>
            </div>
          </div>
        </div>

      </div>
    </div>
  );
}