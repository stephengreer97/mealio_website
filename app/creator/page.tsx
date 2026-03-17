'use client';

import { useEffect, useState, useRef } from 'react';
import { useRouter } from 'next/navigation';
import AppHeader from '@/components/AppHeader';
import AppFooter from '@/components/AppFooter';

interface Creator {
  id: string;
  display_name: string;
  bio: string | null;
  social_handle: string | null;
  photo_url: string | null;
  approved_at: string;
  handle: string | null;
}

interface CreatorMeal {
  id: string;
  name: string;
  photo_url: string | null;
  difficulty: number | null;
  trending_score: number;
  saves_all: number;
  ingredients: Ingredient[];
  recipe: string | null;
  source: string | null;
  story: string | null;
  serves: string | null;
  tags?: string[];
}

interface Stats {
  followers: number;
  savesQtr: number;
  savesAll: number;
  totalCreatorQtrSaves: number;
  totalCreatorAlltimeSaves: number;
  qtrPct: number;
  alltimePct: number;
  combinedSharePct: number;
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

function toFormIng(ing: Ingredient): IngredientForm {
  return {
    ingredientName: ing.ingredientName,
    measure: ing.unit === 'qty' ? String(ing.qty ?? 1) : (ing.measure ?? ''),
    unit: ing.unit === 'qty' ? 'Qty' : ing.unit,
    searchTerm: ing.searchTerm ?? null,
    qty: ing.qty ?? 1,
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
    productQty: 1,
  };
}

const DIFFICULTY_LABELS = ['', 'Easy', 'Easy-Medium', 'Medium', 'Medium-Hard', 'Hard'];

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

function TagPicker({ selected, onChange }: { selected: string[]; onChange: (tags: string[]) => void }) {
  const [search, setSearch] = useState('');
  const filtered = ALL_TAGS
    .filter(tag => !search || tag.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => Number(selected.includes(b)) - Number(selected.includes(a)));
  const toggle = (tag: string) => {
    if (selected.includes(tag)) {
      onChange(selected.filter(t => t !== tag));
    } else if (selected.length < 3) {
      onChange([...selected, tag]);
    }
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
      <input
        type="text"
        placeholder="Search tags…"
        value={search}
        onChange={e => setSearch(e.target.value)}
        style={{
          padding: '4px 8px',
          border: '1.5px solid #ddd',
          borderRadius: '8px',
          fontSize: '11px',
          outline: 'none',
          color: '#333',
          background: '#fafafa',
        }}
      />
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '5px', maxHeight: '90px', overflowY: 'auto', paddingRight: '2px' }}>
        {filtered.map(tag => {
          const isSelected = selected.includes(tag);
          const isDisabled = !isSelected && selected.length >= 3;
          return (
            <button
              key={tag}
              type="button"
              onClick={() => toggle(tag)}
              disabled={isDisabled}
              style={{
                padding: '3px 9px',
                border: `1.5px solid ${isSelected ? '#dd0031' : '#ddd'}`,
                borderRadius: '12px',
                background: isSelected ? '#dd0031' : '#fafafa',
                color: isSelected ? 'white' : '#666',
                fontSize: '11px',
                cursor: isDisabled ? 'not-allowed' : 'pointer',
                opacity: isDisabled ? 0.4 : 1,
                fontWeight: isSelected ? 600 : 400,
              }}
            >
              {tag}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── Shared image helpers ──────────────────────────────────────────────────────

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

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => resolve(e.target?.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function uploadImageFile(file: File, token: string): Promise<string> {
  const dataUrl = await fileToDataUrl(file);
  const compressed = await compressImage(dataUrl);
  const res = await fetch('/api/images/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ imageData: compressed }),
  });
  if (res.status === 413) throw new Error('Image is too large. Please choose a smaller photo.');
  if (!res.ok) throw new Error('Photo upload failed. Please try again.');
  const data = await res.json();
  if (!data.url) throw new Error('Photo upload failed. Please try again.');
  return data.url;
}

// ── Edit Modal ────────────────────────────────────────────────────────────────

function EditPresetMealModal({
  meal, onSave, onClose,
}: {
  meal: CreatorMeal;
  onSave: (updated: CreatorMeal) => void;
  onClose: () => void;
}) {
  const dragRef = useRef(false);
  const [name, setName]           = useState(meal.name);
  const [difficulty, setDifficulty] = useState<number | null>(meal.difficulty ?? null);
  const [serves, setServes]       = useState(meal.serves ?? '');
  const [recipe, setRecipe]       = useState(meal.recipe ?? '');
  const [source, setSource]       = useState(meal.source ?? '');
  const [story, setStory]         = useState(meal.story ?? '');
  const [photoUrl, setPhotoUrl]   = useState(meal.photo_url ?? '');
  const [photoPreview, setPhotoPreview] = useState(meal.photo_url ?? '');
  const [pendingPhotoDataUrl, setPendingPhotoDataUrl] = useState<string | null>(null);
  const [ingredients, setIngredients] = useState<IngredientForm[]>(
    meal.ingredients.map(i => toFormIng(normIng(i)))
  );
  const [selectedTags, setSelectedTags] = useState<string[]>(meal.tags ?? []);
  const [saving, setSaving]       = useState(false);
  const [error, setError]         = useState('');
  const [generating, setGenerating] = useState(false);
  const [thumbs, setThumbs]     = useState<string[]>([]);
  const [fulls, setFulls]       = useState<string[]>([]);
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const token = () => localStorage.getItem('accessToken') ?? '';

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

  const uploadPhoto = async (dataUrl: string): Promise<string> => {
    const compressed = await compressImage(dataUrl);
    const res = await fetch('/api/images/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
      body: JSON.stringify({ imageData: compressed }),
    });
    if (res.status === 413) throw new Error('Image is too large. Please choose a smaller photo.');
    if (!res.ok) throw new Error('Photo upload failed. Please try again.');
    const data = await res.json();
    if (!data.url) throw new Error('Photo upload failed. Please try again.');
    return data.url;
  };

  const generatePhoto = async () => {
    if (generating || !name.trim()) return;
    setGenerating(true);
    setThumbs([]); setFulls([]); setSelectedIdx(null);
    setPhotoUrl(''); setPhotoPreview(''); setPendingPhotoDataUrl(null);
    try {
      const res = await fetch('/api/meals/generate-photo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
        body: JSON.stringify({ mealName: name.trim() }),
      });
      const data = await res.json();
      if (res.ok && data.thumbs?.length) {
        setThumbs(data.thumbs);
        setFulls(data.fulls ?? data.thumbs);
      } else {
        setError(data.error || 'No image found for this meal name.');
      }
    } catch {
      setError('Failed to generate photo.');
    } finally {
      setGenerating(false);
    }
  };

  const selectSuggestion = (i: number) => {
    setPendingPhotoDataUrl(null);
    if (selectedIdx === i) {
      setSelectedIdx(null);
      setPhotoUrl('');
      setPhotoPreview('');
    } else {
      setSelectedIdx(i);
      const url = fulls[i] ?? thumbs[i];
      setPhotoUrl(url);
      setPhotoPreview(url);
    }
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
    setSaving(true);
    setError('');
    try {
      const normalizeUrl = (url: string) => {
        const u = url.trim();
        if (!u) return '';
        return u.startsWith('http://') || u.startsWith('https://') ? u : `https://${u}`;
      };

      let finalPhotoUrl = photoUrl || null;
      if (pendingPhotoDataUrl) {
        const uploaded = await uploadPhoto(pendingPhotoDataUrl);
        finalPhotoUrl = uploaded;
        setPhotoUrl(uploaded);
        setPendingPhotoDataUrl(null);
      }

      const res = await fetch(`/api/creator/meals/${meal.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
        body: JSON.stringify({
          name:        name.trim(),
          ingredients: ingredients.filter(f => f.ingredientName.trim()).map(fromFormIng),
          recipe:      recipe.trim() || null,
          source:      normalizeUrl(source),
          story:       story.trim() || null,
          photoUrl:    finalPhotoUrl,
          difficulty:  difficulty ?? null,
          serves:      serves.trim() || null,
          tags:        selectedTags,
        }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || 'Failed to save.'); return; }
      onSave({ ...meal, ...data.meal, ingredients: ingredients.filter(f => f.ingredientName.trim()).map(fromFormIng), recipe: recipe.trim() || null, source: normalizeUrl(source), story: story.trim() || null, tags: selectedTags });
    } catch (err) { setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.'); }
    finally { setSaving(false); }
  };

  const handleClose = () => {
    if (!window.confirm('Discard changes?')) return;
    onClose();
  };

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50, padding: '16px' }}
      onMouseDown={e => { dragRef.current = e.target !== e.currentTarget; }}
      onClick={e => { if (e.target !== e.currentTarget || dragRef.current) return; handleClose(); }}
    >
      <div style={{ background: 'white', borderRadius: '16px', boxShadow: '0 20px 60px rgba(0,0,0,0.2)', width: '100%', maxWidth: '520px', maxHeight: '90vh', display: 'flex', flexDirection: 'column', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' }}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '20px 24px', borderBottom: '1px solid #f0f0f0' }}>
          <h2 style={{ margin: 0, fontSize: '16px', fontWeight: 700, color: '#111' }}>Edit Meal</h2>
          <button onClick={handleClose} style={{ background: 'none', border: 'none', fontSize: '20px', color: '#aaa', cursor: 'pointer', lineHeight: 1 }}>×</button>
        </div>

        {/* Body */}
        <div style={{ overflowY: 'auto', padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: '16px', flex: 1 }}>

          {/* Name */}
          <div>
            <label style={modalLabelStyle}>Meal Name</label>
            <input value={name} onChange={e => setName(e.target.value)} style={modalInputStyle} />
          </div>

          {/* Recipe URL */}
          <div>
            <label style={modalLabelStyle}>Recipe URL <span style={{ fontWeight: 400, color: '#aaa' }}>(optional)</span></label>
            <input type="url" value={source} onChange={e => setSource(e.target.value)} placeholder="https://…" style={modalInputStyle} />
          </div>

          {/* Photo */}
          <div>
            <label style={modalLabelStyle}>Photo <span style={{ fontWeight: 400, color: '#aaa' }}>(optional)</span></label>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
              {photoPreview && (
                <div style={{ position: 'relative' }}>
                  <img src={photoPreview} alt="preview" style={{ width: '52px', height: '52px', objectFit: 'cover', borderRadius: '8px', display: 'block', border: '1px solid #eee' }} />
                  <button
                    type="button"
                    onClick={() => { setPhotoPreview(''); setPhotoUrl(''); setPendingPhotoDataUrl(null); }}
                    style={{ position: 'absolute', top: '-7px', right: '-7px', width: '20px', height: '20px', borderRadius: '50%', background: '#333', color: 'white', border: 'none', cursor: 'pointer', fontSize: '11px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                    title="Remove photo"
                  >✕</button>
                </div>
              )}
              <button type="button" onClick={() => fileRef.current?.click()} style={modalBtnStyle}>Choose photo</button>
              <button
                type="button"
                onClick={generatePhoto}
                disabled={generating || !name.trim()}
                style={{ ...modalBtnStyle, opacity: generating || !name.trim() ? 0.45 : 1, cursor: generating || !name.trim() ? 'not-allowed' : 'pointer' }}
              >
                {generating ? 'Generating…' : 'Generate photo'}
              </button>
              <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handlePhotoChange} />
            </div>
            {thumbs.length > 0 && (
              <div style={{ display: 'flex', gap: '8px', marginTop: '12px' }}>
                {thumbs.map((thumb, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => selectSuggestion(i)}
                    style={{ flex: 1, padding: 0, border: 'none', borderRadius: '8px', overflow: 'hidden', cursor: 'pointer', outline: selectedIdx === i ? '2.5px solid #3b82f6' : '2.5px solid transparent', outlineOffset: '2px', background: 'none' }}
                  >
                    <img src={thumb} alt="" style={{ width: '100%', aspectRatio: '1', objectFit: 'cover', display: 'block' }} />
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Difficulty */}
          <div>
            <label style={modalLabelStyle}>Difficulty <span style={{ fontWeight: 400, color: '#aaa' }}>(optional)</span></label>
            <div style={{ display: 'flex', gap: '8px' }}>
              {[1, 2, 3, 4, 5].map(v => (
                <button key={v} type="button" onClick={() => setDifficulty(difficulty === v ? null : v)}
                  style={{ width: '36px', height: '36px', borderRadius: '8px', border: `1.5px solid ${difficulty === v ? '#dd0031' : '#e0e0e0'}`, background: difficulty === v ? '#dd0031' : '#fafafa', color: difficulty === v ? 'white' : '#888', fontSize: '13px', fontWeight: 600, cursor: 'pointer' }}>
                  {v}
                </button>
              ))}
            </div>
          </div>

          {/* Serves */}
          <div>
            <label style={modalLabelStyle}>Serves <span style={{ fontWeight: 400, color: '#aaa' }}>(optional)</span></label>
            <input type="text" value={serves} onChange={e => setServes(e.target.value)} placeholder="e.g. 4 or 2-4" style={modalInputStyle} />
          </div>

          {/* Story */}
          <div>
            <label style={modalLabelStyle}>Story <span style={{ fontWeight: 400, color: '#aaa' }}>(optional)</span></label>
            <textarea value={story} onChange={e => setStory(e.target.value)} rows={3} placeholder="e.g. Perfect for a summer BBQ… · Great budget-friendly weeknight dinner · High protein, low carb – great for meal prep" style={{ ...modalInputStyle, resize: 'vertical', fontFamily: 'inherit' }} />
          </div>

          {/* Measurements */}
          <div>
            <label style={modalLabelStyle}>Measurements ({ingredients.filter(f => f.ingredientName.trim()).length})</label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', maxHeight: '200px', overflowY: 'auto', marginBottom: '8px', paddingRight: '4px' }}>
              {ingredients.map((ing, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <input
                    type="text"
                    value={ing.ingredientName}
                    onChange={e => updateFormField(i, 'ingredientName', e.target.value)}
                    placeholder="Ingredient name"
                    style={{ ...modalInputStyle, flex: 1, marginBottom: 0 }}
                  />
                  <input
                    type={ing.unit === 'Qty' ? 'number' : 'text'}
                    value={ing.measure}
                    min={ing.unit === 'Qty' ? 1 : undefined}
                    onChange={e => updateFormField(i, 'measure', e.target.value)}
                    placeholder={ing.unit === 'Qty' ? '1' : 'amt'}
                    style={{ ...modalInputStyle, width: '52px', marginBottom: 0, textAlign: 'center' }}
                  />
                  <select
                    value={ing.unit}
                    onChange={e => updateFormField(i, 'unit', e.target.value)}
                    style={{ ...modalInputStyle, width: '72px', marginBottom: 0 }}
                  >
                    {UNITS.map(u => <option key={u} value={u}>{u}</option>)}
                  </select>
                  <button type="button" onClick={() => removeIngredient(i)} style={{ background: 'none', border: 'none', color: '#bbb', fontSize: '16px', cursor: 'pointer', flexShrink: 0, lineHeight: 1 }}>×</button>
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setIngredients(prev => [...prev, { ingredientName: '', measure: '1', unit: 'Qty', searchTerm: null, qty: 1 }])}
              style={{ fontSize: '13px', color: '#dd0031', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
            >
              + Add ingredient
            </button>
          </div>

          {/* Recipe */}
          <div>
            <label style={modalLabelStyle}>Recipe Instructions <span style={{ fontWeight: 400, color: '#aaa' }}>(optional)</span></label>
            <textarea value={recipe} onChange={e => setRecipe(e.target.value)} rows={5} style={{ ...modalInputStyle, resize: 'vertical', fontFamily: 'inherit' }} />
          </div>

          {/* Tags */}
          <div>
            <label style={modalLabelStyle}>Tags <span style={{ fontWeight: 400, color: '#aaa' }}>(up to 3)</span></label>
            <TagPicker selected={selectedTags} onChange={setSelectedTags} />
          </div>

          {error && (
            <div style={{ background: '#fff0f0', border: '1px solid #ffcccc', borderRadius: '8px', padding: '10px 12px', fontSize: '13px', color: '#c40029' }}>{error}</div>
          )}
        </div>

        {/* Footer */}
        <div style={{ padding: '16px 24px', borderTop: '1px solid #f0f0f0', display: 'flex', gap: '10px' }}>
          <button
            onClick={handleSave}
            disabled={saving}
            style={{ flex: 1, background: saving ? '#aaa' : '#dd0031', color: 'white', border: 'none', borderRadius: '8px', padding: '11px', fontSize: '14px', fontWeight: 600, cursor: saving ? 'not-allowed' : 'pointer' }}
          >
            {saving ? 'Saving…' : 'Save Changes'}
          </button>
          <button onClick={handleClose} style={{ padding: '11px 18px', border: '1px solid #e0e0e0', borderRadius: '8px', background: 'white', fontSize: '14px', cursor: 'pointer', color: '#666' }}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Meal View Modal ───────────────────────────────────────────────────────────

function MealViewModal({
  meal, onEdit, onClose,
}: {
  meal: CreatorMeal;
  onEdit: () => void;
  onClose: () => void;
}) {
  const dragRef = useRef(false);
  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4"
      onMouseDown={e => { dragRef.current = e.target !== e.currentTarget; }}
      onClick={e => { if (e.target !== e.currentTarget || dragRef.current) return; onClose(); }}
    >
      <div className="bg-white w-full sm:rounded-2xl sm:max-w-lg rounded-t-2xl shadow-2xl flex flex-col max-h-[92vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 flex-shrink-0">
          <h2 className="text-base font-bold text-gray-900 truncate pr-4">{meal.name}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 transition-colors flex-shrink-0">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>

        {/* Body */}
        <div className="overflow-y-auto flex-1">
          {meal.photo_url && (
            <img src={meal.photo_url} alt={meal.name} className="w-full h-52 object-cover" />
          )}

          <div className="p-5 space-y-4">
            {/* Meta row */}
            {(meal.difficulty != null || meal.serves || meal.source) && (
              <div className="flex items-center gap-4 flex-wrap">
                {meal.difficulty != null && (
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs text-gray-400">Difficulty</span>
                    <div className="flex gap-0.5">
                      {[1,2,3,4,5].map(i => (
                        <span key={i} className={`text-sm ${i <= meal.difficulty! ? 'text-red-500' : 'text-gray-200'}`}>●</span>
                      ))}
                    </div>
                    <span className="text-xs text-gray-400">{DIFFICULTY_LABELS[meal.difficulty]}</span>
                  </div>
                )}
                {meal.serves && (
                  <span className="text-xs text-gray-500 flex items-center gap-1">
                    <svg width="12" height="12" viewBox="0 0 24 20" fill="currentColor"><circle cx="12" cy="6" r="5"/><path d="M1 20c0-5 5-8 11-8s11 3 11 8z"/></svg>
                    {meal.serves}
                  </span>
                )}
                {meal.source && (
                  <a href={meal.source} target="_blank" rel="noopener noreferrer" className="text-xs text-red-600 hover:text-red-700 truncate max-w-[180px]">
                    {meal.source.replace(/^https?:\/\/(www\.)?/, '')}
                  </a>
                )}
              </div>
            )}

            {/* Tags */}
            {meal.tags && meal.tags.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {meal.tags.map(tag => (
                  <span key={tag} className="text-xs bg-gray-100 text-gray-600 px-2.5 py-1 rounded-full font-medium">{tag}</span>
                ))}
              </div>
            )}

            {/* Story */}
            {meal.story && (
              <p className="text-sm text-gray-500 italic leading-relaxed whitespace-pre-wrap">{meal.story}</p>
            )}

            {/* Measurements */}
            <div>
              <p className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-2">Measurements ({meal.ingredients.length})</p>
              <ul className="space-y-1.5">
                {meal.ingredients.map((ing, i) => (
                  <li key={i} className="text-sm text-gray-700">
                    {fmtMeasurement(normIng(ing))}
                  </li>
                ))}
              </ul>
            </div>

            {/* Recipe */}
            {meal.recipe && (
              <div>
                <p className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-2">Recipe</p>
                <p className="text-sm text-gray-600 whitespace-pre-wrap leading-relaxed">{meal.recipe}</p>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-4 border-t border-gray-100 flex gap-3 flex-shrink-0">
          <button
            onClick={onEdit}
            className="flex-1 bg-red-600 hover:bg-red-700 text-white font-semibold rounded-xl py-2.5 text-sm transition-colors"
          >
            Edit Meal
          </button>
          <button
            onClick={onClose}
            className="px-5 py-2.5 border border-gray-200 rounded-xl text-sm text-gray-600 hover:bg-gray-50 transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Creator Portal ─────────────────────────────────────────────────────────────

export default function CreatorPortal() {
  const router = useRouter();
  const [creator, setCreator] = useState<Creator | null>(null);
  const [meals, setMeals] = useState<CreatorMeal[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);

  const [copiedMealId, setCopiedMealId] = useState<string | null>(null);
  const [editingMeal, setEditingMeal] = useState<CreatorMeal | null>(null);
  const [viewingMeal, setViewingMeal] = useState<CreatorMeal | null>(null);
  const publishDragRef = useRef(false);

  // Publish form state
  const [showForm, setShowForm] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState('');
  const [publishSuccess, setPublishSuccess] = useState('');

  const [mealName, setMealName]       = useState('');
  const [mealRecipe, setMealRecipe]   = useState('');
  const [mealSource, setMealSource]   = useState('');
  const [mealStory, setMealStory]     = useState('');
  const [mealServes, setMealServes]   = useState('');
  const [mealDifficulty, setMealDifficulty] = useState<number | null>(null);
  const [mealIngredients, setMealIngredients] = useState<IngredientForm[]>([
    { ingredientName: '', measure: '1', unit: 'Qty', searchTerm: null, qty: 1 },
  ]);
  const [mealTags, setMealTags]           = useState<string[]>([]);
  const [photoFile, setPhotoFile]         = useState<File | null>(null);
  const [photoPreview, setPhotoPreview]   = useState('');
  const [generating, setGenerating]   = useState(false);
  const [thumbs, setThumbs]           = useState<string[]>([]);
  const [fulls, setFulls]             = useState<string[]>([]);
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);

  // Handle state (kept for backward compat, consumed by saveProfile)
  const [handleInput, setHandleInput]     = useState('');
  const [handleSaving, setHandleSaving]   = useState(false);
  const [handleError, setHandleError]     = useState('');
  const [handleSuccess, setHandleSuccess] = useState('');

  // Profile editing state
  const [editingProfile, setEditingProfile] = useState(false);
  const [profileBio, setProfileBio]         = useState('');
  const [profileWebsite, setProfileWebsite] = useState('');
  const [profilePhotoFile, setProfilePhotoFile]       = useState<File | null>(null);
  const [profilePhotoPreview, setProfilePhotoPreview] = useState('');
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileError, setProfileError]   = useState('');
  const profilePhotoInputRef = useRef<HTMLInputElement>(null);

  // UI state
  const [showEarnings, setShowEarnings] = useState(false);

  useEffect(() => { loadPortal(); }, []);

  // Legacy saveHandle — kept for functional compatibility
  const saveHandle = async () => {
    setHandleError('');
    setHandleSuccess('');
    setHandleSaving(true);
    try {
      const token = localStorage.getItem('accessToken');
      const res = await fetch('/api/creator/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ handle: handleInput.trim() }),
      });
      const data = await res.json();
      if (!res.ok) { setHandleError(data.error || 'Failed to save.'); return; }
      setCreator(prev => prev ? { ...prev, handle: handleInput.trim() || null } : prev);
      setHandleSuccess('Saved!');
      setTimeout(() => setHandleSuccess(''), 2500);
    } finally {
      setHandleSaving(false);
    }
  };

  // Suppress unused-variable warnings for legacy state
  void saveHandle; void handleSaving; void handleError; void handleSuccess;

  const openEditProfile = () => {
    setProfileBio(creator?.bio ?? '');
    setProfileWebsite(creator?.social_handle ?? '');
    setProfilePhotoPreview(creator?.photo_url ?? '');
    setProfilePhotoFile(null);
    setProfileError('');
    setEditingProfile(true);
  };

  const cancelEditProfile = () => {
    setEditingProfile(false);
    setProfileError('');
  };

  const saveProfile = async () => {
    setProfileSaving(true);
    setProfileError('');
    try {
      const token = localStorage.getItem('accessToken');
      let photoUrl: string | undefined;
      if (profilePhotoFile) {
        photoUrl = await uploadImageFile(profilePhotoFile, token!);
      }
      const body: Record<string, unknown> = {
        bio:          profileBio.trim() || null,
        socialHandle: profileWebsite.trim() || null,
        handle:       handleInput.trim() || null,
      };
      if (photoUrl !== undefined) body.photoUrl = photoUrl;

      const res = await fetch('/api/creator/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) { setProfileError(data.error || 'Failed to save.'); return; }
      setCreator(prev => prev ? {
        ...prev,
        bio:           profileBio.trim() || null,
        social_handle: profileWebsite.trim() || null,
        handle:        handleInput.trim() || null,
        ...(photoUrl ? { photo_url: photoUrl } : {}),
      } : prev);
      setEditingProfile(false);
    } catch {
      setProfileError('Something went wrong. Please try again.');
    } finally {
      setProfileSaving(false);
    }
  };

  const loadPortal = async () => {
    const token = localStorage.getItem('accessToken');
    if (!token) { router.push('/signin'); return; }

    const authRes = await fetch('/api/auth/verify', { headers: { Authorization: `Bearer ${token}` } });
    if (!authRes.ok) { localStorage.clear(); router.push('/signin'); return; }

    const meRes = await fetch('/api/creator/me', { headers: { Authorization: `Bearer ${token}` } });
    if (!meRes.ok) { router.push('/creator/apply'); return; }

    const data = await meRes.json();
    if (!data.creator) { router.push('/creator/apply'); return; }

    setCreator(data.creator);
    setHandleInput(data.creator.handle ?? '');
    setMeals((data.meals ?? []).slice().sort((a: CreatorMeal, b: CreatorMeal) => b.trending_score - a.trending_score));
    setStats(data.stats ?? null);
    setLoading(false);
  };

  const handlePhotoChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setPhotoFile(file);
    setThumbs([]); setFulls([]); setSelectedIdx(null);
    setPhotoPreview(URL.createObjectURL(file));
  };

  const handleGeneratePhoto = async () => {
    if (generating || !mealName.trim()) return;
    setGenerating(true);
    setThumbs([]); setFulls([]); setSelectedIdx(null);
    setPhotoFile(null);
    setPhotoPreview('');
    try {
      const token = localStorage.getItem('accessToken');
      const res = await fetch('/api/meals/generate-photo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ mealName: mealName.trim() }),
      });
      const data = await res.json();
      if (res.ok && data.thumbs?.length) {
        setThumbs(data.thumbs);
        setFulls(data.fulls ?? data.thumbs);
      } else {
        setPublishError(data.error || 'No image found for this meal name.');
      }
    } catch {
      setPublishError('Failed to generate photo.');
    } finally {
      setGenerating(false);
    }
  };

  const selectSuggestion = (i: number) => {
    setSelectedIdx(prev => prev === i ? null : i);
  };

  const addIngredientRow = () =>
    setMealIngredients(prev => [...prev, { ingredientName: '', measure: '1', unit: 'Qty', searchTerm: null, qty: 1 }]);

  const removeIngredientRow = (i: number) =>
    setMealIngredients(prev => prev.filter((_, idx) => idx !== i));

  const updateIngredientForm = (i: number, field: keyof IngredientForm, value: string | number) =>
    setMealIngredients(prev => prev.map((ing, idx) => {
      if (idx !== i) return ing;
      if (field === 'ingredientName') return { ...ing, ingredientName: value as string, searchTerm: null };
      return { ...ing, [field]: value };
    }));

  const handlePublish = async (e: React.FormEvent) => {
    e.preventDefault();
    setPublishError('');
    setPublishSuccess('');

    const validIngredientForms = mealIngredients.filter(i => i.ingredientName.trim());
    const validIngredients = validIngredientForms.map(fromFormIng);
    if (!mealName.trim() || validIngredients.length === 0) {
      setPublishError('Meal name and at least one ingredient are required.');
      return;
    }

    if (mealServes.trim() && !/^\d+(-\d+)?$/.test(mealServes.trim())) {
      setPublishError('Serves must be a number or range (e.g. 4 or 2-4).');
      return;
    }

    setPublishing(true);
    try {
      const token = localStorage.getItem('accessToken');
      let photoUrl: string | null = selectedIdx !== null ? (fulls[selectedIdx] ?? thumbs[selectedIdx]) : null;

      if (photoFile) {
        photoUrl = await uploadImageFile(photoFile, token!);
      }

      const res = await fetch('/api/creator/meals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          name:        mealName.trim(),
          ingredients: validIngredients,
          recipe:      mealRecipe.trim() || null,
          source:      mealSource.trim() || '',
          story:       mealStory.trim() || null,
          serves:      mealServes.trim() || null,
          difficulty:  mealDifficulty,
          photoUrl,
          tags:        mealTags,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        setPublishError(data.error || 'Failed to publish meal.');
        return;
      }

      setPublishSuccess(`"${mealName}" is now live in Discover!`);
      setMealName(''); setMealRecipe(''); setMealSource(''); setMealStory('');
      setMealServes(''); setMealDifficulty(null); setMealTags([]); setPhotoFile(null); setPhotoPreview('');
      setThumbs([]); setFulls([]); setSelectedIdx(null);
      setMealIngredients([{ ingredientName: '', measure: '1', unit: 'Qty', searchTerm: null, qty: 1 }]);
      setShowForm(false);
      loadPortal();
    } catch (err) {
      setPublishError(err instanceof Error ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setPublishing(false);
    }
  };

  const handleEditSaved = (updated: CreatorMeal) => {
    setMeals(prev => prev.map(m => m.id === updated.id ? updated : m));
    setEditingMeal(null);
  };

  const handleDeleteMeal = async (mealId: string, mealNameStr: string) => {
    if (!confirm(`Unpublish "${mealNameStr}"? This will remove the meal from Discover and permanently erase all its saves. This cannot be undone.`)) return;
    const token = localStorage.getItem('accessToken');
    await fetch(`/api/creator/meals/${mealId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    loadPortal();
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="w-8 h-8 border-4 border-red-600 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  const qtrComponent     = stats ? (stats.qtrPct     * 0.5).toFixed(1) : '0.0';
  const alltimeComponent = stats ? (stats.alltimePct * 0.5).toFixed(1) : '0.0';
  const combinedShare    = stats ? (parseFloat(qtrComponent) + parseFloat(alltimeComponent)).toFixed(1) : '0.0';

  return (
    <>
      <div className="min-h-screen bg-gray-50">
        <AppHeader />

        <div className="max-w-3xl mx-auto px-4 py-8 space-y-4">

          {/* ── Profile card ── */}
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
            {!editingProfile ? (
              <div className="p-6">
                <div className="flex items-start gap-5">
                  {/* Avatar */}
                  <div className="flex-shrink-0">
                    {creator?.photo_url ? (
                      <img src={creator.photo_url} alt={creator.display_name} className="w-20 h-20 rounded-full object-cover border-2 border-gray-100" />
                    ) : (
                      <div className="w-20 h-20 rounded-full bg-gray-100 border-2 border-gray-200 flex items-center justify-center select-none"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg></div>
                    )}
                  </div>

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-0.5">Creator Portal</p>
                        <h1 className="text-xl font-bold text-gray-900 leading-tight">{creator?.display_name}</h1>
                        {creator?.social_handle && (
                          <p className="text-sm text-gray-500 mt-0.5">{creator.social_handle}</p>
                        )}
                        {creator?.bio && (
                          <p className="text-sm text-gray-600 mt-2 leading-relaxed">{creator.bio}</p>
                        )}
                        {creator?.handle && (
                          <a
                            href={`/${creator.handle}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 text-xs text-red-600 hover:text-red-700 mt-2 font-medium"
                          >
                            mealio.co/{creator.handle}
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                          </a>
                        )}
                      </div>
                      <button
                        onClick={openEditProfile}
                        className="flex-shrink-0 text-xs font-semibold text-gray-500 hover:text-gray-800 border border-gray-200 rounded-lg px-3 py-1.5 hover:bg-gray-50 transition-colors whitespace-nowrap"
                      >
                        Edit Profile
                      </button>
                    </div>
                  </div>
                </div>

                {/* Placeholder nudge if profile is sparse */}
                {!creator?.bio && !creator?.handle && (
                  <p className="mt-4 text-xs text-gray-400 border-t border-gray-50 pt-4">
                    Add a bio, website, and profile link to make your creator page shine.
                  </p>
                )}
              </div>
            ) : (
              <div className="p-6">
                <div className="flex items-center justify-between mb-5">
                  <h2 className="text-base font-bold text-gray-900">Edit Profile</h2>
                  <button onClick={cancelEditProfile} className="text-gray-400 hover:text-gray-600 transition-colors">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                  </button>
                </div>

                {/* Profile photo */}
                <div className="flex items-center gap-4 mb-5">
                  <button
                    type="button"
                    onClick={() => profilePhotoInputRef.current?.click()}
                    className="relative group flex-shrink-0 rounded-full focus:outline-none"
                  >
                    {profilePhotoPreview ? (
                      <img src={profilePhotoPreview} alt="" className="w-20 h-20 rounded-full object-cover border-2 border-gray-100" />
                    ) : (
                      <div className="w-20 h-20 rounded-full bg-gray-100 border-2 border-dashed border-gray-300 flex items-center justify-center select-none"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg></div>
                    )}
                    <div className="absolute inset-0 rounded-full bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2"><path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"/><circle cx="12" cy="13" r="4"/></svg>
                    </div>
                  </button>
                  <div>
                    <p className="text-sm font-semibold text-gray-700">Profile photo</p>
                    <p className="text-xs text-gray-400 mt-0.5">Click avatar to change</p>
                  </div>
                  <input
                    ref={profilePhotoInputRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={e => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      setProfilePhotoFile(file);
                      setProfilePhotoPreview(URL.createObjectURL(file));
                    }}
                  />
                </div>

                {/* Bio */}
                <div className="mb-4">
                  <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Bio</label>
                  <textarea
                    value={profileBio}
                    onChange={e => setProfileBio(e.target.value)}
                    rows={3}
                    placeholder="Tell people about yourself and your cooking style…"
                    className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-red-200 focus:border-red-400 resize-none transition-colors"
                  />
                </div>

                {/* Website / Social */}
                <div className="mb-4">
                  <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Website / Social</label>
                  <input
                    type="text"
                    value={profileWebsite}
                    onChange={e => setProfileWebsite(e.target.value)}
                    placeholder="@yourhandle or https://yoursite.com"
                    className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-red-200 focus:border-red-400 transition-colors"
                  />
                </div>

                {/* Profile link */}
                <div className="mb-5">
                  <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Profile link</label>
                  <div className="flex items-center border border-gray-200 rounded-xl overflow-hidden focus-within:ring-2 focus-within:ring-red-200 focus-within:border-red-400 transition-colors">
                    <span className="px-3 py-2.5 text-sm text-gray-400 bg-gray-50 border-r border-gray-200 select-none whitespace-nowrap">mealio.co/</span>
                    <input
                      value={handleInput}
                      onChange={e => setHandleInput(e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, ''))}
                      placeholder="yourhandle"
                      maxLength={30}
                      className="flex-1 px-3 py-2.5 text-sm text-gray-800 focus:outline-none bg-white"
                    />
                  </div>
                  <p className="text-xs text-gray-400 mt-1">3–30 characters, letters, numbers, hyphens, underscores</p>
                </div>

                {profileError && (
                  <p className="text-sm text-red-600 mb-4">{profileError}</p>
                )}

                <div className="flex gap-3">
                  <button
                    onClick={saveProfile}
                    disabled={profileSaving}
                    className="flex-1 bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white font-semibold rounded-xl py-2.5 text-sm transition-colors"
                  >
                    {profileSaving ? 'Saving…' : 'Save Profile'}
                  </button>
                  <button
                    onClick={cancelEditProfile}
                    className="px-5 py-2.5 border border-gray-200 rounded-xl text-sm text-gray-600 hover:bg-gray-50 transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* ── Stats ── */}
          {stats && (
            <div className="grid grid-cols-3 gap-3">
              {[
                { label: 'Followers',         value: stats.followers.toLocaleString(),  icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg> },
                { label: 'Saves this quarter', value: stats.savesQtr.toLocaleString(),  icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> },
                { label: 'Saves all time',    value: stats.savesAll.toLocaleString(),   icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg> },
              ].map(s => (
                <div key={s.label} className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4 text-center">
                  <div className="flex justify-center mb-1.5">{s.icon}</div>
                  <div className="text-2xl font-bold text-gray-900">{s.value}</div>
                  <div className="text-xs text-gray-400 mt-0.5 leading-tight">{s.label}</div>
                </div>
              ))}
            </div>
          )}

          {/* ── Earnings ── */}
          {stats && (
            <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
              <button
                onClick={() => setShowEarnings(prev => !prev)}
                className="w-full flex items-center justify-between px-5 py-4 text-left hover:bg-gray-50 transition-colors"
              >
                <div className="flex items-center gap-3">
                  <span className="text-sm font-semibold text-gray-800">How earnings work</span>
                  <span className="text-xs bg-red-50 text-red-600 font-semibold px-2 py-0.5 rounded-full">
                    Your share: {combinedShare}%
                  </span>
                </div>
                <svg
                  width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" strokeWidth="2" strokeLinecap="round"
                  style={{ transform: showEarnings ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.2s' }}
                >
                  <polyline points="6 9 12 15 18 9"/>
                </svg>
              </button>

              {showEarnings && (
                <div className="px-5 pb-5 border-t border-gray-50">
                  <p className="mt-4 text-sm text-gray-500 leading-relaxed">
                    Each quarter, 1/3 of subscription profit goes to the creator pool. Your share is split evenly between two factors:
                  </p>
                  <div className="mt-3 bg-orange-50 border border-orange-100 rounded-xl p-4 font-mono text-xs leading-7 text-gray-600">
                    <div className="text-xs font-sans font-bold text-gray-300 mb-2 tracking-widest uppercase">Example</div>
                    <div>Quarterly saves: 485 of 16,420 → 2.95% × 50% = <strong>1.48%</strong></div>
                    <div>All-time saves: &nbsp;3,896 of 67,741 → 5.75% × 50% = <strong>2.88%</strong></div>
                    <div className="border-t border-orange-200 mt-3 pt-3">
                      Combined share: <strong className="text-red-600">4.36%</strong> of the creator pool
                    </div>
                  </div>
                  <p className="mt-3 text-xs text-gray-400">Payouts above $25 are issued at quarter end via Tremendous.</p>
                </div>
              )}
            </div>
          )}

          {/* ── Publish success ── */}
          {publishSuccess && (
            <div className="bg-green-50 border border-green-200 rounded-2xl px-5 py-3.5 text-sm text-green-700 font-medium flex items-center gap-2">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>
              {publishSuccess}
            </div>
          )}

          {/* ── Publish button ── */}
          <button
            onClick={() => setShowForm(true)}
            className="w-full bg-red-600 hover:bg-red-700 text-white font-semibold rounded-2xl py-3.5 text-sm transition-colors flex items-center justify-center gap-2"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            Publish New Meal
          </button>

          {/* ── Publish modal ── */}
          {showForm && (
            <div
              className="fixed inset-0 bg-black/50 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4"
              onMouseDown={e => { publishDragRef.current = e.target !== e.currentTarget; }}
              onClick={e => { if (e.target !== e.currentTarget || publishDragRef.current) return; setShowForm(false); setPublishError(''); }}
            >
              <div className="bg-white w-full sm:rounded-2xl sm:max-w-lg rounded-t-2xl shadow-2xl flex flex-col max-h-[92vh]">
                <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 flex-shrink-0">
                  <h3 className="text-base font-bold text-gray-900">Publish a New Meal</h3>
                  <button
                    onClick={() => { setShowForm(false); setPublishError(''); }}
                    className="text-gray-400 hover:text-gray-600 transition-colors"
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                  </button>
                </div>

              <div className="overflow-y-auto flex-1">
              <form onSubmit={handlePublish} className="p-6 space-y-5">

                {/* Name */}
                <div>
                  <label className={pLabelCls}>Meal Name <span className="text-red-500">*</span></label>
                  <input value={mealName} onChange={e => setMealName(e.target.value)} placeholder="e.g. Spicy Chicken Ramen" className={pInputCls} />
                </div>

                {/* Source */}
                <div>
                  <label className={pLabelCls}>Recipe URL <span className="text-gray-400 font-normal">(optional)</span></label>
                  <input value={mealSource} onChange={e => setMealSource(e.target.value)} placeholder="https://yourblog.com/recipe" className={pInputCls} />
                </div>

                {/* Photo */}
                <div>
                  <label className={pLabelCls}>Photo <span className="text-gray-400 font-normal">(optional)</span></label>
                  <div className="flex items-center gap-3 flex-wrap">
                    {photoPreview && (
                      <div className="relative">
                        <img src={photoPreview} alt="" className="w-16 h-16 rounded-xl object-cover block border border-gray-100" />
                        <button
                          type="button"
                          onClick={() => { setPhotoPreview(''); setPhotoFile(null); }}
                          className="absolute -top-2 -right-2 w-5 h-5 rounded-full bg-gray-800 text-white border-none cursor-pointer text-xs flex items-center justify-center leading-none"
                          title="Remove photo"
                        >✕</button>
                      </div>
                    )}
                    <input type="file" accept="image/*" ref={photoInputRef} onChange={handlePhotoChange} className="hidden" />
                    <button type="button" onClick={() => photoInputRef.current?.click()} className={pSecBtnCls}>
                      Choose photo
                    </button>
                    <button
                      type="button"
                      onClick={handleGeneratePhoto}
                      disabled={generating || !mealName.trim()}
                      className={`${pSecBtnCls} disabled:opacity-40 disabled:cursor-not-allowed`}
                    >
                      {generating ? 'Generating…' : 'Generate photo'}
                    </button>
                  </div>
                  {thumbs.length > 0 && (
                    <div className="flex gap-2 mt-3">
                      {thumbs.map((thumb, i) => (
                        <button
                          key={i}
                          type="button"
                          onClick={() => selectSuggestion(i)}
                          className="flex-1 p-0 border-none rounded-xl overflow-hidden cursor-pointer bg-none"
                          style={{ outline: selectedIdx === i ? '2.5px solid #3b82f6' : '2.5px solid transparent', outlineOffset: '2px' }}
                        >
                          <img src={thumb} alt="" className="w-full aspect-square object-cover block" />
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                {/* Difficulty */}
                <div>
                  <label className={pLabelCls}>Difficulty <span className="text-gray-400 font-normal">(optional)</span></label>
                  <div className="flex items-center gap-2">
                    {[1, 2, 3, 4, 5].map(v => (
                      <button
                        key={v}
                        type="button"
                        onClick={() => setMealDifficulty(mealDifficulty === v ? null : v)}
                        className="w-10 h-10 rounded-xl text-sm font-semibold transition-colors"
                        style={{
                          border: `1.5px solid ${mealDifficulty === v ? '#dd0031' : '#e5e7eb'}`,
                          background: mealDifficulty === v ? '#dd0031' : '#fafafa',
                          color: mealDifficulty === v ? 'white' : '#6b7280',
                          cursor: 'pointer',
                        }}
                      >{v}</button>
                    ))}
                    {mealDifficulty && <span className="text-sm text-gray-400 ml-1">{DIFFICULTY_LABELS[mealDifficulty]}</span>}
                  </div>
                </div>

                {/* Serves */}
                <div>
                  <label className={pLabelCls}>Serves <span className="text-gray-400 font-normal">(optional)</span></label>
                  <input value={mealServes} onChange={e => setMealServes(e.target.value)} placeholder="e.g. 4 or 2-4" className={pInputCls} />
                </div>

                {/* Story */}
                <div>
                  <label className={pLabelCls}>Story <span className="text-gray-400 font-normal">(optional)</span></label>
                  <textarea
                    value={mealStory}
                    onChange={e => setMealStory(e.target.value)}
                    rows={3}
                    placeholder="e.g. Perfect for a summer BBQ… · Great budget-friendly weeknight dinner · High protein, low carb – great for meal prep"
                    className={`${pInputCls} resize-y font-sans`}
                  />
                </div>

                {/* Measurements */}
                <div>
                  <label className={pLabelCls}>Measurements <span className="text-red-500">*</span></label>
                  <div className="bg-gray-50 border border-gray-100 rounded-xl px-4 py-3 mb-3 text-xs text-gray-500 leading-relaxed">
                    Name each ingredient as it would appear in a grocery store search — specific enough to find the right product, but generic enough to work across stores.
                    <div className="mt-1.5 space-x-3">
                      <span><span className="text-green-600 font-semibold">✓</span> &quot;Chicken Stock&quot; · &quot;Garlic&quot; · &quot;Rotisserie Chicken&quot;</span>
                      <span><span className="text-red-500 font-semibold">✗</span> &quot;Costco Bananas&quot; · &quot;Fresh Herbs&quot;</span>
                    </div>
                  </div>
                  <div className="space-y-2 mb-2">
                    {mealIngredients.map((ing, i) => (
                      <div key={i} className="flex items-center gap-2">
                        <input
                          value={ing.ingredientName}
                          onChange={e => updateIngredientForm(i, 'ingredientName', e.target.value)}
                          placeholder="Ingredient name"
                          className={`${pInputCls} flex-1 min-w-0`}
                        />
                        <input
                          type={ing.unit === 'Qty' ? 'number' : 'text'}
                          value={ing.measure}
                          min={ing.unit === 'Qty' ? 1 : undefined}
                          onChange={e => updateIngredientForm(i, 'measure', e.target.value)}
                          placeholder={ing.unit === 'Qty' ? '1' : 'amt'}
                          className={`${pInputCls} w-16 text-center`}
                        />
                        <select
                          value={ing.unit}
                          onChange={e => updateIngredientForm(i, 'unit', e.target.value)}
                          className={`${pInputCls} w-20`}
                        >
                          {UNITS.map(u => <option key={u} value={u}>{u}</option>)}
                        </select>
                        {mealIngredients.length > 1 && (
                          <button type="button" onClick={() => removeIngredientRow(i)} className="text-gray-300 hover:text-red-400 text-lg leading-none cursor-pointer transition-colors bg-none border-none px-1">×</button>
                        )}
                      </div>
                    ))}
                  </div>
                  <button type="button" onClick={addIngredientRow} className="text-sm text-red-600 hover:text-red-700 font-medium bg-none border-none cursor-pointer p-0 transition-colors">
                    + Add ingredient
                  </button>
                </div>

                {/* Recipe */}
                <div>
                  <label className={pLabelCls}>Recipe Instructions <span className="text-gray-400 font-normal">(optional)</span></label>
                  <textarea
                    value={mealRecipe}
                    onChange={e => setMealRecipe(e.target.value)}
                    rows={6}
                    placeholder={'1. Boil 4 cups of water...\n2. Add 200g of noodles...'}
                    className={`${pInputCls} resize-y font-sans`}
                  />
                </div>

                {/* Tags */}
                <div>
                  <label className={pLabelCls}>Tags <span className="text-gray-400 font-normal">(up to 3)</span></label>
                  <TagPicker selected={mealTags} onChange={setMealTags} />
                </div>

                {publishError && (
                  <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-700">
                    {publishError}
                  </div>
                )}

                <div className="flex gap-3 pt-1">
                  <button
                    type="submit"
                    disabled={publishing}
                    className="flex-1 bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white font-semibold rounded-xl py-3 text-sm transition-colors"
                  >
                    {publishing ? 'Publishing…' : 'Publish Meal'}
                  </button>
                  <button
                    type="button"
                    onClick={() => { setShowForm(false); setPublishError(''); }}
                    className="px-5 py-3 border border-gray-200 rounded-xl text-sm text-gray-600 hover:bg-gray-50 transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </form>
              </div>
            </div>
            </div>
          )}

          {/* ── Published meals ── */}
          <div>
            <h3 className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-3 px-1">
              Published Meals {meals.length > 0 && `(${meals.length})`}
            </h3>

            {meals.length === 0 ? (
              <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-12 text-center">
                <div className="text-4xl mb-3">🍽️</div>
                <p className="text-sm text-gray-400">No meals published yet. Hit the button above to get started!</p>
              </div>
            ) : (
              <div className="space-y-2">
                {meals.map(meal => (
                  <div key={meal.id} className="bg-white rounded-2xl border border-gray-100 shadow-sm flex items-center gap-4 p-4 hover:shadow-md transition-shadow">
                    <button
                      onClick={() => setViewingMeal(meal)}
                      className="flex items-center gap-4 flex-1 min-w-0 text-left bg-none border-none p-0 cursor-pointer"
                    >
                      {meal.photo_url ? (
                        <img src={meal.photo_url} alt={meal.name} className="w-14 h-14 rounded-xl object-cover flex-shrink-0" />
                      ) : (
                        <div className="w-14 h-14 rounded-xl bg-gray-100 flex-shrink-0 flex items-center justify-center text-2xl select-none">🍽️</div>
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="font-semibold text-gray-900 text-sm leading-snug truncate">{meal.name}</div>
                        <div className="text-xs text-gray-400 mt-0.5">
                          <span className="font-medium text-gray-500">{meal.saves_all.toLocaleString()}</span> save{meal.saves_all !== 1 ? 's' : ''}
                          <span className="mx-1.5 text-gray-200">·</span>
                          Trending <span className="font-medium text-gray-500">{meal.trending_score}</span>/100
                        </div>
                      </div>
                    </button>

                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      <button
                        onClick={() => setEditingMeal(meal)}
                        className="text-xs font-semibold text-gray-500 hover:text-gray-800 border border-gray-200 rounded-lg px-2.5 py-1.5 hover:bg-gray-50 transition-colors"
                      >
                        Edit
                      </button>
                      <button
                        onClick={async () => {
                          const url = `${process.env.NEXT_PUBLIC_APP_URL}/meal/p/${meal.id}`;
                          await navigator.clipboard.writeText(url).catch(() => prompt('Copy this share link:', url));
                          setCopiedMealId(meal.id);
                          setTimeout(() => setCopiedMealId(id => (id === meal.id ? null : id)), 3000);
                        }}
                        className={`text-xs font-semibold border rounded-lg px-2.5 py-1.5 transition-colors ${
                          copiedMealId === meal.id
                            ? 'text-green-600 bg-green-50 border-green-200'
                            : 'text-gray-500 hover:text-gray-800 border-gray-200 hover:bg-gray-50'
                        }`}
                      >
                        {copiedMealId === meal.id ? '✓ Copied' : 'Share'}
                      </button>
                      <button
                        onClick={() => handleDeleteMeal(meal.id, meal.name)}
                        className="p-1.5 text-gray-300 hover:text-red-500 hover:bg-red-50 transition-colors rounded-lg"
                        title="Unpublish"
                      >
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="3 6 5 6 21 6"/>
                          <path d="M19 6l-1 14H6L5 6"/>
                          <path d="M10 11v6M14 11v6"/>
                          <path d="M9 6V4h6v2"/>
                        </svg>
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

        </div>
      </div>

      {viewingMeal && !editingMeal && (
        <MealViewModal
          meal={viewingMeal}
          onEdit={() => { setEditingMeal(viewingMeal); setViewingMeal(null); }}
          onClose={() => setViewingMeal(null)}
        />
      )}
      {editingMeal && (
        <EditPresetMealModal
          meal={editingMeal}
          onSave={handleEditSaved}
          onClose={() => setEditingMeal(null)}
        />
      )}
      <AppFooter />
    </>
  );
}

// ── Modal styles (used by EditPresetMealModal) ────────────────────────────────

const modalLabelStyle: React.CSSProperties = {
  display: 'block', fontSize: '12px', fontWeight: 600, color: '#555', marginBottom: '5px', textTransform: 'uppercase', letterSpacing: '0.03em',
};

const modalInputStyle: React.CSSProperties = {
  width: '100%', padding: '9px 11px', border: '1px solid #e0e0e0', borderRadius: '8px',
  fontSize: '14px', boxSizing: 'border-box', outline: 'none', marginBottom: 0,
};

const modalBtnStyle: React.CSSProperties = {
  fontSize: '12px', padding: '7px 12px', border: '1px solid #e0e0e0', borderRadius: '7px',
  background: '#fafafa', color: '#444', cursor: 'pointer', whiteSpace: 'nowrap',
};

const qtyBtnStyle: React.CSSProperties = {
  width: '24px', height: '24px', border: '1px solid #e0e0e0', borderRadius: '5px',
  background: '#fafafa', color: '#555', fontSize: '14px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0,
};

// ── Publish form Tailwind class constants ─────────────────────────────────────

const pLabelCls = 'block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5';
const pInputCls = 'w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-red-200 focus:border-red-400 transition-colors';
const pSecBtnCls = 'text-sm px-3.5 py-2 border border-gray-200 rounded-xl bg-gray-50 hover:bg-gray-100 text-gray-600 font-medium cursor-pointer transition-colors';
