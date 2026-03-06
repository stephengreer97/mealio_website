'use client';

import { useEffect, useState } from 'react';

interface CreatorInfo {
  id: string;
  display_name: string;
  bio?: string | null;
  social_handle?: string | null;
  photo_url?: string | null;
  approved_at?: string | null;
}

interface CreatorMeal {
  id: string;
  name: string;
  photo_url?: string | null;
  difficulty?: number | null;
  tags?: string[] | null;
}

export interface FullPresetMeal {
  id: string;
  name: string;
  author?: string | null;
  creator_id?: string | null;
  creator_name?: string | null;
  creator_social?: string | null;
  ingredients: { productName: string; searchTerm?: string; quantity?: number }[];
  source?: string | null;
  recipe?: string | null;
  photo_url?: string | null;
  difficulty?: number | null;
  tags?: string[] | null;
}

interface Props {
  creatorId: string;
  token: string;
  onClose: () => void;
  onMealAdd?: (meal: FullPresetMeal) => void;
}

function DifficultyDots({ level }: { level: number }) {
  return (
    <span className="flex gap-0.5">
      {[1, 2, 3, 4, 5].map(i => (
        <span key={i} className="text-xs" style={{ color: i <= level ? 'var(--wk-red)' : 'var(--wk-border)' }}>●</span>
      ))}
    </span>
  );
}

