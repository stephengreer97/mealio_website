'use client';

import { useEffect, useRef, useState } from 'react';

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
  ingredients: { ingredientName?: string; productName?: string; name?: string; searchTerm?: string; qty?: number; quantity?: number; unit?: string; measure?: string }[];
  source?: string | null;
  story?: string | null;
  recipe?: string | null;
  photo_url?: string | null;
  difficulty?: number | null;
  serves?: string | null;
  tags?: string[] | null;
}

interface Props {
  creatorId: string;
  token?: string;
  onClose: () => void;
  onMealAdd?: (meal: FullPresetMeal) => void;
}

function getInitials(name: string) {
  return name.split(' ').slice(0, 2).map(w => w[0]).join('').toUpperCase();
}

function ingName(ing: FullPresetMeal['ingredients'][number]): string {
  return ing.ingredientName ?? ing.productName ?? ing.name ?? '';
}

function fmtMeasurement(ing: FullPresetMeal['ingredients'][number]): string {
  const n = ingName(ing);
  const qty = ing.qty ?? ing.quantity ?? 1;
  if (!ing.unit || ing.unit === 'qty') return `${n}, ${qty}`;
  return `${n}, ${ing.measure ?? ''} ${ing.unit}`.replace(/\s+/g, ' ').trim();
}

function DifficultyDots({ level }: { level: number }) {
  return (
    <span className="flex gap-1 items-center">
      {[1, 2, 3, 4, 5].map(i => (
        <span
          key={i}
          style={{
            display: 'inline-block',
            width: '6px',
            height: '6px',
            borderRadius: '50%',
            background: i <= level ? 'var(--brand)' : 'var(--border)',
          }}
        />
      ))}
    </span>
  );
}

