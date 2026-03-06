'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import AppHeader from '@/components/AppHeader';
import AppFooter from '@/components/AppFooter';

interface User {
  id: string;
  email: string;
  tier?: string;
  createdAt: string;
}

interface DeletedMeal {
  id: string;
  name: string;
  store_id: string;
  updated_at: string;
}

interface FollowedCreator {
  id: string;
  display_name: string;
  social_handle?: string | null;
  photo_url?: string | null;
  followed_at: string;
}

const STORE_LABELS: Record<string, string> = {
  heb:            'H-E-B',
  walmart:        'Walmart',
  kroger:         'Kroger',
  aldi:           'ALDI',
  central_market: 'Central Market',
};

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

  // Creator photo state
  const [creatorPhotoUrl, setCreatorPhotoUrl] = useState<string | null>(null);
  const [creatorPhotoPreview, setCreatorPhotoPreview] = useState('');
  const [isCreator, setIsCreator] = useState(false);
  const [photoUploading, setPhotoUploading] = useState(false);
  const [photoSaving, setPhotoSaving] = useState(false);
  const [photoError, setPhotoError] = useState('');
  const [photoSuccess, setPhotoSuccess] = useState('');

  // Deleted meals state
  const [deletedMeals, setDeletedMeals] = useState<DeletedMeal[]>([]);
  const [deletedMealsOpen, setDeletedMealsOpen] = useState(false);
  const [deletedMealsLoading, setDeletedMealsLoading] = useState(false);

  // Following state
  const [followingCreators, setFollowingCreators] = useState<FollowedCreator[]>([]);
  const [followingLoading, setFollowingLoading] = useState(true);
  const [unfollowingId, setUnfollowingId] = useState<string | null>(null);

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

      // Check if creator and load photo
      fetch('/api/creator/me', { headers: { Authorization: `Bearer ${accessToken}` } })
        .then(r => r.ok ? r.json() : null)
        .then(d => {
          if (d?.creator) {
            setIsCreator(true);
            setCreatorPhotoUrl(d.creator.photo_url ?? null);
          }
        })
        .catch(() => {});

      // Load followed creators
      fetch('/api/creators/following', { headers: { Authorization: `Bearer ${accessToken}` } })
        .then(r => r.ok ? r.json() : { creators: [] })
        .then(d => setFollowingCreators(d.creators ?? []))
        .catch(() => {})
        .finally(() => setFollowingLoading(false));

      setLoading(false);
    } catch (error) {
      router.push('/');
    }
  };

  const fetchDeletedMeals = async () => {
    setDeletedMealsLoading(true);
    try {
      const accessToken = localStorage.getItem('accessToken');
      const res = await fetch('/api/meals/deleted', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const data = await res.json();
      setDeletedMeals(data.meals ?? []);
    } catch {
      // ignore
    } finally {
      setDeletedMealsLoading(false);
    }
  };

  const handleToggleDeletedMeals = () => {
    if (!deletedMealsOpen) fetchDeletedMeals();
    setDeletedMealsOpen(prev => !prev);
  };

  const handleRestoreMeal = async (meal: DeletedMeal) => {
    const accessToken = localStorage.getItem('accessToken');
    const res = await fetch(`/api/meals/${meal.id}/restore`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (res.ok) {
      setDeletedMeals(prev => prev.filter(m => m.id !== meal.id));
    } else {
      alert('Failed to restore meal. Please try again.');
    }
  };

  const handlePermanentDelete = async (meal: DeletedMeal) => {
    if (!window.confirm(`Permanently delete "${meal.name}"? This cannot be undone.`)) return;
    const accessToken = localStorage.getItem('accessToken');
    const res = await fetch(`/api/meals/${meal.id}?permanent=true`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (res.ok) {
      setDeletedMeals(prev => prev.filter(m => m.id !== meal.id));
    } else {
      alert('Failed to delete meal. Please try again.');
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

  const handlePhotoChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setPhotoUploading(true);
    setPhotoError('');
    setPhotoSuccess('');
    const reader = new FileReader();
    reader.onload = async ev => {
      const imageData = ev.target?.result as string;
      setCreatorPhotoPreview(imageData);
      try {
        const accessToken = localStorage.getItem('accessToken');
        const res = await fetch('/api/images/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
          body: JSON.stringify({ imageData }),
        });
        const data = await res.json();
        if (res.ok) {
          setCreatorPhotoUrl(data.url);
        } else {
          setPhotoError(data.error || 'Upload failed.');
        }
      } catch {
        setPhotoError('Upload failed.');
      } finally {
        setPhotoUploading(false);
      }
    };
    reader.readAsDataURL(file);
  };

  const handleSavePhoto = async () => {
    setPhotoSaving(true);
    setPhotoError('');
    setPhotoSuccess('');
    try {
      const accessToken = localStorage.getItem('accessToken');
      const res = await fetch('/api/creator/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ photoUrl: creatorPhotoUrl }),
      });
      if (res.ok) {
        setPhotoSuccess('Photo saved!');
        setCreatorPhotoPreview('');
      } else {
        const d = await res.json();
        setPhotoError(d.error || 'Save failed.');
      }
    } catch {
      setPhotoError('Save failed.');
    } finally {
      setPhotoSaving(false);
    }
  };

  const handleUnfollow = async (creatorId: string) => {
    setUnfollowingId(creatorId);
    setFollowingCreators(prev => prev.filter(c => c.id !== creatorId));
    try {
      const accessToken = localStorage.getItem('accessToken');
      const res = await fetch(`/api/creators/${creatorId}/follow`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) throw new Error();
    } catch {
      // Revert on failure — re-fetch to restore
      const accessToken = localStorage.getItem('accessToken');
      fetch('/api/creators/following', { headers: { Authorization: `Bearer ${accessToken}` } })
        .then(r => r.json())
        .then(d => setFollowingCreators(d.creators ?? []))
        .catch(() => {});
    } finally {
      setUnfollowingId(null);
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
    <div className="min-h-screen bg-wk-bg">
      <AppHeader />

      <div className="max-w-6xl mx-auto px-4 py-12">
        <h1 className="text-3xl font-bold mb-8">Account Settings</h1>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 items-start">
          {/* ── Left column ── */}
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

          {/* Creator Photo */}
          {isCreator && (
            <div className="bg-white rounded-xl shadow p-6">
              <h2 className="text-xl font-bold mb-1">Creator Photo</h2>
              <p className="text-sm text-gray-500 mb-5">This photo appears next to your name in the Discover tab.</p>
              <div className="flex items-center gap-5">
                {/* Avatar */}
                <div className="relative flex-shrink-0">
                  <div className="w-20 h-20 rounded-full overflow-hidden border-2 border-gray-200 bg-gray-50 flex items-center justify-center text-3xl">
                    {(creatorPhotoPreview || creatorPhotoUrl) ? (
                      <img
                        src={creatorPhotoPreview || creatorPhotoUrl!}
                        alt="Creator photo"
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <span>👤</span>
                    )}
                  </div>
                  {photoUploading && (
                    <div className="absolute inset-0 rounded-full bg-white/70 flex items-center justify-center">
                      <div className="w-5 h-5 border-2 border-gray-200 border-t-red-600 rounded-full animate-spin" />
                    </div>
                  )}
                </div>

                <div className="space-y-2">
                  <label
                    htmlFor="creatorPhotoInput"
                    className="inline-block cursor-pointer px-4 py-2 text-sm font-semibold rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 transition-colors"
                  >
                    {(creatorPhotoPreview || creatorPhotoUrl) ? 'Change Photo' : 'Upload Photo'}
                  </label>
                  <input id="creatorPhotoInput" type="file" accept="image/*" onChange={handlePhotoChange} className="hidden" />

                  {creatorPhotoPreview && !photoUploading && (
                    <div>
                      <button
                        onClick={handleSavePhoto}
                        disabled={photoSaving}
                        className="px-4 py-2 text-sm font-semibold rounded-lg bg-red-600 text-white hover:bg-red-700 disabled:opacity-50 transition-colors"
                      >
                        {photoSaving ? 'Saving…' : 'Save Photo'}
                      </button>
                    </div>
                  )}

                  {photoError && <p className="text-xs text-red-600">{photoError}</p>}
                  {photoSuccess && <p className="text-xs text-green-600">{photoSuccess}</p>}
                </div>
              </div>
            </div>
          )}

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

          </div>{/* end left column */}

          {/* ── Right column ── */}
          <div className="space-y-6">

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

          {/* Following */}
          <div className="bg-white rounded-xl shadow p-6">
            <h2 className="text-xl font-bold mb-1">Following</h2>
            <p className="text-sm text-gray-500 mb-5">Creators you follow appear in your Following tab on Discover.</p>

            {followingLoading ? (
              <div className="flex justify-center py-6">
                <div className="w-6 h-6 border-2 border-gray-200 border-t-red-600 rounded-full animate-spin" />
              </div>
            ) : followingCreators.length === 0 ? (
              <p className="text-sm text-gray-400">You're not following any creators yet. Visit Discover to find some!</p>
            ) : (
              <ul className="divide-y divide-gray-100">
                {followingCreators.map(creator => (
                  <li key={creator.id} className="flex items-center justify-between gap-3 py-3">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="w-10 h-10 rounded-full overflow-hidden flex-shrink-0 bg-gray-100 border border-gray-200 flex items-center justify-center text-lg">
                        {creator.photo_url
                          ? <img src={creator.photo_url} alt={creator.display_name} className="w-full h-full object-cover" />
                          : '👤'}
                      </div>
                      <div className="min-w-0">
                        <p className="font-semibold text-sm text-gray-900 truncate">{creator.display_name}</p>
                        {creator.social_handle && (
                          <p className="text-xs text-gray-400 truncate">@{creator.social_handle}</p>
                        )}
                      </div>
                    </div>
                    <button
                      onClick={() => handleUnfollow(creator.id)}
                      disabled={unfollowingId === creator.id}
                      className="flex-shrink-0 text-xs px-3 py-1 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-50 transition-colors"
                    >
                      Unfollow
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Deleted Meals */}
          <div className="bg-white rounded-xl shadow p-6">
            <button
              onClick={handleToggleDeletedMeals}
              className="flex items-center justify-between w-full text-left"
            >
              <h2 className="text-xl font-bold">
                Deleted Meals
                {deletedMeals.length > 0 && (
                  <span className="ml-2 text-sm font-normal bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">
                    {deletedMeals.length}
                  </span>
                )}
              </h2>
              <span className="text-gray-400 text-lg">{deletedMealsOpen ? '▲' : '▼'}</span>
            </button>

            {deletedMealsOpen && (
              <div className="mt-4">
                {deletedMealsLoading ? (
                  <p className="text-gray-500 text-sm">Loading...</p>
                ) : deletedMeals.length === 0 ? (
                  <p className="text-gray-500 text-sm">No deleted meals.</p>
                ) : (
                  <ul className="divide-y divide-gray-100">
                    {deletedMeals.map(meal => (
                      <li key={meal.id} className="flex items-center justify-between py-3 gap-3">
                        <div className="min-w-0">
                          <p className="font-medium text-gray-900 truncate">{meal.name}</p>
                          <p className="text-xs text-gray-500">
                            {STORE_LABELS[meal.store_id] ?? meal.store_id} &middot; Deleted {new Date(meal.updated_at).toLocaleDateString()}
                          </p>
                        </div>
                        <div className="flex gap-2 shrink-0">
                          <button
                            onClick={() => handleRestoreMeal(meal)}
                            className="text-sm px-3 py-1 bg-green-600 text-white rounded-lg hover:bg-green-700 font-medium"
                          >
                            Restore
                          </button>
                          <button
                            onClick={() => handlePermanentDelete(meal)}
                            className="text-sm px-3 py-1 bg-red-600 text-white rounded-lg hover:bg-red-700 font-medium"
                          >
                            Delete Forever
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>

          </div>{/* end right column */}

        </div>{/* end grid */}

        <p className="text-center text-xs text-gray-400 mt-8">
          Are you a food creator?{' '}
          <a href="/creator/apply" className="underline hover:text-gray-600">Apply to become a Creator Partner</a>
        </p>
      </div>
      <AppFooter />
    </div>
  );
}
