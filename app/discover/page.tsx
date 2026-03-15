'use client';

import React, { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import AppHeader from '@/components/AppHeader';
import AppFooter from '@/components/AppFooter';
import CreatorPopup from '@/components/CreatorPopup';

interface User {
  id: string;
  email: string;
  tier?: string;
  isAdmin?: boolean;
  createdAt?: string;
}

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

const PAGE_SIZE = 20;

const ALL_TAGS = [
  'Under 10 Min', 'Under 30 Min', 'Under 45 Min', 'Over 1 Hour',
  'One Pot', 'Sheet Pan', 'Slow Cooker', 'Air Fryer', 'Grilled', 'No Cook',
  'Instant Pot', 'Baked', 'Stovetop', 'Deep Fried', 'Steamed',
  'Breakfast', 'Brunch', 'Lunch', 'Dinner', 'Snack', 'Dessert', 'Side Dish',
  'Appetizer', 'Soup', 'Salad', 'Sandwich', 'Wrap', 'Pasta', 'Tacos',
  'Pizza', 'Burger', 'Stir Fry', 'Smoothie', 'Bowl',
  'Healthy', 'Keto', 'Low Carb', 'High Protein', 'Vegetarian', 'Vegan',
  'Gluten-Free', 'Dairy-Free', 'Paleo', 'Low Calorie', 'High Fiber',
  'Whole30', 'Mediterranean', 'Low Sodium', 'Nut-Free', 'Sugar-Free', 'Low Fat',
  'Chicken', 'Beef', 'Pork', 'Seafood', 'Fish', 'Turkey', 'Tofu', 'Eggs', 'Lamb',
  'American', 'Mexican', 'Italian', 'Asian', 'Indian', 'Thai', 'Japanese',
  'Chinese', 'Korean', 'Greek', 'French', 'Middle Eastern', 'Southern', 'Tex-Mex', 'BBQ',
  'Meal Prep', 'Budget Friendly', '5 Ingredients', 'Family Friendly', 'Date Night',
  'Comfort Food', 'Kid Friendly', 'Game Day', 'Freezer Friendly', 'Make Ahead',
  'Quick Cleanup', 'Leftovers Good',
];

interface MealFilters {
  authors: string[];
  tags: string[];
  ingredients: string[];
  difficulty: number[];
  excludeIngredients: string[];
}
const EMPTY_FILTERS: MealFilters = { authors: [], tags: [], ingredients: [], difficulty: [], excludeIngredients: [] };

function FilterPanel({ filters, onChange, onClose, authorSuggestions = [], extraTags = [], inline = false }: {
  filters: MealFilters; onChange: (f: MealFilters) => void; onClose: () => void;
  authorSuggestions?: string[]; extraTags?: string[]; inline?: boolean;
}) {
  const [tagSearch, setTagSearch] = useState('');
  const [authorInput, setAuthorInput] = useState('');
  const [showAuthorSug, setShowAuthorSug] = useState(false);
  const [ingredientInput, setIngredientInput] = useState('');
  const [excludeInput, setExcludeInput] = useState('');

  const allTags = [...new Set([...ALL_TAGS, ...extraTags])];
  const visibleTags = allTags.filter(t => !tagSearch || t.toLowerCase().includes(tagSearch.toLowerCase()));
  const sugFiltered = authorSuggestions.filter(a => authorInput.trim() && a.toLowerCase().includes(authorInput.toLowerCase()) && !filters.authors.includes(a));

  const addAuthor = () => {
    const val = authorInput.trim();
    if (val && !filters.authors.includes(val)) onChange({ ...filters, authors: [...filters.authors, val] });
    setAuthorInput(''); setShowAuthorSug(false);
  };
  const addIngredient = () => {
    const val = ingredientInput.trim().toLowerCase();
    if (val && !filters.ingredients.includes(val)) onChange({ ...filters, ingredients: [...filters.ingredients, val] });
    setIngredientInput('');
  };
  const addExclude = () => {
    const val = excludeInput.trim().toLowerCase();
    if (val && !filters.excludeIngredients.includes(val)) onChange({ ...filters, excludeIngredients: [...filters.excludeIngredients, val] });
    setExcludeInput('');
  };
  const chipStyle = {
    display: 'inline-flex' as const, alignItems: 'center' as const, gap: 4,
    padding: '2px 8px', borderRadius: 20, fontSize: 11,
    background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text-2)',
  };
  const xStyle = { background: 'none', border: 'none', color: 'var(--text-3)', cursor: 'pointer', padding: 0, fontSize: 13, lineHeight: '1' as const };
  const panelInputStyle = {
    flex: 1, padding: '6px 8px', fontSize: 12, borderRadius: 8,
    border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text-1)',
    outline: 'none',
  };
  const addBtnStyle = (enabled: boolean) => ({
    padding: '6px 10px', fontSize: 11, fontWeight: 600, borderRadius: 8,
    background: enabled ? 'var(--brand)' : 'var(--border)',
    color: enabled ? '#fff' : 'var(--text-3)',
    border: 'none', cursor: enabled ? 'pointer' : 'default',
  });

  const popupStyle = inline ? {} : { position: 'absolute' as const, right: 0, top: 'calc(100% + 6px)', zIndex: 200, boxShadow: 'var(--shadow-md)' };

  return (
    <div style={{
      width: inline ? '100%' : 310,
      background: 'var(--surface-raised)', border: inline ? 'none' : '1px solid var(--border)',
      borderRadius: inline ? 0 : 14,
      padding: inline ? 0 : 16, maxHeight: inline ? undefined : '80vh', overflowY: inline ? undefined : 'auto',
      ...popupStyle,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-1)' }}>Filters</span>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button type="button" onClick={() => onChange(EMPTY_FILTERS)} style={{ fontSize: 11, color: 'var(--brand)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>Clear all</button>
          {!inline && <button type="button" onClick={onClose} style={{ color: 'var(--text-2)', background: 'none', border: 'none', cursor: 'pointer', padding: '2px', lineHeight: 1 }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>}
        </div>
      </div>

      {/* Author */}
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-2)', marginBottom: 4 }}>Author</div>
        <div style={{ position: 'relative' }}>
          <div style={{ display: 'flex', gap: 4, marginBottom: filters.authors.length > 0 ? 6 : 0 }}>
            <input type="text" value={authorInput}
              onChange={e => { setAuthorInput(e.target.value); setShowAuthorSug(true); }}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addAuthor(); } if (e.key === 'Escape') setShowAuthorSug(false); }}
              onFocus={() => setShowAuthorSug(true)} onBlur={() => setTimeout(() => setShowAuthorSug(false), 150)}
              placeholder="Type author name…" style={panelInputStyle} />
            <button type="button" onClick={addAuthor} disabled={!authorInput.trim()} style={addBtnStyle(!!authorInput.trim())}>+ Add</button>
          </div>
          {showAuthorSug && sugFiltered.length > 0 && (
            <div style={{ position: 'absolute', left: 0, right: 44, zIndex: 10, background: 'var(--surface-raised)', border: '1px solid var(--border)', borderRadius: 8, boxShadow: 'var(--shadow-sm)', overflow: 'hidden', top: '100%', marginTop: 2 }}>
              {sugFiltered.slice(0, 5).map(a => (
                <button key={a} type="button" onMouseDown={e => { e.preventDefault(); onChange({ ...filters, authors: [...filters.authors, a] }); setAuthorInput(''); setShowAuthorSug(false); }}
                  style={{ display: 'block', width: '100%', textAlign: 'left', padding: '6px 10px', fontSize: 12, color: 'var(--text-1)', background: 'none', border: 'none', cursor: 'pointer' }}
                  onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--surface)'; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'none'; }}>
                  {a}
                </button>
              ))}
            </div>
          )}
        </div>
        {filters.authors.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {filters.authors.map(a => (
              <span key={a} style={chipStyle}>{a}
                <button type="button" onClick={() => onChange({ ...filters, authors: filters.authors.filter(x => x !== a) })} style={xStyle}>×</button>
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Tags */}
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-2)', marginBottom: 4 }}>Tags</div>
        <input type="text" value={tagSearch} onChange={e => setTagSearch(e.target.value)} placeholder="Search tags…"
          style={{ ...panelInputStyle, width: '100%', marginBottom: 6 }} />
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, maxHeight: 80, overflowY: 'auto' }}>
          {visibleTags.map(tag => {
            const sel = filters.tags.includes(tag);
            return (
              <button key={tag} type="button" onClick={() => onChange({ ...filters, tags: sel ? filters.tags.filter(t => t !== tag) : [...filters.tags, tag] })}
                style={sel
                  ? { padding: '2px 8px', borderRadius: 20, fontSize: 11, fontWeight: 600, background: 'var(--brand)', border: '1px solid var(--brand)', color: '#fff', cursor: 'pointer' }
                  : { padding: '2px 8px', borderRadius: 20, fontSize: 11, background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-2)', cursor: 'pointer' }}>
                {tag}
              </button>
            );
          })}
        </div>
      </div>

      {/* Contains Ingredient */}
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-2)', marginBottom: 4 }}>Contains Ingredient</div>
        <div style={{ display: 'flex', gap: 4, marginBottom: filters.ingredients.length > 0 ? 6 : 0 }}>
          <input type="text" value={ingredientInput} onChange={e => setIngredientInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addIngredient(); } }}
            placeholder="e.g. chicken, tomato…" style={panelInputStyle} />
          <button type="button" onClick={addIngredient} disabled={!ingredientInput.trim()} style={addBtnStyle(!!ingredientInput.trim())}>+ Add</button>
        </div>
        {filters.ingredients.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {filters.ingredients.map(ing => (
              <span key={ing} style={chipStyle}>{ing}
                <button type="button" onClick={() => onChange({ ...filters, ingredients: filters.ingredients.filter(x => x !== ing) })} style={xStyle}>×</button>
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Difficulty */}
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-2)', marginBottom: 6 }}>Difficulty</div>
        <div style={{ display: 'flex', gap: 6 }}>
          {[1, 2, 3, 4, 5].map(d => {
            const sel = filters.difficulty.includes(d);
            return (
              <button key={d} type="button" title={`Difficulty ${d}`}
                onClick={() => onChange({ ...filters, difficulty: sel ? filters.difficulty.filter(x => x !== d) : [...filters.difficulty, d] })}
                style={{ width: 30, height: 30, borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: 'pointer', background: sel ? 'var(--brand)' : 'transparent', border: `1.5px solid ${sel ? 'var(--brand)' : 'var(--border)'}`, color: sel ? '#fff' : 'var(--text-2)' }}>
                {d}
              </button>
            );
          })}
        </div>
      </div>

      {/* Exclude Ingredients */}
      <div>
        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-2)', marginBottom: 4 }}>Exclude Ingredients</div>
        <div style={{ display: 'flex', gap: 4, marginBottom: filters.excludeIngredients.length > 0 ? 6 : 0 }}>
          <input type="text" value={excludeInput} onChange={e => setExcludeInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addExclude(); } }}
            placeholder="e.g. peanuts, milk…" style={panelInputStyle} />
          <button type="button" onClick={addExclude} disabled={!excludeInput.trim()} style={addBtnStyle(!!excludeInput.trim())}>+ Add</button>
        </div>
        {filters.excludeIngredients.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {filters.excludeIngredients.map(ex => (
              <span key={ex} style={chipStyle}>{ex}
                <button type="button" onClick={() => onChange({ ...filters, excludeIngredients: filters.excludeIngredients.filter(e => e !== ex) })} style={xStyle}>×</button>
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

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
  creator_name?: string | null;
  creator_social?: string | null;
  ingredients: Ingredient[];
  source?: string | null;
  recipe?: string | null;
  story?: string | null;
  photo_url?: string | null;
  difficulty?: number | null;
  serves?: string | null;
  tags?: string[] | null;
}

interface FeaturedCreator {
  id: string;
  display_name: string;
  photo_url: string | null;
}

function FeaturedCreatorsCard({ creators, onCreatorClick }: { creators: FeaturedCreator[]; onCreatorClick: (id: string) => void }) {
  if (creators.length === 0) return null;
  return (
    <div
      className="rounded-2xl"
      style={{
        background: 'var(--surface-raised)',
        border: '1px solid var(--border)',
        padding: '10px 20px',
        height: '81px',
        overflow: 'hidden',
      }}
    >
      <p style={{ fontSize: '11px', fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-3)', marginBottom: '8px' }}>
        Featured Creators
      </p>
      <div className="flex gap-3 flex-wrap">
        {creators.map(c => {
          const initials = c.display_name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
          return (
            <button
              key={c.id}
              onClick={() => onCreatorClick(c.id)}
              title={c.display_name}
              style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
            >
              {c.photo_url ? (
                <img
                  src={c.photo_url}
                  alt={c.display_name}
                  style={{ width: 38, height: 38, borderRadius: '50%', objectFit: 'cover', border: '2px solid var(--border)' }}
                />
              ) : (
                <div style={{ width: 38, height: 38, borderRadius: '50%', background: 'var(--brand)', display: 'flex', alignItems: 'center', justifyContent: 'center', border: '2px solid var(--border)' }}>
                  <span style={{ fontSize: '12px', fontWeight: 700, color: '#fff' }}>{initials}</span>
                </div>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function TrendingCarousel({ meals, onMealClick }: { meals: PresetMeal[]; onMealClick: (meal: PresetMeal) => void }) {
  const withPhotos = useMemo(() => {
    const filtered = meals.filter(m => m.photo_url);
    // Fisher-Yates shuffle (seeded by length so it's stable between renders)
    const arr = [...filtered];
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meals.length]);

  if (withPhotos.length < 3) return null;

  // Duplicate for seamless loop
  const items = [...withPhotos, ...withPhotos];

  return (
    <div
      className="carousel-outer"
      style={{
        overflow: 'hidden',
        marginBottom: '40px',
        position: 'relative',
        left: '50%',
        right: '50%',
        marginLeft: '-50vw',
        marginRight: '-50vw',
        width: '100vw',
        maskImage: 'linear-gradient(to right, transparent 0%, black 4%, black 96%, transparent 100%)',
        WebkitMaskImage: 'linear-gradient(to right, transparent 0%, black 4%, black 96%, transparent 100%)',
      }}
    >
      <style>{`
        @keyframes scroll-carousel {
          0%   { transform: translateX(0); }
          100% { transform: translateX(-50%); }
        }
        .carousel-track {
          display: flex;
          gap: 12px;
          width: max-content;
          animation: scroll-carousel ${Math.max(withPhotos.length * 3.5, 28)}s linear infinite;
          will-change: transform;
        }
        .carousel-outer:hover .carousel-track {
          animation-play-state: paused;
        }
      `}</style>
      <div className="carousel-track">
        {items.map((meal, i) => (
          <button
            key={`${meal.id}-${i}`}
            onClick={() => onMealClick(meal)}
            style={{
              position: 'relative',
              width: '136px',
              height: '136px',
              borderRadius: '14px',
              overflow: 'hidden',
              flexShrink: 0,
              boxShadow: '0 2px 8px rgba(0,0,0,0.12)',
              border: 'none',
              padding: 0,
              cursor: 'pointer',
              display: 'block',
            }}
          >
            <img
              src={meal.photo_url!}
              alt={meal.name}
              style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
              loading="lazy"
            />
            <div
              style={{
                position: 'absolute',
                inset: 0,
                background: 'linear-gradient(to top, rgba(0,0,0,0.55) 0%, transparent 55%)',
                pointerEvents: 'none',
              }}
            />
            <p
              style={{
                position: 'absolute',
                bottom: '8px',
                left: '8px',
                right: '8px',
                margin: 0,
                fontSize: '11px',
                fontWeight: 600,
                color: '#fff',
                lineHeight: 1.3,
                textShadow: '0 1px 3px rgba(0,0,0,0.4)',
                overflow: 'hidden',
                display: '-webkit-box',
                WebkitLineClamp: 2,
                WebkitBoxOrient: 'vertical',
                pointerEvents: 'none',
              } as React.CSSProperties}
            >
              {meal.name}
            </p>
          </button>
        ))}
      </div>
    </div>
  );
}

function DifficultyDots({ level }: { level: number }) {
  return (
    <span className="flex gap-1 items-center">
      {[1, 2, 3, 4, 5].map(i => (
        <span key={i} style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', background: i <= level ? 'var(--brand)' : 'var(--border)' }} />
      ))}
    </span>
  );
}

// ── Store Modal ───────────────────────────────────────────────────────────────

interface StoreModalProps {
  meal: PresetMeal;
  onSave: (storeId: string) => Promise<void>;
  onClose: () => void;
  saving: boolean;
  error: string;
  recentStores: string[];
}

function StoreModal({ meal, onSave, onClose, saving, error, recentStores }: StoreModalProps) {
  const [selectedStore, setSelectedStore] = useState('');
  const dragRef = useRef(false);
  const recentStoreObjects = recentStores.map(id => STORES.find(s => s.id === id)).filter(Boolean) as typeof STORES;
  const otherStores = STORES.filter(s => !recentStores.includes(s.id));

  return (
    <div
      className="fixed inset-0 flex items-center justify-center z-50 p-4"
      style={{ background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(4px)' }}
      onMouseDown={e => { dragRef.current = e.target !== e.currentTarget; }}
      onClick={e => { if (e.target !== e.currentTarget || dragRef.current) return; onClose(); }}
    >
      <div className="rounded-2xl w-full max-w-sm" style={{ background: 'var(--surface-raised)', boxShadow: 'var(--shadow-md)', border: '1px solid var(--border)' }}>
        <div className="flex items-center justify-between px-5 py-4" style={{ borderBottom: '1px solid var(--border)' }}>
          <h2 className="text-sm font-bold" style={{ color: 'var(--text-1)' }}>Save to My Meals</h2>
          <button
            onClick={onClose}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-3)', padding: '2px' }}
            onMouseEnter={e => (e.currentTarget as HTMLElement).style.color = 'var(--text-1)'}
            onMouseLeave={e => (e.currentTarget as HTMLElement).style.color = 'var(--text-3)'}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
        <div className="px-5 py-4 space-y-4">
          <p className="text-sm" style={{ color: 'var(--text-2)' }}>
            Adding <strong style={{ color: 'var(--text-1)' }}>{meal.name}</strong>. Which store are you shopping at?
          </p>
          <div>
            <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--text-2)' }}>Store</label>
            <select
              value={selectedStore}
              onChange={e => setSelectedStore(e.target.value)}
              className="w-full rounded-xl px-3 py-2 text-sm focus:outline-none"
              style={{ border: '1.5px solid var(--border)', background: 'var(--surface)', color: 'var(--text-1)' }}
            >
              <option value="">Select a store…</option>
              {recentStoreObjects.length > 0 && (
                <optgroup label="Recent">
                  {recentStoreObjects.map(s => (
                    <option key={s.id} value={s.id}>{s.label}</option>
                  ))}
                </optgroup>
              )}
              <optgroup label={recentStoreObjects.length > 0 ? 'All Stores' : ''}>
                {otherStores.map(s => (
                  <option key={s.id} value={s.id}>{s.label}</option>
                ))}
              </optgroup>
            </select>
          </div>
          {error && <p className="text-xs" style={{ color: 'var(--brand)' }}>{error}</p>}
          <button
            onClick={() => onSave(selectedStore)}
            disabled={!selectedStore || saving}
            className="w-full text-white text-sm font-semibold rounded-xl py-2.5 disabled:opacity-50 transition-colors"
            style={{ background: 'var(--brand)', border: 'none', cursor: 'pointer' }}
            onMouseEnter={e => { if (!saving && selectedStore) (e.currentTarget as HTMLElement).style.background = 'var(--brand-dark)'; }}
            onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = 'var(--brand)'}
          >
            {saving ? 'Saving…' : 'Save to My Meals'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Meal Detail Modal ─────────────────────────────────────────────────────────

function MealDetailModal({
  meal, savedStores, onAdd, onClose, onCreatorClick,
}: {
  meal: PresetMeal; savedStores?: string[]; onAdd: () => void; onClose: () => void; onCreatorClick?: (id: string) => void;
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
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:p-4"
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
            {authorName && (
              meal.creator_id && onCreatorClick ? (
                <button
                  className="text-xs mt-0.5 text-left hover:underline font-medium"
                  style={{ color: 'var(--brand)', background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
                  onClick={e => { e.stopPropagation(); onClose(); onCreatorClick(meal.creator_id!); }}
                >
                  by {authorName}
                </button>
              ) : (
                <p className="text-xs mt-0.5 font-medium" style={{ color: 'var(--brand)' }}>by {authorName}</p>
              )
            )}
          </div>
          <button
            onClick={onClose}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-3)', padding: '2px', flexShrink: 0 }}
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
          {meal.photo_url ? (
            <div style={{ position: 'relative' }}>
              <img src={meal.photo_url} alt={meal.name} className="w-full rounded-xl object-cover" style={{ maxHeight: '220px' }} />
              {meal.tags && meal.tags.length > 0 && (
                <div style={{ position: 'absolute', top: 8, right: 8, display: 'flex', gap: 4, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                  {meal.tags.slice(0, 3).map(tag => (
                    <span key={tag} className="text-xs px-2.5 py-1 rounded-full font-medium"
                      style={{ background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(4px)', color: '#fff', border: 'none' }}>
                      {tag}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ) : meal.tags && meal.tags.length > 0 ? (
            <div className="flex items-center gap-1.5 flex-wrap">
              {meal.tags.slice(0, 3).map(tag => (
                <span key={tag} className="text-xs px-2.5 py-1 rounded-full font-medium"
                  style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text-2)' }}>
                  {tag}
                </span>
              ))}
            </div>
          ) : null}

          <div className="flex items-center gap-4 flex-wrap">
            {meal.difficulty != null && (
              <div className="flex items-center gap-2">
                <span className="text-xs" style={{ color: 'var(--text-3)' }}>Difficulty</span>
                <DifficultyDots level={meal.difficulty} />
              </div>
            )}
            {meal.serves && (
              <span className="text-xs flex items-center gap-0.5" style={{ color: 'var(--text-3)' }}>
                <svg width="12" height="12" viewBox="0 0 24 20" fill="currentColor">
                  <circle cx="12" cy="6" r="5"/>
                  <path d="M1 20c0-5 5-8 11-8s11 3 11 8z"/>
                </svg>
                {meal.serves}
              </span>
            )}
            {sourceHost && (
              <a href={meal.source!} target="_blank" rel="noopener noreferrer"
                className="text-xs flex items-center gap-1 hover:underline" style={{ color: 'var(--text-3)' }}>
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
                </svg>
                {sourceHost}
              </a>
            )}
          </div>

          {meal.story && (
            <p className="text-sm italic whitespace-pre-wrap leading-relaxed" style={{ color: 'var(--text-2)' }}>{meal.story}</p>
          )}

          <div>
            <p className="text-xs font-semibold uppercase tracking-widest mb-3" style={{ color: 'var(--text-3)', letterSpacing: '0.08em' }}>Ingredients</p>
            <ul className="space-y-1.5">
              {meal.ingredients.map((ing, i) => (
                <li key={i} className="flex items-center justify-between gap-4 py-2" style={{ borderBottom: '1px solid var(--border)' }}>
                  <span className="text-sm" style={{ color: 'var(--text-1)' }}>{(ing as any).productName ?? (ing as any).product_name ?? (ing as any).name ?? ''}</span>
                  <span className="text-xs font-medium flex-shrink-0" style={{ color: 'var(--text-3)', fontFamily: 'var(--font-mono, monospace)' }}>×{ing.quantity ?? 1}</span>
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
        <div className="p-4" style={{ borderTop: '1px solid var(--border)' }}>
          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={() => { onAdd(); onClose(); }}
              className="px-4 py-2 text-sm font-semibold rounded-xl transition-colors"
              style={{ background: 'var(--brand)', border: 'none', color: '#fff', cursor: 'pointer' }}
              onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = 'var(--brand-dark)'}
              onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = 'var(--brand)'}
            >
              Save to My Meals
            </button>
            {savedStores && savedStores.length > 0 && (
              <span className="text-xs" style={{ color: 'var(--text-3)' }}>Saved at {savedStores.join(', ')}</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Meal Card ─────────────────────────────────────────────────────────────────

function MealCard({
  meal, savedStores, onAdd, onCreatorClick,
}: {
  meal: PresetMeal;
  savedStores?: string[];
  onAdd: () => void;
  onCreatorClick?: (id: string) => void;
}) {
  const [detailOpen, setDetailOpen] = useState(false);
  const sourceHost = meal.source ? (() => {
    try { return new URL(meal.source!).hostname.replace('www.', ''); } catch { return meal.source; }
  })() : null;
  const authorName = meal.creator_name
    ? (meal.creator_social || meal.creator_name)
    : meal.author ?? null;

  return (
    <>
      {detailOpen && (
        <MealDetailModal
          meal={meal}
          savedStores={savedStores}
          onAdd={onAdd}
          onClose={() => setDetailOpen(false)}
          onCreatorClick={onCreatorClick}
        />
      )}

      <div
        className="flex items-start gap-4 p-4 rounded-2xl cursor-pointer transition-all"
        style={{ background: 'var(--surface-raised)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-sm)' }}
        onClick={() => setDetailOpen(true)}
        onMouseEnter={e => (e.currentTarget as HTMLElement).style.boxShadow = 'var(--shadow-md)'}
        onMouseLeave={e => (e.currentTarget as HTMLElement).style.boxShadow = 'var(--shadow-sm)'}
      >
        <div className="hidden sm:block flex-shrink-0">
          {meal.photo_url ? (
            <img
              src={meal.photo_url}
              alt={meal.name}
              className="object-cover rounded-xl"
              style={{ width: '120px', height: '120px', border: '1px solid var(--border)' }}
            />
          ) : (
            <div className="rounded-xl flex items-center justify-center" style={{ width: '120px', height: '120px', background: 'var(--surface)', border: '1px solid var(--border)' }}>
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--border-strong)' }}>
                <path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2"/><path d="M7 2v20"/><path d="M21 15V2v0a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7"/>
              </svg>
            </div>
          )}
        </div>

        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold" style={{ color: 'var(--text-1)' }}>{meal.name}</p>

          {(authorName || sourceHost) && (
            <div className="flex items-center gap-2 mt-0.5 flex-wrap">
              {authorName && (
                meal.creator_id && onCreatorClick ? (
                  <button
                    className="text-xs text-left hover:underline font-medium"
                    style={{ color: 'var(--brand)', background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
                    onClick={e => { e.stopPropagation(); onCreatorClick(meal.creator_id!); }}
                  >
                    by {authorName}
                  </button>
                ) : (
                  <span className="text-xs font-medium" style={{ color: 'var(--brand)' }}>by {authorName}</span>
                )
              )}
              {authorName && sourceHost && <span className="text-xs" style={{ color: 'var(--text-3)' }}>·</span>}
              {sourceHost && (
                <a
                  href={meal.source!}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs hover:underline"
                  style={{ color: 'var(--text-3)' }}
                  onClick={e => e.stopPropagation()}
                >
                  {sourceHost}
                </a>
              )}
            </div>
          )}

          {meal.difficulty != null && (
            <div className="flex items-center gap-2 mt-1.5">
              <span className="text-xs" style={{ color: 'var(--text-3)' }}>Difficulty</span>
              <DifficultyDots level={meal.difficulty} />
            </div>
          )}

          {meal.tags && meal.tags.length > 0 && (
            <div className="flex items-center gap-1 flex-wrap mt-1.5">
              {meal.tags.slice(0, 3).map(tag => (
                <span key={tag} className="text-xs px-2 py-0.5 rounded-full font-medium"
                  style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text-2)' }}>
                  {tag}
                </span>
              ))}
            </div>
          )}


          <div className="mt-3 flex items-center gap-2 flex-wrap">
            <button
              onClick={e => { e.stopPropagation(); onAdd(); }}
              className="px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors"
              style={{ background: 'var(--brand)', border: 'none', color: '#fff', cursor: 'pointer' }}
              onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = 'var(--brand-dark)'}
              onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = 'var(--brand)'}
            >
              + Save to My Meals
            </button>
            {savedStores && savedStores.length > 0 && (
              <span className="text-xs" style={{ color: 'var(--text-3)' }}>
                Saved at {savedStores.join(', ')}
              </span>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

// ── Dashboard ─────────────────────────────────────────────────────────────────

const CHROME_EXT_URL  = 'https://chromewebstore.google.com/detail/mealio/eccnnnhkdpigfgbmnnmhppmligjhfpne';
const FIREFOX_EXT_URL = 'https://addons.mozilla.org/en-US/firefox/addon/mealio/';

function getInitials(name: string) {
  return name.split(' ').slice(0, 2).map(w => w[0]).join('').toUpperCase();
}

export default function DiscoverPage() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [isCreator, setIsCreator] = useState(false);
  const [isFirefox, setIsFirefox] = useState(false);

  useEffect(() => {
    setIsFirefox(navigator.userAgent.includes('Firefox'));
  }, []);

  const [token, setToken] = useState('');
  const [section, setSection] = useState<'trending' | 'new' | 'following'>('trending');
  const [creatorPopupId, setCreatorPopupId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState<MealFilters>(EMPTY_FILTERS);
  const [filterOpen, setFilterOpen] = useState(false);
  const filterBtnRef = useRef<HTMLDivElement>(null);
  const [meals, setMeals] = useState<PresetMeal[]>([]);
  const [hasMore, setHasMore] = useState(true);
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState('');
  const offsetRef = useRef(0);
  const sectionRef = useRef<'trending' | 'new' | 'following'>(section);
  const [addingMeal, setAddingMeal] = useState<PresetMeal | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [savedMealStores, setSavedMealStores] = useState<Map<string, string[]>>(new Map());
  const [recentStores, setRecentStores] = useState<string[]>([]);

  useEffect(() => {
    try {
      const stored = localStorage.getItem('mealio_recent_stores');
      if (stored) setRecentStores(JSON.parse(stored));
    } catch { /* ignore */ }
  }, []);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const fetchingRef = useRef(false);
  const fetchGenRef = useRef(0);

  const [followedCreators, setFollowedCreators] = useState<{ id: string; display_name: string; photo_url?: string | null }[]>([]);
  const [selectedCreatorIds, setSelectedCreatorIds] = useState<Set<string>>(new Set());
  const [carouselMeal, setCarouselMeal] = useState<PresetMeal | null>(null);
  const [featuredCreators, setFeaturedCreators] = useState<FeaturedCreator[]>([]);

  useEffect(() => { verifyAuth(); }, []);

  useEffect(() => {
    if (!filterOpen) return;
    const handle = (e: MouseEvent) => {
      if (filterBtnRef.current && !filterBtnRef.current.contains(e.target as Node)) setFilterOpen(false);
    };
    document.addEventListener('mousedown', handle, true);
    return () => document.removeEventListener('mousedown', handle, true);
  }, [filterOpen]);

  const verifyAuth = async () => {
    try {
      const accessToken = localStorage.getItem('accessToken');
      if (!accessToken) { router.push('/'); return; }

      const response = await fetch('/api/auth/verify', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (!response.ok) { localStorage.clear(); router.push('/'); return; }

      const data = await response.json();
      setUser(data.user);
      setToken(accessToken);

      fetch('/api/creator/me', { headers: { Authorization: `Bearer ${accessToken}` } })
        .then(r => r.ok ? r.json() : null)
        .then(d => { if (d?.creator) setIsCreator(true); })
        .catch(() => {});

      fetch('/api/meals', {
        headers: { Authorization: `Bearer ${accessToken}` },
      }).then(r => r.ok ? r.json() : null).then(d => {
        if (!d?.meals) return;
const map = new Map<string, string[]>();
        for (const m of d.meals) {
          if (!m.preset_meal_id) continue;
          const storeLabel = STORES.find(s => s.id === m.store_id)?.label ?? m.store_id;
          const existing = map.get(m.preset_meal_id) ?? [];
          map.set(m.preset_meal_id, [...existing, storeLabel]);
        }
        setSavedMealStores(map);
      }).catch(() => {});

      fetch('/api/creators/featured')
        .then(r => r.ok ? r.json() : { creators: [] })
        .then(d => setFeaturedCreators(d.creators ?? []))
        .catch(() => {});

      setLoading(false);
    } catch {
      localStorage.clear();
      router.push('/');
    }
  };

  const fetchMeals = useCallback(async (reset: boolean, currentSection: 'trending' | 'new' | 'following', currentToken: string) => {
    if (!reset && fetchingRef.current) return;
    fetchingRef.current = true;
    setFetching(true);
    const gen = fetchGenRef.current;
    if (reset) setFetchError('');
    const offset = reset ? 0 : offsetRef.current;
    try {
      let query = '';
      if (currentSection === 'new') query = '&sort=new';
      else if (currentSection === 'following') query = '&followed=true';
      const res = await fetch(`/api/preset-meals?limit=${PAGE_SIZE}&offset=${offset}${query}`, {
        headers: { Authorization: `Bearer ${currentToken}` },
      });
      if (!res.ok) throw new Error('Failed to load');
      const data = await res.json();
      const fetched: PresetMeal[] = data.presetMeals ?? [];
      if (fetchGenRef.current !== gen) return; // section changed while fetching — discard
      setMeals(prev => reset ? fetched : [...prev, ...fetched]);
      setHasMore(data.hasMore ?? false);
      offsetRef.current = offset + fetched.length;
    } catch {
      if (fetchGenRef.current === gen) setFetchError('Failed to load recipes. Please try again.');
    } finally {
      if (fetchGenRef.current === gen) {
        fetchingRef.current = false;
        setFetching(false);
      }
    }
  }, []);

  useEffect(() => {
    if (!token) return;
    fetchGenRef.current += 1;   // invalidate any in-progress fetch
    fetchingRef.current = false; // allow the reset fetch to proceed immediately
    sectionRef.current = section;
    offsetRef.current = 0;
    setMeals([]);
    setHasMore(true);
    fetchMeals(true, section, token);
    if (section === 'following') {
      setSelectedCreatorIds(new Set());
      fetch('/api/creators/following', { headers: { Authorization: `Bearer ${token}` } })
        .then(r => r.ok ? r.json() : { creators: [] })
        .then(d => setFollowedCreators(d.creators ?? []))
        .catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section, token]);

  useEffect(() => {
    if (!sentinelRef.current || !hasMore || fetching) return;
    const observer = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting && !fetchingRef.current) {
        fetchMeals(false, sectionRef.current, token);
      }
    }, { threshold: 0.1 });
    observer.observe(sentinelRef.current);
    return () => observer.disconnect();
  }, [hasMore, fetching, fetchMeals, token]);

  const q = search.trim().toLowerCase();
  const activeFilterCount = [filters.authors.length > 0, filters.tags.length > 0, filters.ingredients.length > 0, filters.difficulty.length > 0, filters.excludeIngredients.length > 0].filter(Boolean).length;
  const customMealTags = [...new Set(meals.flatMap(m => m.tags || []).filter(t => !ALL_TAGS.includes(t)))];
  const authorSuggestions = [...new Set(meals.flatMap(m => [m.author, m.creator_name]).filter((a): a is string => Boolean(a)))];
  const ingName = (i: any) => ((i.productName ?? i.product_name ?? i.name ?? '') as string).toLowerCase();
  const matchesMeal = (m: PresetMeal) => {
    if (q && !(m.name.toLowerCase().includes(q) || m.author?.toLowerCase().includes(q) || m.creator_name?.toLowerCase().includes(q) || m.source?.toLowerCase().includes(q))) return false;
    if (filters.authors.length > 0 && !filters.authors.some(a => m.author?.toLowerCase().includes(a.toLowerCase()) || m.creator_name?.toLowerCase().includes(a.toLowerCase()))) return false;
    if (filters.tags.length > 0 && !filters.tags.some(t => m.tags?.includes(t))) return false;
    if (filters.ingredients.length > 0 && !filters.ingredients.every(ing => m.ingredients?.some(i => ingName(i).includes(ing)))) return false;
    if (filters.difficulty.length > 0 && !filters.difficulty.includes(m.difficulty ?? -1)) return false;
    if (filters.excludeIngredients.length > 0 && filters.excludeIngredients.some(ex => m.ingredients?.some(i => ingName(i).includes(ex)))) return false;
    return true;
  };
  const creatorFiltered = (m: PresetMeal) =>
    section !== 'following' || selectedCreatorIds.size === 0 || (!!m.creator_id && selectedCreatorIds.has(m.creator_id));
  const unsaved = meals.filter(m => !savedMealStores.has(m.id) && matchesMeal(m) && creatorFiltered(m));
  const saved   = meals.filter(m =>  savedMealStores.has(m.id) && matchesMeal(m) && creatorFiltered(m));
  const visible = [...unsaved, ...saved];

  const handleSave = async (storeId: string) => {
    if (!addingMeal || !storeId) return;
    setSaving(true);
    setSaveError('');
    try {
      const res = await fetch('/api/meals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          name:         addingMeal.name,
          storeId,
          ingredients:  addingMeal.ingredients,
          presetMealId: addingMeal.id,
          ...(addingMeal.author       ? { author:     addingMeal.author     } : {}),
          ...(addingMeal.difficulty   ? { difficulty: addingMeal.difficulty } : {}),
          ...(addingMeal.tags?.length ? { tags:       addingMeal.tags       } : {}),
          ...(addingMeal.source       ? { website:    addingMeal.source     } : {}),
          ...(addingMeal.story        ? { story:      addingMeal.story      } : {}),
          ...(addingMeal.recipe       ? { recipe:     addingMeal.recipe     } : {}),
          ...(addingMeal.photo_url    ? { photoUrl:   addingMeal.photo_url  } : {}),
          ...(addingMeal.creator_id   ? { creatorId:  addingMeal.creator_id } : {}),
          ...(addingMeal.serves       ? { serves:     addingMeal.serves     } : {}),
        }),
      });
      if (!res.ok) {
        const data = await res.json();
        setSaveError(data.error || 'Failed to save.');
        return;
      }
      fetch(`/api/preset-meals/${addingMeal.id}/save`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      }).catch(() => {});
      const storeLabel = STORES.find(s => s.id === storeId)?.label ?? storeId;
      setSavedMealStores(prev => {
        const next = new Map(prev);
        next.set(addingMeal.id, [...(next.get(addingMeal.id) ?? []), storeLabel]);
        return next;
      });
      setRecentStores(prev => {
        const updated = [storeId, ...prev.filter(id => id !== storeId)].slice(0, 3);
        try { localStorage.setItem('mealio_recent_stores', JSON.stringify(updated)); } catch { /* ignore */ }
        return updated;
      });
      setAddingMeal(null);
    } catch {
      setSaveError('Something went wrong. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--bg)' }}>
        <div className="w-8 h-8 rounded-full animate-spin" style={{ border: '2px solid var(--border)', borderTopColor: 'var(--brand)' }} />
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col" style={{ background: 'var(--bg)' }}>

      <AppHeader />

      {/* Upgrade nudge */}
      {user && user.tier !== 'paid' && (
        <div className="w-full py-2.5 px-4 text-center text-sm" style={{ background: 'var(--brand-light)', borderBottom: '1px solid var(--brand-border)', color: 'var(--brand)' }}>
          <span className="font-medium">Free plan: </span>limited to 3 saved meals.{' '}
          <a href="/pricing" className="underline font-semibold hover:opacity-80 transition-opacity">Upgrade to Full Access →</a>
        </div>
      )}

      <div className="max-w-7xl mx-auto px-6 py-10 w-full flex-1">

        {/* Discover Section */}
        <div className="mb-10">
          <TrendingCarousel meals={meals} onMealClick={setCarouselMeal} />

          {isCreator && (
            <div className="flex items-center justify-between gap-4 mt-4 px-4 py-3 rounded-xl" style={{ background: 'var(--surface-raised)', border: '1px solid var(--border)' }}>
              <p className="text-sm" style={{ color: 'var(--text-2)' }}>
                You&apos;re a Mealio Creator — manage your meals and track your stats in the Creator Portal.
              </p>
              <a
                href="/creator"
                className="text-xs font-semibold whitespace-nowrap px-3 py-1.5 rounded-lg transition-opacity hover:opacity-80"
                style={{ background: 'var(--brand)', color: '#fff' }}
              >
                Go to Portal →
              </a>
            </div>
          )}


          <div className="lg:flex lg:gap-8 lg:items-start">

            {/* Desktop sidebar */}
            <aside className="hidden lg:block w-64 flex-shrink-0 sticky top-6">
              <div className="rounded-xl overflow-hidden" style={{ border: '1px solid var(--border)', background: 'var(--surface-raised)', boxShadow: 'var(--shadow-sm)' }}>
                {/* Section tabs - vertical */}
                <div className="p-3 border-b" style={{ borderColor: 'var(--border)' }}>
                  <p className="text-xs font-semibold uppercase tracking-wide mb-2" style={{ color: 'var(--text-3)' }}>Browse</p>
                  <div className="flex flex-col gap-0.5">
                    {(['trending', 'new', 'following'] as const).map(s => (
                      <button
                        key={s}
                        onClick={() => { if (s !== section) { setSection(s); setSearch(''); } }}
                        className="w-full text-left px-3 py-2 text-sm font-semibold rounded-lg transition-all"
                        style={section === s
                          ? { background: 'var(--brand-light)', color: 'var(--brand)', border: 'none', cursor: 'pointer' }
                          : { background: 'transparent', color: 'var(--text-2)', border: 'none', cursor: 'pointer' }}
                      >
                        {s === 'trending' ? 'Trending' : s === 'new' ? 'New' : 'Following'}
                      </button>
                    ))}
                  </div>
                </div>
                {/* Filters inline */}
                <div className="p-3">
                  <FilterPanel filters={filters} onChange={setFilters} onClose={() => {}} authorSuggestions={authorSuggestions} extraTags={customMealTags} inline />
                </div>
              </div>
            </aside>

            {/* Main content */}
            <div className="flex-1 min-w-0">

          {/* Controls (mobile: tabs + filter; desktop: search only) */}
          <div className="flex flex-col sm:flex-row gap-3 mb-6">
            {/* Section tabs — hidden on desktop (moved to sidebar) */}
            <div className="lg:hidden flex gap-1 p-1 rounded-xl self-start" style={{ background: 'var(--surface)' }}>
              {(['trending', 'new', 'following'] as const).map(s => (
                <button
                  key={s}
                  onClick={() => { if (s !== section) { setSection(s); setSearch(''); } }}
                  className="px-4 py-1.5 text-sm font-semibold rounded-lg transition-all"
                  style={section === s
                    ? { background: 'var(--surface-raised)', color: 'var(--text-1)', boxShadow: 'var(--shadow-sm)', border: 'none', cursor: 'pointer' }
                    : { background: 'transparent', color: 'var(--text-2)', border: 'none', cursor: 'pointer' }}
                >
                  {s === 'trending' ? 'Trending' : s === 'new' ? 'New' : 'Following'}
                </button>
              ))}
            </div>

            {/* Search */}
            <div className="flex-1 relative">
              <svg className="absolute left-3 top-1/2 -translate-y-1/2" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--text-3)' }}>
                <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
              </svg>
              <input
                type="text"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search recipes, creators…"
                className="w-full pl-9 pr-4 py-2 text-sm rounded-xl focus:outline-none"
                style={{ border: '1.5px solid var(--border)', background: 'var(--surface-raised)', color: 'var(--text-1)' }}
                onFocus={e => (e.target.style.borderColor = 'var(--brand)')}
                onBlur={e => (e.target.style.borderColor = 'var(--border)')}
              />
            </div>

            {/* Filter button + My Meals — hidden on desktop (moved to sidebar) */}
            <div className="lg:hidden flex items-center" style={{ gap: 8 }}>
              <div ref={filterBtnRef} style={{ position: 'relative', flexShrink: 0 }}>
                <button
                  type="button"
                  onClick={() => setFilterOpen(v => !v)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 5, padding: '7px 12px', borderRadius: 10,
                    fontSize: 13, fontWeight: 600,
                    border: `1.5px solid ${(filterOpen || activeFilterCount > 0) ? 'var(--brand)' : 'var(--border)'}`,
                    background: (filterOpen || activeFilterCount > 0) ? 'var(--brand)' : 'var(--surface-raised)',
                    color: (filterOpen || activeFilterCount > 0) ? '#fff' : 'var(--text-2)',
                    cursor: 'pointer', whiteSpace: 'nowrap',
                  }}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>
                  </svg>
                  Filter{activeFilterCount > 0 ? ` (${activeFilterCount})` : ''}
                </button>
                {filterOpen && <FilterPanel filters={filters} onChange={setFilters} onClose={() => setFilterOpen(false)} authorSuggestions={authorSuggestions} extraTags={customMealTags} />}
              </div>
              <a
                href="/my-meals"
                className="sm:hidden flex items-center gap-1.5 text-sm font-semibold rounded-xl px-4 py-2"
                style={{ background: 'var(--brand)', color: '#fff', textDecoration: 'none', marginLeft: 'auto' }}
                onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = 'var(--brand-dark)'}
                onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = 'var(--brand)'}
              >
                My Meals
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 12h14M12 5l7 7-7 7"/>
                </svg>
              </a>
            </div>
          </div>

          {/* Creator carousel — Following tab only */}
          {section === 'following' && followedCreators.length > 0 && (
            <div className="flex gap-3 overflow-x-auto pb-2 mb-5" style={{ scrollbarWidth: 'none', overflowY: 'clip' }}>
              {followedCreators.map(creator => {
                const allSelected = selectedCreatorIds.size === 0;
                const isSelected = allSelected || selectedCreatorIds.has(creator.id);
                return (
                  <button
                    key={creator.id}
                    onClick={() => {
                      const clickedId = creator.id;
                      setSelectedCreatorIds(prev => {
                        const prevAllSelected = prev.size === 0;
                        const next = new Set(prev);
                        if (prevAllSelected) return new Set([clickedId]);
                        if (next.has(clickedId)) {
                          next.delete(clickedId);
                          return next.size === 0 ? new Set() : next;
                        } else {
                          next.add(clickedId);
                          return next;
                        }
                      });
                    }}
                    className="flex-shrink-0 transition-opacity"
                    style={{ background: 'none', border: 'none', cursor: 'pointer', opacity: isSelected ? 1 : 0.4, padding: 0 }}
                  >
                    <div
                      className="w-12 h-12 rounded-full overflow-hidden flex-shrink-0 flex items-center justify-center"
                      style={{ background: 'var(--surface)' }}
                    >
                      {creator.photo_url
                        ? <img src={creator.photo_url} alt={creator.display_name} className="w-full h-full object-cover" />
                        : <span className="text-sm font-bold" style={{ color: 'var(--text-3)' }}>{getInitials(creator.display_name)}</span>}
                    </div>
                  </button>
                );
              })}
            </div>
          )}

          {/* Meal list */}
          {fetchError ? (
            <div className="text-center py-16">
              <p className="text-sm mb-3" style={{ color: 'var(--text-3)' }}>{fetchError}</p>
              <button onClick={() => fetchMeals(true, section, token)} className="text-sm font-medium" style={{ color: 'var(--brand)', background: 'none', border: 'none', cursor: 'pointer' }}>
                Try again
              </button>
            </div>
          ) : visible.length === 0 && !fetching ? (
            <div className="text-center py-16">
              <p className="text-sm" style={{ color: 'var(--text-3)' }}>
                {section === 'following' && meals.length === 0
                  ? 'Follow creators to see their meals here.'
                  : (q || activeFilterCount > 0 || selectedCreatorIds.size > 0)
                    ? 'No recipes match your filters.'
                    : 'No recipes available.'}
              </p>
            </div>
          ) : (
            <>
              {/* Mobile: single column */}
              <div className="flex flex-col gap-3 sm:hidden">
                {visible.map(meal => (
                  <div key={meal.id}>
                    <MealCard
                      meal={meal}
                      savedStores={savedMealStores.get(meal.id)}
                      onAdd={() => { setSaveError(''); setAddingMeal(meal); }}
                      onCreatorClick={id => setCreatorPopupId(id)}
                    />
                  </div>
                ))}
              </div>
              {/* Desktop: two explicit columns — avoids CSS columns stacking/click bugs */}
              <div className="hidden sm:flex gap-3 items-start">
                <div className="flex-1 flex flex-col gap-3">
                  <FeaturedCreatorsCard creators={featuredCreators} onCreatorClick={id => setCreatorPopupId(id)} />
                  {visible.filter((_, i) => i % 2 === 0).map(meal => (
                    <div key={meal.id}>
                      <MealCard
                        meal={meal}
                        savedStores={savedMealStores.get(meal.id)}
                        onAdd={() => { setSaveError(''); setAddingMeal(meal); }}
                        onCreatorClick={id => setCreatorPopupId(id)}
                      />
                    </div>
                  ))}
                </div>
                <div className="flex-1 flex flex-col gap-3">
                  {visible.filter((_, i) => i % 2 !== 0).map(meal => (
                    <div key={meal.id}>
                      <MealCard
                        meal={meal}
                        savedStores={savedMealStores.get(meal.id)}
                        onAdd={() => { setSaveError(''); setAddingMeal(meal); }}
                        onCreatorClick={id => setCreatorPopupId(id)}
                      />
                    </div>
                  ))}
                </div>
              </div>

              <div ref={sentinelRef} className="py-4 text-center">
                {fetching && (
                  <div className="inline-block w-6 h-6 rounded-full animate-spin" style={{ border: '2px solid var(--border)', borderTopColor: 'var(--brand)' }} />
                )}
                {!fetching && !hasMore && meals.length > 0 && (
                  <p className="text-xs" style={{ color: 'var(--text-3)' }}>You&apos;ve seen all recipes.</p>
                )}
              </div>
            </>
          )}

          {fetching && meals.length === 0 && (
            <div className="flex justify-center py-16">
              <div className="w-8 h-8 rounded-full animate-spin" style={{ border: '3px solid var(--border)', borderTopColor: 'var(--brand)' }} />
            </div>
          )}

            </div>{/* end flex-1 main content */}
          </div>{/* end lg:flex */}
        </div>

      </div>

      <AppFooter />

      {addingMeal && (
        <StoreModal
          meal={addingMeal}
          onSave={handleSave}
          onClose={() => setAddingMeal(null)}
          saving={saving}
          error={saveError}
          recentStores={recentStores}
        />
      )}

      {carouselMeal && (
        <MealDetailModal
          meal={carouselMeal}
          savedStores={savedMealStores.get(carouselMeal.id)}
          onAdd={() => { setSaveError(''); setAddingMeal(carouselMeal); setCarouselMeal(null); }}
          onClose={() => setCarouselMeal(null)}
          onCreatorClick={id => { setCarouselMeal(null); setCreatorPopupId(id); }}
        />
      )}

      {creatorPopupId && token && (
        <CreatorPopup
          creatorId={creatorPopupId}
          token={token}
          onClose={() => setCreatorPopupId(null)}
          onMealAdd={meal => { setSaveError(''); setAddingMeal(meal as any); setCreatorPopupId(null); }}
        />
      )}

    </div>
  );
}
