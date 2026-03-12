'use client';

import { useEffect, useState, useRef } from 'react';
import { useRouter } from 'next/navigation';
import AppHeader from '@/components/AppHeader';
import AppFooter from '@/components/AppFooter';
import ExtensionNudge from '@/components/ExtensionNudge';
import CreatorPopup from '@/components/CreatorPopup';

interface User {
  id: string;
  email: string;
  tier?: string;
  isAdmin?: boolean;
  createdAt?: string;
}

interface Ingredient {
  productName: string;
  searchTerm?: string;
  quantity?: number;
}

interface Meal {
  id: string;
  name: string;
  store_id: string;
  ingredients: Ingredient[];
  author?: string | null;
  creator_id?: string | null;
  difficulty?: number | null;
  tags?: string[] | null;
  website?: string | null;
  recipe?: string | null;
  photo_url?: string | null;
  story?: string | null;
  created_at?: string;
}

interface MealFilters {
  authors: string[];
  tags: string[];
  ingredients: string[];
  difficulty: number[];
  excludeIngredients: string[];
}
const EMPTY_FILTERS: MealFilters = { authors: [], tags: [], ingredients: [], difficulty: [], excludeIngredients: [] };

// Stores that support the Kroger API cart integration
const KROGER_API_STORES = new Set([
  'kroger', 'ralphs', 'fred_meyer', 'king_soopers', 'smiths', 'frys',
  'qfc', 'city_market', 'dillons', 'bakers', 'marianos', 'pick_n_save',
  'metro_market', 'pay_less', 'harris_teeter',
]);

interface ConsolidatedIngredient {
  productName: string;
  quantity: number;
  mealIds: string[];
  mealNames: string[];
}

interface KrogerSearchResult {
  term: string;
  quantity: number;
  upc: string | null;
  description: string | null;
  exact: boolean;
  suggestions: Array<{ upc: string; description: string }>;
  mealIds: string[];
  mealNames: string[];
}

