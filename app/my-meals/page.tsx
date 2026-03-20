'use client';

import { useEffect, useState, useRef } from 'react';

const CHROME_EXT_URL  = 'https://chromewebstore.google.com/detail/mealio/eccnnnhkdpigfgbmnnmhppmligjhfpne';
const FIREFOX_EXT_URL = 'https://addons.mozilla.org/en-US/firefox/addon/mealio/';
const EDGE_EXT_URL    = 'https://microsoftedge.microsoft.com/addons/detail/odmgaejgoagcjbimmdpecimocekjiobi';
import { useRouter } from 'next/navigation';
import AppHeader from '@/components/AppHeader';
import AppFooter from '@/components/AppFooter';
import CreatorPopup from '@/components/CreatorPopup';
import KrogerStorePickerModal from '@/components/KrogerStorePickerModal';

interface User {
  id: string;
  email: string;
  tier?: string;
  isAdmin?: boolean;
  createdAt?: string;
}

interface Ingredient {
  ingredientName: string;
  searchTerm?: string | null;
  qty: number;
  unit: string;
  measure?: string | null;
  productQty?: number;
}

interface IngredientForm {
  ingredientName: string;
  measure: string;
  unit: string;
  searchTerm: string | null;
  qty: number;
  productQty?: number;
}

const UNITS = ['Qty', 'cups', 'fl oz', 'g', 'kg', 'L', 'lb', 'mg', 'ml', 'oz', 'tbsp', 'tsp'];

function normIng(raw: any): Ingredient {
  return {
    ingredientName: raw.ingredientName ?? raw.productName ?? raw.product_name ?? raw.name ?? '',
    searchTerm: raw.searchTerm ?? raw.search_term ?? null,
    qty: raw.qty ?? raw.quantity ?? 1,
    unit: raw.unit ?? 'qty',
    measure: raw.measure ?? null,
    productQty: raw.productQty ?? raw.qty ?? raw.quantity ?? 1,
  };
}

function fmtMeasurement(ing: Ingredient): string {
  if (!ing.unit || ing.unit === 'qty') return `${ing.ingredientName}, ${ing.qty ?? 1}`;
  return `${ing.ingredientName}, ${ing.measure ?? ''} ${ing.unit}`;
}

function ingSearchTerm(ing: Ingredient): string {
  if (ing.searchTerm) return ing.searchTerm;
  if (!ing.unit || ing.unit === 'qty') return ing.ingredientName;
  return `${ing.ingredientName}, ${ing.measure ?? ''}${ing.unit}`;
}

function toFormIng(ing: Ingredient): IngredientForm {
  return {
    ingredientName: ing.ingredientName,
    measure: ing.unit === 'qty' ? String(ing.qty ?? 1) : (ing.measure ?? ''),
    unit: ing.unit === 'qty' ? 'Qty' : ing.unit,
    searchTerm: ing.searchTerm ?? null,
    qty: ing.qty ?? 1,
    productQty: ing.productQty ?? ing.qty ?? 1,
  };
}

function fromFormIng(form: IngredientForm): Ingredient {
  if (form.unit === 'Qty') {
    const q = parseInt(form.measure) || 1;
    return {
      ingredientName: form.ingredientName.trim(),
      qty: q,
      unit: 'qty',
      measure: null,
      searchTerm: form.searchTerm ?? null,
      productQty: q,
    };
  }
  return {
    ingredientName: form.ingredientName.trim(),
    qty: form.qty,
    unit: form.unit,
    measure: form.measure.trim() || null,
    searchTerm: form.searchTerm ?? null,
    productQty: form.productQty ?? 1,
  };
}

interface Meal {
  id: string;
  name: string;
  store_id: string;
  ingredients: Ingredient[];
  author?: string | null;
  creator_id?: string | null;
  difficulty?: number | null;
  serves?: string | null;
  tags?: string[] | null;
  website?: string | null;
  recipe?: string | null;
  photo_url?: string | null;
  story?: string | null;
  created_at?: string;
}

function formatWeightName(description: string, averageWeightPerUnit: string | null | undefined, size: string | null | undefined): string {
  const fallback = size && !description.includes(size) ? `${description}, ${size}` : description;
  if (!averageWeightPerUnit) return fallback;
  const numMatch = averageWeightPerUnit.match(/^([\d.]+)/);
  if (!numMatch) return fallback;
  const unitMatch = size?.match(/[a-zA-Z]+/);
  const unit = unitMatch?.[0] ?? 'lb';
  const unitLabel = unit === 'lb' ? 'lbs' : unit;
  return `${description}, avg ${numMatch[1]} ${unitLabel}`;
}

function hasUnchosenProducts(meal: Meal): boolean {
  return meal.ingredients.some(raw => !normIng(raw).searchTerm);
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

interface MealIngredientQty {
  mealId: string;
  mealName: string;
  qty: number;
}

interface ConsolidatedIngredient {
  ingredientName: string;
  searchTerm: string | null;
  unit: string;
  measure: string | null;
  productQty: number;
  mealIds: string[];
  mealNames: string[];
  mealIngredients: MealIngredientQty[];
}

interface KrogerSearchResult {
  searchTerm?: string | null;
  term: string;
  quantity: number;
  upc: string | null;
  description: string | null;
  exact: boolean;
  reason?: 'matched' | 'out_of_stock' | 'no_results' | 'low_confidence';
  suggestions: Array<{ upc: string; description: string; imageUrl: string | null; stockLevel: string | null; price: number | null; size?: string | null; soldBy?: string | null; averageWeightPerUnit?: string | null }>;
  mealIds: string[];
  mealIngredients: MealIngredientQty[];
  mealNames: string[];
  ingredientName: string;
  unit: string;
  measure: string | null;
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

      {/* Creator */}
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-2)', marginBottom: 4 }}>Creator</div>
        <div style={{ position: 'relative' }}>
          <div style={{ display: 'flex', gap: 4, marginBottom: filters.authors.length > 0 ? 6 : 0 }}>
            <input type="text" value={authorInput}
              onChange={e => { setAuthorInput(e.target.value); setShowAuthorSug(true); }}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addAuthor(); } if (e.key === 'Escape') setShowAuthorSug(false); }}
              onFocus={() => setShowAuthorSug(true)} onBlur={() => setTimeout(() => setShowAuthorSug(false), 150)}
              placeholder="Type creator name…" className="focus:outline-none"
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