function MealDetailOverlay({
  meal, onClose, onAdd,
}: {
  meal: FullPresetMeal; onClose: () => void; onAdd?: () => void;
}) {
  const sourceHost = meal.source ? (() => {
    try { return new URL(meal.source!).hostname.replace('www.', ''); } catch { return meal.source; }
  })() : null;
  const authorName = meal.creator_name
    ? (meal.creator_social || meal.creator_name)
    : meal.author ?? null;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center sm:p-4"
      style={{ background: 'rgba(0,0,0,0.5)' }}
      onClick={onClose}
    >
      <div
        className="w-full sm:max-w-lg rounded-t-2xl sm:rounded-2xl flex flex-col"
        style={{ background: 'var(--wk-card)', border: '1px solid var(--wk-border)', maxHeight: '90vh' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between p-5 pb-4" style={{ borderBottom: '1px solid var(--wk-border)' }}>
          <div className="min-w-0 pr-3">
            <h2 className="text-base font-bold text-wk-text leading-tight">{meal.name}</h2>
            {authorName && <p className="text-xs mt-0.5" style={{ color: 'var(--wk-red)' }}>by {authorName}</p>}
          </div>
          <button onClick={onClose} className="flex-shrink-0 text-wk-text3 hover:text-wk-text text-xl leading-none">✕</button>
        </div>

        {/* Body */}
        <div className="overflow-y-auto flex-1 p-5 space-y-4">
          {meal.photo_url && (
            <img src={meal.photo_url} alt={meal.name} className="w-full rounded-xl object-cover" style={{ maxHeight: '220px' }} />
          )}

          <div className="flex items-center gap-4 flex-wrap">
            {meal.difficulty != null && (
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-wk-text3">Difficulty:</span>
                <DifficultyDots level={meal.difficulty} />
              </div>
            )}
            {sourceHost && (
              <a href={meal.source!} target="_blank" rel="noopener noreferrer"
                className="text-xs flex items-center gap-1 hover:underline" style={{ color: 'var(--wk-text3)' }}>
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
                </svg>
                {sourceHost}
              </a>
            )}
          </div>

          {meal.tags && meal.tags.length > 0 && (
            <div className="flex items-center gap-1.5 flex-wrap">
              {meal.tags.map(tag => (
                <span key={tag} className="text-xs px-2 py-0.5 rounded-full" style={{ background: 'var(--wk-surface)', border: '1px solid var(--wk-border)', color: 'var(--wk-text2)' }}>
                  {tag}
                </span>
              ))}
            </div>
          )}

          <div>
            <p className="text-xs font-semibold uppercase tracking-wide mb-2.5" style={{ color: 'var(--wk-text3)' }}>Ingredients</p>
            <ul className="space-y-2">
              {meal.ingredients.map((ing, i) => (
                <li key={i} className="flex items-center justify-between gap-4" style={{ borderBottom: '1px solid var(--wk-border)', paddingBottom: '6px' }}>
                  <span className="text-sm text-wk-text">{ing.productName}</span>
                  <span className="text-xs font-medium text-wk-text3 flex-shrink-0">×{ing.quantity ?? 1}</span>
                </li>
              ))}
            </ul>
          </div>

          {meal.recipe && (
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide mb-2.5" style={{ color: 'var(--wk-text3)' }}>Recipe</p>
              <p className="text-sm whitespace-pre-wrap leading-relaxed" style={{ color: 'var(--wk-text2)' }}>{meal.recipe}</p>
            </div>
          )}
        </div>

        {/* Footer */}
        {onAdd && (
          <div className="p-4" style={{ borderTop: '1px solid var(--wk-border)' }}>
            <button
              onClick={onAdd}
              className="px-4 py-2 text-sm font-medium rounded-lg transition-colors"
              style={{ background: 'var(--wk-red)', border: 'none', color: '#fff' }}
              onMouseEnter={e => { e.currentTarget.style.opacity = '0.88'; }}
              onMouseLeave={e => { e.currentTarget.style.opacity = '1'; }}
            >
              + Add to My Meals
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default function CreatorPopup({ creatorId, token, onClose, onMealAdd }: Props) {
  const [creator, setCreator] = useState<CreatorInfo | null>(null);
  const [meals, setMeals] = useState<CreatorMeal[]>([]);
  const [followerCount, setFollowerCount] = useState(0);
  const [following, setFollowing] = useState(false);
  const [loadingData, setLoadingData] = useState(true);
  const [followLoading, setFollowLoading] = useState(false);
  const [error, setError] = useState('');

  const [selectedMeal, setSelectedMeal] = useState<FullPresetMeal | null>(null);
  const [loadingMeal, setLoadingMeal] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoadingData(true);

    Promise.all([
      fetch(`/api/creators/${creatorId}`).then(r => r.json()),
      fetch(`/api/creators/${creatorId}/follow`, {
        headers: { Authorization: `Bearer ${token}` },
      }).then(r => r.json()),
    ])
      .then(([creatorData, followData]) => {
        if (cancelled) return;
        if (creatorData.creator) {
          setCreator(creatorData.creator);
          setMeals(creatorData.meals ?? []);
          setFollowerCount(creatorData.followerCount ?? 0);
        } else {
          setError('Creator not found.');
        }
        setFollowing(followData.following ?? false);
      })
      .catch(() => {
        if (!cancelled) setError('Failed to load creator.');
      })
      .finally(() => {
        if (!cancelled) setLoadingData(false);
      });

    return () => { cancelled = true; };
  }, [creatorId, token]);

  const toggleFollow = async () => {
    if (followLoading) return;
    setFollowLoading(true);
    const wasFollowing = following;
    setFollowing(!wasFollowing);
    setFollowerCount(c => wasFollowing ? c - 1 : c + 1);

    try {
      const res = await fetch(`/api/creators/${creatorId}/follow`, {
        method: wasFollowing ? 'DELETE' : 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error();
    } catch {
      setFollowing(wasFollowing);
      setFollowerCount(c => wasFollowing ? c + 1 : c - 1);
    } finally {
      setFollowLoading(false);
    }
  };

  const openMeal = async (mealId: string) => {
    setLoadingMeal(true);
    try {
      const res = await fetch(`/api/preset-meals/${mealId}`);
      const data = await res.json();
      if (data.meal) setSelectedMeal(data.meal);
    } catch {
      // silently ignore
    } finally {
      setLoadingMeal(false);
    }
  };

  return (
    <>
      <div
        className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:p-4"
        style={{ background: 'rgba(0,0,0,0.5)' }}
        onClick={onClose}
      >
        <div
          className="w-full sm:max-w-lg rounded-t-2xl sm:rounded-2xl flex flex-col"
          style={{ background: 'var(--wk-card)', border: '1px solid var(--wk-border)', maxHeight: '85vh' }}
          onClick={e => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-5 py-4" style={{ borderBottom: '1px solid var(--wk-border)' }}>
            <h2 className="text-sm font-bold text-wk-text">Creator</h2>
            <button onClick={onClose} className="text-wk-text3 hover:text-wk-text text-xl leading-none transition-colors">✕</button>
          </div>

          {/* Body */}
          <div className="overflow-y-auto flex-1 p-5">
            {loadingData ? (
              <div className="flex justify-center py-12">
                <div className="w-7 h-7 rounded-full animate-spin" style={{ border: '2px solid var(--wk-border)', borderTopColor: 'var(--wk-red)' }} />
              </div>
            ) : error ? (
              <p className="text-sm text-center py-12" style={{ color: 'var(--wk-text3)' }}>{error}</p>
            ) : creator ? (
              <div className="space-y-5">
                {/* Creator profile */}
                <div className="flex items-start justify-between gap-4">
                  <div className="flex items-start gap-3 min-w-0">
                    {/* Avatar */}
                    <div className="flex-shrink-0 rounded-full overflow-hidden" style={{ width: '52px', height: '52px', border: '1px solid var(--wk-border)', background: 'var(--wk-surface)' }}>
                      {creator.photo_url ? (
                        <img src={creator.photo_url} alt={creator.display_name} className="w-full h-full object-cover" />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-xl">👤</div>
                      )}
                    </div>
                    <div className="min-w-0">
                      <p className="text-base font-bold text-wk-text">{creator.display_name}</p>
                      {creator.social_handle && (
                        <p className="text-xs mt-0.5" style={{ color: 'var(--wk-text3)' }}>@{creator.social_handle}</p>
                      )}
                      {creator.bio && (
                        <p className="text-sm mt-2 leading-relaxed" style={{ color: 'var(--wk-text2)' }}>{creator.bio}</p>
                      )}
                      <p className="text-xs mt-2" style={{ color: 'var(--wk-text3)' }}>
                        {followerCount} {followerCount === 1 ? 'follower' : 'followers'}
                      </p>
                    </div>
                  </div>

                  <button
                    onClick={toggleFollow}
                    disabled={followLoading}
                    className="flex-shrink-0 px-4 py-1.5 text-sm font-semibold rounded-xl transition-all disabled:opacity-60"
                    style={following
                      ? { background: 'var(--wk-surface)', color: 'var(--wk-text2)', border: '1px solid var(--wk-border)' }
                      : { background: 'var(--wk-red)', color: '#fff', border: 'none' }}
                  >
                    {following ? 'Following' : 'Follow'}
                  </button>
                </div>

                {/* Meals grid */}
                {meals.length > 0 && (
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wide mb-3" style={{ color: 'var(--wk-text3)' }}>
                      Meals ({meals.length})
                    </p>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                      {meals.map(meal => (
                        <button
                          key={meal.id}
                          className="rounded-xl overflow-hidden text-left transition-opacity"
                          style={{ border: '1px solid var(--wk-border)', background: 'var(--wk-surface)', cursor: 'pointer' }}
                          onClick={() => openMeal(meal.id)}
                          disabled={loadingMeal}
                          onMouseEnter={e => (e.currentTarget.style.opacity = '0.8')}
                          onMouseLeave={e => (e.currentTarget.style.opacity = '1')}
                        >
                          {meal.photo_url ? (
                            <img src={meal.photo_url} alt={meal.name} className="w-full object-cover" style={{ height: '90px' }} />
                          ) : (
                            <div className="flex items-center justify-center" style={{ height: '90px', background: 'var(--wk-surface)' }}>
                              <span className="text-2xl">🍽️</span>
                            </div>
                          )}
                          <p className="text-xs font-medium px-2 py-1.5 leading-tight" style={{ color: 'var(--wk-text)' }}>{meal.name}</p>
                        </button>
                      ))}
                    </div>
                    {loadingMeal && (
                      <div className="flex justify-center pt-4">
                        <div className="w-5 h-5 rounded-full animate-spin" style={{ border: '2px solid var(--wk-border)', borderTopColor: 'var(--wk-red)' }} />
                      </div>
                    )}
                  </div>
                )}

                {meals.length === 0 && (
                  <p className="text-sm text-center py-6" style={{ color: 'var(--wk-text3)' }}>No meals yet.</p>
                )}
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {selectedMeal && (
        <MealDetailOverlay
          meal={selectedMeal}
          onClose={() => setSelectedMeal(null)}
          onAdd={onMealAdd ? () => { onMealAdd(selectedMeal); setSelectedMeal(null); onClose(); } : undefined}
        />
      )}
    </>
  );
}
