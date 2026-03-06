'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
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

function FilterPanel({ filters, onChange, onClose, authorSuggestions = [], extraTags = [] }: {
  filters: MealFilters; onChange: (f: MealFilters) => void; onClose: () => void;
  authorSuggestions?: string[]; extraTags?: string[];
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
  const chipStyle = { display: 'inline-flex' as const, alignItems: 'center' as const, gap: 4, padding: '2px 8px', borderRadius: 20, fontSize: 11, background: 'var(--wk-surface)', border: '1px solid var(--wk-border)', color: 'var(--wk-text2)' };
  const xStyle = { background: 'none', border: 'none', color: 'var(--wk-text3)', cursor: 'pointer', padding: 0, fontSize: 13, lineHeight: '1' as const };

  return (
    <div style={{ position: 'absolute', right: 0, top: 'calc(100% + 6px)', zIndex: 200, width: 310, background: 'var(--wk-card)', border: '1px solid var(--wk-border)', borderRadius: 14, boxShadow: '0 8px 32px rgba(0,0,0,0.18)', padding: 16, maxHeight: '80vh', overflowY: 'auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--wk-text)' }}>Filters</span>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button type="button" onClick={() => onChange(EMPTY_FILTERS)} style={{ fontSize: 11, color: 'var(--wk-red)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>Clear all</button>
          <button type="button" onClick={onClose} style={{ fontSize: 18, lineHeight: '1', color: 'var(--wk-text2)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>×</button>
        </div>
      </div>
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--wk-text2)', marginBottom: 4 }}>Author</div>
        <div style={{ position: 'relative' }}>
          <div style={{ display: 'flex', gap: 4, marginBottom: filters.authors.length > 0 ? 6 : 0 }}>
            <input type="text" value={authorInput}
              onChange={e => { setAuthorInput(e.target.value); setShowAuthorSug(true); }}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addAuthor(); } if (e.key === 'Escape') setShowAuthorSug(false); }}
              onFocus={() => setShowAuthorSug(true)} onBlur={() => setTimeout(() => setShowAuthorSug(false), 150)}
              placeholder="Type author name…" className="focus:outline-none"
              style={{ flex: 1, padding: '6px 8px', fontSize: 12, borderRadius: 8, border: '1px solid var(--wk-border)', background: 'var(--wk-surface)', color: 'var(--wk-text)' }} />
            <button type="button" onClick={addAuthor} disabled={!authorInput.trim()}
              style={{ padding: '6px 10px', fontSize: 11, fontWeight: 600, borderRadius: 8, background: authorInput.trim() ? 'var(--wk-red)' : 'var(--wk-border)', color: authorInput.trim() ? '#fff' : 'var(--wk-text3)', border: 'none', cursor: authorInput.trim() ? 'pointer' : 'default' }}>+ Add</button>
          </div>
          {showAuthorSug && sugFiltered.length > 0 && (
            <div style={{ position: 'absolute', left: 0, right: 44, zIndex: 10, background: 'var(--wk-card)', border: '1px solid var(--wk-border)', borderRadius: 8, boxShadow: '0 4px 16px rgba(0,0,0,0.12)', overflow: 'hidden', top: '100%', marginTop: 2 }}>
              {sugFiltered.slice(0, 5).map(a => (
                <button key={a} type="button" onMouseDown={e => { e.preventDefault(); onChange({ ...filters, authors: [...filters.authors, a] }); setAuthorInput(''); setShowAuthorSug(false); }}
                  style={{ display: 'block', width: '100%', textAlign: 'left', padding: '6px 10px', fontSize: 12, color: 'var(--wk-text)', background: 'none', border: 'none', cursor: 'pointer' }}
                  onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--wk-surface)'; }}
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
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--wk-text2)', marginBottom: 4 }}>Tags</div>
        <input type="text" value={tagSearch} onChange={e => setTagSearch(e.target.value)} placeholder="Search tags…" className="focus:outline-none"
          style={{ width: '100%', padding: '5px 8px', fontSize: 11, borderRadius: 8, border: '1px solid var(--wk-border)', background: 'var(--wk-surface)', color: 'var(--wk-text)', marginBottom: 6 }} />
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, maxHeight: 80, overflowY: 'auto' }}>
          {visibleTags.map(tag => {
            const sel = filters.tags.includes(tag);
            return (
              <button key={tag} type="button" onClick={() => onChange({ ...filters, tags: sel ? filters.tags.filter(t => t !== tag) : [...filters.tags, tag] })}
                style={sel ? { padding: '2px 8px', borderRadius: 20, fontSize: 11, fontWeight: 600, background: 'var(--wk-red)', border: '1px solid var(--wk-red)', color: '#fff', cursor: 'pointer' }
                           : { padding: '2px 8px', borderRadius: 20, fontSize: 11, background: 'transparent', border: '1px solid var(--wk-border)', color: 'var(--wk-text2)', cursor: 'pointer' }}>
                {tag}
              </button>
            );
          })}
        </div>
      </div>
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--wk-text2)', marginBottom: 4 }}>Contains Ingredient</div>
        <div style={{ display: 'flex', gap: 4, marginBottom: filters.ingredients.length > 0 ? 6 : 0 }}>
          <input type="text" value={ingredientInput} onChange={e => setIngredientInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addIngredient(); } }}
            placeholder="e.g. chicken, tomato…" className="focus:outline-none"
            style={{ flex: 1, padding: '6px 8px', fontSize: 12, borderRadius: 8, border: '1px solid var(--wk-border)', background: 'var(--wk-surface)', color: 'var(--wk-text)' }} />
          <button type="button" onClick={addIngredient} disabled={!ingredientInput.trim()}
            style={{ padding: '6px 10px', fontSize: 11, fontWeight: 600, borderRadius: 8, background: ingredientInput.trim() ? 'var(--wk-red)' : 'var(--wk-border)', color: ingredientInput.trim() ? '#fff' : 'var(--wk-text3)', border: 'none', cursor: ingredientInput.trim() ? 'pointer' : 'default' }}>+ Add</button>
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
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--wk-text2)', marginBottom: 6 }}>Difficulty</div>
        <div style={{ display: 'flex', gap: 6 }}>
          {[1, 2, 3, 4, 5].map(d => {
            const sel = filters.difficulty.includes(d);
            return (
              <button key={d} type="button" title={`Difficulty ${d}`}
                onClick={() => onChange({ ...filters, difficulty: sel ? filters.difficulty.filter(x => x !== d) : [...filters.difficulty, d] })}
                style={{ width: 30, height: 30, borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: 'pointer', background: sel ? 'var(--wk-red)' : 'transparent', border: `1.5px solid ${sel ? 'var(--wk-red)' : 'var(--wk-border)'}`, color: sel ? '#fff' : 'var(--wk-text2)' }}>
                {d}
              </button>
            );
          })}
        </div>
      </div>
      <div>
        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--wk-text2)', marginBottom: 4 }}>Exclude Ingredients</div>
        <div style={{ display: 'flex', gap: 4, marginBottom: filters.excludeIngredients.length > 0 ? 6 : 0 }}>
          <input type="text" value={excludeInput} onChange={e => setExcludeInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addExclude(); } }}
            placeholder="e.g. peanuts, milk…" className="focus:outline-none"
            style={{ flex: 1, padding: '6px 8px', fontSize: 12, borderRadius: 8, border: '1px solid var(--wk-border)', background: 'var(--wk-surface)', color: 'var(--wk-text)' }} />
          <button type="button" onClick={addExclude} disabled={!excludeInput.trim()}
            style={{ padding: '6px 10px', fontSize: 11, fontWeight: 600, borderRadius: 8, background: excludeInput.trim() ? 'var(--wk-red)' : 'var(--wk-border)', color: excludeInput.trim() ? '#fff' : 'var(--wk-text3)', border: 'none', cursor: excludeInput.trim() ? 'pointer' : 'default' }}>+ Add</button>
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
  photo_url?: string | null;
  difficulty?: number | null;
  tags?: string[] | null;
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

