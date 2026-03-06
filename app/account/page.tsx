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

function getInitials(name: string) {
  return name.split(' ').slice(0, 2).map(w => w[0]).join('').toUpperCase();
}

function SectionCard({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl p-6" style={{ background: 'var(--surface-raised)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-sm)' }}>
      <h2 className="text-base font-bold mb-0.5" style={{ color: 'var(--text-1)' }}>{title}</h2>
      {subtitle && <p className="text-sm mb-5" style={{ color: 'var(--text-3)' }}>{subtitle}</p>}
      {!subtitle && <div className="mb-4" />}
      {children}
    </div>
  );
}

export default function AccountPage() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [portalLoading, setPortalLoading] = useState(false);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [passwordSuccess, setPasswordSuccess] = useState('');
  const [passwordLoading, setPasswordLoading] = useState(false);

  const [creatorPhotoUrl, setCreatorPhotoUrl] = useState<string | null>(null);
  const [creatorPhotoPreview, setCreatorPhotoPreview] = useState('');
  const [isCreator, setIsCreator] = useState(false);
  const [photoUploading, setPhotoUploading] = useState(false);
  const [photoSaving, setPhotoSaving] = useState(false);
  const [photoError, setPhotoError] = useState('');
  const [photoSuccess, setPhotoSuccess] = useState('');

  const [deletedMeals, setDeletedMeals] = useState<DeletedMeal[]>([]);
  const [deletedMealsOpen, setDeletedMealsOpen] = useState(false);
  const [deletedMealsLoading, setDeletedMealsLoading] = useState(false);

  const [followingCreators, setFollowingCreators] = useState<FollowedCreator[]>([]);
  const [followingLoading, setFollowingLoading] = useState(true);
  const [unfollowingId, setUnfollowingId] = useState<string | null>(null);

  useEffect(() => { verifyAuth(); }, []);

  const verifyAuth = async () => {
    try {
      const accessToken = localStorage.getItem('accessToken');
      if (!accessToken) { router.push('/'); return; }

      const response = await fetch('/api/auth/verify', { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!response.ok) { router.push('/'); return; }

      const data = await response.json();
      setUser(data.user);

      fetch('/api/creator/me', { headers: { Authorization: `Bearer ${accessToken}` } })
        .then(r => r.ok ? r.json() : null)
        .then(d => { if (d?.creator) { setIsCreator(true); setCreatorPhotoUrl(d.creator.photo_url ?? null); } })
        .catch(() => {});

      fetch('/api/creators/following', { headers: { Authorization: `Bearer ${accessToken}` } })
        .then(r => r.ok ? r.json() : { creators: [] })
        .then(d => setFollowingCreators(d.creators ?? []))
        .catch(() => {})
        .finally(() => setFollowingLoading(false));

      setLoading(false);
    } catch { router.push('/'); }
  };

  const fetchDeletedMeals = async () => {
    setDeletedMealsLoading(true);
    try {
      const accessToken = localStorage.getItem('accessToken');
      const res = await fetch('/api/meals/deleted', { headers: { Authorization: `Bearer ${accessToken}` } });
      const data = await res.json();
      setDeletedMeals(data.meals ?? []);
    } catch {} finally { setDeletedMealsLoading(false); }
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
    if (res.ok) setDeletedMeals(prev => prev.filter(m => m.id !== meal.id));
    else alert('Failed to restore meal. Please try again.');
  };

  const handlePermanentDelete = async (meal: DeletedMeal) => {
    if (!window.confirm(`Permanently delete "${meal.name}"? This cannot be undone.`)) return;
    const accessToken = localStorage.getItem('accessToken');
    const res = await fetch(`/api/meals/${meal.id}?permanent=true`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (res.ok) setDeletedMeals(prev => prev.filter(m => m.id !== meal.id));
    else alert('Failed to delete meal. Please try again.');
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setPasswordError('');
    setPasswordSuccess('');

    if (newPassword.length < 8) { setPasswordError('New password must be at least 8 characters'); return; }
    if (newPassword !== confirmPassword) { setPasswordError('Passwords do not match'); return; }

    setPasswordLoading(true);
    try {
      const accessToken = localStorage.getItem('accessToken');
      const response = await fetch('/api/account/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to change password');
      setPasswordSuccess('Password changed successfully!');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err: any) {
      setPasswordError(err.message);
    } finally { setPasswordLoading(false); }
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
        if (res.ok) setCreatorPhotoUrl(data.url);
        else setPhotoError(data.error || 'Upload failed.');
      } catch { setPhotoError('Upload failed.'); }
      finally { setPhotoUploading(false); }
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
      if (res.ok) { setPhotoSuccess('Photo saved!'); setCreatorPhotoPreview(''); }
      else { const d = await res.json(); setPhotoError(d.error || 'Save failed.'); }
    } catch { setPhotoError('Save failed.'); }
    finally { setPhotoSaving(false); }
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
      const accessToken = localStorage.getItem('accessToken');
      fetch('/api/creators/following', { headers: { Authorization: `Bearer ${accessToken}` } })
        .then(r => r.json())
        .then(d => setFollowingCreators(d.creators ?? []))
        .catch(() => {});
    } finally { setUnfollowingId(null); }
  };

  const handleLogout = () => { localStorage.clear(); router.push('/'); };

  const openManageSubscription = async () => {
    setPortalLoading(true);
    try {
      const token = localStorage.getItem('accessToken');
      const res = await fetch('/api/payments/portal', { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      if (data.portalUrl) {
        if (data.portalUrl.startsWith('http') && !data.portalUrl.includes('mealio.co')) {
          window.open(data.portalUrl, '_blank');
        } else {
          router.push(data.portalUrl);
        }
      } else alert('Could not load billing portal. Please try again.');
    } catch { alert('Could not load billing portal. Please try again.'); }
    finally { setPortalLoading(false); }
  };

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

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--bg)' }}>
        <div className="w-8 h-8 rounded-full animate-spin" style={{ border: '2px solid var(--border)', borderTopColor: 'var(--brand)' }} />
      </div>
    );
  }

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg)' }}>
      <AppHeader />

      <div className="max-w-3xl mx-auto px-4 py-10">
        <div className="flex items-center justify-between mb-8">
          <h1 className="text-2xl font-bold" style={{ color: 'var(--text-1)', letterSpacing: '-0.01em' }}>Account Settings</h1>
          <button
            onClick={handleLogout}
            className="text-sm font-medium px-4 py-2 rounded-xl transition-colors"
            style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text-2)', cursor: 'pointer' }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = 'var(--brand)'; (e.currentTarget as HTMLElement).style.borderColor = 'var(--brand-border)'; }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = 'var(--text-2)'; (e.currentTarget as HTMLElement).style.borderColor = 'var(--border)'; }}
          >
            Log Out
          </button>
        </div>

        <div className="space-y-4">

          {/* Account Info */}
          <SectionCard title="Account Information">
            <dl className="space-y-4">
              <div>
                <dt className="text-xs font-semibold uppercase tracking-wider mb-1" style={{ color: 'var(--text-3)' }}>Email</dt>
                <dd className="text-sm font-medium" style={{ color: 'var(--text-1)' }}>{user?.email}</dd>
              </div>
              <div>
                <dt className="text-xs font-semibold uppercase tracking-wider mb-1" style={{ color: 'var(--text-3)' }}>Account Created</dt>
                <dd className="text-sm font-medium" style={{ color: 'var(--text-1)' }}>{new Date(user?.createdAt || '').toLocaleDateString()}</dd>
              </div>
              <div>
                <dt className="text-xs font-semibold uppercase tracking-wider mb-1" style={{ color: 'var(--text-3)' }}>User ID</dt>
                <dd className="text-xs" style={{ color: 'var(--text-3)', fontFamily: 'var(--font-mono, monospace)' }}>{user?.id}</dd>
              </div>
            </dl>
          </SectionCard>

          {/* Subscription */}
          <SectionCard title="Subscription">
            {user?.tier === 'paid' ? (
              <div>
                <div className="rounded-xl p-4 mb-4" style={{ background: '#f0fdf4', border: '1px solid #bbf7d0' }}>
                  <p className="font-semibold text-sm mb-0.5" style={{ color: '#14532d' }}>Full Access</p>
                  <p className="text-sm" style={{ color: '#166534' }}>Unlimited saved meals across all stores.</p>
                </div>
                <button
                  onClick={openManageSubscription}
                  disabled={portalLoading}
                  className="text-sm font-semibold px-5 py-2.5 rounded-xl transition-colors disabled:opacity-50"
                  style={{ background: 'var(--brand)', color: '#fff', border: 'none', cursor: 'pointer' }}
                  onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = 'var(--brand-dark)'}
                  onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = 'var(--brand)'}
                >
                  {portalLoading ? 'Loading...' : 'Manage Subscription'}
                </button>
                <p className="text-xs mt-2" style={{ color: 'var(--text-3)' }}>
                  Update payment method, view billing history, or cancel anytime.
                </p>
              </div>
            ) : (
              <div>
                <div className="rounded-xl p-4 mb-4" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
                  <p className="font-semibold text-sm mb-0.5" style={{ color: 'var(--text-1)' }}>Free Trial</p>
                  <p className="text-sm" style={{ color: 'var(--text-2)' }}>Up to 3 saved meals. Upgrade to remove the limit.</p>
                </div>
                <button
                  onClick={() => router.push('/pricing')}
                  className="text-sm font-semibold px-5 py-2.5 rounded-xl transition-colors"
                  style={{ background: 'var(--brand)', color: '#fff', border: 'none', cursor: 'pointer' }}
                  onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = 'var(--brand-dark)'}
                  onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = 'var(--brand)'}
                >
                  Upgrade to Full Access
                </button>
              </div>
            )}
          </SectionCard>

          {/* Creator Photo */}
          {isCreator && (
            <SectionCard title="Creator Photo" subtitle="This photo appears next to your name in the Discover tab.">
              <div className="flex items-center gap-5">
                <div className="relative flex-shrink-0">
                  <div
                    className="rounded-full overflow-hidden flex items-center justify-center"
                    style={{ width: '72px', height: '72px', border: '2px solid var(--border)', background: 'var(--surface)' }}
                  >
                    {(creatorPhotoPreview || creatorPhotoUrl) ? (
                      <img src={creatorPhotoPreview || creatorPhotoUrl!} alt="Creator photo" className="w-full h-full object-cover" />
                    ) : (
                      <span className="text-base font-bold" style={{ color: 'var(--text-3)' }}>
                        {user?.email?.[0]?.toUpperCase()}
                      </span>
                    )}
                  </div>
                  {photoUploading && (
                    <div className="absolute inset-0 rounded-full flex items-center justify-center" style={{ background: 'rgba(255,255,255,0.75)' }}>
                      <div className="w-5 h-5 rounded-full animate-spin" style={{ border: '2px solid var(--border)', borderTopColor: 'var(--brand)' }} />
                    </div>
                  )}
                </div>

                <div className="space-y-2">
                  <label
                    htmlFor="creatorPhotoInput"
                    className="inline-block cursor-pointer text-sm font-semibold px-4 py-2 rounded-xl transition-colors"
                    style={{ border: '1.5px solid var(--border)', color: 'var(--text-1)', background: 'var(--surface-raised)' }}
                  >
                    {(creatorPhotoPreview || creatorPhotoUrl) ? 'Change Photo' : 'Upload Photo'}
                  </label>
                  <input id="creatorPhotoInput" type="file" accept="image/*" onChange={handlePhotoChange} className="hidden" />

                  {creatorPhotoPreview && !photoUploading && (
                    <div>
                      <button
                        onClick={handleSavePhoto}
                        disabled={photoSaving}
                        className="text-sm font-semibold px-4 py-2 rounded-xl transition-colors disabled:opacity-50"
                        style={{ background: 'var(--brand)', color: '#fff', border: 'none', cursor: 'pointer' }}
                        onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = 'var(--brand-dark)'}
                        onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = 'var(--brand)'}
                      >
                        {photoSaving ? 'Saving…' : 'Save Photo'}
                      </button>
                    </div>
                  )}

                  {photoError && <p className="text-xs" style={{ color: 'var(--error)' }}>{photoError}</p>}
                  {photoSuccess && <p className="text-xs" style={{ color: 'var(--success)' }}>{photoSuccess}</p>}
                </div>
              </div>
            </SectionCard>
          )}

          {/* Change Password */}
          <SectionCard title="Change Password">
            <form onSubmit={handleChangePassword} className="space-y-4 max-w-sm">
              {[
                { label: 'Current Password', value: currentPassword, onChange: setCurrentPassword, hint: undefined },
                { label: 'New Password',     value: newPassword,     onChange: setNewPassword,     hint: 'At least 8 characters' },
                { label: 'Confirm New Password', value: confirmPassword, onChange: setConfirmPassword, hint: undefined },
              ].map(f => (
                <div key={f.label}>
                  <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--text-2)' }}>{f.label}</label>
                  <input
                    type="password"
                    value={f.value}
                    onChange={e => f.onChange(e.target.value)}
                    required
                    minLength={8}
                    style={inputStyle}
                    onFocus={e => (e.target.style.borderColor = 'var(--brand)')}
                    onBlur={e => (e.target.style.borderColor = 'var(--border)')}
                  />
                  {f.hint && <p className="text-xs mt-1" style={{ color: 'var(--text-3)' }}>{f.hint}</p>}
                </div>
              ))}

              {passwordError && (
                <div className="px-4 py-3 rounded-xl text-sm" style={{ background: 'var(--brand-light)', border: '1px solid var(--brand-border)', color: '#9f1239' }}>
                  {passwordError}
                </div>
              )}
              {passwordSuccess && (
                <div className="px-4 py-3 rounded-xl text-sm" style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', color: '#14532d' }}>
                  {passwordSuccess}
                </div>
              )}

              <button
                type="submit"
                disabled={passwordLoading}
                className="text-sm font-semibold px-5 py-2.5 rounded-xl transition-colors disabled:opacity-50"
                style={{ background: 'var(--brand)', color: '#fff', border: 'none', cursor: 'pointer' }}
                onMouseEnter={e => { if (!passwordLoading) (e.currentTarget as HTMLElement).style.background = 'var(--brand-dark)'; }}
                onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = 'var(--brand)'}
              >
                {passwordLoading ? 'Changing…' : 'Change Password'}
              </button>
            </form>
          </SectionCard>

          {/* Following */}
          <SectionCard title="Following" subtitle="Creators you follow appear in your Following tab on Discover.">
            {followingLoading ? (
              <div className="flex justify-center py-6">
                <div className="w-6 h-6 rounded-full animate-spin" style={{ border: '2px solid var(--border)', borderTopColor: 'var(--brand)' }} />
              </div>
            ) : followingCreators.length === 0 ? (
              <p className="text-sm" style={{ color: 'var(--text-3)' }}>You&apos;re not following any creators yet. Visit Discover to find some!</p>
            ) : (
              <ul className="divide-y" style={{ borderTop: '1px solid var(--border)' }}>
                {followingCreators.map(creator => (
                  <li key={creator.id} className="flex items-center justify-between gap-3 py-3">
                    <div className="flex items-center gap-3 min-w-0">
                      <div
                        className="rounded-full overflow-hidden flex-shrink-0 flex items-center justify-center"
                        style={{ width: '36px', height: '36px', background: 'var(--surface)', border: '1px solid var(--border)' }}
                      >
                        {creator.photo_url
                          ? <img src={creator.photo_url} alt={creator.display_name} className="w-full h-full object-cover" />
                          : <span className="text-xs font-bold" style={{ color: 'var(--text-3)' }}>{getInitials(creator.display_name)}</span>}
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-semibold truncate" style={{ color: 'var(--text-1)' }}>{creator.display_name}</p>
                        {creator.social_handle && (
                          <p className="text-xs truncate" style={{ color: 'var(--text-3)' }}>@{creator.social_handle}</p>
                        )}
                      </div>
                    </div>
                    <button
                      onClick={() => handleUnfollow(creator.id)}
                      disabled={unfollowingId === creator.id}
                      className="flex-shrink-0 text-xs px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50"
                      style={{ border: '1px solid var(--border)', color: 'var(--text-2)', background: 'var(--surface-raised)', cursor: 'pointer' }}
                      onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = 'var(--surface)'}
                      onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = 'var(--surface-raised)'}
                    >
                      Unfollow
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>

          {/* Deleted Meals */}
          <div className="rounded-2xl" style={{ background: 'var(--surface-raised)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-sm)' }}>
            <button
              onClick={handleToggleDeletedMeals}
              className="flex items-center justify-between w-full text-left px-6 py-5"
              style={{ background: 'none', border: 'none', cursor: 'pointer' }}
            >
              <div className="flex items-center gap-2">
                <h2 className="text-base font-bold" style={{ color: 'var(--text-1)' }}>Deleted Meals</h2>
                {deletedMeals.length > 0 && (
                  <span className="text-xs font-semibold px-2 py-0.5 rounded-full" style={{ background: 'var(--surface)', color: 'var(--text-2)' }}>
                    {deletedMeals.length}
                  </span>
                )}
              </div>
              <svg
                width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                style={{ color: 'var(--text-3)', transition: 'transform 0.2s', transform: deletedMealsOpen ? 'rotate(180deg)' : 'none' }}
              >
                <polyline points="6 9 12 15 18 9"/>
              </svg>
            </button>

            {deletedMealsOpen && (
              <div className="px-6 pb-5" style={{ borderTop: '1px solid var(--border)' }}>
                <div className="pt-4">
                  {deletedMealsLoading ? (
                    <p className="text-sm" style={{ color: 'var(--text-3)' }}>Loading…</p>
                  ) : deletedMeals.length === 0 ? (
                    <p className="text-sm" style={{ color: 'var(--text-3)' }}>No deleted meals.</p>
                  ) : (
                    <ul className="divide-y" style={{ borderTop: '1px solid var(--border)' }}>
                      {deletedMeals.map(meal => (
                        <li key={meal.id} className="flex items-center justify-between py-3 gap-3">
                          <div className="min-w-0">
                            <p className="text-sm font-medium truncate" style={{ color: 'var(--text-1)' }}>{meal.name}</p>
                            <p className="text-xs mt-0.5" style={{ color: 'var(--text-3)' }}>
                              {STORE_LABELS[meal.store_id] ?? meal.store_id} · Deleted {new Date(meal.updated_at).toLocaleDateString()}
                            </p>
                          </div>
                          <div className="flex gap-2 shrink-0">
                            <button
                              onClick={() => handleRestoreMeal(meal)}
                              className="text-xs px-3 py-1.5 rounded-lg font-semibold transition-colors"
                              style={{ background: '#16a34a', color: '#fff', border: 'none', cursor: 'pointer' }}
                              onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = '#15803d'}
                              onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = '#16a34a'}
                            >
                              Restore
                            </button>
                            <button
                              onClick={() => handlePermanentDelete(meal)}
                              className="text-xs px-3 py-1.5 rounded-lg font-semibold transition-colors"
                              style={{ background: 'var(--surface)', color: 'var(--error)', border: '1px solid var(--border)', cursor: 'pointer' }}
                              onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = 'var(--brand-light)'}
                              onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = 'var(--surface)'}
                            >
                              Delete Forever
                            </button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            )}
          </div>

        </div>

        <p className="text-center text-xs mt-8" style={{ color: 'var(--text-3)' }}>
          Are you a food creator?{' '}
          <a href="/creator/apply" className="underline" style={{ color: 'var(--text-2)' }}>Apply to become a Creator Partner</a>
        </p>
      </div>
      <AppFooter />
    </div>
  );
}
