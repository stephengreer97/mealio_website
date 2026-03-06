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
  const chipStyle = { display: 'inline-flex' as const, alignItems: 'center' as const, gap: 4, padding: '2px 8px', borderRadius: 20, fontSize: 11, background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text-2)' };
  const xStyle = { background: 'none', border: 'none', color: 'var(--text-3)', cursor: 'pointer', padding: 0, fontSize: 13, lineHeight: '1' as const };

  return (
    <div style={{ position: 'absolute', right: 0, top: 'calc(100% + 6px)', zIndex: 200, width: 310, background: 'var(--surface-raised)', border: '1px solid var(--border)', borderRadius: 14, boxShadow: '0 8px 32px rgba(0,0,0,0.18)', padding: 16, maxHeight: '80vh', overflowY: 'auto' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-1)' }}>Filters</span>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button type="button" onClick={() => onChange(EMPTY_FILTERS)} style={{ fontSize: 11, color: 'var(--brand)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>Clear all</button>
          <button type="button" onClick={onClose} style={{ fontSize: 18, lineHeight: '1', color: 'var(--text-2)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>×</button>
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

function EditModal({ meal, onSave, onClose, accessToken }: EditModalProps) {
  const [name, setName] = useState(meal.name);
  const [author, setAuthor] = useState(meal.author ?? '');
  const [difficulty, setDifficulty] = useState<number | null>(meal.difficulty ?? null);
  const [selectedTags, setSelectedTags] = useState<string[]>(meal.tags ?? []);
  const [website, setWebsite] = useState(meal.website ?? '');
  const [recipe, setRecipe] = useState(meal.recipe ?? '');
  const [photoUrl, setPhotoUrl] = useState(meal.photo_url ?? '');
  const [photoPreview, setPhotoPreview] = useState(meal.photo_url ?? '');
  const [ingredients, setIngredients] = useState<Ingredient[]>(
    meal.ingredients.map(i => ({ ...i }))
  );
  const [newIngredient, setNewIngredient] = useState('');
  const [saving, setSaving] = useState(false);
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
      uploadPhoto(dataUrl).then(url => { if (url) setPhotoUrl(url); });
    };
    reader.readAsDataURL(file);
  };

  const generatePhoto = async () => {
    if (generating || !name.trim()) return;
    setGenerating(true);
    setThumbs([]); setFulls([]); setSelectedIdx(null);
    setPhotoUrl(''); setPhotoPreview('');
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
    if (selectedIdx === i) {
      setSelectedIdx(null);
      setPhotoUrl('');
    } else {
      setSelectedIdx(i);
      setPhotoUrl(fulls[i] ?? thumbs[i]);
    }
  };

  const uploadPhoto = async (dataUrl: string): Promise<string | null> => {
    try {
      const res = await fetch('/api/images/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ image: dataUrl }),
      });
      const data = await res.json();
      return data.url ?? null;
    } catch {
      return null;
    }
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
          recipe:     recipe.trim()  || null,
          photoUrl:   photoUrl       || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || 'Failed to save.'); return; }
      onSave(data.meal);
    } catch {
      setError('Something went wrong. Please try again.');
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
      onClick={e => { if (e.target === e.currentTarget) handleClose(); }}
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
                    onClick={() => { setPhotoPreview(''); setPhotoUrl(''); }}
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
  const [recipe, setRecipe] = useState('');
  const [photoUrl, setPhotoUrl] = useState('');
  const [photoPreview, setPhotoPreview] = useState('');
  const [ingredients, setIngredients] = useState<Ingredient[]>([{ productName: '', searchTerm: '', quantity: 1 }]);
  const [newIngredient, setNewIngredient] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [generating, setGenerating] = useState(false);
  const [thumbs, setThumbs] = useState<string[]>([]);
  const [fulls, setFulls] = useState<string[]>([]);
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const uploadPhoto = async (dataUrl: string): Promise<string | null> => {
    try {
      const res = await fetch('/api/images/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ image: dataUrl }),
      });
      const data = await res.json();
      return data.url ?? null;
    } catch { return null; }
  };

  const handlePhotoChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setThumbs([]); setFulls([]); setSelectedIdx(null);
    const reader = new FileReader();
    reader.onload = ev => {
      const dataUrl = ev.target?.result as string;
      setPhotoPreview(dataUrl);
      uploadPhoto(dataUrl).then(url => { if (url) setPhotoUrl(url); });
    };
    reader.readAsDataURL(file);
  };

  const generatePhoto = async () => {
    if (generating || !name.trim()) return;
    setGenerating(true);
    setThumbs([]); setFulls([]); setSelectedIdx(null);
    setPhotoUrl(''); setPhotoPreview('');
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
    if (selectedIdx === i) { setSelectedIdx(null); setPhotoUrl(''); }
    else { setSelectedIdx(i); setPhotoUrl(fulls[i] ?? thumbs[i]); }
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
          recipe:     recipe.trim()  || null,
          photoUrl:   photoUrl       || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || 'Failed to create meal.'); return; }
      onCreated(data.meal);
    } catch { setError('Something went wrong. Please try again.'); }
    finally { setSaving(false); }
  };

  const handleClose = () => {
    if (!window.confirm('Discard this meal?')) return;
    onClose();
  };

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
      onClick={e => { if (e.target === e.currentTarget) handleClose(); }}
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
                    onClick={() => { setPhotoPreview(''); setPhotoUrl(''); }}
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
  onEdit, onDelete, onShare, onClose, onCreatorClick,
}: {
  meal: Meal;
  isPro: boolean;
  isCreator: boolean;
  creatorChecked: boolean;
  copiedMealId: string | null;
  onEdit: () => void;
  onDelete: () => void;
  onShare: () => void;
  onClose: () => void;
  onCreatorClick?: (id: string) => void;
}) {
  const websiteHost = meal.website ? (() => {
    try { return new URL(meal.website).hostname.replace('www.', ''); } catch { return meal.website; }
  })() : null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:p-4"
      style={{ background: 'rgba(0,0,0,0.5)' }}
      onClick={onClose}
    >
      <div
        className="w-full sm:max-w-lg rounded-t-2xl sm:rounded-2xl flex flex-col"
        style={{ background: 'var(--surface-raised)', border: '1px solid var(--border)', maxHeight: '90vh' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between p-5 pb-4" style={{ borderBottom: '1px solid var(--border)' }}>
          <div className="min-w-0 pr-3">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-base font-bold text-ml-t1 leading-tight">{meal.name}</h2>
              <span className="text-xs font-medium rounded-full px-2 py-0.5 flex-shrink-0" style={{ background: STORE_COLORS[meal.store_id] ?? 'var(--surface)', color: STORE_COLORS[meal.store_id] ? '#fff' : 'var(--text-3)', border: STORE_COLORS[meal.store_id] ? 'none' : '1px solid var(--border)' }}>
                {STORE_LABELS[meal.store_id] ?? meal.store_id}
              </span>
            </div>
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

        {/* Footer */}
        <div className="p-4 flex items-center gap-2 flex-wrap" style={{ borderTop: '1px solid var(--border)' }}>
          <button
            onClick={() => { onEdit(); onClose(); }}
            className="px-3 py-1.5 text-sm font-medium text-ml-t2 rounded-lg transition-colors"
            style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--border)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'var(--surface)')}
          >
            Edit
          </button>
          <button
            onClick={() => { onDelete(); onClose(); }}
            className="px-3 py-1.5 text-sm font-medium rounded-lg transition-colors"
            style={{ color: 'var(--brand)', background: 'var(--brand-light)', border: '1px solid #fecdd3' }}
            onMouseEnter={e => { e.currentTarget.style.background = '#fecdd3'; e.currentTarget.style.borderColor = '#fca5a5'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'var(--brand-light)'; e.currentTarget.style.borderColor = '#fecdd3'; }}
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

