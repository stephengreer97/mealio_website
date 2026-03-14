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

interface SharedMeal {
  id: string;
  name: string;
  store_id: string;
  ingredients: Ingredient[];
  author?: string | null;
  difficulty?: number | null;
  serves?: string | null;
  website?: string | null;
  story?: string | null;
  recipe?: string | null;
  photo_url?: string | null;
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

export default function SharedMealPage() {
  const router = useRouter();
  const params = useParams();
  const token = params.token as string;

  const [meal, setMeal] = useState<SharedMeal | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [loading, setLoading] = useState(true);

  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [selectedStore, setSelectedStore] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [tierLimitReached, setTierLimitReached] = useState(false);

  // Check auth + fetch meal
  useEffect(() => {
    const accessToken = localStorage.getItem('accessToken');
    setIsLoggedIn(!!accessToken);

    fetch(`/api/shared/${token}`)
      .then(r => {
        if (r.status === 404) { setNotFound(true); return null; }
        return r.json();
      })
      .then(data => {
        if (data?.meal) {
          setMeal(data.meal);
          setSelectedStore('');
        }
      })
      .catch(() => setNotFound(true))
      .finally(() => setLoading(false));
  }, [token]);

  // If coming back after login with autoSave param, trigger save automatically
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
      localStorage.setItem('pendingShareToken', token);
      router.push(`/?redirect=/meal/${token}?autoSave=1`);
      return;
    }

    setSaving(true);
    setSaveError('');
    setTierLimitReached(false);

    try {
      const accessToken = localStorage.getItem('accessToken');
      const res = await fetch(`/api/shared/${token}/save`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ storeId: selectedStore }),
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
    } catch {
      setSaveError('Something went wrong. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const storeLabel = STORES.find(s => s.id === meal?.store_id)?.label ?? meal?.store_id ?? '';

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

          {/* Name + store badge */}
          <div className="flex items-start justify-between gap-3 mb-3">
            <h1 className="text-xl font-bold text-gray-900 leading-tight">{meal.name}</h1>
            {storeLabel && (
              <span className="flex-shrink-0 text-xs font-semibold text-gray-500 bg-gray-100 rounded-full px-3 py-1">
                {storeLabel}
              </span>
            )}
          </div>

          {/* Author */}
          {meal.author && (
            <p className="text-sm text-gray-500 mb-2">by {meal.author}</p>
          )}

          {/* Difficulty + Serves + Website */}
          {(meal.difficulty != null || meal.serves || meal.website) && (
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
              {meal.website && (
                <a
                  href={meal.website}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-red-600 hover:text-red-700 truncate max-w-full"
                >
                  {meal.website.replace(/^https?:\/\/(www\.)?/, '')}
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
                  <option value="">Select a store…</option>
                  {STORES.map(s => (
                    <option key={s.id} value={s.id}>{s.label}</option>
                  ))}
                </select>
              </div>

              {saveError && (
                <p className="text-xs text-red-600">{saveError}</p>
              )}

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
                    onClick={() => {
                      localStorage.setItem('pendingShareToken', token);
                      router.push(`/?redirect=/meal/${token}?autoSave=1`);
                    }}
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