const STORE_URLS: Record<string, string> = {
  kroger:        'kroger.com',
  ralphs:        'ralphs.com',
  fred_meyer:    'fredmeyer.com',
  king_soopers:  'kingsoopers.com',
  smiths:        'smithsfoodanddrug.com',
  frys:          'frysfood.com',
  qfc:           'qfc.com',
  city_market:   'citymarket.com',
  dillons:       'dillons.com',
  bakers:        'bakersplus.com',
  marianos:      'marianos.com',
  pick_n_save:   'picknsave.com',
  metro_market:  'metromarket.net',
  pay_less:      'pay-less.com',
  harris_teeter: 'harristeeter.com',
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
  onDelete: (meal: Meal) => void;
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

async function fetchAndUploadGeneratedPhoto(proxyUrl: string, token: string): Promise<string | null> {
  try {
    const res = await fetch(proxyUrl);
    if (!res.ok) return null;
    const blob = await res.blob();
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = e => resolve(e.target?.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
    const compressed = await compressImage(dataUrl);
    const uploadRes = await fetch('/api/images/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ imageData: compressed }),
    });
    if (!uploadRes.ok) return null;
    const data = await uploadRes.json();
    return data.url ?? null;
  } catch {
    return null;
  }
}

function EditModal({ meal, onSave, onDelete, onClose, accessToken }: EditModalProps) {
  const [name, setName] = useState(meal.name);
  const [editStoreId, setEditStoreId] = useState(meal.store_id);
  const [recentStores, setRecentStores] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem('mealio_recent_stores') || '[]'); } catch { return []; }
  });
  const [author, setAuthor] = useState(meal.author ?? '');
  const [serves, setServes] = useState(meal.serves ?? '');
  const [difficulty, setDifficulty] = useState<number | null>(meal.difficulty ?? null);
  const [selectedTags, setSelectedTags] = useState<string[]>(meal.tags ?? []);
  const [website, setWebsite] = useState(meal.website ?? '');
  const [story, setStory] = useState(meal.story ?? '');
  const [recipe, setRecipe] = useState(meal.recipe ?? '');
  const [photoUrl, setPhotoUrl] = useState(meal.photo_url ?? '');
  const [photoPreview, setPhotoPreview] = useState(meal.photo_url ?? '');
  const [pendingPhotoDataUrl, setPendingPhotoDataUrl] = useState<string | null>(null);
  const [ingredients, setIngredients] = useState<IngredientForm[]>(
    meal.ingredients.map(i => toFormIng(normIng(i)))
  );
  const [productsOpen, setProductsOpen] = useState(true);
  const [saving, setSaving] = useState(false);
  const dragRef = useRef(false);
  const [error, setError] = useState('');
  const [generating, setGenerating] = useState(false);
  const [thumbs, setThumbs] = useState<string[]>([]);
  const [fulls, setFulls]   = useState<string[]>([]);
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
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

  const selectSuggestion = async (i: number) => {
    setPendingPhotoDataUrl(null);
    if (selectedIdx === i) {
      setSelectedIdx(null);
      setPhotoUrl(''); setPhotoPreview('');
    } else {
      setSelectedIdx(i);
      const proxyUrl = fulls[i] ?? thumbs[i];
      setPhotoUrl(proxyUrl); setPhotoPreview(proxyUrl);
      setUploadingPhoto(true);
      const stored = await fetchAndUploadGeneratedPhoto(proxyUrl, accessToken);
      if (stored) setPhotoUrl(stored);
      setUploadingPhoto(false);
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

  const updateFormField = (i: number, field: keyof IngredientForm, value: string | number) => {
    setIngredients(prev => prev.map((ing, idx) => {
      if (idx !== i) return ing;
      if (field === 'ingredientName') return { ...ing, ingredientName: value as string, searchTerm: null };
      return { ...ing, [field]: value };
    }));
  };

  const removeIngredient = (i: number) => {
    setIngredients(prev => prev.filter((_, idx) => idx !== i));
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
          storeId:    editStoreId,
          ingredients: ingredients.filter(f => f.ingredientName.trim()).map(fromFormIng),
          author:     author.trim()  || null,
          serves:     serves.trim()  || null,
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
      if (editStoreId) {
        const updatedRecent = [editStoreId, ...recentStores.filter(id => id !== editStoreId)].slice(0, 3);
        try { localStorage.setItem('mealio_recent_stores', JSON.stringify(updatedRecent)); setRecentStores(updatedRecent); } catch { /* ignore */ }
      }
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
            <label className="block text-xs font-semibold text-ml-t2 mb-1">Store</label>
            <select
              value={editStoreId}
              onChange={e => setEditStoreId(e.target.value)}
              className="w-full rounded-lg px-3 py-2 text-sm focus:outline-none"
              style={{ border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text-1)' }}
            >
              {recentStores.length > 0 && (
                <optgroup label="Recent">
                  {recentStores.filter(id => STORE_LABELS[id]).map(id => (
                    <option key={id} value={id}>{STORE_LABELS[id]}</option>
                  ))}
                </optgroup>
              )}
              <optgroup label={recentStores.length > 0 ? 'All Stores' : ''}>
                {Object.entries(STORE_LABELS).sort(([, a], [, b]) => a.localeCompare(b)).map(([id, label]) => (
                  <option key={id} value={id}>{label}</option>
                ))}
              </optgroup>
            </select>
          </div>

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
            <label className="block text-xs font-semibold text-ml-t2 mb-1">Creator (optional)</label>
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
            <label className="block text-xs font-semibold text-ml-t2 mb-1">Serves (optional)</label>
            <input
              type="text"
              value={serves}
              onChange={e => setServes(e.target.value)}
              placeholder="e.g. 4 or 2-4"
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
              placeholder={"The story behind the meal or a simple one liner. e.g.\nPerfect for a summer BBQ\nGreat budget-friendly weeknight dinner\nHigh protein, low carb – great for meal prep"}
              className="w-full rounded-lg px-3 py-2 text-sm focus:outline-none resize-none"
              style={{ border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text-1)' }}
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-ml-t2 mb-2">
              Measurements ({ingredients.filter(f => f.ingredientName.trim()).length})
            </label>
            <div className="space-y-1.5 max-h-52 overflow-y-auto mb-2">
              {ingredients.map((ing, i) => (
                <div key={i} className="flex items-center gap-1.5">
                  <input
                    type="text"
                    value={ing.ingredientName}
                    onChange={e => updateFormField(i, 'ingredientName', e.target.value)}
                    placeholder="Ingredient"
                    className="flex-1 rounded-lg px-2 py-1.5 text-xs focus:outline-none"
                    style={{ border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text-1)' }}
                  />
                  <input
                    type={ing.unit === 'Qty' ? 'number' : 'text'}
                    value={ing.measure}
                    min={ing.unit === 'Qty' ? 1 : undefined}
                    onChange={e => updateFormField(i, 'measure', e.target.value)}
                    placeholder={ing.unit === 'Qty' ? '1' : 'amt'}
                    className="rounded-lg px-2 py-1.5 text-xs focus:outline-none text-center"
                    style={{ width: '52px', border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text-1)' }}
                  />
                  <select
                    value={ing.unit}
                    onChange={e => updateFormField(i, 'unit', e.target.value)}
                    className="rounded-lg px-1 py-1.5 text-xs focus:outline-none"
                    style={{ width: '72px', border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text-1)' }}
                  >
                    {UNITS.map(u => <option key={u} value={u}>{u}</option>)}
                  </select>
                  <button type="button" onClick={() => removeIngredient(i)} className="text-xs transition-colors flex-shrink-0" style={{ color: 'var(--brand)', background: 'none', border: 'none', cursor: 'pointer' }}>✕</button>
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setIngredients(prev => [...prev, { ingredientName: '', measure: '1', unit: 'Qty', searchTerm: null, qty: 1 }])}
              className="text-xs transition-colors"
              style={{ color: 'var(--brand)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
            >
              + Add ingredient
            </button>
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
            <label className="block text-xs font-semibold text-ml-t2 mb-2">Tags <span className="font-normal text-ml-t3">(up to 3, optional)</span></label>
            <TagPicker selected={selectedTags} onChange={setSelectedTags} />
          </div>

          {/* Products section (collapsed by default) */}
          <div>
            <button
              type="button"
              onClick={() => setProductsOpen(v => !v)}
              className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide"
              style={{ color: 'var(--text-3)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
            >
              Products ({ingredients.filter(f => f.ingredientName.trim()).length})
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                {productsOpen ? <polyline points="18 15 12 9 6 15"/> : <polyline points="6 9 12 15 18 9"/>}
              </svg>
            </button>
            {productsOpen && (
              <div className="mt-2 space-y-2">
                {ingredients.map((form, i) => {
                  if (!form.ingredientName.trim()) return null;
                  const realIdx = ingredients.indexOf(form);
                  return (
                    <div key={i} className="space-y-0.5">
                      <p className="text-xs font-medium" style={{ color: 'var(--text-2)' }}>{form.ingredientName}</p>
                      <div className="flex gap-1.5 items-center">
                        <input
                          type="text"
                          value={form.searchTerm ?? ''}
                          onChange={e => {
                            const val = e.target.value;
                            setIngredients(prev => prev.map((ing, idx) => idx === realIdx ? { ...ing, searchTerm: val || null } : ing));
                          }}
                          className="flex-1 rounded-lg px-2 py-1.5 text-xs focus:outline-none min-w-0"
                          style={{ border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text-1)' }}
                        />
                        <input
                          type="number"
                          min={1}
                          value={form.productQty ?? 1}
                          onChange={e => {
                            const qty = parseInt(e.target.value, 10);
                            if (!isNaN(qty) && qty > 0) setIngredients(prev => prev.map((ing, idx) => idx === realIdx ? { ...ing, productQty: qty } : ing));
                          }}
                          className="rounded-lg px-2 py-1.5 text-xs text-center focus:outline-none"
                          style={{ width: 52, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text-1)' }}
                        />
                        <button
                          type="button"
                          onClick={() => setIngredients(prev => prev.map((ing, idx) => idx === realIdx ? { ...ing, searchTerm: null, productQty: undefined } : ing))}
                          className="flex-shrink-0 rounded-lg flex items-center justify-center text-xs transition-colors"
                          style={{ width: 28, height: 28, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text-3)', cursor: 'pointer' }}
                          title="Remove product"
                        >✕</button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {error && <p className="text-xs" style={{ color: 'var(--brand)' }}>{error}</p>}
        </div>

        <div className="flex gap-3 px-6 py-4" style={{ borderTop: '1px solid var(--border)' }}>
          <button
            onClick={handleSave}
            disabled={saving || uploadingPhoto}
            className="flex-1 text-white text-sm font-semibold rounded-xl py-2.5 disabled:opacity-50 transition-opacity"
            style={{ background: 'var(--brand)' }}
          >
            {uploadingPhoto ? 'Uploading photo…' : saving ? 'Saving…' : 'Save Changes'}
          </button>
          <button
            onClick={handleClose}
            className="px-5 py-2.5 text-sm rounded-xl transition-colors text-ml-t2 hover:bg-ml-surface"
          >
            Cancel
          </button>
          <button
            onClick={() => { onDelete(meal); onClose(); }}
            className="px-5 py-2.5 text-sm rounded-xl transition-colors"
            style={{ color: 'var(--brand)', background: 'var(--brand-light)', border: '1px solid #fecdd3' }}
            onMouseEnter={e => { e.currentTarget.style.background = '#fecdd3'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'var(--brand-light)'; }}
          >
            Delete
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
  const [recentStores, setRecentStores] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem('mealio_recent_stores') || '[]'); } catch { return []; }
  });
  const [author, setAuthor] = useState('');
  const [serves, setServes] = useState('');
  const [difficulty, setDifficulty] = useState<number | null>(null);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [website, setWebsite] = useState('');
  const [story, setStory] = useState('');
  const [recipe, setRecipe] = useState('');
  const [photoUrl, setPhotoUrl] = useState('');
  const [photoPreview, setPhotoPreview] = useState('');
  const [pendingPhotoDataUrl, setPendingPhotoDataUrl] = useState<string | null>(null);
  const [ingredients, setIngredients] = useState<IngredientForm[]>([{ ingredientName: '', measure: '1', unit: 'Qty', searchTerm: null, qty: 1 }]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [generating, setGenerating] = useState(false);
  const [thumbs, setThumbs] = useState<string[]>([]);
  const [fulls, setFulls] = useState<string[]>([]);
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
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

  const selectSuggestion = async (i: number) => {
    setPendingPhotoDataUrl(null);
    if (selectedIdx === i) { setSelectedIdx(null); setPhotoUrl(''); setPhotoPreview(''); }
    else {
      const proxyUrl = fulls[i] ?? thumbs[i];
      setSelectedIdx(i); setPhotoUrl(proxyUrl); setPhotoPreview(proxyUrl);
      setUploadingPhoto(true);
      const stored = await fetchAndUploadGeneratedPhoto(proxyUrl, accessToken);
      if (stored) setPhotoUrl(stored);
      setUploadingPhoto(false);
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

  const updateFormField = (i: number, field: keyof IngredientForm, value: string | number) =>
    setIngredients(prev => prev.map((ing, idx) => {
      if (idx !== i) return ing;
      if (field === 'ingredientName') return { ...ing, ingredientName: value as string, searchTerm: null };
      return { ...ing, [field]: value };
    }));

  const removeIngredient = (i: number) =>
    setIngredients(prev => prev.filter((_, idx) => idx !== i));

  const handleSave = async () => {
    if (!name.trim()) { setError('Meal name is required.'); return; }
    if (!storeId) { setError('Please select a store.'); return; }
    const validIngredients = ingredients.filter(i => i.ingredientName.trim()).map(fromFormIng);
    if (validIngredients.length === 0) { setError('Add at least one ingredient.'); return; }
    if (serves.trim() && !/^\d+(-\d+)?$/.test(serves.trim())) { setError('Serves must be a number or range (e.g. 4 or 2-4).'); return; }
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
          serves:     serves.trim()  || null,
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
      const updatedRecent = [storeId, ...recentStores.filter(id => id !== storeId)].slice(0, 3);
      try { localStorage.setItem('mealio_recent_stores', JSON.stringify(updatedRecent)); } catch { /* ignore */ }
      setRecentStores(updatedRecent);
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
            <label className="block text-xs font-semibold text-ml-t2 mb-1">Store</label>
            <select
              value={storeId}
              onChange={e => setStoreId(e.target.value)}
              className="w-full rounded-lg px-3 py-2 text-sm focus:outline-none"
              style={{ border: '1px solid var(--border)', background: 'var(--surface)', color: storeId ? 'var(--text-1)' : 'var(--text-3)' }}
            >
              <option value="" disabled>Select a store…</option>
              {recentStores.length > 0 && (
                <optgroup label="Recent">
                  {recentStores.filter(id => STORE_LABELS[id]).map(id => (
                    <option key={id} value={id}>{STORE_LABELS[id]}</option>
                  ))}
                </optgroup>
              )}
              <optgroup label={recentStores.length > 0 ? 'All Stores' : ''}>
                {Object.entries(STORE_LABELS).sort(([, a], [, b]) => a.localeCompare(b)).map(([id, label]) => (
                  <option key={id} value={id}>{label}</option>
                ))}
              </optgroup>
            </select>
          </div>

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
            <label className="block text-xs font-semibold text-ml-t2 mb-1">Creator (optional)</label>
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
            <label className="block text-xs font-semibold text-ml-t2 mb-1">Serves (optional)</label>
            <input
              type="text"
              value={serves}
              onChange={e => setServes(e.target.value)}
              placeholder="e.g. 4 or 2-4"
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
              placeholder={"The story behind the meal or a simple one liner. e.g.\nPerfect for a summer BBQ\nGreat budget-friendly weeknight dinner\nHigh protein, low carb – great for meal prep"}
              className="w-full rounded-lg px-3 py-2 text-sm focus:outline-none resize-none"
              style={{ border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text-1)' }}
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-ml-t2 mb-2">Measurements ({ingredients.filter(i => i.ingredientName.trim()).length})</label>
            <div className="space-y-1.5 max-h-52 overflow-y-auto mb-2">
              {ingredients.map((ing, i) => (
                <div key={i} className="flex items-center gap-1.5">
                  <input
                    type="text"
                    value={ing.ingredientName}
                    onChange={e => updateFormField(i, 'ingredientName', e.target.value)}
                    placeholder="Ingredient"
                    className="flex-1 rounded-lg px-2 py-1.5 text-xs focus:outline-none"
                    style={{ border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text-1)' }}
                  />
                  <input
                    type={ing.unit === 'Qty' ? 'number' : 'text'}
                    value={ing.measure}
                    min={ing.unit === 'Qty' ? 1 : undefined}
                    onChange={e => updateFormField(i, 'measure', e.target.value)}
                    placeholder={ing.unit === 'Qty' ? '1' : 'amt'}
                    className="rounded-lg px-2 py-1.5 text-xs focus:outline-none text-center"
                    style={{ width: '52px', border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text-1)' }}
                  />
                  <select
                    value={ing.unit}
                    onChange={e => updateFormField(i, 'unit', e.target.value)}
                    className="rounded-lg px-1 py-1.5 text-xs focus:outline-none"
                    style={{ width: '72px', border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text-1)' }}
                  >
                    {UNITS.map(u => <option key={u} value={u}>{u}</option>)}
                  </select>
                  <button type="button" onClick={() => removeIngredient(i)} className="text-xs transition-colors flex-shrink-0" style={{ color: 'var(--brand)', background: 'none', border: 'none', cursor: 'pointer' }}>✕</button>
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setIngredients(prev => [...prev, { ingredientName: '', measure: '1', unit: 'Qty', searchTerm: null, qty: 1 }])}
              className="text-xs transition-colors"
              style={{ color: 'var(--brand)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
            >
              + Add ingredient
            </button>
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
            <label className="block text-xs font-semibold text-ml-t2 mb-2">Tags <span className="font-normal text-ml-t3">(up to 3, optional)</span></label>
            <TagPicker selected={selectedTags} onChange={setSelectedTags} />
          </div>

          {error && <p className="text-xs" style={{ color: 'var(--brand)' }}>{error}</p>}
        </div>

        <div className="flex gap-3 px-6 py-4" style={{ borderTop: '1px solid var(--border)' }}>
          <button
            onClick={handleSave}
            disabled={saving || uploadingPhoto}
            className="flex-1 text-white text-sm font-semibold rounded-xl py-2.5 disabled:opacity-50 transition-opacity"
            style={{ background: 'var(--brand)' }}
          >
            {uploadingPhoto ? 'Uploading photo…' : saving ? 'Creating…' : 'Create Meal'}
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
  krogerConnected, krogerLocations,
  onEdit, onDelete, onShare, onClose, onCreatorClick, accessToken,
}: {
  meal: Meal;
  isPro: boolean;
  isCreator: boolean;
  creatorChecked: boolean;
  copiedMealId: string | null;
  krogerConnected: boolean;
  krogerLocations: Record<string, { locationId: string; locationName: string }>;
  onEdit: () => void;
  onDelete: () => void;
  onShare: () => void;
  onClose: () => void;
  onCreatorClick?: (id: string) => void;
  accessToken: string;
}) {
  const dragRef = useRef(false);
  const [krogerLoading, setKrogerLoading] = useState(false);
  const [krogerResult, setKrogerResult] = useState<{ added: string[]; notFound: string[] } | null>(null);
  const [krogerResultVisible, setKrogerResultVisible] = useState(false);
  const [productsOpen, setProductsOpen] = useState(false);
  const [productIngredients, setProductIngredients] = useState<Ingredient[]>(
    meal.ingredients.map(normIng)
  );
  useEffect(() => {
    setProductIngredients(meal.ingredients.map(normIng));
  }, [meal.ingredients]);

  const krogerLocationId = krogerLocations[meal.store_id]?.locationId ?? null;

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
        body: JSON.stringify({ ingredients: productIngredients.map(i => ({ productName: i.ingredientName, quantity: i.productQty ?? i.qty })), locationId: krogerLocationId }),
      });
      const data = await res.json();
      if (res.ok) {
        setKrogerResult({ added: data.added ?? [], notFound: data.notFound ?? [] });
        setKrogerResultVisible(true);
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
      {/* Kroger cart result screen — renders in place of the meal detail card */}
      {krogerResultVisible && krogerResult && (
        <div
          className="w-full sm:max-w-lg rounded-t-2xl sm:rounded-2xl flex flex-col items-center p-8"
          style={{ background: 'var(--surface-raised)', border: '1px solid var(--border)', maxHeight: '90vh', overflowY: 'auto' }}
          onClick={e => e.stopPropagation()}
        >
          <div className="text-5xl mb-5">{krogerResult.notFound.length === 0 ? '✅' : '⚠️'}</div>
          <h3 className="text-xl font-bold mb-3 text-center" style={{ color: 'var(--text-1)' }}>
            {krogerResult.notFound.length === 0
              ? 'Added to cart!'
              : `${krogerResult.added.length} of ${krogerResult.added.length + krogerResult.notFound.length} items added`}
          </h3>
          <p className="text-sm text-center mb-5 leading-relaxed" style={{ color: 'var(--text-2)' }}>
            {krogerResult.notFound.length === 0
              ? `${krogerResult.added.length} item${krogerResult.added.length !== 1 ? 's' : ''} ${krogerResult.added.length === 1 ? 'was' : 'were'} successfully added to your Kroger cart.`
              : `${krogerResult.notFound.length} item${krogerResult.notFound.length !== 1 ? 's' : ''} could not be added to cart. This may be because the item is out of stock or the store no longer carries it.`}
          </p>
          {krogerResult.notFound.length > 0 && (
            <div className="w-full rounded-xl mb-5" style={{ border: '1px solid var(--border)' }}>
              {krogerResult.notFound.map((name, i) => {
                const ing = productIngredients.find(p => (p.ingredientName ?? (p as any).productName ?? '') === name);
                let hint = '';
                if (ing) {
                  if (!ing.unit || ing.unit === 'qty') {
                    hint = `${meal.name} calls for ${ing.qty ?? 1} ${ing.ingredientName}`;
                  } else {
                    const parts = [ing.measure, ing.unit].filter(Boolean).join(' ');
                    hint = `${meal.name} calls for ${parts} of ${ing.ingredientName}`;
                  }
                }
                return (
                  <div key={i} className="px-4 py-3" style={{ borderBottom: i < krogerResult.notFound.length - 1 ? '1px solid var(--border)' : 'none' }}>
                    <p className="text-sm font-medium" style={{ color: 'var(--text-1)' }}>{name}</p>
                    {hint && <p className="text-xs mt-0.5" style={{ color: 'var(--text-3)' }}>{hint}</p>}
                  </div>
                );
              })}
            </div>
          )}
          <button
            onClick={() => setKrogerResultVisible(false)}
            className="w-full py-3 rounded-xl text-sm font-semibold text-white"
            style={{ background: 'var(--brand)' }}
          >
            OK
          </button>
        </div>
      )}

      <div
        className={`w-full sm:max-w-lg rounded-t-2xl sm:rounded-2xl flex flex-col${krogerResultVisible && krogerResult ? ' hidden' : ''}`}
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
                <span key={tag} className="text-xs px-2 py-0.5 rounded-full"
                  style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text-2)' }}>
                  {tag}
                </span>
              ))}
            </div>
          ) : null}

          <div className="flex items-center gap-4 flex-wrap">
            {meal.difficulty != null && (
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-ml-t3">Difficulty:</span>
                <DifficultyDots level={meal.difficulty} />
              </div>
            )}
            {meal.serves && (
              <span className="text-xs flex items-center gap-0.5 text-ml-t3">
                <svg width="12" height="12" viewBox="0 0 24 20" fill="currentColor">
                  <circle cx="12" cy="6" r="5"/>
                  <path d="M1 20c0-5 5-8 11-8s11 3 11 8z"/>
                </svg>
                {meal.serves}
              </span>
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

          {meal.story && (
            <p className="text-sm italic whitespace-pre-wrap leading-relaxed" style={{ color: 'var(--text-2)' }}>{meal.story}</p>
          )}

          <div>
            <p className="text-xs font-semibold uppercase tracking-wide mb-2.5" style={{ color: 'var(--text-3)' }}>Measurements</p>
            <ul className="space-y-2">
              {productIngredients.map((ing, i) => (
                <li
                  key={i}
                  className="text-sm"
                  style={{ borderBottom: '1px solid var(--border)', paddingBottom: '6px', color: 'var(--text-1)', cursor: ing.searchTerm ? 'help' : 'default' }}
                  title={ing.searchTerm ? `${ing.productQty ?? ing.qty}x ${ing.searchTerm}` : undefined}
                >
                  {fmtMeasurement(ing)}
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

          {/* Products section */}
          {productIngredients.length > 0 && (
            <div>
              <button
                type="button"
                onClick={() => setProductsOpen(v => !v)}
                className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide"
                style={{ color: 'var(--text-3)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
              >
                Products ({productIngredients.length})
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  {productsOpen ? <polyline points="18 15 12 9 6 15"/> : <polyline points="6 9 12 15 18 9"/>}
                </svg>
              </button>
              {productsOpen && (
                <div className="mt-2">
                  {productIngredients.map((ing, i) => (
                    <div key={i} style={{ padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
                      <p className="text-xs font-medium mb-0.5" style={{ color: 'var(--text-3)' }}>{ing.ingredientName ?? (ing as any).productName ?? ''}</p>
                      <div className="flex items-center justify-between">
                        <span className="text-xs" style={{ color: 'var(--text-1)' }}>{ing.searchTerm ?? ''}</span>
                        {ing.searchTerm && <span className="text-xs flex-shrink-0" style={{ color: 'var(--text-3)' }}>×{ing.productQty ?? ing.qty}</span>}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>


        {/* Footer */}
        <div className="p-4 flex items-center gap-2 flex-wrap" style={{ borderTop: '1px solid var(--border)' }}>
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
    for (const rawIng of meal.ingredients) {
      const ing = normIng(rawIng);
      const key = `${ing.ingredientName.toLowerCase().trim()}::${(ing.searchTerm ?? '').toLowerCase().trim()}`;
      if (!key) continue;
      const ingQty = ing.productQty ?? 1;
      if (map.has(key)) {
        const e = map.get(key)!;
        e.productQty += ingQty;
        if (!e.mealIds.includes(meal.id)) {
          e.mealIds.push(meal.id);
          e.mealNames.push(meal.name);
          e.mealIngredients.push({ mealId: meal.id, mealName: meal.name, qty: ingQty });
        } else {
          const mi = e.mealIngredients.find(m => m.mealId === meal.id);
          if (mi) mi.qty += ingQty;
        }
      } else {
        map.set(key, { ingredientName: ing.ingredientName, searchTerm: ing.searchTerm ?? null, unit: ing.unit ?? 'qty', measure: ing.measure ?? null, productQty: ingQty, mealIds: [meal.id], mealNames: [meal.name], mealIngredients: [{ mealId: meal.id, mealName: meal.name, qty: ingQty }] });
      }
    }
  }
  return [...map.values()];
}

function KrogerCartFlow({
  meals, locationId, storeId, accessToken, onClose, onMealUpdated,
}: {
  meals: Meal[];
  locationId: string;
  storeId: string;
  accessToken: string;
  onClose: () => void;
  onMealUpdated: (updated: Meal) => void;
}) {
  type Step = 'qty' | 'searching' | 'searchResult' | 'review' | 'adding' | 'done';
  const [step, setStep] = useState<Step>('qty');
  const [error, setError] = useState('');

  // Step 1 – consolidated ingredient list with editable quantities
  const [items, setItems] = useState<ConsolidatedIngredient[]>(() => consolidateIngredients(meals));
  const [checkedItems, setCheckedItems] = useState<boolean[]>(() => consolidateIngredients(meals).map(() => true));

  // Steps 3/4 – results
  const [searchResults, setSearchResults] = useState<KrogerSearchResult[]>([]);
  const [reviewIdx, setReviewIdx] = useState(0);
  const [pickedItems, setPickedItems] = useState<{ upc: string; quantity: number; description: string }[]>([]);
  const [totalAdded, setTotalAdded] = useState(0);
  const [cartError, setCartError] = useState('');
  const [addedItems, setAddedItems] = useState<{ description: string; quantity: number }[]>([]);

  const [selectedSuggIdx, setSelectedSuggIdx] = useState<number | 'custom'>(0);
  const [customText, setCustomText] = useState('');
  const [hoveredSugg, setHoveredSugg] = useState<{ idx: number; rect: DOMRect } | null>(null);
  const [customSearching, setCustomSearching] = useState(false);
  // Suggestions produced by a custom search (replaces currentReview.suggestions in-place)
  const [customSuggestions, setCustomSuggestions] = useState<KrogerSearchResult['suggestions']>([]);
  const [customSearchTerm, setCustomSearchTerm] = useState('');
  const shouldShowSuggestionsRef = useRef(false);
  const [reviewQty, setReviewQty] = useState(1);

  // Per-review-item meal quantities: reviewIdx → mealId → qty
  const [reviewMealQtys, setReviewMealQtys] = useState<Record<number, Record<string, number>>>({});

  const reviewQueue = searchResults.filter(r => !r.exact);
  const currentReview = reviewQueue[reviewIdx];

  function getReviewMealQtys(): Record<string, number> {
    if (reviewMealQtys[reviewIdx]) return reviewMealQtys[reviewIdx];
    const init: Record<string, number> = {};
    for (const mi of currentReview?.mealIngredients ?? []) init[mi.mealId] = mi.qty;
    return init;
  }

  function adjustReviewMealQty(mealId: string, delta: number) {
    setReviewMealQtys(prev => {
      const cur = prev[reviewIdx] ?? getReviewMealQtys();
      return { ...prev, [reviewIdx]: { ...cur, [mealId]: Math.max(1, (cur[mealId] ?? 1) + delta) } };
    });
  }

  // Reset selection when moving to next item
  useEffect(() => {
    setSelectedSuggIdx(0);
    setCustomText('');
    setCustomSuggestions([]);
    setCustomSearchTerm('');
    setReviewQty(searchResults.filter(r => !r.exact)[reviewIdx]?.quantity ?? 1);
  }, [reviewIdx]);

  const handleStartSearch = async () => {
    setStep('searching');
    setError('');
    try {
      const res = await fetch('/api/kroger/search-products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({
          ingredients: items.filter((it, i) => checkedItems[i] && it.productQty > 0).map(i => ({ productName: i.ingredientName, searchTerm: i.searchTerm, unit: i.unit, measure: i.measure, quantity: i.productQty })),
          locationId,
          storeId,
          mealNames: [...new Set(items.flatMap(it => it.mealNames))],
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Search failed');

      const results: KrogerSearchResult[] = data.results.map((r: any) => {
        const src = items.find(c => c.ingredientName.toLowerCase().trim() === r.term.toLowerCase().trim());
        return { ...r, suggestions: r.suggestions ?? [], mealIds: src?.mealIds ?? [], mealNames: src?.mealNames ?? [], mealIngredients: src?.mealIngredients ?? [], ingredientName: src?.ingredientName ?? r.term, searchTerm: src?.searchTerm ?? null, unit: src?.unit ?? 'qty', measure: src?.measure ?? null };
      });
      setSearchResults(results);

      const needsReview = results.filter(r => !r.exact);
      if (needsReview.length === 0) {
        await doAddToCart(results.filter(r => r.upc).map(r => ({ upc: r.upc!, quantity: r.quantity, description: r.description ?? '' })));
      } else {
        setReviewIdx(0);
        setReviewQty(needsReview[0]?.quantity ?? 1);
        setStep('searchResult');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed');
      setStep('qty');
    }
  };

  const resolveCurrentSelection = async (): Promise<{ upc: string | null; name: string } | null> => {
    shouldShowSuggestionsRef.current = false;
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
        // Always show suggestions for custom searches — the user typed this term
        // to review options, so never silently add even if the score is exact.
        setCustomSuggestions(result?.suggestions ?? []);
        setCustomSearchTerm(term);
        setSelectedSuggIdx(0);
        setCustomText('');
        shouldShowSuggestionsRef.current = true;
        return null;
      } finally { setCustomSearching(false); }
    }
    const displaySuggestions = customSuggestions.length > 0 ? customSuggestions : currentReview.suggestions;
    const s = displaySuggestions[selectedSuggIdx as number];
    if (!s) return null;
    const name = s.soldBy === 'WEIGHT'
      ? formatWeightName(s.description, s.averageWeightPerUnit, s.size)
      : (s.size && !s.description.includes(s.size) ? `${s.description}, ${s.size}` : s.description);
    return { upc: s.upc, name };
  };

  const handleReviewDecision = async (action: 'skip' | 'add' | 'update') => {
    const newPicked = [...pickedItems];

    if (action !== 'skip') {
      const resolved = await resolveCurrentSelection();
      if (shouldShowSuggestionsRef.current) return; // custom search showed new suggestions — stay on this item
      if (resolved?.upc) {
        newPicked.push({ upc: resolved.upc, quantity: reviewQty, description: resolved.name });
      }
      if (action === 'update' && resolved?.name) {
        for (const mealId of currentReview.mealIds) {
          const meal = meals.find(m => m.id === mealId);
          if (!meal) continue;
          const updatedIngredients = meal.ingredients.map(ing => {
            const ni = normIng(ing);
            if (ni.ingredientName.toLowerCase().trim() === currentReview.ingredientName.toLowerCase().trim()) {
              return { ...ing, searchTerm: resolved.name, productQty: reviewQty };
            }
            return ing;
          });
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
      const exactItems = searchResults.filter(r => r.exact && r.upc).map(r => ({ upc: r.upc!, quantity: r.quantity, description: r.description ?? '' }));
      await doAddToCart([...exactItems, ...newPicked]);
    }
  };

  const doAddToCart = async (cartItems: { upc: string; quantity: number; description: string }[]) => {
    setStep('adding');
    if (cartItems.length === 0) { setTotalAdded(0); setAddedItems([]); setStep('done'); return; }
    try {
      const res = await fetch('/api/kroger/add-to-cart', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ items: cartItems, locationId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to add to cart');
      setTotalAdded(cartItems.length);
      setAddedItems(cartItems.map(i => ({ description: i.description, quantity: i.quantity })));
      setCartError('');
    } catch (err) {
      setTotalAdded(0);
      setAddedItems([]);
      setCartError(err instanceof Error ? err.message : 'Failed to add to cart');
    }
    setStep('done');
  };

  const updateMealQty = (i: number, mIdx: number, delta: number) =>
    setItems(prev => prev.map((it, idx) => {
      if (idx !== i) return it;
      const newMealIngredients = it.mealIngredients.map((mi, midx) =>
        midx === mIdx ? { ...mi, qty: Math.max(0, mi.qty + delta) } : mi
      );
      return { ...it, mealIngredients: newMealIngredients, productQty: newMealIngredients.reduce((s, mi) => s + mi.qty, 0) };
    }));

  const toggleChecked = (i: number) =>
    setCheckedItems(prev => prev.map((c, idx) => idx === i ? !c : c));

  const allChecked = checkedItems.every(c => c);
  const toggleAll = () => setCheckedItems(prev => prev.map(() => !allChecked));

  const storeColor = STORE_COLORS[storeId] ?? '#0063a1';
  const storeName = STORE_LABELS[storeId] ?? 'Kroger';

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:p-4" style={{ background: 'rgba(0,0,0,0.55)' }}>
      <div className="w-full sm:max-w-xl rounded-t-2xl sm:rounded-2xl flex flex-col" style={{ background: 'var(--surface-raised)', border: '1px solid var(--border)', maxHeight: '90vh' }} onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4" style={{ borderBottom: '1px solid var(--border)' }}>
          <h2 className="text-base font-bold text-ml-t1">
            {step === 'qty' && 'Review Ingredients'}
            {step === 'searching' && 'Finding Products…'}
            {step === 'searchResult' && 'Items Not Added'}
            {step === 'review' && `Review Unmatched Ingredients (${reviewIdx + 1} of ${reviewQueue.length})`}
            {step === 'adding' && 'Adding to Cart…'}
            {step === 'done' && 'Done!'}
          </h2>
          <button onClick={onClose} className="text-ml-t3 hover:text-ml-t1 text-xl leading-none">✕</button>
        </div>

        {/* Step 1 – Qty review */}
        {step === 'qty' && (
          <>
            <div className="overflow-y-auto flex-1 px-5 py-4 space-y-1">
              <div className="flex items-center justify-between mb-3">
                <button onClick={toggleAll} className="text-xs font-medium" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-3)' }}>
                  {allChecked ? 'Uncheck all' : 'Check all'}
                </button>
                <p className="text-xs text-ml-t3">
                  {meals.length} meal{meals.length !== 1 ? 's' : ''} · {items.length} ingredient{items.length !== 1 ? 's' : ''}
                </p>
              </div>
              {items.map((it, i) => {
                const checked = checkedItems[i] ?? true;
                const excluded = !checked;
                return (
                  <div key={i} className="py-2" style={{ borderBottom: '1px solid var(--border)', opacity: excluded ? 0.45 : 1 }}>
                    <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleChecked(i)}
                        className="flex-shrink-0"
                        style={{ width: '16px', height: '16px', cursor: 'pointer', accentColor: storeColor }}
                      />
                      <p className="text-sm text-ml-t1 flex-1" style={{ textDecoration: excluded ? 'line-through' : 'none' }}>{it.searchTerm || it.ingredientName}</p>
                    </div>
                    {it.mealIngredients.map((mi, mIdx) => {
                      const isQty = it.unit.toLowerCase() === 'qty';
                      const measurement = isQty ? null : `${it.measure ?? ''} ${it.unit}`.trim();
                      const label = measurement ? `${mi.mealName} • ${measurement}` : mi.mealName;
                      return (
                        <div key={mIdx} className="flex items-center gap-2 mt-1 pl-6">
                          <p className="text-xs text-ml-t3 flex-1">{label}</p>
                          <button onClick={() => updateMealQty(i, mIdx, -1)} disabled={mi.qty === 0 || excluded} className="w-6 h-6 rounded text-xs flex items-center justify-center flex-shrink-0 disabled:opacity-30" style={{ border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text-2)' }}>−</button>
                          <span className="w-4 text-center text-xs text-ml-t2 flex-shrink-0">{mi.qty}</span>
                          <button onClick={() => updateMealQty(i, mIdx, 1)} disabled={excluded} className="w-6 h-6 rounded text-xs flex items-center justify-center flex-shrink-0 disabled:opacity-30" style={{ border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text-2)' }}>+</button>
                        </div>
                      );
                    })}
                  </div>
                );
              })}
              {error && <p className="text-xs pt-2" style={{ color: 'var(--brand)' }}>{error}</p>}
            </div>
            <div className="px-5 py-4 flex gap-3" style={{ borderTop: '1px solid var(--border)' }}>
              <button
                onClick={handleStartSearch}
                disabled={items.filter((it, i) => checkedItems[i] && it.productQty > 0).length === 0}
                className="flex-1 text-white text-sm font-semibold rounded-xl py-2.5 disabled:opacity-40"
                style={{ background: storeColor }}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.opacity = '0.85'; }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.opacity = '1'; }}
              >
                Add Ingredients to {storeName} Cart →
              </button>
              <button onClick={onClose} className="px-4 text-sm text-ml-t2 rounded-xl" style={{ border: '1px solid var(--border)' }}>Cancel</button>
            </div>
          </>
        )}

        {/* Step 2 – Searching */}
        {step === 'searching' && (
          <div className="flex-1 flex flex-col items-center justify-center py-12 gap-4">
            <div className="w-8 h-8 rounded-full animate-spin" style={{ border: '3px solid var(--border)', borderTopColor: storeColor }} />
            <p className="text-sm text-ml-t2">{(() => { const n = items.filter((it, i) => checkedItems[i] && it.productQty > 0).length; return `Searching for ${n} ingredient${n !== 1 ? 's' : ''}…`; })()}</p>
          </div>
        )}

        {/* Step 2b – Search result summary before review */}
        {step === 'searchResult' && (() => {
          const autoAdded = searchResults.filter(r => r.exact && r.upc);
          const needsReview = searchResults.filter(r => !r.exact);
          return (
            <>
              <div className="flex-1 px-5 py-6 overflow-y-auto flex flex-col items-center text-center gap-4">
                <div className="text-5xl">⚠️</div>
                <div>
                  <p className="text-base font-bold text-ml-t1 mb-1">
                    {needsReview.length} item{needsReview.length !== 1 ? 's' : ''} could not be added to cart
                  </p>
                  <p className="text-sm text-ml-t2">
                    This may be because the item is out of stock or the store no longer carries it.
                  </p>
                </div>
                {autoAdded.length > 0 && (
                  <p className="text-sm text-ml-t3">
                    {autoAdded.length} item{autoAdded.length !== 1 ? 's' : ''} matched and will be added automatically.
                  </p>
                )}
                <div className="w-full rounded-xl overflow-hidden" style={{ border: '1px solid var(--border)' }}>
                  {needsReview.map((r, i) => (
                    <div key={i} className="px-4 py-3 text-left" style={{ borderBottom: i < needsReview.length - 1 ? '1px solid var(--border)' : 'none' }}>
                      <p className="text-sm font-medium text-ml-t1">{r.searchTerm || r.ingredientName}</p>
                    </div>
                  ))}
                </div>
              </div>
              <div className="px-5 py-4" style={{ borderTop: '1px solid var(--border)' }}>
                <button
                  onClick={() => setStep('review')}
                  className="w-full text-white text-sm font-semibold rounded-xl py-2.5"
                  style={{ background: storeColor }}
                  onMouseEnter={e => { (e.currentTarget as HTMLElement).style.opacity = '0.85'; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.opacity = '1'; }}
                >
                  Review {needsReview.length} Item{needsReview.length !== 1 ? 's' : ''} →
                </button>
              </div>
            </>
          );
        })()}

        {/* Step 3 – Review non-exact matches */}
        {step === 'review' && currentReview && (() => {
          const displaySuggestions = customSuggestions.length > 0 ? customSuggestions : currentReview.suggestions;
          const hasSuggestions = displaySuggestions.length > 0;
          const canAdd = hasSuggestions
            ? (selectedSuggIdx !== 'custom' || customText.trim().length > 0)
            : (selectedSuggIdx === 'custom' && customText.trim().length > 0);
          const isProcessing = customSearching;

          return (
            <>
              <div className="flex-1 px-5 py-4 overflow-y-auto space-y-3">
                {/* What was searched */}
                {currentReview.reason === 'out_of_stock' && (
                  <p className="text-xs font-medium" style={{ color: '#b45309' }}>⚠ Out of stock at this store</p>
                )}
                {currentReview.reason === 'no_results' && (
                  <p className="text-xs font-medium" style={{ color: 'var(--text-3)' }}>No products found for this search</p>
                )}
                {(!currentReview.reason || currentReview.reason === 'low_confidence') && (
                  <p className="text-xs font-medium" style={{ color: 'var(--text-3)' }}>No exact match found</p>
                )}
                <div className="rounded-xl px-4 py-3" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
                  <p className="text-xs text-ml-t3 mb-0.5">You searched for</p>
                  <p className="text-sm font-semibold text-ml-t1">{currentReview.searchTerm || currentReview.term}</p>
                  {currentReview.mealIngredients.map((mi, mIdx) => {
                    const isQty = currentReview.unit === 'qty';
                    const measurement = isQty ? `${mi.qty} qty` : `${currentReview.measure} ${currentReview.unit}`;
                    return (
                      <p key={mIdx} className="text-xs text-ml-t3 mt-0.5">{mi.mealName} • {measurement}</p>
                    );
                  })}
                  {customSearchTerm && (
                    <p className="text-xs mt-1" style={{ color: storeColor }}>Showing results for: "{customSearchTerm}"</p>
                  )}
                </div>

                {/* Selectable suggestions */}
                <div>
                  <p className="text-xs font-semibold text-ml-t3 mb-2 uppercase tracking-wide">
                    {hasSuggestions ? 'Kroger suggests' : 'No exact match found'}
                  </p>
                  <div className="space-y-1.5">
                    {displaySuggestions.map((s, i) => (
                      <button
                        key={i}
                        type="button"
                        onClick={() => setSelectedSuggIdx(i)}
                        onMouseEnter={e => s.imageUrl ? setHoveredSugg({ idx: i, rect: e.currentTarget.getBoundingClientRect() }) : undefined}
                        onMouseLeave={() => setHoveredSugg(null)}
                        className="w-full text-left px-3 py-2.5 rounded-lg text-sm transition-all"
                        style={{
                          border: `1.5px solid ${selectedSuggIdx === i ? storeColor : 'var(--border)'}`,
                          background: selectedSuggIdx === i ? '#e8f4fb' : 'var(--surface)',
                          color: 'var(--text-1)',
                        }}
                      >
                        <span className="flex items-start justify-between gap-3">
                          <span>{s.soldBy === 'WEIGHT' ? formatWeightName(s.description, s.averageWeightPerUnit, s.size) : (s.size && !s.description.includes(s.size) ? `${s.description}, ${s.size}` : s.description)}</span>
                          {s.price != null && (
                            <span className="text-sm font-semibold flex-shrink-0" style={{ color: 'var(--text-2)' }}>
                              {s.soldBy === 'WEIGHT' && s.size ? `$${s.price.toFixed(2)} / ${s.size.replace(/(\d)([a-zA-Z])/, '$1 $2').toLowerCase()}` : `$${s.price.toFixed(2)}`}
                            </span>
                          )}
                        </span>
                        {s.stockLevel === 'TEMPORARILY_OUT_OF_STOCK' && (
                          <span className="block text-xs mt-0.5 font-medium" style={{ color: '#b45309' }}>⚠ Temporarily out of stock</span>
                        )}
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
                        {customSuggestions.length > 0 ? 'Try a different search…' : 'Other — type a product name…'}
                      </button>
                      {selectedSuggIdx === 'custom' && (
                        <input
                          autoFocus
                          type="text"
                          value={customText}
                          onChange={e => setCustomText(e.target.value)}
                          onKeyDown={e => { if (e.key === 'Enter' && customText.trim()) handleReviewDecision('add'); }}
                          placeholder="e.g. Ground Beef 80/20"
                          className="w-full mt-1.5 px-3 py-2 text-sm rounded-lg focus:outline-none"
                          style={{ border: `1.5px solid ${storeColor}`, background: 'var(--surface)', color: 'var(--text-1)' }}
                        />
                      )}
                    </div>
                  </div>
                </div>

              </div>

              {/* Floating product image on hover */}
              {hoveredSugg && displaySuggestions[hoveredSugg.idx]?.imageUrl && (
                <div style={{
                  position: 'fixed',
                  left: hoveredSugg.rect.right + 10,
                  top: hoveredSugg.rect.top,
                  zIndex: 200,
                  background: 'var(--surface-raised)',
                  border: '1px solid var(--border)',
                  borderRadius: 12,
                  padding: 8,
                  boxShadow: '0 4px 20px rgba(0,0,0,0.15)',
                  pointerEvents: 'none',
                }}>
                  <img
                    src={displaySuggestions[hoveredSugg.idx].imageUrl!}
                    alt=""
                    style={{ width: 180, height: 180, objectFit: 'contain', display: 'block' }}
                  />
                </div>
              )}

              <div className="px-5 py-4 flex flex-col gap-2" style={{ borderTop: '1px solid var(--border)' }}>
                {/* Qty adjuster */}
                <div className="flex items-center justify-between mb-1">
                  <span className="text-sm text-ml-t2 font-medium">Quantity</span>
                  <div className="flex items-center gap-3">
                    <button
                      onClick={() => setReviewQty(q => Math.max(1, q - 1))}
                      className="w-7 h-7 rounded text-sm flex items-center justify-center"
                      style={{ border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text-2)' }}
                    >−</button>
                    <span className="text-sm font-semibold text-ml-t1 w-5 text-center">{reviewQty}</span>
                    <button
                      onClick={() => setReviewQty(q => q + 1)}
                      className="w-7 h-7 rounded text-sm flex items-center justify-center"
                      style={{ border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text-2)' }}
                    >+</button>
                  </div>
                </div>
                <button
                  onClick={() => handleReviewDecision('update')}
                  disabled={!canAdd || isProcessing}
                  className="w-full text-sm font-semibold rounded-xl py-2.5 text-white disabled:opacity-40"
                  style={{ background: storeColor }}
                  onMouseEnter={e => { if (canAdd) (e.currentTarget as HTMLElement).style.opacity = '0.85'; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.opacity = '1'; }}
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
                <div className="flex gap-2">
                  {reviewIdx > 0 && (
                    <button
                      onClick={() => { setReviewIdx(reviewIdx - 1); setPickedItems(prev => prev.slice(0, -1)); }}
                      disabled={isProcessing}
                      className="flex-1 text-sm rounded-xl py-2 text-ml-t3 disabled:opacity-40"
                      style={{ background: 'none', border: '1px solid var(--border)', cursor: 'pointer' }}
                    >
                      ← Back
                    </button>
                  )}
                  <button
                    onClick={() => handleReviewDecision('skip')}
                    disabled={isProcessing}
                    className="flex-1 text-sm rounded-xl py-2 text-ml-t3 disabled:opacity-40"
                    style={{ background: 'none', border: 'none', cursor: 'pointer' }}
                  >
                    Skip this ingredient
                  </button>
                </div>
              </div>
            </>
          );
        })()}

        {/* Step 4 – Adding */}
        {step === 'adding' && (
          <div className="flex-1 flex flex-col items-center justify-center py-12 gap-4">
            <div className="w-8 h-8 rounded-full animate-spin" style={{ border: '3px solid var(--border)', borderTopColor: storeColor }} />
            <p className="text-sm text-ml-t2">Adding items to your {storeName} cart…</p>
          </div>
        )}

        {/* Step 5 – Done */}
        {step === 'done' && (
          <>
            <div className="px-6 pt-6 pb-3 text-center flex-shrink-0">
              {cartError
                ? <><div className="text-4xl mb-2">⚠️</div><p className="text-base font-bold text-red-500">Failed to add items to cart.</p><p className="text-sm text-ml-t3">Kroger returned an error. Please try again or add items manually.</p></>
                : totalAdded > 0
                  ? <><div className="text-4xl mb-2">🛒</div><p className="text-base font-bold text-ml-t1">{totalAdded} item{totalAdded !== 1 ? 's' : ''} added to your {storeName} cart!</p></>
                  : <><div className="text-4xl mb-2">😔</div><p className="text-base font-bold text-ml-t1">No items were added.</p><p className="text-sm text-ml-t3">No matching products were found or all were skipped.</p></>
              }
            </div>
            {addedItems.length > 0 && (
              <div className="flex-1 overflow-y-auto px-5 pb-3 min-h-0">
                <ul className="rounded-xl overflow-hidden" style={{ border: '1px solid var(--border)' }}>
                  {addedItems.map((item, i) => (
                    <li
                      key={i}
                      className="px-4 py-2.5 text-sm text-ml-t1"
                      style={{ borderBottom: i < addedItems.length - 1 ? '1px solid var(--border)' : 'none' }}
                    >
                      {item.description}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {!cartError && totalAdded === 0 && <div className="flex-1" />}
            <div className="px-5 py-4 flex gap-3" style={{ borderTop: '1px solid var(--border)' }}>
              {!cartError && totalAdded > 0 && (
                <a
                  href={`https://www.${STORE_URLS[storeId] ?? 'kroger.com'}/cart`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex-1 text-center text-sm font-semibold rounded-xl py-2.5 text-white"
                  style={{ background: storeColor, textDecoration: 'none' }}
                  onMouseEnter={e => { (e.currentTarget as HTMLElement).style.opacity = '0.85'; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.opacity = '1'; }}
                >
                  View Cart →
                </a>
              )}
              <button onClick={onClose} className="flex-1 text-sm font-semibold rounded-xl py-2.5" style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text-1)' }}>Done</button>
            </div>
          </>
        )}

      </div>
    </div>
  );
}

// ── Choose Products Flow ──────────────────────────────────────────────────────

function ChooseProductsFlow({
  meal, locationId, storeId, accessToken, onClose, onMealUpdated,
}: {
  meal: Meal;
  locationId: string;
  storeId: string;
  accessToken: string;
  onClose: () => void;
  onMealUpdated: (updated: Meal) => void;
}) {
  type Step = 'searching' | 'picking' | 'saving' | 'done';
  const [step, setStep] = useState<Step>('searching');
  const [error, setError] = useState('');
  const [searchResults, setSearchResults] = useState<KrogerSearchResult[]>([]);
  const [pickIdx, setPickIdx] = useState(0);
  const [selections, setSelections] = useState<Map<string, { description: string; qty: number }>>(new Map());
  const [productQtyMap, setProductQtyMap] = useState<Map<string, number>>(new Map());
  const [selectedSuggIdx, setSelectedSuggIdx] = useState<number | 'custom'>(0);
  const [customText, setCustomText] = useState('');
  const [customSuggestions, setCustomSuggestions] = useState<KrogerSearchResult['suggestions']>([]);
  const [customSearchTerm, setCustomSearchTerm] = useState('');
  const [customSearching, setCustomSearching] = useState(false);
  const [hoveredSugg, setHoveredSugg] = useState<{ idx: number; rect: DOMRect } | null>(null);
  const [savedCount, setSavedCount] = useState(0);
  const shouldShowSuggestionsRef = useRef(false);

  const storeColor = STORE_COLORS[storeId] ?? '#0063a1';
  const storeName = STORE_LABELS[storeId] ?? 'Kroger';
  const unchosenIngredients = meal.ingredients.map(normIng).filter(i => !i.searchTerm);
  const currentResult = searchResults[pickIdx];
  const currentIngredient = unchosenIngredients.find(i => i.ingredientName === (currentResult?.ingredientName ?? ''));
  const currentIngQty = productQtyMap.get(currentResult?.ingredientName ?? '') ?? 0;

  const adjustCurrentQty = (delta: number) => {
    if (!currentResult) return;
    setProductQtyMap(prev => {
      const next = new Map(prev);
      next.set(currentResult.ingredientName, Math.max(0, (prev.get(currentResult.ingredientName) ?? 0) + delta));
      return next;
    });
  };

  useEffect(() => { doSearch(); }, []);

  useEffect(() => {
    setSelectedSuggIdx(0);
    setCustomText('');
    setCustomSuggestions([]);
    setCustomSearchTerm('');
    shouldShowSuggestionsRef.current = false;
  }, [pickIdx]);

  const doSearch = async () => {
    setStep('searching');
    setError('');
    try {
      const res = await fetch('/api/kroger/search-products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({
          ingredients: unchosenIngredients.map(i => ({ productName: i.ingredientName, searchTerm: null, unit: i.unit, measure: i.measure, quantity: 1 })),
          locationId,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Search failed');
      setSearchResults(data.results.map((r: any) => ({
        ...r,
        suggestions: r.suggestions ?? [],
        mealIds: [meal.id],
        mealNames: [meal.name],
        mealIngredients: [],
        ingredientName: unchosenIngredients.find(i => i.ingredientName.toLowerCase().trim() === r.term.toLowerCase().trim())?.ingredientName ?? r.term,
      })));
      setPickIdx(0);
      setStep('picking');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed');
    }
  };

  const handleNext = async (skip: boolean) => {
    if (customSearching) return;
    let newSelections = new Map(selections);

    if (!skip) {
      if (selectedSuggIdx === 'custom') {
        const term = customText.trim();
        if (!term) return;
        shouldShowSuggestionsRef.current = false;
        setCustomSearching(true);
        try {
          const res = await fetch('/api/kroger/search-products', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
            body: JSON.stringify({ ingredients: [{ productName: term, quantity: 1 }], locationId }),
          });
          const data = await res.json();
          setCustomSuggestions(data.results?.[0]?.suggestions ?? []);
          setCustomSearchTerm(term);
          setSelectedSuggIdx(0);
          setCustomText('');
          shouldShowSuggestionsRef.current = true;
        } finally { setCustomSearching(false); }
        if (shouldShowSuggestionsRef.current) return;
        return;
      }
      const displaySuggestions = customSuggestions.length > 0 ? customSuggestions : currentResult?.suggestions ?? [];
      const s = displaySuggestions[selectedSuggIdx as number];
      if (s && currentResult) {
        const desc = s.soldBy === 'WEIGHT'
          ? formatWeightName(s.description, s.averageWeightPerUnit, s.size)
          : (s.size && !s.description.includes(s.size) ? `${s.description}, ${s.size}` : s.description);
        newSelections.set(currentResult.ingredientName, { description: desc, qty: currentIngQty });
      }
    }

    setSelections(newSelections);
    if (pickIdx < searchResults.length - 1) {
      setPickIdx(pickIdx + 1);
    } else {
      await doSave(newSelections);
    }
  };

  const doSave = async (selMap: Map<string, { description: string; qty: number }>) => {
    setStep('saving');
    const updatedIngredients = meal.ingredients.map(rawIng => {
      const ing = normIng(rawIng);
      const chosen = selMap.get(ing.ingredientName);
      return chosen !== undefined ? { ...rawIng, searchTerm: chosen.description, productQty: chosen.qty } : rawIng;
    });
    const count = selMap.size;
    try {
      const res = await fetch(`/api/meals/${meal.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ ingredients: updatedIngredients }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save');
      if (data.meal) onMealUpdated(data.meal);
      setSavedCount(count);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    }
    setStep('done');
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:p-4" style={{ background: 'rgba(0,0,0,0.55)' }}>
      <div className="w-full sm:max-w-xl rounded-t-2xl sm:rounded-2xl flex flex-col" style={{ background: 'var(--surface-raised)', border: '1px solid var(--border)', maxHeight: '90vh' }} onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4" style={{ borderBottom: '1px solid var(--border)' }}>
          <div className="min-w-0">
            <h2 className="text-base font-bold text-ml-t1">
              {step === 'searching' && 'Searching Products…'}
              {step === 'picking' && `Choose Product (${pickIdx + 1} of ${searchResults.length})`}
              {step === 'saving' && 'Saving…'}
              {step === 'done' && 'Products Chosen!'}
            </h2>
            <p className="text-xs text-ml-t3 truncate">{meal.name}</p>
          </div>
          <button onClick={onClose} className="text-ml-t3 hover:text-ml-t1 text-xl leading-none flex-shrink-0 ml-3">✕</button>
        </div>

        {/* Searching */}
        {step === 'searching' && (
          <div className="flex-1 flex flex-col items-center justify-center py-12 gap-4">
            {error ? (
              <>
                <p className="text-sm text-red-500 text-center px-6">{error}</p>
                <button onClick={doSearch} className="text-sm px-4 py-2 rounded-xl text-white" style={{ background: storeColor }}>Retry</button>
              </>
            ) : (
              <>
                <div className="w-8 h-8 rounded-full animate-spin" style={{ border: '3px solid var(--border)', borderTopColor: storeColor }} />
                <p className="text-sm text-ml-t2">Searching for {unchosenIngredients.length} ingredient{unchosenIngredients.length !== 1 ? 's' : ''}…</p>
              </>
            )}
          </div>
        )}

        {/* Picking */}
        {step === 'picking' && currentResult && (() => {
          const displaySuggestions = customSuggestions.length > 0 ? customSuggestions : currentResult.suggestions;
          const hasSuggestions = displaySuggestions.length > 0;
          const canPick = hasSuggestions
            ? (selectedSuggIdx !== 'custom' || customText.trim().length > 0)
            : (selectedSuggIdx === 'custom' && customText.trim().length > 0);
          const isLast = pickIdx === searchResults.length - 1;

          return (
            <>
              <div className="flex-1 px-5 py-4 overflow-y-auto space-y-3">
                <div className="rounded-xl px-4 py-3" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
                  <p className="text-xs text-ml-t3 mb-0.5">{meal.name} calls for</p>
                  <p className="text-sm font-semibold text-ml-t1">{currentIngredient ? fmtMeasurement(currentIngredient) : currentResult.ingredientName}</p>
                  {customSearchTerm && (
                    <p className="text-xs mt-1" style={{ color: storeColor }}>Showing results for: "{customSearchTerm}"</p>
                  )}
                </div>

                <div>
                  <p className="text-xs font-semibold text-ml-t3 mb-2 uppercase tracking-wide">
                    {hasSuggestions ? `${storeName} products` : 'No products found'}
                  </p>
                  <div className="space-y-1.5">
                    {displaySuggestions.map((s, i) => (
                      <button
                        key={i}
                        type="button"
                        onClick={() => setSelectedSuggIdx(i)}
                        onMouseEnter={e => s.imageUrl ? setHoveredSugg({ idx: i, rect: e.currentTarget.getBoundingClientRect() }) : undefined}
                        onMouseLeave={() => setHoveredSugg(null)}
                        className="w-full text-left px-3 py-2.5 rounded-lg text-sm transition-all"
                        style={{
                          border: `1.5px solid ${selectedSuggIdx === i ? storeColor : 'var(--border)'}`,
                          background: selectedSuggIdx === i ? '#e8f4fb' : 'var(--surface)',
                          color: 'var(--text-1)',
                        }}
                      >
                        <span className="flex items-start justify-between gap-3">
                          <span>{s.soldBy === 'WEIGHT' ? formatWeightName(s.description, s.averageWeightPerUnit, s.size) : (s.size && !s.description.includes(s.size) ? `${s.description}, ${s.size}` : s.description)}</span>
                          {s.price != null && (
                            <span className="text-sm font-semibold flex-shrink-0" style={{ color: 'var(--text-2)' }}>
                              {s.soldBy === 'WEIGHT' && s.size ? `$${s.price.toFixed(2)} / ${s.size.replace(/(\d)([a-zA-Z])/, '$1 $2').toLowerCase()}` : `$${s.price.toFixed(2)}`}
                            </span>
                          )}
                        </span>
                        {s.stockLevel === 'TEMPORARILY_OUT_OF_STOCK' && (
                          <span className="block text-xs mt-0.5 font-medium" style={{ color: '#b45309' }}>⚠ Temporarily out of stock</span>
                        )}
                      </button>
                    ))}

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
                        {customSuggestions.length > 0 ? 'Try a different search…' : 'Other — type a product name…'}
                      </button>
                      {selectedSuggIdx === 'custom' && (
                        <input
                          autoFocus
                          type="text"
                          value={customText}
                          onChange={e => setCustomText(e.target.value)}
                          onKeyDown={e => { if (e.key === 'Enter' && customText.trim()) handleNext(false); }}
                          placeholder="e.g. Ground Beef 80/20"
                          className="w-full mt-1.5 px-3 py-2 text-sm rounded-lg focus:outline-none"
                          style={{ border: `1.5px solid ${storeColor}`, background: 'var(--surface)', color: 'var(--text-1)' }}
                        />
                      )}
                    </div>
                  </div>
                </div>
              </div>

              {hoveredSugg && displaySuggestions[hoveredSugg.idx]?.imageUrl && (
                <div style={{ position: 'fixed', left: hoveredSugg.rect.right + 10, top: hoveredSugg.rect.top, zIndex: 200, background: 'var(--surface-raised)', border: '1px solid var(--border)', borderRadius: 12, padding: 8, boxShadow: '0 4px 20px rgba(0,0,0,0.15)', pointerEvents: 'none' }}>
                  <img src={displaySuggestions[hoveredSugg.idx].imageUrl!} alt="" style={{ width: 180, height: 180, objectFit: 'contain', display: 'block' }} />
                </div>
              )}

              <div className="px-5 py-4 flex flex-col gap-2" style={{ borderTop: '1px solid var(--border)' }}>
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between px-3 py-2 rounded-lg" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
                    <span className="text-sm" style={{ color: currentIngQty === 0 ? '#ef4444' : 'var(--text-2)' }}>Qty to add to cart</span>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => adjustCurrentQty(-1)}
                        disabled={currentIngQty <= 0}
                        className="w-7 h-7 rounded flex items-center justify-center text-sm disabled:opacity-30"
                        style={{ border: '1px solid var(--border)', background: 'var(--surface-raised)', color: 'var(--text-2)' }}
                      >−</button>
                      <span className="text-sm font-semibold w-5 text-center" style={{ color: currentIngQty === 0 ? '#ef4444' : 'var(--text-1)' }}>{currentIngQty}</span>
                      <button
                        type="button"
                        onClick={() => adjustCurrentQty(1)}
                        className="w-7 h-7 rounded flex items-center justify-center text-sm"
                        style={{ border: '1px solid var(--border)', background: 'var(--surface-raised)', color: 'var(--text-2)' }}
                      >+</button>
                    </div>
                  </div>
                  {currentIngQty > 2 && (
                    <p className="text-sm font-semibold rounded-md px-3 py-2 border border-amber-400 bg-amber-50 text-amber-800">
                      ⚠ {currentIngQty} is a lot for one item — does this come in a multipack or bulk size?
                    </p>
                  )}
                </div>
                <button
                  onClick={() => handleNext(false)}
                  disabled={!canPick || customSearching || currentIngQty === 0}
                  className="w-full text-sm font-semibold rounded-xl py-2.5 text-white disabled:opacity-40"
                  style={{ background: storeColor }}
                  onMouseEnter={e => { if (canPick && currentIngQty > 0) (e.currentTarget as HTMLElement).style.opacity = '0.85'; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.opacity = ''; }}
                >
                  {customSearching ? 'Searching…' : isLast ? 'Save Products' : 'Choose & Next →'}
                </button>
                <div className="flex gap-2">
                  {pickIdx > 0 && (
                    <button
                      onClick={() => setPickIdx(pickIdx - 1)}
                      disabled={customSearching}
                      className="flex-1 text-sm rounded-xl py-2 text-ml-t3 disabled:opacity-40"
                      style={{ background: 'none', border: '1px solid var(--border)', cursor: 'pointer' }}
                    >← Back</button>
                  )}
                  <button
                    onClick={() => handleNext(true)}
                    disabled={customSearching}
                    className="flex-1 text-sm rounded-xl py-2 text-ml-t3 disabled:opacity-40"
                    style={{ background: 'none', border: 'none', cursor: 'pointer' }}
                  >{isLast ? 'Skip & Save' : 'Skip'}</button>
                </div>
              </div>
            </>
          );
        })()}

        {/* Saving */}
        {step === 'saving' && (
          <div className="flex-1 flex flex-col items-center justify-center py-12 gap-4">
            <div className="w-8 h-8 rounded-full animate-spin" style={{ border: '3px solid var(--border)', borderTopColor: storeColor }} />
            <p className="text-sm text-ml-t2">Saving your product choices…</p>
          </div>
        )}

        {/* Done */}
        {step === 'done' && (
          <>
            <div className="px-6 pt-6 pb-3 text-center flex-shrink-0">
              {error
                ? <><div className="text-4xl mb-2">⚠️</div><p className="text-base font-bold text-red-500">Failed to save.</p><p className="text-sm text-ml-t3">{error}</p></>
                : savedCount > 0
                  ? <><div className="text-4xl mb-2">✅</div><p className="text-base font-bold text-ml-t1">Products chosen!</p><p className="text-sm text-ml-t3">{savedCount} of {unchosenIngredients.length} ingredient{unchosenIngredients.length !== 1 ? 's' : ''} linked to a {storeName} product.</p></>
                  : <><div className="text-4xl mb-2">👋</div><p className="text-base font-bold text-ml-t1">No products chosen.</p><p className="text-sm text-ml-t3">You can choose products at any time from the meal card.</p></>
              }
            </div>
            <div className="flex-1" />
            <div className="px-5 py-4" style={{ borderTop: '1px solid var(--border)' }}>
              <button onClick={onClose} className="w-full text-sm font-semibold rounded-xl py-2.5" style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text-1)' }}>Done</button>
            </div>
          </>
        )}

      </div>
    </div>
  );
}

function DashboardMealCard({
  meal, isPro, isCreator, creatorChecked, copiedMealId,
  krogerConnected, krogerLocations,
  selectMode, selected, onToggleSelect,
  onEdit, onDelete, onShare, onRemovePhoto, onCreatorClick, accessToken,
  onChooseProducts,
}: {
  meal: Meal;
  isPro: boolean;
  isCreator: boolean;
  creatorChecked: boolean;
  copiedMealId: string | null;
  krogerConnected: boolean;
  krogerLocations: Record<string, { locationId: string; locationName: string }>;
  selectMode?: boolean;
  selected?: boolean;
  onToggleSelect?: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onShare: () => void;
  onRemovePhoto: () => void;
  onCreatorClick?: (id: string) => void;
  accessToken: string;
  onChooseProducts?: () => void;
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
          krogerLocations={krogerLocations}
          onEdit={onEdit}
          onDelete={onDelete}
          onShare={onShare}
          onClose={() => setDetailOpen(false)}
          onCreatorClick={onCreatorClick}
          accessToken={accessToken}
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

          {hasUnchosenProducts(meal) && KROGER_API_STORES.has(meal.store_id) && (
            <div className="mt-2 flex items-center gap-1.5">
              <span className="text-xs font-medium px-2 py-0.5 rounded-full flex items-center gap-1" style={{ background: '#fef3c7', color: '#92400e', border: '1px solid #fde68a' }}>
                ⚠ Cannot add to cart until products have been chosen
              </span>
            </div>
          )}

          <div className="flex justify-end mt-2 gap-2 flex-wrap">
            {hasUnchosenProducts(meal) && KROGER_API_STORES.has(meal.store_id) && onChooseProducts && (
              <button
                onClick={e => { e.stopPropagation(); onChooseProducts(); }}
                className="px-3 py-1 text-xs font-semibold rounded-lg flex-shrink-0"
                style={{ color: '#fff', background: STORE_COLORS[meal.store_id] ?? '#0063a1', border: 'none' }}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.opacity = '0.85'; }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.opacity = '1'; }}
              >
                Choose Products
              </button>
            )}
            <button
              onClick={e => { e.stopPropagation(); setDetailOpen(true); }}
              className="px-3 py-1 text-xs font-medium rounded-lg transition-colors flex-shrink-0"
              style={{ color: '#444', background: '#f3f4f6', border: '1px solid #e5e7eb' }}
              onMouseEnter={e => { e.currentTarget.style.background = '#e5e7eb'; }}
              onMouseLeave={e => { e.currentTarget.style.background = '#f3f4f6'; }}
            >
              View
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
  const [krogerLocations, setKrogerLocations] = useState<Record<string, { locationId: string; locationName: string }>>({});

  // Browser detection for extension link
  const [extUrl, setExtUrl] = useState(CHROME_EXT_URL);
  const [extLabel, setExtLabel] = useState('Add to Chrome');
  useEffect(() => {
    const ua = navigator.userAgent;
    if (ua.includes('Firefox/')) { setExtUrl(FIREFOX_EXT_URL); setExtLabel('Add to Firefox'); }
    else if (ua.includes('Edg/')) { setExtUrl(EDGE_EXT_URL); setExtLabel('Add to Edge'); }
  }, []);

  // Store pill filter + multi-select for Kroger cart
  const [selectedStore, setSelectedStore] = useState<string | null>(null);
  const [selectedMealIds, setSelectedMealIds] = useState<Set<string>>(new Set());
  const [showKrogerFlow, setShowKrogerFlow] = useState(false);
  const [showKrogerStorePicker, setShowKrogerStorePicker] = useState(false);
  const [krogerConnecting, setKrogerConnecting] = useState(false);
  const [choosingProductsMeal, setChoosingProductsMeal] = useState<Meal | null>(null);
  const pendingChooseFlowMealRef = useRef<Meal | null>(null);
  const chooseQueueRef = useRef<string[]>([]);

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
      if (!accessToken) { router.push('/signin'); return; }

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

      if (!response.ok) { localStorage.clear(); router.push('/signin'); return; }

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
          setKrogerLocations(d.locations ?? {});
        }
      }).catch(() => {});

      setLoading(false);
      loadMeals(accessToken);
    } catch {
      localStorage.clear();
      router.push('/discover');
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
    const storeLocationId = krogerLocations[selectedStore ?? '']?.locationId ?? null;
    if (krogerConnected && !storeLocationId) {
      // Connected but no location saved for this store brand — show store picker
      setShowKrogerStorePicker(true);
      return;
    }
    if (!krogerConnected) {
      setKrogerConnecting(true);
      try {
        const res = await fetch('/api/kroger/connect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
          body: JSON.stringify({ popup: true, storeId: selectedStore }),
        });
        const data = await res.json();
        if (!data.redirectUrl) { setKrogerConnecting(false); return; }

        const krogerPopup = window.open(data.redirectUrl, 'kroger-oauth', 'width=520,height=680,scrollbars=yes,resizable=yes');

        if (!krogerPopup) {
          // Popup blocked — fall back to full redirect
          sessionStorage.setItem('pendingKrogerCart', JSON.stringify({ mealIds: [...selectedMealIds], storeId: selectedStore }));
          window.location.href = data.redirectUrl;
          return;
        }

        const handleMessage = (e: MessageEvent) => {
          if (e.origin !== window.location.origin || e.data?.kroger !== 'connected') return;
          window.removeEventListener('message', handleMessage);
          clearInterval(closedPoll);
          krogerPopup.close();
          const token = localStorage.getItem('accessToken');
          fetch('/api/kroger/status', { headers: { Authorization: `Bearer ${token}` } })
            .then(r => r.ok ? r.json() : null)
            .then(d => {
              setKrogerConnecting(false);
              if (d?.connected) {
                setKrogerConnected(true);
                setKrogerLocations(d.locations ?? {});
                if (d.locations?.[selectedStore ?? '']?.locationId) {
                  setShowKrogerFlow(true);
                } else {
                  setShowKrogerStorePicker(true);
                }
              }
            })
            .catch(() => setKrogerConnecting(false));
        };

        window.addEventListener('message', handleMessage);

        const closedPoll = setInterval(() => {
          if (krogerPopup.closed) {
            clearInterval(closedPoll);
            window.removeEventListener('message', handleMessage);
            setKrogerConnecting(false);
          }
        }, 500);
      } catch { setKrogerConnecting(false); }
      return;
    }
    setShowKrogerFlow(true);
  };

  const handleChooseProducts = async (meal: Meal) => {
    const storeId = meal.store_id;
    const storeLocationId = krogerLocations[storeId]?.locationId ?? null;

    if (krogerConnected && storeLocationId) {
      setChoosingProductsMeal(meal);
      return;
    }

    if (krogerConnected && !storeLocationId) {
      pendingChooseFlowMealRef.current = meal;
      setShowKrogerStorePicker(true);
      return;
    }

    // Not connected — OAuth popup
    pendingChooseFlowMealRef.current = meal;
    setKrogerConnecting(true);
    try {
      const res = await fetch('/api/kroger/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ popup: true, storeId }),
      });
      const data = await res.json();
      if (!data.redirectUrl) { setKrogerConnecting(false); return; }

      const krogerPopup = window.open(data.redirectUrl, 'kroger-oauth', 'width=520,height=680,scrollbars=yes,resizable=yes');
      if (!krogerPopup) { setKrogerConnecting(false); return; }

      const handleMessage = (e: MessageEvent) => {
        if (e.origin !== window.location.origin || e.data?.kroger !== 'connected') return;
        window.removeEventListener('message', handleMessage);
        clearInterval(closedPoll);
        krogerPopup.close();
        const token = localStorage.getItem('accessToken');
        fetch('/api/kroger/status', { headers: { Authorization: `Bearer ${token}` } })
          .then(r => r.ok ? r.json() : null)
          .then(d => {
            setKrogerConnecting(false);
            if (d?.connected) {
              setKrogerConnected(true);
              setKrogerLocations(d.locations ?? {});
              const pending = pendingChooseFlowMealRef.current;
              if (pending && d.locations?.[pending.store_id]?.locationId) {
                pendingChooseFlowMealRef.current = null;
                setChoosingProductsMeal(pending);
              } else {
                setShowKrogerStorePicker(true);
              }
            }
          })
          .catch(() => setKrogerConnecting(false));
      };

      window.addEventListener('message', handleMessage);
      const closedPoll = setInterval(() => {
        if (krogerPopup.closed) {
          clearInterval(closedPoll);
          window.removeEventListener('message', handleMessage);
          setKrogerConnecting(false);
        }
      }, 500);
    } catch { setKrogerConnecting(false); }
  };

  const advanceChooseQueue = (currentMeals?: Meal[]) => {
    const mealsToCheck = currentMeals ?? meals;
    while (chooseQueueRef.current.length > 0) {
      const nextId = chooseQueueRef.current.shift()!;
      const nextMeal = mealsToCheck.find(m => m.id === nextId);
      if (nextMeal && hasUnchosenProducts(nextMeal)) {
        setChoosingProductsMeal(nextMeal);
        return;
      }
    }
    setChoosingProductsMeal(null);
  };

  const handleFloatingChooseProducts = async () => {
    const mealsToChoose = meals.filter(m => selectedMealIds.has(m.id)).filter(hasUnchosenProducts);
    if (mealsToChoose.length === 0) return;
    const [first, ...rest] = mealsToChoose;
    chooseQueueRef.current = rest.map(m => m.id);
    await handleChooseProducts(first);
  };

  const notifyExtension = () => {
    window.dispatchEvent(new CustomEvent('mealio:mealsChanged'));
  };

  const handleEditSaved = (updated: Meal) => {
    setMeals(prev => prev.map(m => (m.id === updated.id ? updated : m)));
    setEditingMeal(null);
    if (updated.store_id) setSelectedStore(updated.store_id);
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

        <div className="lg:flex lg:gap-8 lg:items-start">

          {/* Left column: heading + sidebar */}
          <div className="w-full lg:w-64 flex-shrink-0">
            <h1 className="text-5xl font-bold text-ml-t1 leading-tight mb-6">
              Your saved<br />
              <span style={{ borderBottom: '4px solid var(--brand)', paddingBottom: '3px' }}>meals.</span>
            </h1>

            {/* Desktop sidebar */}
            {!mealsLoading && meals.length > 0 && (() => {
              const customMealTags = [...new Set(meals.flatMap(m => m.tags || []).filter(t => !ALL_TAGS.includes(t)))];
              const authorSuggestions = [...new Set(meals.map(m => m.author).filter((a): a is string => Boolean(a)))];
              return (
                <aside className="hidden lg:block sticky top-6">
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
          </div>

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

          {selectedStore && !KROGER_API_STORES.has(selectedStore) && (
            <div className="flex items-start gap-4 rounded-2xl px-5 py-4 mb-6" style={{ background: 'var(--brand-light)', border: '1px solid var(--brand-border)' }}>
              <div className="flex-shrink-0 w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: 'var(--brand)' }}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10"/><path d="M12 8v4m0 4h.01"/>
                </svg>
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold" style={{ color: 'var(--text-1)' }}>
                  {STORE_LABELS[selectedStore] ?? 'This store'} doesn&apos;t currently support cart integration without the web extension
                </p>
                <p className="text-xs mt-0.5" style={{ color: 'var(--text-2)' }}>
                  Get the Mealio browser extension on desktop to add meal ingredients directly to your cart. Stay tuned for updates.
                </p>
              </div>
              <a
                href={extUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex-shrink-0 text-sm font-semibold px-4 py-2 rounded-xl transition-colors"
                style={{ background: 'var(--brand)', color: '#fff', textDecoration: 'none' }}
                onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = 'var(--brand-dark)'}
                onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = 'var(--brand)'}
              >
                {extLabel}
              </a>
            </div>
          )}

          {/* Select-mode banner for Kroger stores */}
          {selectedStore && KROGER_API_STORES.has(selectedStore) && !mealsLoading && (
            <div className="flex items-center gap-3 mb-4 px-3 py-2 rounded-lg text-xs" style={{ background: '#e8f4fb', border: '1px solid #bae6fd', color: '#0369a1' }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4m0 4h.01"/></svg>
              <span>Select meals below to add their ingredients to your {STORE_LABELS[selectedStore] ?? 'Kroger'} cart.</span>
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
                if (filters.ingredients.length > 0 && !filters.ingredients.every(ing => m.ingredients.some(i => normIng(i).ingredientName.toLowerCase().includes(ing)))) return false;
                if (filters.difficulty.length > 0 && !filters.difficulty.includes(m.difficulty ?? -1)) return false;
                if (filters.excludeIngredients.length > 0 && filters.excludeIngredients.some(ex => m.ingredients.some(i => normIng(i).ingredientName.toLowerCase().includes(ex)))) return false;
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
                      krogerLocations={krogerLocations}
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
                      accessToken={accessToken}
                      onChooseProducts={KROGER_API_STORES.has(meal.store_id) ? () => handleChooseProducts(meal) : undefined}
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
          onDelete={handleDelete}
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

      {/* Floating action button — "Choose Products" or "Add to Cart" */}
      {selectedMealIds.size > 0 && selectedStore && KROGER_API_STORES.has(selectedStore) && (() => {
        const storeColor = STORE_COLORS[selectedStore] ?? '#0063a1';
        const storeName = STORE_LABELS[selectedStore] ?? 'Kroger';
        const needsChoose = meals.filter(m => selectedMealIds.has(m.id)).some(hasUnchosenProducts);
        const unchosenCount = meals.filter(m => selectedMealIds.has(m.id)).filter(hasUnchosenProducts).length;
        return (
          <div className="fixed bottom-6 left-1/2 z-40 flex flex-col items-center gap-1.5" style={{ transform: 'translateX(-50%)' }}>
            <button
              onClick={needsChoose ? handleFloatingChooseProducts : handleKrogerCartClick}
              disabled={krogerConnecting}
              className="flex items-center gap-2 px-5 py-3 rounded-2xl text-sm font-semibold text-white shadow-lg disabled:opacity-60 transition-transform active:scale-95"
              style={{ background: storeColor, boxShadow: `0 4px 20px ${storeColor}66` }}
              onMouseEnter={e => { if (!krogerConnecting) (e.currentTarget as HTMLElement).style.opacity = '0.88'; }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.opacity = '1'; }}
            >
              {needsChoose ? (
                <>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
                  </svg>
                  {krogerConnecting ? 'Connecting…' : `Choose Products for ${unchosenCount} meal${unchosenCount !== 1 ? 's' : ''}`}
                </>
              ) : (
                <>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/>
                    <path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/>
                  </svg>
                  {krogerConnecting ? 'Connecting…' : `Add ${selectedMealIds.size} meal${selectedMealIds.size !== 1 ? 's' : ''} to ${storeName} Cart`}
                </>
              )}
            </button>
            {!krogerConnected && !needsChoose && (
              <p className="text-xs px-3 py-1.5 rounded-xl text-center" style={{ background: 'rgba(0,0,0,0.6)', color: 'rgba(255,255,255,0.85)', backdropFilter: 'blur(4px)', maxWidth: '320px' }}>
                {selectedStore !== 'kroger' ? `You may see a Kroger login screen — ${storeName} uses the Kroger sign-in system.` : "You'll be prompted to sign in to Kroger."}
              </p>
            )}
          </div>
        );
      })()}

      {/* Kroger store picker — shown after OAuth when no store is saved yet */}
      {showKrogerStorePicker && (
        <KrogerStorePickerModal
          accessToken={accessToken}
          targetStoreId={selectedStore ?? undefined}
          onSaved={(locationId, locationName, storeId) => {
            setKrogerLocations(prev => ({ ...prev, [storeId]: { locationId, locationName } }));
            setShowKrogerStorePicker(false);
            if (pendingChooseFlowMealRef.current) {
              const m = pendingChooseFlowMealRef.current;
              pendingChooseFlowMealRef.current = null;
              setChoosingProductsMeal(m);
            } else {
              setShowKrogerFlow(true);
            }
          }}
          onClose={() => setShowKrogerStorePicker(false)}
        />
      )}

      {/* Kroger cart flow modal */}
      {showKrogerFlow && selectedStore && KROGER_API_STORES.has(selectedStore) && krogerLocations[selectedStore]?.locationId && (
        <KrogerCartFlow
          meals={meals.filter(m => selectedMealIds.has(m.id))}
          locationId={krogerLocations[selectedStore].locationId}
          storeId={selectedStore}
          accessToken={accessToken}
          onClose={() => { setShowKrogerFlow(false); setSelectedMealIds(new Set()); }}
          onMealUpdated={updated => setMeals(prev => prev.map(m => m.id === updated.id ? updated : m))}
        />
      )}

      {/* Choose Products flow modal */}
      {choosingProductsMeal && KROGER_API_STORES.has(choosingProductsMeal.store_id) && krogerLocations[choosingProductsMeal.store_id]?.locationId && (
        <ChooseProductsFlow
          key={choosingProductsMeal.id}
          meal={choosingProductsMeal}
          locationId={krogerLocations[choosingProductsMeal.store_id].locationId}
          storeId={choosingProductsMeal.store_id}
          accessToken={accessToken}
          onClose={() => advanceChooseQueue()}
          onMealUpdated={updated => {
            setMeals(prev => prev.map(m => m.id === updated.id ? updated : m));
          }}
        />
      )}

    </div>
  );
}
