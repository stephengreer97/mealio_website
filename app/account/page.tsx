'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

interface User {
  id: string;
  email: string;
  tier?: string;
  createdAt: string;
}

export default function AccountPage() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [portalLoading, setPortalLoading] = useState(false);

  // Change password state
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [passwordSuccess, setPasswordSuccess] = useState('');
  const [passwordLoading, setPasswordLoading] = useState(false);

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
        router.push('/');
        return;
      }

      const data = await response.json();
      setUser(data.user);
      setLoading(false);
    } catch (error) {
      router.push('/');
    }
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setPasswordError('');
    setPasswordSuccess('');

    if (newPassword.length < 8) {
      setPasswordError('New password must be at least 8 characters');
      return;
    }

    if (newPassword !== confirmPassword) {
      setPasswordError('Passwords do not match');
      return;
    }

    setPasswordLoading(true);

    try {
      const accessToken = localStorage.getItem('accessToken');
      const response = await fetch('/api/account/change-password', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`
        },
        body: JSON.stringify({ currentPassword, newPassword })
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to change password');
      }

      setPasswordSuccess('Password changed successfully!');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err: any) {
      setPasswordError(err.message);
    } finally {
      setPasswordLoading(false);
    }
  };

  const handleLogout = () => {
    localStorage.clear();
    router.push('/');
  };

  const openManageSubscription = async () => {
    setPortalLoading(true);
    try {
      const token = localStorage.getItem('accessToken');
      const res = await fetch('/api/payments/portal', {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (data.portalUrl) {
        // External Stripe portal → new tab; internal /pricing → same tab
        if (data.portalUrl.startsWith('http') && !data.portalUrl.includes('mealio.co')) {
          window.open(data.portalUrl, '_blank');
        } else {
          router.push(data.portalUrl);
        }
      }
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
      <header className="bg-white border-b">
        <div className="max-w-7xl mx-auto px-4 py-4 flex justify-between items-center">
          <div className="flex items-center gap-4">
            <button onClick={() => router.push('/dashboard')} className="text-gray-600 hover:text-gray-900">
              ← Back
            </button>
            <div style={{ fontFamily: 'var(--font-pacifico), cursive', lineHeight: 1, letterSpacing: '0.5px' }}>
              <span style={{ fontSize: '42px', lineHeight: '0.85', display: 'inline-block', verticalAlign: 'middle', textShadow: '2px 3px 0px rgba(0,0,0,0.12)', color: '#dd0031' }}>M</span>
              <span style={{ fontSize: '32px', textShadow: '1px 2px 0px rgba(0,0,0,0.1)', color: '#dd0031' }}>ealio</span>
            </div>
          </div>
          <button onClick={handleLogout} className="px-4 py-2 text-sm hover:bg-gray-100 rounded">
            Log Out
          </button>
        </div>
      </header>

      <div className="max-w-4xl mx-auto px-4 py-12">
        <h1 className="text-3xl font-bold mb-8">Account Settings</h1>
        
        <div className="space-y-6">
          
          {/* Account Info */}
          <div className="bg-white rounded-xl shadow p-6">
            <h2 className="text-xl font-bold mb-4">Account Information</h2>
            <dl className="space-y-3">
              <div>
                <dt className="text-sm text-gray-600">Email</dt>
                <dd className="font-medium">{user?.email}</dd>
              </div>
              <div>
                <dt className="text-sm text-gray-600">Account Created</dt>
                <dd className="font-medium">{new Date(user?.createdAt || '').toLocaleDateString()}</dd>
              </div>
              <div>
                <dt className="text-sm text-gray-600">User ID</dt>
                <dd className="font-mono text-xs text-gray-600">{user?.id}</dd>
              </div>
            </dl>
          </div>

          {/* Change Password */}
          <div className="bg-white rounded-xl shadow p-6">
            <h2 className="text-xl font-bold mb-4">Change Password</h2>
            <form onSubmit={handleChangePassword} className="space-y-4 max-w-md">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Current Password
                </label>
                <input
                  type="password"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  required
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-transparent"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  New Password
                </label>
                <input
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  required
                  minLength={8}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-transparent"
                />
                <p className="text-xs text-gray-500 mt-1">At least 8 characters</p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Confirm New Password
                </label>
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                  minLength={8}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-transparent"
                />
              </div>

              {passwordError && (
                <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">
                  {passwordError}
                </div>
              )}

              {passwordSuccess && (
                <div className="bg-green-50 border border-green-200 text-green-700 px-4 py-3 rounded-lg text-sm">
                  {passwordSuccess}
                </div>
              )}

              <button
                type="submit"
                disabled={passwordLoading}
                className="bg-red-600 text-white px-6 py-2 rounded-lg font-semibold hover:bg-red-700 disabled:opacity-50"
              >
                {passwordLoading ? 'Changing...' : 'Change Password'}
              </button>
            </form>
          </div>

          {/* Subscription Management */}
          <div className="bg-white rounded-xl shadow p-6">
            <h2 className="text-xl font-bold mb-4">Subscription</h2>
            {user?.tier === 'paid' ? (
              <div>
                <div className="bg-green-50 border border-green-200 rounded-lg p-4 mb-4">
                  <p className="text-green-900 font-medium mb-1">Full Access</p>
                  <p className="text-green-700 text-sm">Unlimited saved meals across all stores.</p>
                </div>
                <button
                  onClick={openManageSubscription}
                  disabled={portalLoading}
                  className="bg-red-600 text-white px-5 py-2 rounded-lg font-semibold hover:bg-red-700 disabled:opacity-50 text-sm"
                >
                  {portalLoading ? 'Loading...' : 'Manage Subscription'}
                </button>
                <p className="text-xs text-gray-500 mt-2">
                  Update payment method, view billing history, or cancel anytime.
                </p>
              </div>
            ) : (
              <div>
                <div className="bg-gray-50 border border-gray-200 rounded-lg p-4 mb-4">
                  <p className="text-gray-900 font-medium mb-1">Free Trial</p>
                  <p className="text-gray-600 text-sm">Up to 3 saved meals. Upgrade to remove the limit.</p>
                </div>
                <button
                  onClick={() => router.push('/pricing')}
                  className="bg-red-600 text-white px-5 py-2 rounded-lg font-semibold hover:bg-red-700 text-sm"
                >
                  Upgrade to Full Access
                </button>
              </div>
            )}
          </div>

          {/* Danger Zone */}
          <div className="bg-white rounded-xl shadow p-6 border-2 border-red-200">
            <h2 className="text-xl font-bold text-red-600 mb-4">Danger Zone</h2>
            <div className="space-y-3">
              <div>
                <h3 className="font-semibold text-gray-900 mb-1">Delete Account</h3>
                <p className="text-sm text-gray-600 mb-3">
                  Permanently delete your account and all associated data. This action cannot be undone.
                </p>
                <button
                  disabled
                  className="px-4 py-2 bg-red-600 text-white rounded-lg font-semibold opacity-50 cursor-not-allowed"
                >
                  Delete Account (Coming Soon)
                </button>
              </div>
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}