function MealDetailOverlay({
  meal, onClose, onAdd,
}: {
  meal: FullPresetMeal; onClose: () => void; onAdd?: () => void;
}) {
  const dragRef = useRef(false);
  const sourceHost = meal.source ? (() => {
    try { return new URL(meal.source!).hostname.replace('www.', ''); } catch { return meal.source; }
  })() : null;
  const authorName = meal.creator_name
    ? (meal.creator_social || meal.creator_name)
    : meal.author ?? null;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center sm:p-4"
      style={{ background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(4px)' }}
      onMouseDown={e => { dragRef.current = e.target !== e.currentTarget; }}
      onClick={e => { if (e.target !== e.currentTarget || dragRef.current) return; onClose(); }}
    >
      <div
        className="w-full sm:max-w-lg rounded-t-2xl sm:rounded-2xl flex flex-col"
        style={{ background: 'var(--surface-raised)', border: '1px solid var(--border)', maxHeight: '90vh', boxShadow: 'var(--shadow-md)' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between p-5 pb-4" style={{ borderBottom: '1px solid var(--border)' }}>
          <div className="min-w-0 pr-3">
            <h2 className="text-base font-bold leading-tight" style={{ color: 'var(--text-1)' }}>{meal.name}</h2>
            {authorName && <p className="text-xs mt-0.5 font-medium" style={{ color: 'var(--brand)' }}>by {authorName}</p>}
          </div>
          <button
            onClick={onClose}
            className="flex-shrink-0 transition-colors"
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-3)', padding: '2px' }}
            onMouseEnter={e => (e.currentTarget as HTMLElement).style.color = 'var(--text-1)'}
            onMouseLeave={e => (e.currentTarget as HTMLElement).style.color = 'var(--text-3)'}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="overflow-y-auto flex-1 p-5 space-y-4">
          {meal.photo_url && (
            <div style={{ position: 'relative' }}>
              <img src={meal.photo_url} alt={meal.name} className="w-full rounded-xl object-cover" style={{ maxHeight: '220px' }} />
              {meal.tags && meal.tags.length > 0 && (
                <div style={{ position: 'absolute', top: 8, right: 8, display: 'flex', flexWrap: 'wrap', gap: 4, justifyContent: 'flex-end', maxWidth: '80%' }}>
                  {meal.tags.map(tag => (
                    <span key={tag} style={{ background: 'rgba(0,0,0,0.52)', borderRadius: '20px', padding: '3px 9px', fontSize: '11px', color: '#fff', fontWeight: 500 }}>
                      {tag}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}

          {(meal.difficulty != null || meal.serves || sourceHost) && (
            <div className="flex items-center gap-4 flex-wrap">
              {meal.difficulty != null && (
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium" style={{ color: 'var(--text-3)' }}>Difficulty</span>
                  <DifficultyDots level={meal.difficulty} />
                </div>
              )}
              {meal.serves && (
                <div className="flex items-center gap-1.5">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--text-3)' }}>
                    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>
                  </svg>
                  <span className="text-xs font-medium" style={{ color: 'var(--text-3)' }}>{meal.serves}</span>
                </div>
              )}
              {sourceHost && (
                <a href={meal.source!} target="_blank" rel="noopener noreferrer"
                  className="text-xs flex items-center gap-1 hover:underline"
                  style={{ color: 'var(--text-3)' }}>
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
                  </svg>
                  {sourceHost}
                </a>
              )}
            </div>
          )}

          {!meal.photo_url && meal.tags && meal.tags.length > 0 && (
            <div className="flex items-center gap-1.5 flex-wrap">
              {meal.tags.map(tag => (
                <span key={tag} className="text-xs px-2.5 py-1 rounded-full font-medium"
                  style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text-2)' }}>
                  {tag}
                </span>
              ))}
            </div>
          )}

          {meal.story && (
            <p className="text-sm italic leading-relaxed" style={{ color: 'var(--text-2)' }}>{meal.story}</p>
          )}

          <div>
            <p className="text-xs font-semibold uppercase tracking-widest mb-3" style={{ color: 'var(--text-3)', letterSpacing: '0.08em' }}>Measurements</p>
            <ul className="space-y-1.5">
              {meal.ingredients.map((ing, i) => (
                <li key={i} className="flex items-start gap-2 py-2" style={{ borderBottom: '1px solid var(--border)' }}>
                  <span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', background: 'var(--brand)', flexShrink: 0, marginTop: 7 }} />
                  <span className="text-sm" style={{ color: 'var(--text-1)' }}>{fmtMeasurement(ing)}</span>
                </li>
              ))}
            </ul>
          </div>

          {meal.recipe && (
            <div>
              <p className="text-xs font-semibold uppercase tracking-widest mb-3" style={{ color: 'var(--text-3)', letterSpacing: '0.08em' }}>Recipe</p>
              <p className="text-sm whitespace-pre-wrap leading-relaxed" style={{ color: 'var(--text-2)' }}>{meal.recipe}</p>
            </div>
          )}
        </div>

        {/* Footer */}
        {onAdd && (
          <div className="p-4" style={{ borderTop: '1px solid var(--border)' }}>
            <button
              onClick={onAdd}
              className="w-full px-4 py-2.5 text-sm font-semibold rounded-xl transition-colors"
              style={{ background: 'var(--brand)', border: 'none', color: '#fff' }}
              onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = 'var(--brand-dark)'}
              onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = 'var(--brand)'}
            >
              Save to My Meals
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
  const dragRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    setLoadingData(true);

    Promise.all([
      fetch(`/api/creators/${creatorId}`).then(r => r.json()),
      token
        ? fetch(`/api/creators/${creatorId}/follow`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json())
        : Promise.resolve({ following: false }),
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
      .catch(() => { if (!cancelled) setError('Failed to load creator.'); })
      .finally(() => { if (!cancelled) setLoadingData(false); });

    return () => { cancelled = true; };
  }, [creatorId, token]);

  const toggleFollow = async () => {
    if (!token) { window.location.href = '/'; return; }
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
    } catch {} finally {
      setLoadingMeal(false);
    }
  };

  return (
    <>
      <div
        className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:p-4"
        style={{ background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(4px)' }}
        onMouseDown={e => { dragRef.current = e.target !== e.currentTarget; }}
        onClick={e => { if (e.target !== e.currentTarget || dragRef.current) return; onClose(); }}
      >
        <div
          className="w-full sm:max-w-lg rounded-t-2xl sm:rounded-2xl flex flex-col"
          style={{ background: 'var(--surface-raised)', border: '1px solid var(--border)', maxHeight: '85vh', boxShadow: 'var(--shadow-md)' }}
          onClick={e => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-5 py-4" style={{ borderBottom: '1px solid var(--border)' }}>
            <h2 className="text-sm font-semibold" style={{ color: 'var(--text-1)' }}>Creator Profile</h2>
            <button
              onClick={onClose}
              className="transition-colors"
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-3)', padding: '2px' }}
              onMouseEnter={e => (e.currentTarget as HTMLElement).style.color = 'var(--text-1)'}
              onMouseLeave={e => (e.currentTarget as HTMLElement).style.color = 'var(--text-3)'}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>

          {/* Body */}
          <div className="overflow-y-auto flex-1 p-5">
            {loadingData ? (
              <div className="flex justify-center py-12">
                <div className="w-7 h-7 rounded-full animate-spin" style={{ border: '2px solid var(--border)', borderTopColor: 'var(--brand)' }} />
              </div>
            ) : error ? (
              <p className="text-sm text-center py-12" style={{ color: 'var(--text-3)' }}>{error}</p>
            ) : creator ? (
              <div className="space-y-5">
                {/* Creator profile */}
                <div className="flex items-start justify-between gap-4">
                  <div className="flex items-start gap-3.5 min-w-0">
                    {/* Avatar */}
                    <div
                      className="flex-shrink-0 rounded-full overflow-hidden flex items-center justify-center"
                      style={{ width: '52px', height: '52px', border: '1.5px solid var(--border)', background: 'var(--surface)' }}
                    >
                      {creator.photo_url ? (
                        <img src={creator.photo_url} alt={creator.display_name} className="w-full h-full object-cover" />
                      ) : (
                        <span className="text-sm font-bold" style={{ color: 'var(--text-2)' }}>
                          {getInitials(creator.display_name)}
                        </span>
                      )}
                    </div>
                    <div className="min-w-0">
                      <p className="text-base font-bold" style={{ color: 'var(--text-1)' }}>{creator.display_name}</p>
                      {creator.social_handle && (
                        <p className="text-xs mt-0.5" style={{ color: 'var(--text-3)' }}>@{creator.social_handle}</p>
                      )}
                      {creator.bio && (
                        <p className="text-sm mt-2 leading-relaxed" style={{ color: 'var(--text-2)' }}>{creator.bio}</p>
                      )}
                      <p className="text-xs mt-2" style={{ color: 'var(--text-3)' }}>
                        {followerCount} {followerCount === 1 ? 'follower' : 'followers'}
                      </p>
                    </div>
                  </div>

                  <button
                    onClick={toggleFollow}
                    disabled={followLoading}
                    className="flex-shrink-0 px-4 py-1.5 text-sm font-semibold rounded-xl transition-all disabled:opacity-60"
                    style={following
                      ? { background: 'var(--surface)', color: 'var(--text-2)', border: '1.5px solid var(--border)' }
                      : { background: 'var(--brand)', color: '#fff', border: 'none' }}
                    onMouseEnter={e => {
                      if (!following) (e.currentTarget as HTMLElement).style.background = 'var(--brand-dark)';
                    }}
                    onMouseLeave={e => {
                      if (!following) (e.currentTarget as HTMLElement).style.background = 'var(--brand)';
                    }}
                  >
                    {following ? 'Following' : 'Follow'}
                  </button>
                </div>

                {/* Meals grid */}
                {meals.length > 0 && (
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-widest mb-3" style={{ color: 'var(--text-3)', letterSpacing: '0.08em' }}>
                      Meals ({meals.length})
                    </p>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                      {meals.map(meal => (
                        <button
                          key={meal.id}
                          className="rounded-xl overflow-hidden text-left transition-all"
                          style={{ border: '1px solid var(--border)', background: 'var(--surface)', cursor: 'pointer' }}
                          onClick={() => openMeal(meal.id)}
                          disabled={loadingMeal}
                          onMouseEnter={e => { (e.currentTarget as HTMLElement).style.transform = 'translateY(-1px)'; (e.currentTarget as HTMLElement).style.boxShadow = 'var(--shadow-sm)'; }}
                          onMouseLeave={e => { (e.currentTarget as HTMLElement).style.transform = 'none'; (e.currentTarget as HTMLElement).style.boxShadow = 'none'; }}
                        >
                          {meal.photo_url ? (
                            <img src={meal.photo_url} alt={meal.name} className="w-full object-cover" style={{ height: '90px' }} />
                          ) : (
                            <div className="flex items-center justify-center" style={{ height: '90px', background: 'var(--surface)' }}>
                              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--border-strong)' }}>
                                <path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2"/><path d="M7 2v20"/><path d="M21 15V2v0a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7"/>
                              </svg>
                            </div>
                          )}
                          <p className="text-xs font-medium px-2.5 py-2 leading-tight" style={{ color: 'var(--text-1)' }}>{meal.name}</p>
                        </button>
                      ))}
                    </div>
                    {loadingMeal && (
                      <div className="flex justify-center pt-4">
                        <div className="w-5 h-5 rounded-full animate-spin" style={{ border: '2px solid var(--border)', borderTopColor: 'var(--brand)' }} />
                      </div>
                    )}
                  </div>
                )}

                {meals.length === 0 && (
                  <p className="text-sm text-center py-6" style={{ color: 'var(--text-3)' }}>No meals yet.</p>
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