function DashboardMealCard({
  meal, isPro, isCreator, creatorChecked, copiedMealId,
  onEdit, onDelete, onShare, onRemovePhoto, onCreatorClick,
}: {
  meal: Meal;
  isPro: boolean;
  isCreator: boolean;
  creatorChecked: boolean;
  copiedMealId: string | null;
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
          onEdit={onEdit}
          onDelete={onDelete}
          onShare={onShare}
          onClose={() => setDetailOpen(false)}
          onCreatorClick={onCreatorClick}
        />
      )}

      <div
        className="flex items-start gap-4 p-4 rounded-xl cursor-pointer"
        style={{ border: '1px solid var(--border)', background: 'var(--surface-raised)' }}
        onClick={() => setDetailOpen(true)}
        onMouseEnter={e => (e.currentTarget.style.background = 'var(--surface)')}
        onMouseLeave={e => (e.currentTarget.style.background = 'var(--surface-raised)')}
      >
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
            <span className="flex-shrink-0 text-xs font-medium rounded-full px-2 py-0.5" style={{ background: STORE_COLORS[meal.store_id] ?? 'var(--surface)', color: STORE_COLORS[meal.store_id] ? '#fff' : 'var(--text-3)', border: STORE_COLORS[meal.store_id] ? 'none' : '1px solid var(--border)' }}>
              {STORE_LABELS[meal.store_id] ?? meal.store_id}
            </span>
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
              onClick={e => { e.stopPropagation(); onEdit(); }}
              className="px-3 py-1 text-xs font-medium text-ml-t2 rounded-lg transition-colors"
              style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--border)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'var(--surface)')}
            >
              Edit
            </button>
            <button
              onClick={e => { e.stopPropagation(); onDelete(); }}
              className="px-3 py-1 text-xs font-medium rounded-lg transition-colors"
              style={{ color: 'var(--brand)', background: 'var(--brand-light)', border: '1px solid #fecdd3' }}
              onMouseEnter={e => { e.currentTarget.style.background = '#fecdd3'; e.currentTarget.style.borderColor = '#fca5a5'; }}
              onMouseLeave={e => { e.currentTarget.style.background = 'var(--brand-light)'; e.currentTarget.style.borderColor = '#fecdd3'; }}
            >
              Delete
            </button>
            {creatorChecked && !isCreator && (
              <button onClick={e => { e.stopPropagation(); onShare(); }} className="px-3 py-1 text-xs font-medium text-blue-600 bg-blue-50 hover:bg-blue-100 rounded-lg transition">
                {copiedMealId === meal.id ? '✓ Link copied!' : 'Share'}
              </button>
            )}
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
  const [filterOpen, setFilterOpen] = useState(false);
  const filterBtnRef = useRef<HTMLDivElement>(null);
  const [editingMeal, setEditingMeal] = useState<Meal | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [copiedMealId, setCopiedMealId] = useState<string | null>(null);
  const [creatorPopupId, setCreatorPopupId] = useState<string | null>(null);
  const [accessToken, setAccessToken] = useState('');

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
      setAccessToken(accessToken);

      fetch('/api/creator/me', {
        headers: { Authorization: `Bearer ${accessToken}` },
      }).then(r => r.ok ? r.json() : null).then(d => {
        if (d?.creator) setIsCreator(true);
        setCreatorChecked(true);
      }).catch(() => { setCreatorChecked(true); });

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
        setMeals(data.meals ?? []);
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

  const handleEditSaved = (updated: Meal) => {
    setMeals(prev => prev.map(m => (m.id === updated.id ? updated : m)));
    setEditingMeal(null);
  };

  const handleMealCreated = (meal: Meal) => {
    setMeals(prev => [...prev, meal]);
    setShowCreateModal(false);
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

      <div className="max-w-5xl mx-auto px-6 py-10 w-full flex-1">

        <ExtensionNudge />

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

        {/* My Meals */}
        <div className="rounded-xl p-8 mb-6" style={{ background: 'var(--surface-raised)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-sm)' }}>
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

          {!mealsLoading && meals.length > 0 && (() => {
            const activeFilterCount = [filters.authors.length > 0, filters.tags.length > 0, filters.ingredients.length > 0, filters.difficulty.length > 0, filters.excludeIngredients.length > 0].filter(Boolean).length;
            const customMealTags = [...new Set(meals.flatMap(m => m.tags || []).filter(t => !ALL_TAGS.includes(t)))];
            const authorSuggestions = [...new Set(meals.map(m => m.author).filter((a): a is string => Boolean(a)))];
            return (
              <div className="flex gap-2 items-center mb-4">
                <div className="relative flex-1">
                  <svg className="absolute left-3 top-1/2 -translate-y-1/2" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--text-3)' }}>
                    <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
                  </svg>
                  <input
                    type="text"
                    value={mealSearch}
                    onChange={e => setMealSearch(e.target.value)}
                    placeholder="Search meals, tags…"
                    className="w-full pl-8 pr-4 py-1.5 text-sm rounded-lg focus:outline-none"
                    style={{ border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text-1)' }}
                  />
                </div>
                <div ref={filterBtnRef} style={{ position: 'relative', flexShrink: 0 }}>
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
              const filtered = meals.filter(m => {
                if (q && !(m.name.toLowerCase().includes(q) || m.tags?.some(t => t.toLowerCase().includes(q)) || m.author?.toLowerCase().includes(q))) return false;
                if (filters.authors.length > 0 && !filters.authors.some(a => m.author?.toLowerCase().includes(a.toLowerCase()))) return false;
                if (filters.tags.length > 0 && !filters.tags.some(t => m.tags?.includes(t))) return false;
                if (filters.ingredients.length > 0 && !filters.ingredients.every(ing => m.ingredients.some(i => i.productName.toLowerCase().includes(ing)))) return false;
                if (filters.difficulty.length > 0 && !filters.difficulty.includes(m.difficulty ?? -1)) return false;
                if (filters.excludeIngredients.length > 0 && filters.excludeIngredients.some(ex => m.ingredients.some(i => i.productName.toLowerCase().includes(ex)))) return false;
                return true;
              });
              return filtered.length === 0 ? (
                <p className="text-sm text-ml-t3 py-4 text-center">No meals match your search or filters.</p>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {filtered.map(meal => (
                    <DashboardMealCard
                      key={meal.id}
                      meal={meal}
                      isPro={isPro}
                      isCreator={isCreator}
                      creatorChecked={creatorChecked}
                      copiedMealId={copiedMealId}
                      onEdit={() => setEditingMeal(meal)}
                      onDelete={() => handleDelete(meal)}
                      onShare={() => handleShare(meal)}
                      onRemovePhoto={() => handleRemovePhoto(meal)}
                      onCreatorClick={id => setCreatorPopupId(id)}
                    />
                  ))}
                </div>
              );
            })()
          )}
        </div>

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

    </div>
  );
}