// ── Store Modal ───────────────────────────────────────────────────────────────

interface StoreModalProps {
  meal: PresetMeal;
  onSave: (storeId: string) => Promise<void>;
  onClose: () => void;
  saving: boolean;
  error: string;
}

function StoreModal({ meal, onSave, onClose, saving, error }: StoreModalProps) {
  const [selectedStore, setSelectedStore] = useState('');

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="rounded-2xl w-full max-w-sm" style={{ background: 'var(--wk-card)', boxShadow: 'var(--wk-shadow-md)', border: '1px solid var(--wk-border)' }}>
        <div className="flex items-center justify-between px-5 py-4" style={{ borderBottom: '1px solid var(--wk-border)' }}>
          <h2 className="text-sm font-bold text-wk-text">Add to My Meals</h2>
          <button onClick={onClose} className="text-wk-text3 hover:text-wk-text2 text-xl leading-none transition-colors">&times;</button>
        </div>
        <div className="px-5 py-4 space-y-4">
          <p className="text-sm text-wk-text2">
            Adding <strong className="text-wk-text">{meal.name}</strong>. Which store are you shopping at?
          </p>
          <div>
            <label className="block text-xs font-semibold text-wk-text2 mb-1.5">Store</label>
            <select
              value={selectedStore}
              onChange={e => setSelectedStore(e.target.value)}
              className="w-full rounded-lg px-3 py-2 text-sm focus:outline-none"
              style={{ border: '1px solid var(--wk-border)', background: 'var(--wk-surface)', color: 'var(--wk-text)' }}
            >
              <option value="">Select a store…</option>
              {STORES.map(s => (
                <option key={s.id} value={s.id}>{s.label}</option>
              ))}
            </select>
          </div>
          {error && <p className="text-xs" style={{ color: 'var(--wk-red)' }}>{error}</p>}
          <button
            onClick={() => onSave(selectedStore)}
            disabled={!selectedStore || saving}
            className="w-full text-white text-sm font-semibold rounded-xl py-2.5 disabled:opacity-50 transition-opacity"
            style={{ background: 'var(--wk-red)' }}
          >
            {saving ? 'Saving…' : 'Add to My Meals'}
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
  const sourceHost = meal.source ? (() => {
    try { return new URL(meal.source!).hostname.replace('www.', ''); } catch { return meal.source; }
  })() : null;
  const authorName = meal.creator_name
    ? (meal.creator_social || meal.creator_name)
    : meal.author ?? null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:p-4"
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
            {authorName && (
              meal.creator_id && onCreatorClick ? (
                <button
                  className="text-xs mt-0.5 text-left hover:underline"
                  style={{ color: 'var(--wk-red)', background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
                  onClick={e => { e.stopPropagation(); onClose(); onCreatorClick(meal.creator_id!); }}
                >
                  by {authorName}
                </button>
              ) : (
                <p className="text-xs mt-0.5" style={{ color: 'var(--wk-red)' }}>by {authorName}</p>
              )
            )}
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
              {meal.tags.slice(0, 3).map(tag => (
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
        <div className="p-4" style={{ borderTop: '1px solid var(--wk-border)' }}>
          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={() => { onAdd(); onClose(); }}
              className="px-4 py-2 text-sm font-medium rounded-lg transition-colors"
              style={{ background: 'var(--wk-red)', border: 'none', color: '#fff' }}
              onMouseEnter={e => { e.currentTarget.style.opacity = '0.88'; }}
              onMouseLeave={e => { e.currentTarget.style.opacity = '1'; }}
            >
              + Add to My Meals
            </button>
            {savedStores && savedStores.length > 0 && (
              <span className="text-xs" style={{ color: 'var(--wk-text3)' }}>Saved at {savedStores.join(', ')}</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Meal Card ─────────────────────────────────────────────────────────────────

function MealCard({
  meal,
  savedStores,
  onAdd,
  onCreatorClick,
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
        className="flex items-start gap-4 p-4 rounded-xl cursor-pointer"
        style={{ background: 'var(--wk-card)', border: '1px solid var(--wk-border)', boxShadow: 'var(--wk-shadow)' }}
        onClick={() => setDetailOpen(true)}
        onMouseEnter={e => (e.currentTarget.style.boxShadow = 'var(--wk-shadow-md)')}
        onMouseLeave={e => (e.currentTarget.style.boxShadow = 'var(--wk-shadow)')}
      >
        <div className="hidden sm:block">
          {meal.photo_url ? (
            <img
              src={meal.photo_url}
              alt={meal.name}
              className="object-cover rounded-lg flex-shrink-0"
              style={{ width: '120px', height: '120px', border: '1px solid var(--wk-border)' }}
            />
          ) : (
            <div className="rounded-lg flex-shrink-0 flex items-center justify-center text-xl" style={{ width: '120px', height: '120px', background: 'var(--wk-surface)', border: '1px solid var(--wk-border)' }}>
              🍽️
            </div>
          )}
        </div>

        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-wk-text">{meal.name}</p>

          {(authorName || sourceHost) && (
            <div className="flex items-center gap-2 mt-0.5 flex-wrap">
              {authorName && (
                meal.creator_id && onCreatorClick ? (
                  <button
                    className="text-xs text-left hover:underline"
                    style={{ color: 'var(--wk-red)', background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
                    onClick={e => { e.stopPropagation(); onCreatorClick(meal.creator_id!); }}
                  >
                    by {authorName}
                  </button>
                ) : (
                  <span className="text-xs" style={{ color: 'var(--wk-red)' }}>by {authorName}</span>
                )
              )}
              {authorName && sourceHost && <span className="text-xs text-wk-text3">·</span>}
              {sourceHost && (
                <a
                  href={meal.source!}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs flex items-center gap-1 transition-colors hover:underline"
                  style={{ color: 'var(--wk-text3)' }}
                  onClick={e => e.stopPropagation()}
                >
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
                  </svg>
                  {sourceHost}
                </a>
              )}
            </div>
          )}

          {meal.difficulty != null && (
            <div className="flex items-center gap-2 mt-1">
              <span className="text-xs text-wk-text3">Difficulty:</span>
              <DifficultyDots level={meal.difficulty} />
            </div>
          )}

          {meal.tags && meal.tags.length > 0 && (
            <div className="flex items-center gap-1 flex-wrap mt-1">
              {meal.tags.slice(0, 3).map(tag => (
                <span key={tag} className="text-xs px-2 py-0.5 rounded-full" style={{ background: 'var(--wk-surface)', border: '1px solid var(--wk-border)', color: 'var(--wk-text2)' }}>
                  {tag}
                </span>
              ))}
            </div>
          )}

          {meal.recipe && (
            <div className="mt-2 select-none rounded-md" style={{ background: '#f2f2f2', padding: '7px 9px' }}>
              <div className="relative" style={{ maxHeight: '3.6em', overflow: 'hidden' }}>
                <p className="text-xs whitespace-pre-wrap leading-relaxed" style={{ color: '#555' }}>{meal.recipe}</p>
                <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: '1.8em', background: 'linear-gradient(to bottom, rgba(242,242,242,0), rgba(242,242,242,1))' }} />
              </div>
            </div>
          )}

          <div className="mt-3 flex items-center gap-2 flex-wrap">
            <button
              onClick={e => { e.stopPropagation(); onAdd(); }}
              className="px-3 py-1 text-xs font-medium rounded-lg transition-colors"
              style={{ background: 'var(--wk-red)', border: 'none', color: '#fff' }}
              onMouseEnter={e => { e.currentTarget.style.opacity = '0.88'; }}
              onMouseLeave={e => { e.currentTarget.style.opacity = '1'; }}
            >
              + Add to My Meals
            </button>
            {savedStores && savedStores.length > 0 && (
              <span className="text-xs" style={{ color: 'var(--wk-text3)' }}>
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

export default function DiscoverPage() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [hasSavedMeals, setHasSavedMeals] = useState(true);
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
  const sentinelRef = useRef<HTMLDivElement>(null);
  const observerRef = useRef<IntersectionObserver | null>(null);

  // Following tab — creator carousel
  const [followedCreators, setFollowedCreators] = useState<{ id: string; display_name: string; photo_url?: string | null }[]>([]);
  const [selectedCreatorIds, setSelectedCreatorIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    verifyAuth();
  }, []);

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

      fetch('/api/meals', {
        headers: { Authorization: `Bearer ${accessToken}` },
      }).then(r => r.ok ? r.json() : null).then(d => {
        if (!d?.meals) return;
        if (d.meals.length === 0) setHasSavedMeals(false);
        const map = new Map<string, string[]>();
        for (const m of d.meals) {
          if (!m.preset_meal_id) continue;
          const storeLabel = STORES.find(s => s.id === m.store_id)?.label ?? m.store_id;
          const existing = map.get(m.preset_meal_id) ?? [];
          map.set(m.preset_meal_id, [...existing, storeLabel]);
        }
        setSavedMealStores(map);
      }).catch(() => {});

      setLoading(false);
    } catch {
      localStorage.clear();
      router.push('/');
    }
  };

  // ── Fetch pre-built meals ──────────────────────────────────────────────────

  const fetchMeals = useCallback(async (reset: boolean, currentSection: 'trending' | 'new' | 'following', currentToken: string) => {
    if (fetching) return;
    setFetching(true);
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
      setMeals(prev => reset ? fetched : [...prev, ...fetched]);
      setHasMore(data.hasMore ?? false);
      offsetRef.current = offset + fetched.length;
    } catch {
      setFetchError('Failed to load recipes. Please try again.');
    } finally {
      setFetching(false);
    }
  }, [fetching]);

  useEffect(() => {
    if (!token) return;
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

  // ── Infinite scroll ───────────────────────────────────────────────────────

  useEffect(() => {
    if (observerRef.current) observerRef.current.disconnect();
    if (!sentinelRef.current || !hasMore || fetching) return;
    observerRef.current = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting) fetchMeals(false, sectionRef.current, token);
    }, { threshold: 0.1 });
    observerRef.current.observe(sentinelRef.current);
    return () => observerRef.current?.disconnect();
  }, [hasMore, fetching, fetchMeals, token]);

  // ── Search filter ─────────────────────────────────────────────────────────

  const q = search.trim().toLowerCase();
  const activeFilterCount = [filters.authors.length > 0, filters.tags.length > 0, filters.ingredients.length > 0, filters.difficulty.length > 0, filters.excludeIngredients.length > 0].filter(Boolean).length;
  const customMealTags = [...new Set(meals.flatMap(m => m.tags || []).filter(t => !ALL_TAGS.includes(t)))];
  const authorSuggestions = [...new Set(meals.flatMap(m => [m.author, m.creator_name]).filter((a): a is string => Boolean(a)))];
  const matchesMeal = (m: PresetMeal) => {
    if (q && !(m.name.toLowerCase().includes(q) || m.author?.toLowerCase().includes(q) || m.creator_name?.toLowerCase().includes(q) || m.source?.toLowerCase().includes(q) || m.tags?.some(t => t.toLowerCase().includes(q)) || m.ingredients?.some(i => i.productName.toLowerCase().includes(q)))) return false;
    if (filters.authors.length > 0 && !filters.authors.some(a => m.author?.toLowerCase().includes(a.toLowerCase()) || m.creator_name?.toLowerCase().includes(a.toLowerCase()))) return false;
    if (filters.tags.length > 0 && !filters.tags.some(t => m.tags?.includes(t))) return false;
    if (filters.ingredients.length > 0 && !filters.ingredients.every(ing => m.ingredients?.some(i => i.productName.toLowerCase().includes(ing)))) return false;
    if (filters.difficulty.length > 0 && !filters.difficulty.includes(m.difficulty ?? -1)) return false;
    if (filters.excludeIngredients.length > 0 && filters.excludeIngredients.some(ex => m.ingredients?.some(i => i.productName.toLowerCase().includes(ex)))) return false;
    return true;
  };
  const creatorFiltered = (m: PresetMeal) =>
    section !== 'following' || selectedCreatorIds.size === 0 || (!!m.creator_id && selectedCreatorIds.has(m.creator_id));
  const unsaved = meals.filter(m => !savedMealStores.has(m.id) && matchesMeal(m) && creatorFiltered(m));
  const saved   = meals.filter(m =>  savedMealStores.has(m.id) && matchesMeal(m) && creatorFiltered(m));
  const visible = [...unsaved, ...saved];

  // ── Save pre-built meal ───────────────────────────────────────────────────

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
          ...(addingMeal.recipe       ? { recipe:     addingMeal.recipe     } : {}),
          ...(addingMeal.photo_url    ? { photoUrl:   addingMeal.photo_url  } : {}),
          ...(addingMeal.creator_id   ? { creatorId:  addingMeal.creator_id } : {}),
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
      setAddingMeal(null);
    } catch {
      setSaveError('Something went wrong. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-wk-bg flex items-center justify-center">
        <div className="w-10 h-10 border-4 border-t-transparent rounded-full animate-spin" style={{ borderColor: 'var(--wk-border)', borderTopColor: 'var(--wk-red)' }} />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-wk-bg flex flex-col">

      <AppHeader />

      {/* Upgrade nudge */}
      {user && user.tier !== 'paid' && (
        <div className="w-full py-2.5 px-4 text-center text-sm" style={{ background: 'var(--wk-red-bg)', borderBottom: '1px solid #fecdd3', color: 'var(--wk-red)' }}>
          <span className="font-medium">Free plan: </span>limited to 3 saved meals.{' '}
          <a href="/pricing" className="underline font-semibold hover:opacity-80 transition-opacity">Upgrade to Full Access →</a>
        </div>
      )}

      <div className="max-w-5xl mx-auto px-6 py-10 w-full flex-1">

        {/* Getting Started — only shown if user has no saved meals yet */}
        {!hasSavedMeals && (
          <div className="rounded-xl p-8 mb-8" style={{ background: 'var(--wk-card)', border: '1px solid var(--wk-border)', boxShadow: 'var(--wk-shadow)' }}>
            <h2 className="text-lg font-bold text-wk-text mb-6">Getting started</h2>
            <div className="space-y-5">
              {/* Step 1 — special: has extension link */}
              <div className="flex items-start gap-4">
                <div className="w-7 h-7 text-white rounded-full flex items-center justify-center font-bold text-xs flex-shrink-0 mt-0.5" style={{ background: 'var(--wk-red)' }}>1</div>
                <div>
                  <p className="text-sm font-semibold text-wk-text">Install the Web Extension</p>
                  <p className="text-sm text-wk-text2 mt-0.5">
                    Add Mealio to your browser to start saving meals and adding ingredients to your cart.{' '}
                    <a href={isFirefox ? FIREFOX_EXT_URL : CHROME_EXT_URL} target="_blank" rel="noopener noreferrer" className="font-medium underline underline-offset-2 transition-colors" style={{ color: 'var(--wk-red)' }}>
                      Get the {isFirefox ? 'Firefox' : 'Chrome'} extension →
                    </a>
                  </p>
                </div>
              </div>
              {[
                {
                  n: 2,
                  title: 'Open the extension and sign in',
                  desc: 'Click the Mealio icon in your browser toolbar. You will be logged in automatically.',
                },
                {
                  n: 3,
                  title: 'Go to a supported grocery store',
                  desc: 'Visit any major grocery retailer online. Mealio detects the store automatically.',
                },
                {
                  n: 4,
                  title: 'Save your first meal',
                  desc: 'Click "Add Meal," name it, then add items to your cart. Mealio records every ingredient so you can reorder with one click. You can also browse Discover to instantly add pre-built meals without recording anything.',
                },
              ].map(step => (
                <div key={step.n} className="flex items-start gap-4">
                  <div className="w-7 h-7 text-white rounded-full flex items-center justify-center font-bold text-xs flex-shrink-0 mt-0.5" style={{ background: 'var(--wk-red)' }}>
                    {step.n}
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-wk-text">{step.title}</p>
                    <p className="text-sm text-wk-text2 mt-0.5">{step.desc}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── Discover Section ──────────────────────────────────────────────── */}
        <div className="mb-10">
          <div className="mb-8 flex items-end justify-between gap-4">
            <div>
              <h1 className="text-5xl font-bold text-wk-text leading-tight">
                What's for<br />
                <span style={{ borderBottom: '4px solid var(--wk-red)', paddingBottom: '3px' }}>dinner?</span>
              </h1>
            </div>
            <a
              href="/my-meals"
              className="flex-shrink-0 flex items-center gap-1.5 text-sm font-semibold rounded-xl px-4 py-2 transition-colors"
              style={{ background: 'var(--wk-red)', color: '#fff', border: 'none', textDecoration: 'none' }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = '#c40029'; }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'var(--wk-red)'; }}
            >
              My Meals
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 12h14M12 5l7 7-7 7"/>
              </svg>
            </a>
          </div>

          {/* Controls */}
          <div className="flex flex-col sm:flex-row gap-3 mb-6">
            <div className="flex gap-1 p-1 rounded-xl self-start" style={{ background: 'var(--wk-surface)' }}>
              {(['trending', 'new', 'following'] as const).map(s => (
                <button
                  key={s}
                  onClick={() => { if (s !== section) { setSection(s); setSearch(''); } }}
                  className="px-4 py-1.5 text-sm font-semibold rounded-lg transition-all"
                  style={section === s
                    ? { background: 'var(--wk-card)', color: 'var(--wk-text)', boxShadow: 'var(--wk-shadow)' }
                    : { background: 'transparent', color: 'var(--wk-text2)' }}
                >
                  {s === 'trending' ? '🔥 Trending' : s === 'new' ? 'New' : 'Following'}
                </button>
              ))}
            </div>

            <div className="flex-1 relative">
              <svg className="absolute left-3 top-1/2 -translate-y-1/2 text-wk-text3" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
              </svg>
              <input
                type="text"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search recipes, ingredients, tags…"
                className="w-full pl-9 pr-4 py-2 text-sm rounded-xl focus:outline-none"
                style={{ border: '1px solid var(--wk-border)', background: 'var(--wk-card)', color: 'var(--wk-text)' }}
              />
            </div>
            <div ref={filterBtnRef} style={{ position: 'relative', flexShrink: 0 }}>
              <button type="button" onClick={() => setFilterOpen(v => !v)}
                style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '7px 11px', borderRadius: 10, fontSize: 13, fontWeight: 600, border: '1px solid var(--wk-border)', background: (filterOpen || activeFilterCount > 0) ? 'var(--wk-red)' : 'var(--wk-card)', color: (filterOpen || activeFilterCount > 0) ? '#fff' : 'var(--wk-text2)', cursor: 'pointer', whiteSpace: 'nowrap' }}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>
                </svg>
                Filter{activeFilterCount > 0 ? ` (${activeFilterCount})` : ''}
              </button>
              {filterOpen && <FilterPanel filters={filters} onChange={setFilters} onClose={() => setFilterOpen(false)} authorSuggestions={authorSuggestions} extraTags={customMealTags} />}
            </div>
          </div>

          {/* Creator carousel — Following tab only */}
          {section === 'following' && followedCreators.length > 0 && (
            <div className="flex gap-3 overflow-x-auto pb-2 mb-5 scrollbar-hide" style={{ scrollbarWidth: 'none' }}>
              {followedCreators.map(creator => {
                const allSelected = selectedCreatorIds.size === 0;
                const isSelected = allSelected || selectedCreatorIds.has(creator.id);
                return (
                  <button
                    key={creator.id}
                    onClick={() => {
                      setSelectedCreatorIds(prev => {
                        const next = new Set(prev);
                        if (allSelected) {
                          // First click: select only this one
                          return new Set([creator.id]);
                        }
                        if (next.has(creator.id)) {
                          next.delete(creator.id);
                          // Deselecting the last one → back to "all"
                          return next.size === 0 ? new Set() : next;
                        } else {
                          next.add(creator.id);
                          return next;
                        }
                      });
                    }}
                    className="flex flex-col items-center gap-1.5 flex-shrink-0 transition-opacity"
                    style={{ background: 'none', border: 'none', cursor: 'pointer', opacity: isSelected ? 1 : 0.4 }}
                  >
                    <div
                      className="w-14 h-14 rounded-full overflow-hidden flex-shrink-0"
                      style={{
                        border: isSelected ? '2.5px solid var(--wk-red)' : '2.5px solid var(--wk-border)',
                        background: 'var(--wk-surface)',
                        transition: 'border-color 0.15s',
                      }}
                    >
                      {creator.photo_url
                        ? <img src={creator.photo_url} alt={creator.display_name} className="w-full h-full object-cover" />
                        : <div className="w-full h-full flex items-center justify-center text-xl">👤</div>}
                    </div>
                    <span className="text-xs font-medium text-center max-w-[64px] truncate" style={{ color: isSelected ? 'var(--wk-text)' : 'var(--wk-text3)' }}>
                      {creator.display_name}
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {/* Meal list */}
          {fetchError ? (
            <div className="text-center py-16">
              <p className="text-sm text-wk-text3 mb-3">{fetchError}</p>
              <button onClick={() => fetchMeals(true, section, token)} className="text-sm font-medium" style={{ color: 'var(--wk-red)' }}>
                Try again
              </button>
            </div>
          ) : visible.length === 0 && !fetching ? (
            <div className="text-center py-16">
              <p className="text-sm text-wk-text3">
                {section === 'following' && meals.length === 0
                  ? 'Follow creators to see their meals here.'
                  : (q || activeFilterCount > 0 || selectedCreatorIds.size > 0)
                    ? 'No recipes match your filters.'
                    : 'No recipes available.'}
              </p>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {visible.map(meal => (
                  <MealCard
                    key={meal.id}
                    meal={meal}
                    savedStores={savedMealStores.get(meal.id)}
                    onAdd={() => { setSaveError(''); setAddingMeal(meal); }}
                    onCreatorClick={id => setCreatorPopupId(id)}
                  />
                ))}
              </div>

              <div ref={sentinelRef} className="py-4 text-center">
                {fetching && (
                  <div className="inline-block w-6 h-6 rounded-full animate-spin" style={{ border: '2px solid var(--wk-border)', borderTopColor: 'var(--wk-red)' }} />
                )}
                {!fetching && !hasMore && meals.length > 0 && (
                  <p className="text-xs text-wk-text3">You&apos;ve seen all recipes.</p>
                )}
              </div>
            </>
          )}

          {fetching && meals.length === 0 && (
            <div className="flex justify-center py-16">
              <div className="w-8 h-8 rounded-full animate-spin" style={{ border: '3px solid var(--wk-border)', borderTopColor: 'var(--wk-red)' }} />
            </div>
          )}
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
