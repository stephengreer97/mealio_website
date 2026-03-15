'use client';

import { useEffect, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';

const STORES = [
  { id: 'acme',          label: 'Acme Markets' },
  { id: 'aldi',          label: 'ALDI' },
  { id: 'albertsons',    label: 'Albertsons' },
  { id: 'amazon',        label: 'Amazon Fresh' },
  { id: 'bakers',        label: "Baker's" },
  { id: 'balduccis',     label: "Balducci's" },
  { id: 'carrs',         label: 'Carrs' },
  { id: 'central_market',label: 'Central Market' },
  { id: 'city_market',   label: 'City Market' },
  { id: 'costco',        label: 'Costco' },
  { id: 'dillons',       label: 'Dillons' },
  { id: 'fred_meyer',    label: 'Fred Meyer' },
  { id: 'frys',          label: "Fry's Food" },
  { id: 'haggen',        label: 'Haggen' },
  { id: 'heb',           label: 'H-E-B' },
  { id: 'harris_teeter', label: 'Harris Teeter' },
  { id: 'jewel_osco',    label: 'Jewel-Osco' },
  { id: 'king_soopers',  label: 'King Soopers' },
  { id: 'kings',         label: 'Kings Food Markets' },
  { id: 'kroger',        label: 'Kroger' },
  { id: 'marianos',      label: "Mariano's" },
  { id: 'metro_market',  label: 'Metro Market' },
  { id: 'pay_less',      label: 'Pay-Less' },
  { id: 'pavilions',     label: 'Pavilions' },
  { id: 'pick_n_save',   label: "Pick 'n Save" },
  { id: 'qfc',           label: 'QFC' },
  { id: 'ralphs',        label: 'Ralphs' },
  { id: 'randalls',      label: 'Randalls' },
  { id: 'safeway',       label: 'Safeway' },
  { id: 'shaws',         label: "Shaw's" },
  { id: 'smiths',        label: "Smith's Food & Drug" },
  { id: 'star_market',   label: 'Star Market' },
  { id: 'tom_thumb',     label: 'Tom Thumb' },
  { id: 'vons',          label: 'Vons' },
  { id: 'walmart',       label: 'Walmart' },
  { id: 'wegmans',       label: 'Wegmans' },
];

interface Ingredient {
  productName: string;
  searchTerm?: string;
  quantity?: number;
}

interface PresetMeal {
  id: string;
  name: string;
  author?: string | null;
  creator_id?: string | null;
  ingredients: Ingredient[];
  difficulty?: number | null;
  serves?: string | null;
  source?: string | null;
  story?: string | null;
  recipe?: string | null;
  photo_url?: string | null;
  tags?: string[] | null;
}

function DifficultyDots({ level }: { level: number }) {
  return (
    <div className="flex gap-0.5">
      {[1, 2, 3, 4, 5].map(i => (
        <span key={i} className={`text-base ${i <= level ? 'text-red-500' : 'text-gray-200'}`}>●</span>
      ))}
    </div>
  );
}

export default function SharedPresetMealPage() {
  const router = useRouter();
  const params = useParams();
  const id = params.id as string;

  const [meal, setMeal] = useState<PresetMeal | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [loading, setLoading] = useState(true);

  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [selectedStore, setSelectedStore] = useState('');
  const [recentStores, setRecentStores] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [tierLimitReached, setTierLimitReached] = useState(false);

  useEffect(() => {
    const accessToken = localStorage.getItem('accessToken');
    setIsLoggedIn(!!accessToken);
    try { setRecentStores(JSON.parse(localStorage.getItem('mealio_recent_stores') || '[]')); } catch { /* ignore */ }

    fetch(`/api/preset-meals/${id}`)
      .then(r => {
        if (r.status === 404) { setNotFound(true); return null; }
        return r.json();
      })
      .then(data => {
        if (data?.meal) setMeal(data.meal);
      })
      .catch(() => setNotFound(true))
      .finally(() => setLoading(false));
  }, [id]);

  // Auto-save if returning from login with ?autoSave=1
  useEffect(() => {
    if (!meal || !isLoggedIn) return;
    const url = new URL(window.location.href);
    if (url.searchParams.get('autoSave') === '1') {
      url.searchParams.delete('autoSave');
      window.history.replaceState({}, '', url.toString());
      handleSave();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meal, isLoggedIn]);

  const handleSave = async () => {
    if (!isLoggedIn) {
      router.push(`/?redirect=/meal/p/${id}?autoSave=1`);
      return;
    }

    setSaving(true);
    setSaveError('');
    setTierLimitReached(false);

    try {
      const accessToken = localStorage.getItem('accessToken')!;
      const headers = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      };

      // Record the save — counts toward creator stats (fire-and-forget)
      fetch(`/api/preset-meals/${id}/save`, { method: 'POST', headers }).catch(() => {});

      // Create a personal copy
      const res = await fetch('/api/meals', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name:        meal!.name,
          storeId:     selectedStore,
          ingredients: meal!.ingredients,
          ...(meal!.author     ? { author:    meal!.author }     : {}),
          ...(meal!.difficulty ? { difficulty: meal!.difficulty } : {}),
          ...(meal!.source     ? { website:   meal!.source }     : {}),
          ...(meal!.story      ? { story:     meal!.story }      : {}),
          ...(meal!.recipe     ? { recipe:    meal!.recipe }     : {}),
          ...(meal!.photo_url  ? { photoUrl:  meal!.photo_url }  : {}),
          ...(meal!.serves          ? { serves: meal!.serves }             : {}),
          ...(meal!.tags?.length    ? { tags:   meal!.tags }               : {}),
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        if (data.tierLimitReached) {
          setTierLimitReached(true);
        } else {
          setSaveError(data.error || 'Something went wrong. Please try again.');
        }
        return;
      }

      setSaved(true);
      try {
        const updated = [selectedStore, ...recentStores.filter(id => id !== selectedStore)].slice(0, 3);
        localStorage.setItem('mealio_recent_stores', JSON.stringify(updated));
      } catch { /* ignore */ }
    } catch {
      setSaveError('Something went wrong. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="w-10 h-10 border-4 border-red-600 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (notFound || !meal) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
        <div className="bg-white rounded-2xl border border-gray-100 shadow-lg p-10 max-w-sm w-full text-center">
          <div className="text-4xl mb-4">🍽️</div>
          <h2 className="text-lg font-bold text-gray-900 mb-2">Meal not found</h2>
          <p className="text-sm text-gray-500">This meal link is no longer available.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center px-4 py-10">

      {/* Header */}
      <div className="mb-6 text-center">
        <div style={{ fontFamily: 'var(--font-pacifico), cursive' }}>
          <span style={{ fontSize: '38px', lineHeight: '1', display: 'inline-block', verticalAlign: 'middle', textShadow: '2px 3px 0px rgba(0,0,0,0.12)', color: '#dd0031' }}>M</span>
          <span style={{ fontSize: '28px', textShadow: '1px 2px 0px rgba(0,0,0,0.1)', color: '#dd0031' }}>ealio</span>
        </div>
        <p className="text-sm text-gray-500 mt-1">Someone shared a meal with you</p>
      </div>

      {/* Meal Card */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-lg w-full" style={{ maxWidth: '854px' }}>

        {/* Hero image */}
        {meal.photo_url && (
          <img
            src={meal.photo_url}
            alt={meal.name}
            className="w-full h-48 object-cover"
          />
        )}

        <div className="p-6">

          {/* Name */}
          <h1 className="text-xl font-bold text-gray-900 leading-tight mb-3">{meal.name}</h1>

          {/* Author */}
          {meal.author && (
            meal.creator_id
              ? <a href={`/discover?creator=${meal.creator_id}`} className="text-sm text-red-600 hover:text-red-700 mb-2 block">by {meal.author}</a>
              : <p className="text-sm text-gray-500 mb-2">by {meal.author}</p>
          )}

          {/* Difficulty + Serves + Source */}
          {(meal.difficulty != null || meal.serves || meal.source) && (
            <div className="flex items-center gap-4 mb-3 flex-wrap">
              {meal.difficulty != null && (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-gray-400">Difficulty</span>
                  <DifficultyDots level={meal.difficulty} />
                </div>
              )}
              {meal.serves && (
                <span className="flex items-center gap-0.5 text-xs text-gray-400">
                  <svg width="12" height="12" viewBox="0 0 24 20" fill="currentColor">
                    <circle cx="12" cy="6" r="5"/>
                    <path d="M1 20c0-5 5-8 11-8s11 3 11 8z"/>
                  </svg>
                  {meal.serves}
                </span>
              )}
              {meal.source && (
                <a
                  href={meal.source}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-red-600 hover:text-red-700 truncate max-w-full"
                >
                  {meal.source.replace(/^https?:\/\/(www\.)?/, '')}
                </a>
              )}
            </div>
          )}

          {/* Story */}
          {meal.story && (
            <p className="text-sm text-gray-500 italic whitespace-pre-wrap leading-relaxed mb-4">
              {meal.story}
            </p>
          )}

          {/* Ingredients */}
          <div className="mb-4">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
              Ingredients ({meal.ingredients.length})
            </p>
            <ul className="space-y-1">
              {meal.ingredients.map((item, i) => (
                <li key={i} className="flex items-center justify-between gap-8 text-sm text-gray-700">
                  <span>{item.productName}</span>
                  <span className="text-xs font-semibold text-gray-400 flex-shrink-0">×{item.quantity ?? 1}</span>
                </li>
              ))}
            </ul>
          </div>

          {/* Recipe */}
          {meal.recipe && (
            <div className="mb-4">
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Recipe</p>
              <p className="text-sm text-gray-600 whitespace-pre-wrap leading-relaxed">
                {meal.recipe}
              </p>
            </div>
          )}

          {/* Save section */}
          {saved ? (
            <div className="bg-green-50 border border-green-200 rounded-xl p-4 text-center">
              <p className="text-sm font-semibold text-green-700 mb-1">✓ Saved to your meals!</p>
              <p className="text-xs text-green-600">Open the Mealio extension to add it to your cart.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {/* Store picker */}
              <div>
                <label className="block text-xs font-semibold text-gray-500 mb-1">Select your grocery store</label>
                <select
                  value={selectedStore}
                  onChange={e => setSelectedStore(e.target.value)}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-red-500"
                >
                  <option value="" disabled>Select a store…</option>
                  {recentStores.length > 0 && (
                    <optgroup label="Recent">
                      {recentStores.filter(id => STORES.find(s => s.id === id)).map(id => (
                        <option key={id} value={id}>{STORES.find(s => s.id === id)!.label}</option>
                      ))}
                    </optgroup>
                  )}
                  <optgroup label={recentStores.length > 0 ? 'All Stores' : ''}>
                    {STORES.filter(s => !recentStores.includes(s.id)).map(s => (
                      <option key={s.id} value={s.id}>{s.label}</option>
                    ))}
                  </optgroup>
                </select>
              </div>

              {saveError && <p className="text-xs text-red-600">{saveError}</p>}

              {tierLimitReached && (
                <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs text-amber-700">
                  You have reached the 3-meal limit on the free plan.{' '}
                  <a href="/pricing" className="underline font-medium">Upgrade to Full Access</a> to save more meals.
                </div>
              )}

              <button
                onClick={handleSave}
                disabled={saving || !selectedStore}
                className="w-full bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white font-semibold rounded-xl py-3 text-sm transition"
              >
                {saving ? 'Saving…' : isLoggedIn ? 'Save to My Meals' : 'Sign in to Save'}
              </button>

              {!isLoggedIn && (
                <p className="text-center text-xs text-gray-400">
                  Don&apos;t have an account?{' '}
                  <button
                    onClick={() => router.push(`/?redirect=/meal/p/${id}?autoSave=1`)}
                    className="text-red-600 hover:text-red-700 font-medium"
                  >
                    Create one free
                  </button>
                </p>
              )}
            </div>
          )}

        </div>
      </div>

      <p className="mt-6 text-xs text-gray-400">
        <a href="/" className="hover:text-gray-600">Go to Mealio</a>
      </p>
    </div>
  );
}