const ALL_TAGS = [
  // Time
  'Under 10 Min', 'Under 30 Min', 'Under 45 Min', 'Over 1 Hour',
  // Cooking Method
  'One Pot', 'Sheet Pan', 'Slow Cooker', 'Air Fryer', 'Grilled', 'No Cook',
  'Instant Pot', 'Baked', 'Stovetop', 'Deep Fried', 'Steamed',
  // Meal Type
  'Breakfast', 'Brunch', 'Lunch', 'Dinner', 'Snack', 'Dessert', 'Side Dish',
  'Appetizer', 'Soup', 'Salad', 'Sandwich', 'Wrap', 'Pasta', 'Tacos',
  'Pizza', 'Burger', 'Stir Fry', 'Smoothie', 'Bowl',
  // Dietary
  'Healthy', 'Keto', 'Low Carb', 'High Protein', 'Vegetarian', 'Vegan',
  'Gluten-Free', 'Dairy-Free', 'Paleo', 'Low Calorie', 'High Fiber',
  'Whole30', 'Mediterranean', 'Low Sodium', 'Nut-Free', 'Sugar-Free', 'Low Fat',
  // Protein
  'Chicken', 'Beef', 'Pork', 'Seafood', 'Fish', 'Turkey', 'Tofu', 'Eggs', 'Lamb',
  // Cuisine
  'American', 'Mexican', 'Italian', 'Asian', 'Indian', 'Thai', 'Japanese',
  'Chinese', 'Korean', 'Greek', 'French', 'Middle Eastern', 'Southern', 'Tex-Mex', 'BBQ',
  // Lifestyle
  'Meal Prep', 'Budget Friendly', '5 Ingredients', 'Family Friendly', 'Date Night',
  'Comfort Food', 'Kid Friendly', 'Game Day', 'Freezer Friendly', 'Make Ahead',
  'Quick Cleanup', 'Leftovers Good',
];

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
  const chipStyle = { display: 'inline-flex' as const, alignItems: 'center' as const, gap: 4, padding: '2px 8px', borderRadius: 20, fontSize: 11, background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text-2)' };
  const xStyle = { background: 'none', border: 'none', color: 'var(--text-3)', cursor: 'pointer', padding: 0, fontSize: 13, lineHeight: '1' as const };

  const popupStyle = inline ? {} : { position: 'absolute' as const, right: 0, top: 'calc(100% + 6px)', zIndex: 200, boxShadow: '0 8px 32px rgba(0,0,0,0.18)' };

  return (
    <div style={{ width: inline ? '100%' : 310, background: 'var(--surface-raised)', border: inline ? 'none' : '1px solid var(--border)', borderRadius: inline ? 0 : 14, padding: inline ? 0 : 16, maxHeight: inline ? undefined : '80vh', overflowY: inline ? undefined : 'auto', ...popupStyle }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-1)' }}>Filters</span>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button type="button" onClick={() => onChange(EMPTY_FILTERS)} style={{ fontSize: 11, color: 'var(--brand)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>Clear all</button>
          {!inline && <button type="button" onClick={onClose} style={{ fontSize: 18, lineHeight: '1', color: 'var(--text-2)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>×</button>}
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
              placeholder="Type author name…" className="focus:outline-none"
              style={{ flex: 1, padding: '6px 8px', fontSize: 12, borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text-1)' }} />
            <button type="button" onClick={addAuthor} disabled={!authorInput.trim()}
              style={{ padding: '6px 10px', fontSize: 11, fontWeight: 600, borderRadius: 8, background: authorInput.trim() ? 'var(--brand)' : 'var(--border)', color: authorInput.trim() ? '#fff' : 'var(--text-3)', border: 'none', cursor: authorInput.trim() ? 'pointer' : 'default' }}>+ Add</button>
          </div>
          {showAuthorSug && sugFiltered.length > 0 && (
            <div style={{ position: 'absolute', left: 0, right: 44, zIndex: 10, background: 'var(--surface-raised)', border: '1px solid var(--border)', borderRadius: 8, boxShadow: '0 4px 16px rgba(0,0,0,0.12)', overflow: 'hidden', top: '100%', marginTop: 2 }}>
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
        <input type="text" value={tagSearch} onChange={e => setTagSearch(e.target.value)} placeholder="Search tags…" className="focus:outline-none"
          style={{ width: '100%', padding: '5px 8px', fontSize: 11, borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text-1)', marginBottom: 6 }} />
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, maxHeight: 80, overflowY: 'auto' }}>
          {visibleTags.map(tag => {
            const sel = filters.tags.includes(tag);
            return (
              <button key={tag} type="button" onClick={() => onChange({ ...filters, tags: sel ? filters.tags.filter(t => t !== tag) : [...filters.tags, tag] })}
                style={sel ? { padding: '2px 8px', borderRadius: 20, fontSize: 11, fontWeight: 600, background: 'var(--brand)', border: '1px solid var(--brand)', color: '#fff', cursor: 'pointer' }
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
            placeholder="e.g. chicken, tomato…" className="focus:outline-none"
            style={{ flex: 1, padding: '6px 8px', fontSize: 12, borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text-1)' }} />
          <button type="button" onClick={addIngredient} disabled={!ingredientInput.trim()}
            style={{ padding: '6px 10px', fontSize: 11, fontWeight: 600, borderRadius: 8, background: ingredientInput.trim() ? 'var(--brand)' : 'var(--border)', color: ingredientInput.trim() ? '#fff' : 'var(--text-3)', border: 'none', cursor: ingredientInput.trim() ? 'pointer' : 'default' }}>+ Add</button>
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
            placeholder="e.g. peanuts, milk…" className="focus:outline-none"
            style={{ flex: 1, padding: '6px 8px', fontSize: 12, borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text-1)' }} />
          <button type="button" onClick={addExclude} disabled={!excludeInput.trim()}
            style={{ padding: '6px 10px', fontSize: 11, fontWeight: 600, borderRadius: 8, background: excludeInput.trim() ? 'var(--brand)' : 'var(--border)', color: excludeInput.trim() ? '#fff' : 'var(--text-3)', border: 'none', cursor: excludeInput.trim() ? 'pointer' : 'default' }}>+ Add</button>
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

function TagPicker({ selected, onChange }: { selected: string[]; onChange: (tags: string[]) => void }) {
  const [search, setSearch] = useState('');
  const trimmed = search.trim();
  const customSelected = selected.filter(t => !ALL_TAGS.includes(t));
  const filtered = ALL_TAGS
    .filter(tag => !search || tag.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => Number(selected.includes(b)) - Number(selected.includes(a)));
  const allPills = [...customSelected, ...filtered];
  const toggle = (tag: string) => {
    if (selected.includes(tag)) {
      onChange(selected.filter(t => t !== tag));
    } else if (selected.length < 3) {
      onChange([...selected, tag]);
    }
  };
  const canAddCustom = trimmed.length > 0 && trimmed.length <= 20 &&
    !ALL_TAGS.some(t => t.toLowerCase() === trimmed.toLowerCase()) &&
    !selected.some(t => t.toLowerCase() === trimmed.toLowerCase());
  const addCustom = () => {
    if (canAddCustom && selected.length < 3) {
      onChange([...selected, trimmed]);
      setSearch('');
    }
  };
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex gap-1">
        <input
          type="text"
          placeholder="Search or add custom tag…"
          value={search}
          onChange={e => setSearch(e.target.value.slice(0, 20))}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addCustom(); } }}
          className="flex-1 px-2 py-1 text-xs rounded-lg outline-none"
          style={{ border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text-1)' }}
        />
        {canAddCustom && selected.length < 3 && (
          <button
            type="button"
            onClick={addCustom}
            className="px-2 py-1 text-xs rounded-lg whitespace-nowrap"
            style={{ background: 'var(--brand)', color: '#fff', border: 'none' }}
          >
            + Add
          </button>
        )}
      </div>
      {trimmed.length > 0 && (
        <div className="text-xs" style={{ color: 'var(--text-2)' }}>
          {trimmed.length}/20 characters
        </div>
      )}
      <div className="flex flex-wrap gap-1.5 overflow-y-auto pr-0.5" style={{ maxHeight: '90px' }}>
        {allPills.map(tag => {
          const isSelected = selected.includes(tag);
          const isDisabled = !isSelected && selected.length >= 3;
          return (
            <button
              key={tag}
              type="button"
              onClick={() => toggle(tag)}
              disabled={isDisabled}
              className="px-2 py-0.5 rounded-full text-xs transition disabled:opacity-40 disabled:cursor-not-allowed"
              style={isSelected
                ? { background: 'var(--brand)', border: '1px solid var(--brand)', color: '#fff', fontWeight: 600 }
                : { border: '1px solid var(--border)', color: 'var(--text-2)', background: 'transparent' }}
            >
              {tag}
            </button>
          );
        })}
      </div>
    </div>
  );
}

const STORE_LABELS: Record<string, string> = {
  heb:           'H-E-B',
  walmart:       'Walmart',
  kroger:        'Kroger',
  aldi:          'ALDI',
  central_market:'Central Market',
  costco:        'Costco',
  albertsons:    'Albertsons',
  amazon:        'Amazon Fresh',
  safeway:       'Safeway',
  vons:          'Vons',
  jewel_osco:    'Jewel-Osco',
  shaws:         "Shaw's",
  acme:          'Acme Markets',
  tom_thumb:     'Tom Thumb',
  randalls:      'Randalls',
  pavilions:     'Pavilions',
  star_market:   'Star Market',
  haggen:        'Haggen',
  carrs:         'Carrs',
  kings:         'Kings Food Markets',
  balduccis:     "Balducci's",
  ralphs:        'Ralphs',
  fred_meyer:    'Fred Meyer',
  king_soopers:  'King Soopers',
  smiths:        "Smith's Food & Drug",
  frys:          "Fry's Food",
  qfc:           'QFC',
  city_market:   'City Market',
  dillons:       'Dillons',
  bakers:        "Baker's",
  marianos:      "Mariano's",
  pick_n_save:   "Pick 'n Save",
  metro_market:  'Metro Market',
  pay_less:      'Pay-Less',
  harris_teeter: 'Harris Teeter',
  wegmans:       'Wegmans',
};

const STORE_COLORS: Record<string, string> = {
  heb:           '#dd0031',
  walmart:       '#0053E2',
  kroger:        '#0E51A1',
  aldi:          '#02205F',
  central_market:'#005732',
  costco:        '#E31936',
  albertsons:    '#009ee5',
  amazon:        '#78BD21',
  safeway:       '#E5161E',
  vons:          '#E41720',
  jewel_osco:    '#E12C47',
  shaws:         '#F48424',
  acme:          '#F04035',
  tom_thumb:     '#0435A6',
  randalls:      '#02365E',
  pavilions:     '#2D2B29',
  star_market:   '#7AC142',
  haggen:        '#025635',
  carrs:         '#E5171D',
  kings:         '#417EC0',
  balduccis:     '#8D2B1E',
  ralphs:        '#EA0029',
  fred_meyer:    '#D7282F',
  king_soopers:  '#005DAA',
  smiths:        '#D51E48',
  frys:          '#E1251B',
  qfc:           '#006BB6',
  city_market:   '#EE3124',
  dillons:       '#CA2128',
  bakers:        '#EE3124',
  marianos:      '#64433D',
  pick_n_save:   '#243444',
  metro_market:  '#63463E',
  pay_less:      '#D8232A',
  harris_teeter: '#A32036',
  wegmans:       '#000000',
};

function DifficultyDots({ level }: { level: number }) {
  return (
    <span className="flex gap-0.5">
      {[1, 2, 3, 4, 5].map(i => (
        <span key={i} className="text-sm" style={{ color: i <= level ? 'var(--brand)' : 'var(--border)' }}>●</span>
      ))}
    </span>
  );
}

// ── Edit Modal ───────────────────────────────────────────────────────────────

interface EditModalProps {
  meal: Meal;
  onSave: (updated: Meal) => void;
  onClose: () => void;
  accessToken: string;
}

function compressImage(dataUrl: string, maxPx = 1200, quality = 0.82): Promise<string> {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxPx / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width  = Math.round(img.width  * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.src = dataUrl;
  });
}

function EditModal({ meal, onSave, onClose, accessToken }: EditModalProps) {
  const [name, setName] = useState(meal.name);
  const [author, setAuthor] = useState(meal.author ?? '');
  const [difficulty, setDifficulty] = useState<number | null>(meal.difficulty ?? null);
  const [selectedTags, setSelectedTags] = useState<string[]>(meal.tags ?? []);
  const [website, setWebsite] = useState(meal.website ?? '');
  const [story, setStory] = useState(meal.story ?? '');
  const [recipe, setRecipe] = useState(meal.recipe ?? '');
  const [photoUrl, setPhotoUrl] = useState(meal.photo_url ?? '');
  const [photoPreview, setPhotoPreview] = useState(meal.photo_url ?? '');
  const [pendingPhotoDataUrl, setPendingPhotoDataUrl] = useState<string | null>(null);
  const [ingredients, setIngredients] = useState<Ingredient[]>(
    meal.ingredients.map(i => ({ ...i }))
  );
  const [newIngredient, setNewIngredient] = useState('');
  const [saving, setSaving] = useState(false);
  const dragRef = useRef(false);
  const [error, setError] = useState('');
  const [generating, setGenerating] = useState(false);
  const [thumbs, setThumbs] = useState<string[]>([]);
  const [fulls, setFulls]   = useState<string[]>([]);
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const handlePhotoChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setThumbs([]); setFulls([]); setSelectedIdx(null);
    const reader = new FileReader();
    reader.onload = ev => {
      const dataUrl = ev.target?.result as string;
      setPhotoPreview(dataUrl);
      setPendingPhotoDataUrl(dataUrl);
      setPhotoUrl('');
    };
    reader.readAsDataURL(file);
  };

  const generatePhoto = async () => {
    if (generating || !name.trim()) return;
    setGenerating(true);
    setThumbs([]); setFulls([]); setSelectedIdx(null);
    setPhotoUrl(''); setPhotoPreview(''); setPendingPhotoDataUrl(null);
    try {
      const res = await fetch('/api/meals/generate-photo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ mealName: name.trim() }),
      });
      const data = await res.json();
      if (res.ok && data.thumbs?.length) {
        setThumbs(data.thumbs);
        setFulls(data.fulls ?? data.thumbs);
      } else {
        setError(data.error || 'No image found for this meal name.');
      }
    } catch (err) {
      console.error('[generate-photo] threw', err);
      setError('Failed to generate photo.');
    } finally {
      setGenerating(false);
    }
  };

  const selectSuggestion = (i: number) => {
    setPendingPhotoDataUrl(null);
    if (selectedIdx === i) {
      setSelectedIdx(null);
      setPhotoUrl(''); setPhotoPreview('');
    } else {
      setSelectedIdx(i);
      const url = fulls[i] ?? thumbs[i];
      setPhotoUrl(url); setPhotoPreview(url);
    }
  };

  const uploadPendingPhoto = async (): Promise<string | null> => {
    if (!pendingPhotoDataUrl) return photoUrl || null;
    const compressed = await compressImage(pendingPhotoDataUrl);
    const res = await fetch('/api/images/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ imageData: compressed }),
    });
    if (res.status === 413) throw new Error('Image is too large. Please choose a smaller photo.');
    if (!res.ok) throw new Error('Photo upload failed. Please try again.');
    const data = await res.json();
    return data.url ?? null;
  };

  const updateIngredientName = (i: number, value: string) => {
    setIngredients(prev => prev.map((ing, idx) =>
      idx === i ? { ...ing, productName: value, searchTerm: value } : ing
    ));
  };

  const updateIngredientQty = (i: number, delta: number) => {
    setIngredients(prev => prev.map((ing, idx) => {
      if (idx !== i) return ing;
      const qty = Math.max(1, (ing.quantity ?? 1) + delta);
      return { ...ing, quantity: qty };
    }));
  };

  const removeIngredient = (i: number) => {
    setIngredients(prev => prev.filter((_, idx) => idx !== i));
  };

  const addIngredient = () => {
    const trimmed = newIngredient.trim();
    if (!trimmed) return;
    setIngredients(prev => [...prev, { productName: trimmed, searchTerm: trimmed, quantity: 1 }]);
    setNewIngredient('');
  };

  const handleSave = async () => {
    if (!name.trim()) { setError('Meal name is required.'); return; }
    setSaving(true);
    setError('');
    try {
      const finalPhotoUrl = await uploadPendingPhoto();
      const res = await fetch(`/api/meals/${meal.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({
          name: name.trim(),
          ingredients,
          author:     author.trim()  || null,
          difficulty: difficulty     ?? null,
          tags:       selectedTags,
          website:    website.trim() || null,
          story:      story.trim()   || null,
          recipe:     recipe.trim()  || null,
          photoUrl:   finalPhotoUrl,
        }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || 'Failed to save.'); return; }
      onSave(data.meal);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const handleClose = () => {
    if (!window.confirm('Discard changes?')) return;
    onClose();
  };

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
      onMouseDown={e => { dragRef.current = e.target !== e.currentTarget; }}
      onClick={e => { if (e.target !== e.currentTarget || dragRef.current) return; handleClose(); }}
    >
      <div className="rounded-2xl w-full max-w-lg max-h-[90vh] flex flex-col" style={{ background: 'var(--surface-raised)', boxShadow: 'var(--shadow-md)' }}>

        <div className="flex items-center justify-between px-6 py-4" style={{ borderBottom: '1px solid var(--border)' }}>
          <h2 className="text-base font-bold text-ml-t1">Edit Meal</h2>
          <button onClick={handleClose} className="text-ml-t3 hover:text-ml-t2 text-xl leading-none transition-colors">&times;</button>
        </div>

        <div className="overflow-y-auto px-6 py-4 space-y-4 flex-1">

          <div>
            <label className="block text-xs font-semibold text-ml-t2 mb-1">Meal Name</label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              className="w-full rounded-lg px-3 py-2 text-sm focus:outline-none"
              style={{ border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text-1)' }}
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-ml-t2 mb-1">Author (optional)</label>
            <input
              type="text"
              value={author}
              onChange={e => setAuthor(e.target.value)}
              className="w-full rounded-lg px-3 py-2 text-sm focus:outline-none"
              style={{ border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text-1)' }}
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-ml-t2 mb-2">Difficulty (optional)</label>
            <div className="flex gap-2">
              {[1, 2, 3, 4, 5].map(v => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setDifficulty(difficulty === v ? null : v)}
                  className="w-9 h-9 rounded-lg text-sm font-semibold transition-all"
                  style={difficulty === v
                    ? { background: 'var(--brand)', border: '1px solid var(--brand)', color: '#fff' }
                    : { border: '1px solid var(--border)', color: 'var(--text-2)', background: 'var(--surface)' }}
                >
                  {v}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-ml-t2 mb-2">Tags <span className="font-normal text-ml-t3">(up to 3, optional)</span></label>
            <TagPicker selected={selectedTags} onChange={setSelectedTags} />
          </div>

          <div>
            <label className="block text-xs font-semibold text-ml-t2 mb-1">Website (optional)</label>
            <input
              type="url"
              value={website}
              onChange={e => setWebsite(e.target.value)}
              placeholder="https://…"
              className="w-full rounded-lg px-3 py-2 text-sm focus:outline-none"
              style={{ border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text-1)' }}
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-ml-t2 mb-1">Story (optional)</label>
            <textarea
              value={story}
              onChange={e => setStory(e.target.value)}
              rows={3}
              placeholder="e.g. Perfect for a summer BBQ, or the story behind this meal…"
              className="w-full rounded-lg px-3 py-2 text-sm focus:outline-none resize-none"
              style={{ border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text-1)' }}
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-ml-t2 mb-1">Recipe (optional)</label>
            <textarea
              value={recipe}
              onChange={e => setRecipe(e.target.value)}
              rows={4}
              className="w-full rounded-lg px-3 py-2 text-sm focus:outline-none resize-none"
              style={{ border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text-1)' }}
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-ml-t2 mb-2">Photo (optional)</label>
            <div className="flex items-center gap-3 flex-wrap">
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className="px-3 py-1.5 text-xs rounded-lg transition-colors"
                style={{ border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text-2)' }}
              >
                Choose photo
              </button>
              <button
                type="button"
                onClick={generatePhoto}
                disabled={generating || !name.trim()}
                className="px-3 py-1.5 text-xs rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                style={{ border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text-2)' }}
              >
                {generating ? 'Generating…' : 'Generate photo'}
              </button>
              {photoPreview && (
                <div className="relative">
                  <img src={photoPreview} alt="preview" className="w-12 h-12 object-cover rounded-lg" style={{ border: '1px solid var(--border)' }} />
                  <button
                    type="button"
                    onClick={() => { setPhotoPreview(''); setPhotoUrl(''); setPendingPhotoDataUrl(null); }}
                    className="absolute -top-1.5 -right-1.5 w-5 h-5 text-white rounded-full text-xs flex items-center justify-center"
                    style={{ background: '#333' }}
                  >✕</button>
                </div>
              )}
            </div>
            {thumbs.length > 0 && (
              <div className="flex gap-2 mt-3">
                {thumbs.map((thumb, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => selectSuggestion(i)}
                    className="flex-1 rounded-lg overflow-hidden"
                    style={{ outline: selectedIdx === i ? '2.5px solid var(--brand)' : '2.5px solid transparent', outlineOffset: '2px' }}
                  >
                    <img src={thumb} alt="" className="w-full aspect-square object-cover block" />
                  </button>
                ))}
              </div>
            )}
            <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handlePhotoChange} />
          </div>

          <div>
            <label className="block text-xs font-semibold text-ml-t2 mb-2">
              Ingredients ({ingredients.length})
            </label>
            <div className="space-y-1.5 max-h-52 overflow-y-auto mb-2">
              {ingredients.map((ing, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input
                    type="text"
                    value={ing.productName}
                    onChange={e => updateIngredientName(i, e.target.value)}
                    className="flex-1 rounded-lg px-2 py-1.5 text-xs focus:outline-none"
                    style={{ border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text-1)' }}
                  />
                  <button type="button" onClick={() => updateIngredientQty(i, -1)} className="w-6 h-6 text-ml-t2 rounded text-xs leading-none flex items-center justify-center transition-colors" style={{ border: '1px solid var(--border)', background: 'var(--surface)' }}>−</button>
                  <span className="text-xs text-ml-t2 w-4 text-center">{ing.quantity ?? 1}</span>
                  <button type="button" onClick={() => updateIngredientQty(i, 1)} className="w-6 h-6 text-ml-t2 rounded text-xs leading-none flex items-center justify-center transition-colors" style={{ border: '1px solid var(--border)', background: 'var(--surface)' }}>+</button>
                  <button type="button" onClick={() => removeIngredient(i)} className="text-xs ml-1 transition-colors" style={{ color: 'var(--brand)' }}>✕</button>
                </div>
              ))}
            </div>
            <div className="flex gap-2">
              <input
                type="text"
                value={newIngredient}
                onChange={e => setNewIngredient(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addIngredient(); } }}
                placeholder="Add ingredient…"
                className="flex-1 rounded-lg px-2 py-1.5 text-xs focus:outline-none"
                style={{ border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text-1)' }}
              />
              <button type="button" onClick={addIngredient} className="px-3 py-1.5 text-xs rounded-lg transition-colors" style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text-2)' }}>+ Add</button>
            </div>
          </div>

          {error && <p className="text-xs" style={{ color: 'var(--brand)' }}>{error}</p>}
        </div>

        <div className="flex gap-3 px-6 py-4" style={{ borderTop: '1px solid var(--border)' }}>
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex-1 text-white text-sm font-semibold rounded-xl py-2.5 disabled:opacity-50 transition-opacity"
            style={{ background: 'var(--brand)' }}
          >
            {saving ? 'Saving…' : 'Save Changes'}
          </button>
          <button
            onClick={handleClose}
            className="px-5 py-2.5 text-sm rounded-xl transition-colors text-ml-t2 hover:bg-ml-surface"
          >
            Cancel
          </button>
        </div>

      </div>
    </div>
  );
}

// ── Create Meal Modal ─────────────────────────────────────────────────────────

function CreateMealModal({ onCreated, onClose, accessToken }: {
  onCreated: (meal: Meal) => void;
  onClose: () => void;
  accessToken: string;
}) {
  const [name, setName] = useState('');
  const [storeId, setStoreId] = useState('');
  const [author, setAuthor] = useState('');
  const [difficulty, setDifficulty] = useState<number | null>(null);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [website, setWebsite] = useState('');
  const [story, setStory] = useState('');
  const [recipe, setRecipe] = useState('');
  const [photoUrl, setPhotoUrl] = useState('');
  const [photoPreview, setPhotoPreview] = useState('');
  const [pendingPhotoDataUrl, setPendingPhotoDataUrl] = useState<string | null>(null);
  const [ingredients, setIngredients] = useState<Ingredient[]>([{ productName: '', searchTerm: '', quantity: 1 }]);
  const [newIngredient, setNewIngredient] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [generating, setGenerating] = useState(false);
  const [thumbs, setThumbs] = useState<string[]>([]);
  const [fulls, setFulls] = useState<string[]>([]);
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const dragRef = useRef(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const handlePhotoChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setThumbs([]); setFulls([]); setSelectedIdx(null);
    const reader = new FileReader();
    reader.onload = ev => {
      const dataUrl = ev.target?.result as string;
      setPhotoPreview(dataUrl);
      setPendingPhotoDataUrl(dataUrl);
      setPhotoUrl('');
    };
    reader.readAsDataURL(file);
  };

  const generatePhoto = async () => {
    if (generating || !name.trim()) return;
    setGenerating(true);
    setThumbs([]); setFulls([]); setSelectedIdx(null);
    setPhotoUrl(''); setPhotoPreview(''); setPendingPhotoDataUrl(null);
    try {
      const res = await fetch('/api/meals/generate-photo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ mealName: name.trim() }),
      });
      const data = await res.json();
      if (res.ok && data.thumbs?.length) {
        setThumbs(data.thumbs);
        setFulls(data.fulls ?? data.thumbs);
      } else {
        setError(data.error || 'No image found for this meal name.');
      }
    } catch { setError('Failed to generate photo.'); }
    finally { setGenerating(false); }
  };

  const selectSuggestion = (i: number) => {
    setPendingPhotoDataUrl(null);
    if (selectedIdx === i) { setSelectedIdx(null); setPhotoUrl(''); setPhotoPreview(''); }
    else { const url = fulls[i] ?? thumbs[i]; setSelectedIdx(i); setPhotoUrl(url); setPhotoPreview(url); }
  };

  const uploadPendingPhoto = async (): Promise<string | null> => {
    if (!pendingPhotoDataUrl) return photoUrl || null;
    const compressed = await compressImage(pendingPhotoDataUrl);
    const res = await fetch('/api/images/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ imageData: compressed }),
    });
    if (res.status === 413) throw new Error('Image is too large. Please choose a smaller photo.');
    if (!res.ok) throw new Error('Photo upload failed. Please try again.');
    const data = await res.json();
    return data.url ?? null;
  };

  const updateIngredientName = (i: number, value: string) =>
    setIngredients(prev => prev.map((ing, idx) => idx === i ? { ...ing, productName: value, searchTerm: value } : ing));

  const updateIngredientQty = (i: number, delta: number) =>
    setIngredients(prev => prev.map((ing, idx) => idx === i ? { ...ing, quantity: Math.max(1, (ing.quantity ?? 1) + delta) } : ing));

  const removeIngredient = (i: number) =>
    setIngredients(prev => prev.filter((_, idx) => idx !== i));

  const addIngredient = () => {
    const trimmed = newIngredient.trim();
    if (!trimmed) return;
    setIngredients(prev => [...prev, { productName: trimmed, searchTerm: trimmed, quantity: 1 }]);
    setNewIngredient('');
  };

  const handleSave = async () => {
    if (!name.trim()) { setError('Meal name is required.'); return; }
    if (!storeId) { setError('Please select a store.'); return; }
    const validIngredients = ingredients.filter(i => i.productName.trim());
    if (validIngredients.length === 0) { setError('Add at least one ingredient.'); return; }
    setSaving(true); setError('');
    try {
      const finalPhotoUrl = await uploadPendingPhoto();
      const res = await fetch('/api/meals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({
          name:       name.trim(),
          storeId,
          ingredients: validIngredients,
          author:     author.trim()  || null,
          difficulty: difficulty     ?? null,
          tags:       selectedTags,
          website:    website.trim() || null,
          story:      story.trim()   || null,
          recipe:     recipe.trim()  || null,
          photoUrl:   finalPhotoUrl,
        }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || 'Failed to create meal.'); return; }
      onCreated(data.meal);
    } catch (err) { setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.'); }
    finally { setSaving(false); }
  };

  const handleClose = () => {
    if (!window.confirm('Discard this meal?')) return;
    onClose();
  };

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
      onMouseDown={e => { dragRef.current = e.target !== e.currentTarget; }}
      onClick={e => { if (e.target !== e.currentTarget || dragRef.current) return; handleClose(); }}
    >
      <div className="rounded-2xl w-full max-w-lg max-h-[90vh] flex flex-col" style={{ background: 'var(--surface-raised)', boxShadow: 'var(--shadow-md)' }}>

        <div className="flex items-center justify-between px-6 py-4" style={{ borderBottom: '1px solid var(--border)' }}>
          <h2 className="text-base font-bold text-ml-t1">Add Meal</h2>
          <button onClick={handleClose} className="text-ml-t3 hover:text-ml-t2 text-xl leading-none transition-colors">&times;</button>
        </div>

        <div className="overflow-y-auto px-6 py-4 space-y-4 flex-1">

          <div>
            <label className="block text-xs font-semibold text-ml-t2 mb-1">Meal Name</label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g., Taco Tuesday"
              className="w-full rounded-lg px-3 py-2 text-sm focus:outline-none"
              style={{ border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text-1)' }}
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-ml-t2 mb-1">Store</label>
            <select
              value={storeId}
              onChange={e => setStoreId(e.target.value)}
              className="w-full rounded-lg px-3 py-2 text-sm focus:outline-none"
              style={{ border: '1px solid var(--border)', background: 'var(--surface)', color: storeId ? 'var(--text-1)' : 'var(--text-3)' }}
            >
              <option value="" disabled>Select a store…</option>
              {Object.entries(STORE_LABELS).map(([id, label]) => (
                <option key={id} value={id}>{label}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs font-semibold text-ml-t2 mb-1">Author (optional)</label>
            <input
              type="text"
              value={author}
              onChange={e => setAuthor(e.target.value)}
              placeholder="e.g., Ina Garten"
              className="w-full rounded-lg px-3 py-2 text-sm focus:outline-none"
              style={{ border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text-1)' }}
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-ml-t2 mb-2">Difficulty (optional)</label>
            <div className="flex gap-2">
              {[1, 2, 3, 4, 5].map(v => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setDifficulty(difficulty === v ? null : v)}
                  className="w-9 h-9 rounded-lg text-sm font-semibold transition-all"
                  style={difficulty === v
                    ? { background: 'var(--brand)', border: '1px solid var(--brand)', color: '#fff' }
                    : { border: '1px solid var(--border)', color: 'var(--text-2)', background: 'var(--surface)' }}
                >
                  {v}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-ml-t2 mb-2">Tags <span className="font-normal text-ml-t3">(up to 3, optional)</span></label>
            <TagPicker selected={selectedTags} onChange={setSelectedTags} />
          </div>

          <div>
            <label className="block text-xs font-semibold text-ml-t2 mb-1">Website (optional)</label>
            <input
              type="url"
              value={website}
              onChange={e => setWebsite(e.target.value)}
              placeholder="https://…"
              className="w-full rounded-lg px-3 py-2 text-sm focus:outline-none"
              style={{ border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text-1)' }}
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-ml-t2 mb-1">Story (optional)</label>
            <textarea
              value={story}
              onChange={e => setStory(e.target.value)}
              rows={3}
              placeholder="e.g. Perfect for a summer BBQ, or the story behind this meal…"
              className="w-full rounded-lg px-3 py-2 text-sm focus:outline-none resize-none"
              style={{ border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text-1)' }}
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-ml-t2 mb-1">Recipe (optional)</label>
            <textarea
              value={recipe}
              onChange={e => setRecipe(e.target.value)}
              rows={4}
              className="w-full rounded-lg px-3 py-2 text-sm focus:outline-none resize-none"
              style={{ border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text-1)' }}
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-ml-t2 mb-2">Photo (optional)</label>
            <div className="flex items-center gap-3 flex-wrap">
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className="px-3 py-1.5 text-xs rounded-lg transition-colors"
                style={{ border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text-2)' }}
              >Choose photo</button>
              <button
                type="button"
                onClick={generatePhoto}
                disabled={generating || !name.trim()}
                className="px-3 py-1.5 text-xs rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                style={{ border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text-2)' }}
              >{generating ? 'Generating…' : 'Generate photo'}</button>
              {photoPreview && (
                <div className="relative">
                  <img src={photoPreview} alt="preview" className="w-12 h-12 object-cover rounded-lg" style={{ border: '1px solid var(--border)' }} />
                  <button
                    type="button"
                    onClick={() => { setPhotoPreview(''); setPhotoUrl(''); setPendingPhotoDataUrl(null); }}
                    className="absolute -top-1.5 -right-1.5 w-5 h-5 text-white rounded-full text-xs flex items-center justify-center"
                    style={{ background: '#333' }}
                  >✕</button>
                </div>
              )}
            </div>
            {thumbs.length > 0 && (
              <div className="flex gap-2 mt-3">
                {thumbs.map((thumb, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => selectSuggestion(i)}
                    className="flex-1 rounded-lg overflow-hidden"
                    style={{ outline: selectedIdx === i ? '2.5px solid var(--brand)' : '2.5px solid transparent', outlineOffset: '2px' }}
                  >
                    <img src={thumb} alt="" className="w-full aspect-square object-cover block" />
                  </button>
                ))}
              </div>
            )}
            <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handlePhotoChange} />
          </div>

          <div>
            <label className="block text-xs font-semibold text-ml-t2 mb-2">Ingredients ({ingredients.filter(i => i.productName.trim()).length})</label>
            <div className="space-y-1.5 max-h-52 overflow-y-auto mb-2">
              {ingredients.map((ing, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input
                    type="text"
                    value={ing.productName}
                    onChange={e => updateIngredientName(i, e.target.value)}
                    placeholder="e.g., Chicken breast"
                    className="flex-1 rounded-lg px-2 py-1.5 text-xs focus:outline-none"
                    style={{ border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text-1)' }}
                  />
                  <button type="button" onClick={() => updateIngredientQty(i, -1)} className="w-6 h-6 text-ml-t2 rounded text-xs leading-none flex items-center justify-center transition-colors" style={{ border: '1px solid var(--border)', background: 'var(--surface)' }}>−</button>
                  <span className="text-xs text-ml-t2 w-4 text-center">{ing.quantity ?? 1}</span>
                  <button type="button" onClick={() => updateIngredientQty(i, 1)} className="w-6 h-6 text-ml-t2 rounded text-xs leading-none flex items-center justify-center transition-colors" style={{ border: '1px solid var(--border)', background: 'var(--surface)' }}>+</button>
                  <button type="button" onClick={() => removeIngredient(i)} className="text-xs ml-1 transition-colors" style={{ color: 'var(--brand)' }}>✕</button>
                </div>
              ))}
            </div>
            <div className="flex gap-2">
              <input
                type="text"
                value={newIngredient}
                onChange={e => setNewIngredient(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addIngredient(); } }}
                placeholder="Add ingredient…"
                className="flex-1 rounded-lg px-2 py-1.5 text-xs focus:outline-none"
                style={{ border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text-1)' }}
              />
              <button type="button" onClick={addIngredient} className="px-3 py-1.5 text-xs rounded-lg transition-colors" style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text-2)' }}>+ Add</button>
            </div>
          </div>

          {error && <p className="text-xs" style={{ color: 'var(--brand)' }}>{error}</p>}
        </div>

        <div className="flex gap-3 px-6 py-4" style={{ borderTop: '1px solid var(--border)' }}>
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex-1 text-white text-sm font-semibold rounded-xl py-2.5 disabled:opacity-50 transition-opacity"
            style={{ background: 'var(--brand)' }}
          >
            {saving ? 'Creating…' : 'Create Meal'}
          </button>
          <button
            onClick={handleClose}
            className="px-5 py-2.5 text-sm rounded-xl transition-colors text-ml-t2 hover:bg-ml-surface"
          >
            Cancel
          </button>
        </div>

      </div>
    </div>
  );
}

// ── Meal Card ─────────────────────────────────────────────────────────────────

function MealDetailModal({
  meal, isPro, isCreator, creatorChecked, copiedMealId,
  krogerConnected, krogerLocationId,
  onEdit, onDelete, onShare, onClose, onCreatorClick,
}: {
  meal: Meal;
  isPro: boolean;
  isCreator: boolean;
  creatorChecked: boolean;
  copiedMealId: string | null;
  krogerConnected: boolean;
  krogerLocationId: string | null;
  onEdit: () => void;
  onDelete: () => void;
  onShare: () => void;
  onClose: () => void;
  onCreatorClick?: (id: string) => void;
}) {
  const dragRef = useRef(false);
  const [krogerLoading, setKrogerLoading] = useState(false);
  const [krogerResult, setKrogerResult] = useState<{ added: string[]; notFound: string[] } | null>(null);

  const handleAddToKroger = async () => {
    if (!krogerLocationId) {
      alert('Please select a Kroger store in Account Settings first.');
      return;
    }
    setKrogerLoading(true);
    setKrogerResult(null);
    try {
      const accessToken = localStorage.getItem('accessToken');
      const res = await fetch('/api/kroger/add-to-cart', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ ingredients: meal.ingredients, locationId: krogerLocationId }),
      });
      const data = await res.json();
      if (res.ok) {
        setKrogerResult({ added: data.added ?? [], notFound: data.notFound ?? [] });
      } else {
        alert(data.error || 'Failed to add to Kroger cart.');
      }
    } catch { alert('Failed to add to Kroger cart.'); }
    finally { setKrogerLoading(false); }
  };
  const websiteHost = meal.website ? (() => {
    try { return new URL(meal.website).hostname.replace('www.', ''); } catch { return meal.website; }
  })() : null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:p-4"
      style={{ background: 'rgba(0,0,0,0.5)' }}
      onMouseDown={e => { dragRef.current = e.target !== e.currentTarget; }}
      onClick={e => { if (e.target !== e.currentTarget || dragRef.current) return; onClose(); }}
    >
      <div
        className="w-full sm:max-w-lg rounded-t-2xl sm:rounded-2xl flex flex-col"
        style={{ background: 'var(--surface-raised)', border: '1px solid var(--border)', maxHeight: '90vh' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between p-5 pb-4" style={{ borderBottom: '1px solid var(--border)' }}>
          <div className="min-w-0 pr-3">
            <h2 className="text-base font-bold text-ml-t1 leading-tight">{meal.name}</h2>
            {meal.author && (
              meal.creator_id && onCreatorClick ? (
                <button
                  className="text-xs mt-0.5 text-left hover:underline"
                  style={{ color: 'var(--brand)', background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
                  onClick={e => { e.stopPropagation(); onClose(); onCreatorClick(meal.creator_id!); }}
                >
                  by {meal.author}
                </button>
              ) : (
                <p className="text-xs mt-0.5" style={{ color: 'var(--brand)' }}>by {meal.author}</p>
              )
            )}
          </div>
          <button onClick={onClose} className="flex-shrink-0 text-ml-t3 hover:text-ml-t1 text-xl leading-none">✕</button>
        </div>

        {/* Body */}
        <div className="overflow-y-auto flex-1 p-5 space-y-4">
          {meal.photo_url && (
            <img src={meal.photo_url} alt={meal.name} className="w-full rounded-xl object-cover" style={{ maxHeight: '220px' }} />
          )}

          <div className="flex items-center gap-4 flex-wrap">
            {meal.difficulty != null && (
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-ml-t3">Difficulty:</span>
                <DifficultyDots level={meal.difficulty} />
              </div>
            )}
            {websiteHost && (
              <a href={meal.website!} target="_blank" rel="noopener noreferrer"
                className="text-xs flex items-center gap-1 hover:underline" style={{ color: 'var(--text-3)' }}>
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
                </svg>
                {websiteHost}
              </a>
            )}
          </div>

          {meal.tags && meal.tags.length > 0 && (
            <div className="flex items-center gap-1.5 flex-wrap">
              {meal.tags.slice(0, 3).map(tag => (
                <span key={tag} className="text-xs px-2 py-0.5 rounded-full" style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text-2)' }}>
                  {tag}
                </span>
              ))}
            </div>
          )}

          {meal.story && (
            <p className="text-sm italic whitespace-pre-wrap leading-relaxed" style={{ color: 'var(--text-2)' }}>{meal.story}</p>
          )}

          <div>
            <p className="text-xs font-semibold uppercase tracking-wide mb-2.5" style={{ color: 'var(--text-3)' }}>Ingredients</p>
            <ul className="space-y-2">
              {meal.ingredients.map((ing, i) => (
                <li key={i} className="flex items-center justify-between gap-4" style={{ borderBottom: '1px solid var(--border)', paddingBottom: '6px' }}>
                  <span className="text-sm text-ml-t1">{ing.productName}</span>
                  <span className="text-xs font-medium text-ml-t3 flex-shrink-0">×{ing.quantity ?? 1}</span>
                </li>
              ))}
            </ul>
          </div>

          {meal.recipe && (
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide mb-2.5" style={{ color: 'var(--text-3)' }}>Recipe</p>
              <p className="text-sm whitespace-pre-wrap leading-relaxed" style={{ color: 'var(--text-2)' }}>{meal.recipe}</p>
            </div>
          )}
        </div>

        {/* Kroger result feedback */}
        {krogerResult && (
          <div className="px-5 pb-3">
            <div className="rounded-xl p-3 text-xs" style={{ background: krogerResult.added.length > 0 ? '#f0fdf4' : 'var(--brand-light)', border: `1px solid ${krogerResult.added.length > 0 ? '#bbf7d0' : 'var(--brand-border)'}` }}>
              {krogerResult.added.length > 0 && (
                <p style={{ color: '#14532d' }}>{krogerResult.added.length} item{krogerResult.added.length !== 1 ? 's' : ''} added to your Kroger cart.</p>
              )}
              {krogerResult.notFound.length > 0 && (
                <p style={{ color: '#9f1239', marginTop: krogerResult.added.length > 0 ? '4px' : 0 }}>Not found: {krogerResult.notFound.join(', ')}</p>
              )}
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="p-4 flex items-center gap-2 flex-wrap" style={{ borderTop: '1px solid var(--border)' }}>
          {krogerConnected && KROGER_API_STORES.has(meal.store_id) && (
            <button
              onClick={handleAddToKroger}
              disabled={krogerLoading}
              className="px-3 py-1.5 text-sm font-semibold rounded-lg transition-colors disabled:opacity-50"
              style={{ background: '#0063a1', color: '#fff', border: 'none', cursor: 'pointer' }}
              onMouseEnter={e => { if (!krogerLoading) (e.currentTarget as HTMLElement).style.background = '#00497a'; }}
              onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = '#0063a1'}
            >
              {krogerLoading ? 'Adding…' : 'Add to Kroger Cart'}
            </button>
          )}
          <button
            onClick={() => { onEdit(); onClose(); }}
            className="px-3 py-1.5 text-sm font-medium rounded-lg transition-colors"
            style={{ color: 'var(--brand)', background: 'var(--brand-light)', border: '1px solid #fecdd3' }}
            onMouseEnter={e => { e.currentTarget.style.background = '#fecdd3'; e.currentTarget.style.borderColor = '#fca5a5'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'var(--brand-light)'; e.currentTarget.style.borderColor = '#fecdd3'; }}
          >
            Edit
          </button>
          <button
            onClick={() => { onDelete(); onClose(); }}
            className="px-3 py-1.5 text-sm font-medium text-ml-t2 rounded-lg transition-colors"
            style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--border)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'var(--surface)')}
          >
            Delete
          </button>
          {creatorChecked && !isCreator && (
            <button onClick={onShare} className="px-3 py-1.5 text-sm font-medium text-blue-600 bg-blue-50 hover:bg-blue-100 rounded-lg transition">
              {copiedMealId === meal.id ? '✓ Link copied!' : 'Share'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Kroger Cart Flow ──────────────────────────────────────────────────────────

function consolidateIngredients(meals: Meal[]): ConsolidatedIngredient[] {
  const map = new Map<string, ConsolidatedIngredient>();
  for (const meal of meals) {
    for (const ing of meal.ingredients) {
      const key = (ing.productName ?? '').toLowerCase().trim();
      if (!key) continue;
      if (map.has(key)) {
        const e = map.get(key)!;
        e.quantity += ing.quantity ?? 1;
        if (!e.mealIds.includes(meal.id)) { e.mealIds.push(meal.id); e.mealNames.push(meal.name); }
      } else {
        map.set(key, { productName: ing.productName, quantity: ing.quantity ?? 1, mealIds: [meal.id], mealNames: [meal.name] });
      }
    }
  }
  return [...map.values()];
}

function KrogerCartFlow({
  meals, locationId, accessToken, onClose, onMealUpdated,
}: {
  meals: Meal[];
  locationId: string;
  accessToken: string;
  onClose: () => void;
  onMealUpdated: (updated: Meal) => void;
}) {
  type Step = 'qty' | 'searching' | 'review' | 'adding' | 'done';
  const [step, setStep] = useState<Step>('qty');
  const [error, setError] = useState('');

  // Step 1 – consolidated ingredient list with editable quantities
  const [items, setItems] = useState<ConsolidatedIngredient[]>(() => consolidateIngredients(meals));

  // Steps 3/4 – results
  const [searchResults, setSearchResults] = useState<KrogerSearchResult[]>([]);
  const [reviewIdx, setReviewIdx] = useState(0);
  const [pickedItems, setPickedItems] = useState<{ upc: string; quantity: number }[]>([]);
  const [totalAdded, setTotalAdded] = useState(0);

  const [selectedSuggIdx, setSelectedSuggIdx] = useState<number | 'custom'>(0);
  const [customText, setCustomText] = useState('');
  const [customSearching, setCustomSearching] = useState(false);

  const reviewQueue = searchResults.filter(r => !r.exact);
  const currentReview = reviewQueue[reviewIdx];

  // Reset selection when moving to next item
  useEffect(() => { setSelectedSuggIdx(0); setCustomText(''); }, [reviewIdx]);

  const handleStartSearch = async () => {
    setStep('searching');
    setError('');
    try {
      const res = await fetch('/api/kroger/search-products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({
          ingredients: items.filter(i => i.quantity > 0).map(i => ({ productName: i.productName, quantity: i.quantity })),
          locationId,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Search failed');

      const results: KrogerSearchResult[] = data.results.map((r: any) => {
        const src = items.find(c => c.productName.toLowerCase().trim() === r.term.toLowerCase().trim());
        return { ...r, suggestions: r.suggestions ?? [], mealIds: src?.mealIds ?? [], mealNames: src?.mealNames ?? [] };
      });
      setSearchResults(results);

      const needsReview = results.filter(r => !r.exact);
      if (needsReview.length === 0) {
        await doAddToCart(results.filter(r => r.upc).map(r => ({ upc: r.upc!, quantity: r.quantity })));
      } else {
        setReviewIdx(0);
        setStep('review');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed');
      setStep('qty');
    }
  };

  const resolveCurrentSelection = async (): Promise<{ upc: string | null; name: string } | null> => {
    if (selectedSuggIdx === 'custom') {
      const term = customText.trim();
      if (!term) return null;
      setCustomSearching(true);
      try {
        const res = await fetch('/api/kroger/search-products', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
          body: JSON.stringify({ ingredients: [{ productName: term, quantity: 1 }], locationId }),
        });
        const data = await res.json();
        const result = data.results?.[0];
        return { upc: result?.upc ?? null, name: term };
      } finally { setCustomSearching(false); }
    }
    const s = currentReview.suggestions[selectedSuggIdx as number];
    return s ? { upc: s.upc, name: s.description } : null;
  };

  const handleReviewDecision = async (action: 'skip' | 'add' | 'update') => {
    const newPicked = [...pickedItems];

    if (action !== 'skip') {
      const resolved = await resolveCurrentSelection();
      if (resolved?.upc) {
        newPicked.push({ upc: resolved.upc, quantity: currentReview.quantity });
      }
      if (action === 'update' && resolved?.name) {
        for (const mealId of currentReview.mealIds) {
          const meal = meals.find(m => m.id === mealId);
          if (!meal) continue;
          const updatedIngredients = meal.ingredients.map(ing =>
            ing.productName.toLowerCase().trim() === currentReview.term.toLowerCase().trim()
              ? { ...ing, productName: resolved.name, searchTerm: resolved.name }
              : ing
          );
          fetch(`/api/meals/${mealId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
            body: JSON.stringify({ ingredients: updatedIngredients }),
          }).then(r => r.ok ? r.json() : null).then(d => { if (d?.meal) onMealUpdated(d.meal); }).catch(() => {});
        }
      }
    }

    if (reviewIdx < reviewQueue.length - 1) {
      setPickedItems(newPicked);
      setReviewIdx(reviewIdx + 1);
    } else {
      const exactItems = searchResults.filter(r => r.exact && r.upc).map(r => ({ upc: r.upc!, quantity: r.quantity }));
      await doAddToCart([...exactItems, ...newPicked]);
    }
  };

  const doAddToCart = async (cartItems: { upc: string; quantity: number }[]) => {
    setStep('adding');
    if (cartItems.length === 0) { setTotalAdded(0); setStep('done'); return; }
    try {
      const res = await fetch('/api/kroger/add-to-cart', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ items: cartItems, locationId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to add to cart');
      setTotalAdded(cartItems.length);
    } catch { setTotalAdded(0); }
    setStep('done');
  };

  const updateQty = (i: number, delta: number) =>
    setItems(prev => prev.map((it, idx) => idx === i ? { ...it, quantity: Math.max(0, it.quantity + delta) } : it));

  const removeItem = (i: number) =>
    setItems(prev => prev.map((it, idx) => idx === i ? { ...it, quantity: 0 } : it));

  const storeColor = '#0063a1';

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:p-4" style={{ background: 'rgba(0,0,0,0.55)' }}>
      <div className="w-full sm:max-w-xl rounded-t-2xl sm:rounded-2xl flex flex-col" style={{ background: 'var(--surface-raised)', border: '1px solid var(--border)', maxHeight: '90vh' }} onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4" style={{ borderBottom: '1px solid var(--border)' }}>
          <h2 className="text-base font-bold text-ml-t1">
            {step === 'qty' && 'Review Ingredients'}
            {step === 'searching' && 'Finding Products…'}
            {step === 'review' && `Review Match (${reviewIdx + 1} of ${reviewQueue.length})`}
            {step === 'adding' && 'Adding to Cart…'}
            {step === 'done' && 'Done!'}
          </h2>
          <button onClick={onClose} className="text-ml-t3 hover:text-ml-t1 text-xl leading-none">✕</button>
        </div>

        {/* Step 1 – Qty review */}
        {step === 'qty' && (
          <>
            <div className="overflow-y-auto flex-1 px-5 py-4 space-y-1">
              <p className="text-xs text-ml-t3 mb-3">
                {meals.length} meal{meals.length !== 1 ? 's' : ''} · {items.length} ingredient{items.length !== 1 ? 's' : ''}
              </p>
              {items.map((it, i) => {
                const zeroed = it.quantity === 0;
                return (
                  <div key={i} className="flex items-center gap-2 py-2" style={{ borderBottom: '1px solid var(--border)', opacity: zeroed ? 0.45 : 1 }}>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-ml-t1 truncate" style={{ textDecoration: zeroed ? 'line-through' : 'none' }}>{it.productName}</p>
                      <p className="text-xs text-ml-t3 truncate">{it.mealNames.join(', ')}</p>
                    </div>
                    <button onClick={() => updateQty(i, -1)} disabled={zeroed} className="w-6 h-6 rounded text-xs flex items-center justify-center flex-shrink-0 disabled:opacity-30" style={{ border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text-2)' }}>−</button>
                    <span className="w-4 text-center text-xs text-ml-t2 flex-shrink-0">{it.quantity}</span>
                    <button onClick={() => updateQty(i, 1)} className="w-6 h-6 rounded text-xs flex items-center justify-center flex-shrink-0" style={{ border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text-2)' }}>+</button>
                    <button onClick={() => removeItem(i)} className="text-xs ml-1 flex-shrink-0" style={{ color: zeroed ? 'var(--brand)' : 'var(--text-3)', background: 'none', border: 'none', cursor: 'pointer' }} title={zeroed ? 'Restore' : 'Remove'}>
                      {zeroed ? '↩' : '✕'}
                    </button>
                  </div>
                );
              })}
              {error && <p className="text-xs pt-2" style={{ color: 'var(--brand)' }}>{error}</p>}
            </div>
            <div className="px-5 py-4 flex gap-3" style={{ borderTop: '1px solid var(--border)' }}>
              <button
                onClick={handleStartSearch}
                disabled={items.filter(i => i.quantity > 0).length === 0}
                className="flex-1 text-white text-sm font-semibold rounded-xl py-2.5 disabled:opacity-40"
                style={{ background: storeColor }}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = '#004d82'; }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = storeColor; }}
              >
                Search Kroger Products →
              </button>
              <button onClick={onClose} className="px-4 text-sm text-ml-t2 rounded-xl" style={{ border: '1px solid var(--border)' }}>Cancel</button>
            </div>
          </>
        )}

        {/* Step 2 – Searching */}
        {step === 'searching' && (
          <div className="flex-1 flex flex-col items-center justify-center py-12 gap-4">
            <div className="w-8 h-8 rounded-full animate-spin" style={{ border: '3px solid var(--border)', borderTopColor: storeColor }} />
            <p className="text-sm text-ml-t2">Searching for {items.length} ingredient{items.length !== 1 ? 's' : ''}…</p>
          </div>
        )}

        {/* Step 3 – Review non-exact matches */}
        {step === 'review' && currentReview && (() => {
          const hasSuggestions = currentReview.suggestions.length > 0;
          const canAdd = hasSuggestions
            ? (selectedSuggIdx !== 'custom' || customText.trim().length > 0)
            : (selectedSuggIdx === 'custom' && customText.trim().length > 0);
          const isProcessing = customSearching;

          return (
            <>
              <div className="flex-1 px-5 py-4 overflow-y-auto space-y-3">
                {/* What was searched */}
                <div className="rounded-xl px-4 py-3" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
                  <p className="text-xs text-ml-t3 mb-0.5">You searched for</p>
                  <p className="text-sm font-semibold text-ml-t1">{currentReview.term}</p>
                  {currentReview.mealNames.length > 0 && (
                    <p className="text-xs text-ml-t3 mt-0.5">from: {currentReview.mealNames.join(', ')}</p>
                  )}
                </div>

                {/* Selectable suggestions */}
                <div>
                  <p className="text-xs font-semibold text-ml-t3 mb-2 uppercase tracking-wide">
                    {hasSuggestions ? 'Kroger suggests' : 'No match found'}
                  </p>
                  <div className="space-y-1.5">
                    {currentReview.suggestions.map((s, i) => (
                      <button
                        key={i}
                        type="button"
                        onClick={() => setSelectedSuggIdx(i)}
                        className="w-full text-left px-3 py-2.5 rounded-lg text-sm transition-all"
                        style={{
                          border: `1.5px solid ${selectedSuggIdx === i ? storeColor : 'var(--border)'}`,
                          background: selectedSuggIdx === i ? '#e8f4fb' : 'var(--surface)',
                          color: 'var(--text-1)',
                        }}
                      >
                        {s.description}
                      </button>
                    ))}

                    {/* Custom / free text option */}
                    <div>
                      <button
                        type="button"
                        onClick={() => setSelectedSuggIdx('custom')}
                        className="w-full text-left px-3 py-2.5 rounded-lg text-sm transition-all"
                        style={{
                          border: `1.5px solid ${selectedSuggIdx === 'custom' ? storeColor : 'var(--border)'}`,
                          background: selectedSuggIdx === 'custom' ? '#e8f4fb' : 'var(--surface)',
                          color: selectedSuggIdx === 'custom' ? 'var(--text-1)' : 'var(--text-3)',
                        }}
                      >
                        Other — type a product name…
                      </button>
                      {selectedSuggIdx === 'custom' && (
                        <input
                          autoFocus
                          type="text"
                          value={customText}
                          onChange={e => setCustomText(e.target.value)}
                          placeholder="e.g. Ground Beef 80/20"
                          className="w-full mt-1.5 px-3 py-2 text-sm rounded-lg focus:outline-none"
                          style={{ border: `1.5px solid ${storeColor}`, background: 'var(--surface)', color: 'var(--text-1)' }}
                        />
                      )}
                    </div>
                  </div>
                </div>
              </div>

              <div className="px-5 py-4 flex flex-col gap-2" style={{ borderTop: '1px solid var(--border)' }}>
                <button
                  onClick={() => handleReviewDecision('update')}
                  disabled={!canAdd || isProcessing}
                  className="w-full text-sm font-semibold rounded-xl py-2.5 text-white disabled:opacity-40"
                  style={{ background: storeColor }}
                  onMouseEnter={e => { if (canAdd) (e.currentTarget as HTMLElement).style.background = '#004d82'; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = storeColor; }}
                >
                  {isProcessing ? 'Searching…' : 'Add & Update Meal Ingredient'}
                </button>
                <button
                  onClick={() => handleReviewDecision('add')}
                  disabled={!canAdd || isProcessing}
                  className="w-full text-sm font-medium rounded-xl py-2.5 disabled:opacity-40"
                  style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text-1)' }}
                  onMouseEnter={e => { if (canAdd) (e.currentTarget as HTMLElement).style.background = 'var(--border)'; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'var(--surface)'; }}
                >
                  Add to Cart Only
                </button>
                <button
                  onClick={() => handleReviewDecision('skip')}
                  disabled={isProcessing}
                  className="w-full text-sm rounded-xl py-2 text-ml-t3 disabled:opacity-40"
                  style={{ background: 'none', border: 'none', cursor: 'pointer' }}
                >
                  Skip this ingredient
                </button>
              </div>
            </>
          );
        })()}

        {/* Step 4 – Adding */}
        {step === 'adding' && (
          <div className="flex-1 flex flex-col items-center justify-center py-12 gap-4">
            <div className="w-8 h-8 rounded-full animate-spin" style={{ border: '3px solid var(--border)', borderTopColor: storeColor }} />
            <p className="text-sm text-ml-t2">Adding items to your Kroger cart…</p>
          </div>
        )}

        {/* Step 5 – Done */}
        {step === 'done' && (
          <>
            <div className="flex-1 flex flex-col items-center justify-center py-10 px-6 gap-3 text-center">
              {totalAdded > 0
                ? <><div className="text-4xl mb-2">🛒</div><p className="text-base font-bold text-ml-t1">{totalAdded} item{totalAdded !== 1 ? 's' : ''} added to your Kroger cart!</p><p className="text-sm text-ml-t3">Open kroger.com to review and checkout.</p></>
                : <><div className="text-4xl mb-2">😔</div><p className="text-base font-bold text-ml-t1">No items were added.</p><p className="text-sm text-ml-t3">No matching products were found or all were skipped.</p></>
              }
            </div>
            <div className="px-5 py-4" style={{ borderTop: '1px solid var(--border)' }}>
              <button onClick={onClose} className="w-full text-sm font-semibold rounded-xl py-2.5 text-white" style={{ background: storeColor }}>Done</button>
            </div>
          </>
        )}

      </div>
    </div>
  );
}

function DashboardMealCard({
  meal, isPro, isCreator, creatorChecked, copiedMealId,
  krogerConnected, krogerLocationId,
  selectMode, selected, onToggleSelect,
  onEdit, onDelete, onShare, onRemovePhoto, onCreatorClick,
}: {
  meal: Meal;
  isPro: boolean;
  isCreator: boolean;
  creatorChecked: boolean;
  copiedMealId: string | null;
  krogerConnected: boolean;
  krogerLocationId: string | null;
  selectMode?: boolean;
  selected?: boolean;
  onToggleSelect?: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onShare: () => void;
  onRemovePhoto: () => void;
  onCreatorClick?: (id: string) => void;
}) {
  const [detailOpen, setDetailOpen] = useState(false);

  const websiteHost = meal.website ? (() => {
    try { return new URL(meal.website).hostname.replace('www.', ''); } catch { return meal.website; }
  })() : null;

  return (
    <>
      {detailOpen && (
        <MealDetailModal
          meal={meal}
          isPro={isPro}
          isCreator={isCreator}
          creatorChecked={creatorChecked}
          copiedMealId={copiedMealId}
          krogerConnected={krogerConnected}
          krogerLocationId={krogerLocationId}
          onEdit={onEdit}
          onDelete={onDelete}
          onShare={onShare}
          onClose={() => setDetailOpen(false)}
          onCreatorClick={onCreatorClick}
        />
      )}

      <div
        className="flex items-start gap-4 p-4 rounded-xl cursor-pointer relative"
        style={{
          border: `1px solid ${selected ? '#0063a1' : 'var(--border)'}`,
          background: selected ? '#e8f4fb' : 'var(--surface-raised)',
          outline: selected ? '2px solid #0063a1' : 'none',
          outlineOffset: '-1px',
        }}
        onClick={() => selectMode ? onToggleSelect?.() : setDetailOpen(true)}
        onMouseEnter={e => { if (!selected) (e.currentTarget as HTMLElement).style.background = 'var(--surface)'; }}
        onMouseLeave={e => { if (!selected) (e.currentTarget as HTMLElement).style.background = 'var(--surface-raised)'; }}
      >
        {selectMode && (
          <div
            className="absolute top-2 right-2 w-5 h-5 rounded flex items-center justify-center flex-shrink-0"
            style={{
              background: selected ? '#0063a1' : 'var(--surface)',
              border: `2px solid ${selected ? '#0063a1' : 'var(--border)'}`,
            }}
          >
            {selected && <svg width="10" height="10" viewBox="0 0 12 12" fill="none"><polyline points="1.5,6 4.5,9 10.5,3" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>}
          </div>
        )}
        <div className="hidden sm:block">
          {meal.photo_url ? (
            <div className="flex-shrink-0">
              <img src={meal.photo_url} alt={meal.name} className="object-cover rounded-lg" style={{ width: '120px', height: '120px', border: '1px solid var(--border)' }} />
            </div>
          ) : (
            <div className="rounded-lg flex-shrink-0 flex items-center justify-center" style={{ width: '120px', height: '120px', background: 'var(--surface)', border: '1px solid var(--border)' }}>
              <span className="text-2xl">🍽️</span>
            </div>
          )}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2">
            <p className="text-sm font-semibold text-ml-t1">{meal.name}</p>
          </div>

          {(meal.author || meal.website) && (
            <div className="flex items-center gap-2 mt-0.5 flex-wrap">
              {meal.author && (
                meal.creator_id && onCreatorClick ? (
                  <button
                    className="text-xs text-left hover:underline"
                    style={{ color: 'var(--brand)', background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
                    onClick={e => { e.stopPropagation(); onCreatorClick(meal.creator_id!); }}
                  >
                    by {meal.author}
                  </button>
                ) : (
                  <span className="text-xs" style={{ color: 'var(--brand)' }}>by {meal.author}</span>
                )
              )}
              {meal.author && meal.website && <span className="text-xs text-ml-t3">·</span>}
              {meal.website && (
                <a
                  href={meal.website}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs flex items-center gap-1 hover:underline"
                  style={{ color: 'var(--text-3)' }}
                  onClick={e => e.stopPropagation()}
                >
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
                  </svg>
                  {websiteHost}
                </a>
              )}
            </div>
          )}

          {meal.difficulty != null && (
            <div className="flex items-center gap-2 mt-1">
              <span className="text-xs text-ml-t3">Difficulty:</span>
              <DifficultyDots level={meal.difficulty} />
            </div>
          )}

          {meal.tags && meal.tags.length > 0 && (
            <div className="flex items-center gap-1 flex-wrap mt-1">
              {meal.tags.slice(0, 3).map(tag => (
                <span key={tag} className="text-xs px-2 py-0.5 rounded-full" style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text-2)' }}>
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

          <div className="flex items-center gap-2 mt-3 flex-wrap">
            <button
              onClick={e => { e.stopPropagation(); setDetailOpen(true); }}
              className="px-3 py-1 text-xs font-medium text-ml-t2 rounded-lg transition-colors"
              style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--border)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'var(--surface)')}
            >
              View
            </button>
            <button
              onClick={e => { e.stopPropagation(); onEdit(); }}
              className="px-3 py-1 text-xs font-medium rounded-lg transition-colors"
              style={{ color: 'var(--brand)', background: 'var(--brand-light)', border: '1px solid #fecdd3' }}
              onMouseEnter={e => { e.currentTarget.style.background = '#fecdd3'; e.currentTarget.style.borderColor = '#fca5a5'; }}
              onMouseLeave={e => { e.currentTarget.style.background = 'var(--brand-light)'; e.currentTarget.style.borderColor = '#fecdd3'; }}
            >
              Edit
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function MyMealsPage() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [isCreator, setIsCreator] = useState(false);
  const [creatorChecked, setCreatorChecked] = useState(false);

  const [meals, setMeals] = useState<Meal[]>([]);
  const [mealsLoading, setMealsLoading] = useState(true);
  const [mealSearch, setMealSearch] = useState('');
  const [filters, setFilters] = useState<MealFilters>(EMPTY_FILTERS);
  const [ownerFilter, setOwnerFilter] = useState<'all' | 'mine'>('all');
  const [filterOpen, setFilterOpen] = useState(false);
  const filterBtnRef = useRef<HTMLDivElement>(null);
  const [editingMeal, setEditingMeal] = useState<Meal | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [copiedMealId, setCopiedMealId] = useState<string | null>(null);
  const [creatorPopupId, setCreatorPopupId] = useState<string | null>(null);
  const [accessToken, setAccessToken] = useState('');
  const [krogerConnected, setKrogerConnected] = useState(false);
  const [krogerLocationId, setKrogerLocationId] = useState<string | null>(null);

  // Store pill filter + multi-select for Kroger cart
  const [selectedStore, setSelectedStore] = useState<string | null>(null);
  const [selectedMealIds, setSelectedMealIds] = useState<Set<string>>(new Set());
  const [showKrogerFlow, setShowKrogerFlow] = useState(false);
  const [krogerConnecting, setKrogerConnecting] = useState(false);

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

      // Handle Kroger OAuth callback redirect
      const params = new URLSearchParams(window.location.search);
      const krogerParam = params.get('kroger');
      if (krogerParam) {
        window.history.replaceState({}, '', '/my-meals');
        if (krogerParam === 'connected') {
          // Restore pending cart selection from before OAuth redirect
          try {
            const pending = sessionStorage.getItem('pendingKrogerCart');
            if (pending) {
              sessionStorage.removeItem('pendingKrogerCart');
              const { mealIds, storeId } = JSON.parse(pending);
              if (storeId) setSelectedStore(storeId);
              if (mealIds?.length) setSelectedMealIds(new Set(mealIds));
            }
          } catch { /* ignore */ }
        }
      }

      const response = await fetch('/api/auth/verify', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (!response.ok) { localStorage.clear(); router.push('/'); return; }

      const data = await response.json();
      setUser(data.user);
      setAccessToken(accessToken);

      fetch('/api/creator/me', {
        headers: { Authorization: `Bearer ${accessToken}` },
      }).then(r => r.ok ? r.json() : null).then(d => {
        if (d?.creator) setIsCreator(true);
        setCreatorChecked(true);
      }).catch(() => { setCreatorChecked(true); });

      fetch('/api/kroger/status', {
        headers: { Authorization: `Bearer ${accessToken}` },
      }).then(r => r.ok ? r.json() : null).then(d => {
        if (d?.connected) {
          setKrogerConnected(true);
          setKrogerLocationId(d.locationId ?? null);
        }
      }).catch(() => {});

      setLoading(false);
      loadMeals(accessToken);
    } catch {
      localStorage.clear();
      router.push('/');
    }
  };

  const loadMeals = async (token: string) => {
    setMealsLoading(true);
    try {
      const res = await fetch('/api/meals', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        const loaded: Meal[] = data.meals ?? [];
        setMeals(loaded);
        // Auto-select the store with the most meals (only on first load)
        setSelectedStore(prev => {
          if (prev) return prev; // already set (e.g. restored from sessionStorage)
          if (loaded.length === 0) return null;
          const counts: Record<string, number> = {};
          for (const m of loaded) counts[m.store_id] = (counts[m.store_id] ?? 0) + 1;
          return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
        });
      }
    } finally {
      setMealsLoading(false);
    }
  };

  const handleDelete = async (meal: Meal) => {
    if (!window.confirm(`Move "${meal.name}" to trash? You can recover it from Account Settings.`)) return;
    const accessToken = localStorage.getItem('accessToken')!;
    const res = await fetch(`/api/meals/${meal.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (res.ok) {
      setMeals(prev => prev.filter(m => m.id !== meal.id));
    } else {
      alert('Failed to delete meal. Please try again.');
    }
  };

  const handleShare = async (meal: Meal) => {
    const accessToken = localStorage.getItem('accessToken')!;
    const res = await fetch(`/api/meals/${meal.id}/share`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) { alert('Failed to generate share link.'); return; }
    const { shareUrl } = await res.json();
    await navigator.clipboard.writeText(shareUrl).catch(() => {
      prompt('Copy this share link:', shareUrl);
    });
    setCopiedMealId(meal.id);
    setTimeout(() => setCopiedMealId(id => (id === meal.id ? null : id)), 3000);
  };

  const handleRemovePhoto = async (meal: Meal) => {
    const accessToken = localStorage.getItem('accessToken')!;
    const res = await fetch(`/api/meals/${meal.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ photoUrl: null }),
    });
    if (res.ok) {
      setMeals(prev => prev.map(m => m.id === meal.id ? { ...m, photo_url: null } : m));
    }
  };

  const handleKrogerCartClick = async () => {
    if (selectedMealIds.size === 0) return;
    if (!krogerConnected || !krogerLocationId) {
      // Save pending selection to sessionStorage and start OAuth
      setKrogerConnecting(true);
      try {
        sessionStorage.setItem('pendingKrogerCart', JSON.stringify({
          mealIds: [...selectedMealIds],
          storeId: selectedStore,
        }));
        const res = await fetch('/api/kroger/connect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
          body: JSON.stringify({ returnTo: '/my-meals' }),
        });
        const data = await res.json();
        if (data.redirectUrl) window.location.href = data.redirectUrl;
      } catch { setKrogerConnecting(false); }
      return;
    }
    setShowKrogerFlow(true);
  };

  const notifyExtension = () => {
    window.dispatchEvent(new CustomEvent('mealio:mealsChanged'));
  };

  const handleEditSaved = (updated: Meal) => {
    setMeals(prev => prev.map(m => (m.id === updated.id ? updated : m)));
    setEditingMeal(null);
    notifyExtension();
  };

  const handleMealCreated = (meal: Meal) => {
    setMeals(prev => [...prev, meal]);
    setShowCreateModal(false);
    notifyExtension();
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-ml-bg flex items-center justify-center">
        <div className="w-10 h-10 border-4 border-t-transparent rounded-full animate-spin" style={{ borderColor: 'var(--border)', borderTopColor: 'var(--brand)' }} />
      </div>
    );
  }

  const isPro = user?.tier === 'paid';

  return (
    <div className="min-h-screen bg-ml-bg flex flex-col">

      <AppHeader />

      {/* Upgrade nudge */}
      {!isPro && (
        <div className="w-full py-2.5 px-4 text-center text-sm" style={{ background: 'var(--brand-light)', borderBottom: '1px solid #fecdd3', color: 'var(--brand)' }}>
          <span className="font-medium">Free plan: </span>limited to 3 saved meals.{' '}
          <a href="/pricing" className="underline font-semibold hover:opacity-80 transition-opacity">Upgrade to Full Access →</a>
        </div>
      )}

      <div className="max-w-7xl mx-auto px-6 py-10 w-full flex-1">

        <ExtensionNudge />

        {/* Mobile: one-click cart info (extension nudge is desktop-only) */}
        <p className="sm:hidden text-xs mb-6" style={{ color: 'var(--text-3)' }}>
          One-click add to cart is available on desktop with the Mealio browser extension.
        </p>

        {/* Page header */}
        <div className="mb-8 flex items-end justify-between gap-4">
          <div>
            <h1 className="text-5xl font-bold text-ml-t1 leading-tight">
              Your saved<br />
              <span style={{ borderBottom: '4px solid var(--brand)', paddingBottom: '3px' }}>meals.</span>
            </h1>
          </div>
          <button
            onClick={() => router.push('/discover')}
            className="flex-shrink-0 flex items-center gap-2 text-sm font-medium text-ml-t2 hover:text-ml-t1 transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6"/>
            </svg>
            Discover
          </button>
        </div>

        <div className="lg:flex lg:gap-8 lg:items-start">

          {/* Desktop sidebar */}
          {!mealsLoading && meals.length > 0 && (() => {
            const customMealTags = [...new Set(meals.flatMap(m => m.tags || []).filter(t => !ALL_TAGS.includes(t)))];
            const authorSuggestions = [...new Set(meals.map(m => m.author).filter((a): a is string => Boolean(a)))];
            return (
              <aside className="hidden lg:block w-64 flex-shrink-0 sticky top-6">
                <div className="rounded-xl overflow-hidden" style={{ background: 'var(--surface-raised)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-sm)' }}>
                  {/* Owner filter */}
                  <div className="p-3 border-b" style={{ borderColor: 'var(--border)' }}>
                    <div className="flex gap-1 p-1 rounded-lg" style={{ background: 'var(--surface)' }}>
                      {(['all', 'mine'] as const).map(v => (
                        <button key={v} type="button" onClick={() => setOwnerFilter(v)}
                          className="flex-1 py-1.5 text-xs font-semibold rounded-md transition-all"
                          style={ownerFilter === v
                            ? { background: 'var(--surface-raised)', color: 'var(--text-1)', boxShadow: 'var(--shadow-sm)', border: 'none', cursor: 'pointer' }
                            : { background: 'transparent', color: 'var(--text-2)', border: 'none', cursor: 'pointer' }}>
                          {v === 'all' ? 'All' : 'Created By Me'}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="p-4">
                    <FilterPanel filters={filters} onChange={setFilters} onClose={() => {}} authorSuggestions={authorSuggestions} extraTags={customMealTags} inline />
                  </div>
                </div>
              </aside>
            );
          })()}

        {/* My Meals */}
        <div className="flex-1 min-w-0 rounded-xl p-8 mb-6" style={{ background: 'var(--surface-raised)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-sm)' }}>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-bold text-ml-t1">My Meals</h2>
            <div className="flex items-center gap-3">
              {!mealsLoading && (
                <span className="text-xs text-ml-t3">{meals.length} meal{meals.length !== 1 ? 's' : ''}</span>
              )}
              <button
                onClick={() => setShowCreateModal(true)}
                className="px-3 py-1.5 text-xs font-semibold rounded-lg text-white transition-opacity hover:opacity-90"
                style={{ background: 'var(--brand)' }}
              >
                + Add Meal
              </button>
            </div>
          </div>

          {/* Store pills */}
          {!mealsLoading && meals.length > 0 && (() => {
            const storeCounts: Record<string, number> = {};
            for (const m of meals) storeCounts[m.store_id] = (storeCounts[m.store_id] ?? 0) + 1;
            const storeIds = Object.keys(storeCounts).sort((a, b) => storeCounts[b] - storeCounts[a]);
            return (
              <div className="flex gap-2 flex-wrap mb-4 pb-4" style={{ borderBottom: '1px solid var(--border)' }}>
                {storeIds.map(storeId => {
                  const color = STORE_COLORS[storeId];
                  const isSelected = selectedStore === storeId;
                  return (
                    <button
                      key={storeId}
                      type="button"
                      onClick={() => { setSelectedStore(storeId); setSelectedMealIds(new Set()); }}
                      className="px-3 py-1 rounded-full text-xs font-semibold transition-all"
                      style={isSelected
                        ? { background: color ?? 'var(--text-1)', color: '#fff', border: `1.5px solid ${color ?? 'var(--text-1)'}` }
                        : { background: 'transparent', color: 'var(--text-2)', border: '1.5px solid var(--border)' }}
                    >
                      {STORE_LABELS[storeId] ?? storeId} ({storeCounts[storeId]})
                    </button>
                  );
                })}
              </div>
            );
          })()}

          {/* Select-mode banner for Kroger stores */}
          {selectedStore && KROGER_API_STORES.has(selectedStore) && !mealsLoading && (
            <div className="flex items-center gap-3 mb-4 px-3 py-2 rounded-lg text-xs" style={{ background: '#e8f4fb', border: '1px solid #bae6fd', color: '#0369a1' }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4m0 4h.01"/></svg>
              <span>Select meals below to add their ingredients to your Kroger cart.</span>
              {selectedMealIds.size > 0 && (
                <button type="button" onClick={() => setSelectedMealIds(new Set())} className="ml-auto underline" style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#0369a1' }}>
                  Clear ({selectedMealIds.size})
                </button>
              )}
            </div>
          )}

          {!mealsLoading && meals.length > 0 && (() => {
            const activeFilterCount = [filters.authors.length > 0, filters.tags.length > 0, filters.ingredients.length > 0, filters.difficulty.length > 0, filters.excludeIngredients.length > 0].filter(Boolean).length;
            const customMealTags = [...new Set(meals.flatMap(m => m.tags || []).filter(t => !ALL_TAGS.includes(t)))];
            const authorSuggestions = [...new Set(meals.map(m => m.author).filter((a): a is string => Boolean(a)))];
            return (
              <div className="flex flex-col gap-2 mb-4">
              <div className="lg:hidden flex gap-1 p-1 rounded-lg self-start" style={{ background: 'var(--surface)' }}>
                {(['all', 'mine'] as const).map(v => (
                  <button key={v} type="button" onClick={() => setOwnerFilter(v)}
                    className="px-3 py-1.5 text-xs font-semibold rounded-md transition-all"
                    style={ownerFilter === v
                      ? { background: 'var(--surface-raised)', color: 'var(--text-1)', boxShadow: 'var(--shadow-sm)', border: 'none', cursor: 'pointer' }
                      : { background: 'transparent', color: 'var(--text-2)', border: 'none', cursor: 'pointer' }}>
                    {v === 'all' ? 'All' : 'Created By Me'}
                  </button>
                ))}
              </div>
              <div className="flex gap-2 items-center">
                <div className="relative flex-1">
                  <svg className="absolute left-3 top-1/2 -translate-y-1/2" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--text-3)' }}>
                    <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
                  </svg>
                  <input
                    type="text"
                    value={mealSearch}
                    onChange={e => setMealSearch(e.target.value)}
                    placeholder="Search meals, authors…"
                    className="w-full pl-8 pr-4 py-1.5 text-sm rounded-lg focus:outline-none"
                    style={{ border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text-1)' }}
                  />
                </div>
                <div ref={filterBtnRef} className="lg:hidden" style={{ position: 'relative', flexShrink: 0 }}>
                  <button type="button" onClick={() => setFilterOpen(v => !v)}
                    style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '6px 10px', borderRadius: 8, fontSize: 12, fontWeight: 600, border: '1px solid var(--border)', background: (filterOpen || activeFilterCount > 0) ? 'var(--brand)' : 'var(--surface)', color: (filterOpen || activeFilterCount > 0) ? '#fff' : 'var(--text-2)', cursor: 'pointer', whiteSpace: 'nowrap' }}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>
                    </svg>
                    Filter{activeFilterCount > 0 ? ` (${activeFilterCount})` : ''}
                  </button>
                  {filterOpen && <FilterPanel filters={filters} onChange={setFilters} onClose={() => setFilterOpen(false)} authorSuggestions={authorSuggestions} extraTags={customMealTags} />}
                </div>
              </div>
              </div>
            );
          })()}

          {mealsLoading ? (
            <div className="flex justify-center py-8">
              <div className="w-7 h-7 rounded-full animate-spin" style={{ border: '3px solid var(--border)', borderTopColor: 'var(--brand)' }} />
            </div>
          ) : meals.length === 0 ? (
            <div className="text-center py-10">
              <p className="text-sm text-ml-t3 mb-1">No meals saved yet.</p>
              <p className="text-xs text-ml-t3 opacity-60">Use the web extension to record your first meal.</p>
            </div>
          ) : (
            (() => {
              const q = mealSearch.trim().toLowerCase();
              const isKrogerSelectMode = !!(selectedStore && KROGER_API_STORES.has(selectedStore));
              const filtered = meals.filter(m => {
                if (selectedStore && m.store_id !== selectedStore) return false;
                if (ownerFilter === 'mine' && m.creator_id) return false;
                if (q && !(m.name.toLowerCase().includes(q) || m.author?.toLowerCase().includes(q))) return false;
                if (filters.authors.length > 0 && !filters.authors.some(a => m.author?.toLowerCase().includes(a.toLowerCase()))) return false;
                if (filters.tags.length > 0 && !filters.tags.some(t => m.tags?.includes(t))) return false;
                if (filters.ingredients.length > 0 && !filters.ingredients.every(ing => m.ingredients.some(i => i.productName.toLowerCase().includes(ing)))) return false;
                if (filters.difficulty.length > 0 && !filters.difficulty.includes(m.difficulty ?? -1)) return false;
                if (filters.excludeIngredients.length > 0 && filters.excludeIngredients.some(ex => m.ingredients.some(i => i.productName.toLowerCase().includes(ex)))) return false;
                return true;
              }).sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''));
              return filtered.length === 0 ? (
                <p className="text-sm text-ml-t3 py-4 text-center">No meals match your search or filters.</p>
              ) : (
                <div className="columns-1 sm:columns-2 gap-3">
                  {filtered.map(meal => (
                    <div key={meal.id} className="break-inside-avoid mb-3">
                    <DashboardMealCard
                      meal={meal}
                      isPro={isPro}
                      isCreator={isCreator}
                      creatorChecked={creatorChecked}
                      copiedMealId={copiedMealId}
                      krogerConnected={krogerConnected}
                      krogerLocationId={krogerLocationId}
                      selectMode={isKrogerSelectMode}
                      selected={selectedMealIds.has(meal.id)}
                      onToggleSelect={() => setSelectedMealIds(prev => {
                        const next = new Set(prev);
                        if (next.has(meal.id)) next.delete(meal.id); else next.add(meal.id);
                        return next;
                      })}
                      onEdit={() => setEditingMeal(meal)}
                      onDelete={() => handleDelete(meal)}
                      onShare={() => handleShare(meal)}
                      onRemovePhoto={() => handleRemovePhoto(meal)}
                      onCreatorClick={id => setCreatorPopupId(id)}
                    />
                    </div>
                  ))}
                </div>
              );
            })()
          )}
        </div>

        </div>{/* end lg:flex */}

      </div>

      <AppFooter />

      {showCreateModal && (
        <CreateMealModal
          accessToken={localStorage.getItem('accessToken') ?? ''}
          onCreated={handleMealCreated}
          onClose={() => setShowCreateModal(false)}
        />
      )}

      {editingMeal && (
        <EditModal
          meal={editingMeal}
          accessToken={localStorage.getItem('accessToken') ?? ''}
          onSave={handleEditSaved}
          onClose={() => setEditingMeal(null)}
        />
      )}

      {creatorPopupId && accessToken && (
        <CreatorPopup
          creatorId={creatorPopupId}
          token={accessToken}
          onClose={() => setCreatorPopupId(null)}
        />
      )}

      {/* Floating "Add to Kroger Cart" button */}
      {selectedMealIds.size > 0 && selectedStore && KROGER_API_STORES.has(selectedStore) && (
        <div className="fixed bottom-6 left-1/2 z-40" style={{ transform: 'translateX(-50%)' }}>
          <button
            onClick={handleKrogerCartClick}
            disabled={krogerConnecting}
            className="flex items-center gap-2 px-5 py-3 rounded-2xl text-sm font-semibold text-white shadow-lg disabled:opacity-60 transition-transform active:scale-95"
            style={{ background: '#0063a1', boxShadow: '0 4px 20px rgba(0,99,161,0.45)' }}
            onMouseEnter={e => { if (!krogerConnecting) (e.currentTarget as HTMLElement).style.background = '#004d82'; }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = '#0063a1'; }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/>
              <path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/>
            </svg>
            {krogerConnecting ? 'Connecting…' : `Add ${selectedMealIds.size} meal${selectedMealIds.size !== 1 ? 's' : ''} to Kroger Cart`}
          </button>
        </div>
      )}

      {/* Kroger cart flow modal */}
      {showKrogerFlow && selectedStore && KROGER_API_STORES.has(selectedStore) && krogerLocationId && (
        <KrogerCartFlow
          meals={meals.filter(m => selectedMealIds.has(m.id))}
          locationId={krogerLocationId}
          accessToken={accessToken}
          onClose={() => { setShowKrogerFlow(false); setSelectedMealIds(new Set()); }}
          onMealUpdated={updated => setMeals(prev => prev.map(m => m.id === updated.id ? updated : m))}
        />
      )}

    </div>
  );
}
