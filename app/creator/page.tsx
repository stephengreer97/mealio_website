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
  productName: string;
  searchTerm: string;
  quantity: number;
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
  const [ingredients, setIngredients] = useState<Ingredient[]>(
    meal.ingredients.map(i => ({ ...i }))
  );
  const [newIngredient, setNewIngredient] = useState('');
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
    } catch (err) {
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

  const updateIngredientName = (i: number, value: string) =>
    setIngredients(prev => prev.map((ing, idx) =>
      idx === i ? { ...ing, productName: value, searchTerm: value } : ing
    ));

  const updateIngredientQty = (i: number, delta: number) =>
    setIngredients(prev => prev.map((ing, idx) => {
      if (idx !== i) return ing;
      return { ...ing, quantity: Math.max(1, (ing.quantity ?? 1) + delta) };
    }));

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
    setSaving(true);
    setError('');
    try {
      const normalizeUrl = (url: string) => {
        const u = url.trim();
        if (!u) return '';
        return u.startsWith('http://') || u.startsWith('https://') ? u : `https://${u}`;
      };

      // If the user picked a new photo, upload it now (avoids race condition)
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
          ingredients,
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
      onSave({ ...meal, ...data.meal, ingredients, recipe: recipe.trim() || null, source: normalizeUrl(source), story: story.trim() || null, tags: selectedTags });
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

          {/* Serves */}
          <div>
            <label style={modalLabelStyle}>Serves <span style={{ fontWeight: 400, color: '#aaa' }}>(optional)</span></label>
            <input type="text" value={serves} onChange={e => setServes(e.target.value)} placeholder="e.g. 4 or 2-4" style={modalInputStyle} />
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

          {/* Tags */}
          <div>
            <label style={modalLabelStyle}>Tags <span style={{ fontWeight: 400, color: '#aaa' }}>(up to 3)</span></label>
            <TagPicker selected={selectedTags} onChange={setSelectedTags} />
          </div>

          {/* Recipe URL */}
          <div>
            <label style={modalLabelStyle}>Recipe URL <span style={{ fontWeight: 400, color: '#aaa' }}>(optional)</span></label>
            <input type="url" value={source} onChange={e => setSource(e.target.value)} placeholder="https://…" style={modalInputStyle} />
          </div>

          {/* Story */}
          <div>
            <label style={modalLabelStyle}>Story <span style={{ fontWeight: 400, color: '#aaa' }}>(optional)</span></label>
            <textarea value={story} onChange={e => setStory(e.target.value)} rows={3} placeholder="e.g. Perfect for a summer BBQ, or the story behind this meal…" style={{ ...modalInputStyle, resize: 'vertical', fontFamily: 'inherit' }} />
          </div>

          {/* Recipe */}
          <div>
            <label style={modalLabelStyle}>Recipe Instructions <span style={{ fontWeight: 400, color: '#aaa' }}>(optional)</span></label>
            <textarea value={recipe} onChange={e => setRecipe(e.target.value)} rows={5} style={{ ...modalInputStyle, resize: 'vertical', fontFamily: 'inherit' }} />
          </div>

          {/* Ingredients */}
          <div>
            <label style={modalLabelStyle}>Ingredients ({ingredients.length})</label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', maxHeight: '200px', overflowY: 'auto', marginBottom: '8px', paddingRight: '4px' }}>
              {ingredients.map((ing, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <input
                    type="text"
                    value={ing.productName}
                    onChange={e => updateIngredientName(i, e.target.value)}
                    style={{ ...modalInputStyle, flex: 1, marginBottom: 0 }}
                  />
                  <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flexShrink: 0 }}>
                    <button type="button" onClick={() => updateIngredientQty(i, -1)} style={qtyBtnStyle}>−</button>
                    <span style={{ fontSize: '13px', minWidth: '20px', textAlign: 'center', color: '#333' }}>{ing.quantity ?? 1}</span>
                    <button type="button" onClick={() => updateIngredientQty(i, +1)} style={qtyBtnStyle}>+</button>
                  </div>
                  <button type="button" onClick={() => removeIngredient(i)} style={{ background: 'none', border: 'none', color: '#bbb', fontSize: '16px', cursor: 'pointer', flexShrink: 0, lineHeight: 1 }}>×</button>
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', gap: '8px' }}>
              <input
                type="text"
                value={newIngredient}
                onChange={e => setNewIngredient(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addIngredient(); } }}
                placeholder="Add ingredient…"
                style={{ ...modalInputStyle, flex: 1, marginBottom: 0 }}
              />
              <button type="button" onClick={addIngredient} style={{ ...modalBtnStyle, flexShrink: 0 }}>Add</button>
            </div>
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

export default function CreatorPortal() {
  const router = useRouter();
  const [creator, setCreator] = useState<Creator | null>(null);
  const [meals, setMeals] = useState<CreatorMeal[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);

  const [copiedMealId, setCopiedMealId] = useState<string | null>(null);
  const [editingMeal, setEditingMeal] = useState<CreatorMeal | null>(null);

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
  const [mealIngredients, setMealIngredients] = useState<Ingredient[]>([
    { productName: '', searchTerm: '', quantity: 1 },
  ]);
  const [mealTags, setMealTags]           = useState<string[]>([]);
  const [photoFile, setPhotoFile]         = useState<File | null>(null);
  const [photoPreview, setPhotoPreview]   = useState('');
  const [generating, setGenerating]   = useState(false);
  const [thumbs, setThumbs]           = useState<string[]>([]);
  const [fulls, setFulls]             = useState<string[]>([]);
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { loadPortal(); }, []);

  const loadPortal = async () => {
    const token = localStorage.getItem('accessToken');
    if (!token) { router.push('/'); return; }

    const authRes = await fetch('/api/auth/verify', { headers: { Authorization: `Bearer ${token}` } });
    if (!authRes.ok) { localStorage.clear(); router.push('/'); return; }

    const meRes = await fetch('/api/creator/me', { headers: { Authorization: `Bearer ${token}` } });
    if (!meRes.ok) { router.push('/creator/apply'); return; }

    const data = await meRes.json();
    if (!data.creator) { router.push('/creator/apply'); return; }

    setCreator(data.creator);
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
    setMealIngredients(prev => [...prev, { productName: '', searchTerm: '', quantity: 1 }]);

  const removeIngredientRow = (i: number) =>
    setMealIngredients(prev => prev.filter((_, idx) => idx !== i));

  const updateIngredient = (i: number, field: keyof Ingredient, value: string | number) =>
    setMealIngredients(prev => prev.map((ing, idx) => {
      if (idx !== i) return ing;
      const updated = { ...ing, [field]: value };
      if (field === 'productName') updated.searchTerm = value as string;
      return updated;
    }));

  const handlePublish = async (e: React.FormEvent) => {
    e.preventDefault();
    setPublishError('');
    setPublishSuccess('');

    const validIngredients = mealIngredients.filter(i => i.productName.trim());
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
          ingredients: validIngredients.map(i => ({
            productName: i.productName.trim(),
            searchTerm:  i.searchTerm.trim() || i.productName.trim(),
            quantity:    Number(i.quantity) || 1,
          })),
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
      setMealIngredients([{ productName: '', searchTerm: '', quantity: 1 }]);
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
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f5f5f5' }}>
        <p style={{ color: '#888' }}>Loading…</p>
      </div>
    );
  }

  const qtrComponent     = stats ? (stats.qtrPct     * 0.5).toFixed(1) : '0.0';
  const alltimeComponent = stats ? (stats.alltimePct * 0.5).toFixed(1) : '0.0';

  return (
    <>
    <div style={{ minHeight: '100vh', background: '#f5f5f5', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' }}>
      <AppHeader />

      <div style={{ maxWidth: '720px', margin: '0 auto', padding: '24px 20px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '14px', marginBottom: '20px' }}>
          {creator?.photo_url ? (
            <img src={creator.photo_url} alt={creator.display_name} style={{ width: '56px', height: '56px', borderRadius: '50%', objectFit: 'cover', flexShrink: 0, border: '2px solid #e5e7eb' }} />
          ) : (
            <div style={{ width: '56px', height: '56px', borderRadius: '50%', background: '#f3f4f6', border: '2px solid #e5e7eb', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '22px', flexShrink: 0 }}>👤</div>
          )}
          <div>
            <p style={{ margin: '0 0 2px', fontSize: '12px', color: '#888' }}>Creator Portal</p>
            <h1 style={{ margin: 0, fontSize: '22px', fontWeight: 700, color: '#111' }}>{creator?.display_name}</h1>
            {creator?.social_handle && <p style={{ margin: '2px 0 0', fontSize: '13px', color: '#666' }}>{creator.social_handle}</p>}
          </div>
        </div>

        {/* Stats */}
        {stats && (
          <>
            {/* Row 1: Raw save counts */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '12px', marginBottom: '12px' }}>
              {[
                { label: 'Followers',            value: stats.followers.toLocaleString() },
                { label: 'Saves (this quarter)', value: stats.savesQtr.toLocaleString() },
                { label: 'Saves (all time)',     value: stats.savesAll.toLocaleString() },
              ].map(s => (
                <div key={s.label} style={{ background: 'white', borderRadius: '10px', padding: '16px', boxShadow: '0 1px 3px rgba(0,0,0,0.08)', textAlign: 'center' }}>
                  <div style={{ fontSize: '26px', fontWeight: 700, color: '#333' }}>{s.value}</div>
                  <div style={{ fontSize: '12px', color: '#888', marginTop: '4px' }}>{s.label}</div>
                </div>
              ))}
            </div>

          </>
        )}

        {/* Revenue info */}
        {stats && (
          <div style={{ background: '#fff8f0', border: '1px solid #ffe0b2', borderRadius: '10px', padding: '16px', marginBottom: '24px', fontSize: '13px', color: '#555', lineHeight: 1.8 }}>
            <strong style={{ color: '#dd0031', display: 'block', marginBottom: '8px' }}>How earnings work</strong>
            <div>Each quarter, 1/3 of subscription profit goes to the creator pool. Your share is split evenly between two factors:</div>
            <div style={{ margin: '10px 0', fontFamily: 'monospace', fontSize: '12px', background: '#fff3e0', borderRadius: '6px', padding: '10px 12px', lineHeight: 2 }}>
              <div style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.05em', color: '#bbb', marginBottom: '4px', fontFamily: 'sans-serif' }}>EXAMPLE</div>
              <div>Quarterly saves:&nbsp; 485 of 16,420 → 2.95% × 50% = <strong>1.48%</strong></div>
              <div>All-time saves:&nbsp;&nbsp; 3,896 of 67,741 → 5.75% × 50% = <strong>2.88%</strong></div>
              <div style={{ borderTop: '1px solid #ffe0b2', marginTop: '6px', paddingTop: '6px' }}>
                Combined share: <strong style={{ color: '#dd0031' }}>4.36%</strong> of the creator pool
              </div>
            </div>
            <div style={{ color: '#888', fontSize: '12px' }}>Payouts above $25 are issued at quarter end via Tremendous.</div>
          </div>
        )}

        {publishSuccess && (
          <div style={{ background: '#f0fff4', border: '1px solid #c6f6d5', borderRadius: '8px', padding: '12px 16px', marginBottom: '16px', fontSize: '14px', color: '#276749' }}>
            {publishSuccess}
          </div>
        )}

        {/* Publish button / form */}
        {!showForm ? (
          <button onClick={() => setShowForm(true)} style={{ width: '100%', background: '#dd0031', color: 'white', border: 'none', borderRadius: '10px', padding: '14px', fontSize: '15px', fontWeight: 600, cursor: 'pointer', marginBottom: '24px' }}>
            + Publish New Meal
          </button>
        ) : (
          <div style={{ background: 'white', borderRadius: '12px', padding: '24px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', marginBottom: '24px' }}>
            <h3 style={{ margin: '0 0 20px', fontSize: '16px', color: '#222' }}>Publish a New Meal</h3>
            <form onSubmit={handlePublish}>

              {/* Name */}
              <div style={{ marginBottom: '16px' }}>
                <label style={labelStyle}>Meal Name <span style={{ color: '#dd0031' }}>*</span></label>
                <input value={mealName} onChange={e => setMealName(e.target.value)} placeholder="e.g. Spicy Chicken Ramen" style={inputStyle} />
              </div>

              {/* Photo */}
              <div style={{ marginBottom: '16px' }}>
                <label style={labelStyle}>Photo <span style={{ color: '#999', fontWeight: 400 }}>(optional)</span></label>
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
                  {photoPreview && (
                    <div style={{ position: 'relative' }}>
                      <img src={photoPreview} alt="" style={{ width: '64px', height: '64px', borderRadius: '8px', objectFit: 'cover', display: 'block' }} />
                      <button
                        type="button"
                        onClick={() => { setPhotoPreview(''); setPhotoFile(null); }}
                        style={{ position: 'absolute', top: '-8px', right: '-8px', width: '20px', height: '20px', borderRadius: '50%', background: '#333', color: 'white', border: 'none', cursor: 'pointer', fontSize: '11px', display: 'flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1 }}
                        title="Remove photo"
                      >
                        ✕
                      </button>
                    </div>
                  )}
                  <input type="file" accept="image/*" ref={photoInputRef} onChange={handlePhotoChange} style={{ display: 'none' }} />
                  <button type="button" onClick={() => photoInputRef.current?.click()} style={{ fontSize: '13px', padding: '8px 14px', border: '1px solid #ddd', borderRadius: '8px', background: '#fafafa', cursor: 'pointer' }}>
                    Choose photo
                  </button>
                  <button
                    type="button"
                    onClick={handleGeneratePhoto}
                    disabled={generating || !mealName.trim()}
                    style={{ fontSize: '13px', padding: '8px 14px', border: '1px solid #ddd', borderRadius: '8px', background: '#fafafa', cursor: generating || !mealName.trim() ? 'not-allowed' : 'pointer', opacity: generating || !mealName.trim() ? 0.5 : 1 }}
                  >
                    {generating ? 'Generating…' : 'Generate photo'}
                  </button>
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

              {/* Ingredients */}
              <div style={{ marginBottom: '16px' }}>
                <label style={labelStyle}>Ingredients <span style={{ color: '#dd0031' }}>*</span></label>
                <div style={{ background: '#f8f9fa', border: '1px solid #e9ecef', borderRadius: '8px', padding: '10px 12px', marginBottom: '12px', fontSize: '12.5px', color: '#666', lineHeight: 1.6 }}>
                  Name each ingredient as it would appear in a grocery store search — specific enough to find the right product, but generic enough to work across stores. Include the size or quantity when it matters.
                  <div style={{ marginTop: '6px', color: '#999' }}>
                    <span style={{ color: '#22c55e', fontWeight: 600 }}>✓ Good:</span> "Chicken Stock, 32 oz" &nbsp;·&nbsp; "Garlic" &nbsp;·&nbsp; "Rotisserie Chicken"<br />
                    <span style={{ color: '#ef4444', fontWeight: 600 }}>✗ Avoid:</span> "Costco Bananas" &nbsp;·&nbsp; "Fresh Herbs"
                  </div>
                </div>
                {mealIngredients.map((ing, i) => (
                  <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 60px 32px', gap: '8px', marginBottom: '8px', alignItems: 'center' }}>
                    <input value={ing.productName} onChange={e => updateIngredient(i, 'productName', e.target.value)} placeholder="e.g. Chicken Stock, 32 oz" style={{ ...inputStyle, marginBottom: 0 }} />
                    <input type="number" value={ing.quantity} min={1} onChange={e => updateIngredient(i, 'quantity', parseInt(e.target.value) || 1)} style={{ ...inputStyle, marginBottom: 0, textAlign: 'center' }} />
                    {mealIngredients.length > 1 && (
                      <button type="button" onClick={() => removeIngredientRow(i)} style={{ background: 'none', border: 'none', color: '#aaa', fontSize: '18px', cursor: 'pointer', lineHeight: 1 }}>×</button>
                    )}
                  </div>
                ))}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 60px', gap: '8px', marginBottom: '6px' }}>
                  <div style={{ fontSize: '11px', color: '#aaa' }}>Grocery store product name</div>
                  <div style={{ fontSize: '11px', color: '#aaa', textAlign: 'center' }}>Qty</div>
                </div>
                <button type="button" onClick={addIngredientRow} style={{ fontSize: '13px', color: '#dd0031', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
                  + Add ingredient
                </button>
              </div>

              {/* Story */}
              <div style={{ marginBottom: '16px' }}>
                <label style={labelStyle}>Story <span style={{ color: '#999', fontWeight: 400 }}>(optional)</span></label>
                <textarea value={mealStory} onChange={e => setMealStory(e.target.value)} rows={3} placeholder="e.g. Perfect for a summer BBQ, or the story behind this meal…" style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit' }} />
              </div>

              {/* Recipe */}
              <div style={{ marginBottom: '16px' }}>
                <label style={labelStyle}>Recipe Instructions <span style={{ color: '#999', fontWeight: 400 }}>(optional)</span></label>
                <textarea value={mealRecipe} onChange={e => setMealRecipe(e.target.value)} rows={6} placeholder={'1. Boil 4 cups of water...\n2. Add 200g of noodles...'} style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit' }} />
              </div>

              {/* Source */}
              <div style={{ marginBottom: '16px' }}>
                <label style={labelStyle}>Recipe URL <span style={{ color: '#999', fontWeight: 400 }}>(optional)</span></label>
                <input value={mealSource} onChange={e => setMealSource(e.target.value)} placeholder="https://yourblog.com/recipe" style={inputStyle} />
              </div>

              {/* Serves */}
              <div style={{ marginBottom: '16px' }}>
                <label style={labelStyle}>Serves <span style={{ color: '#999', fontWeight: 400 }}>(optional)</span></label>
                <input value={mealServes} onChange={e => setMealServes(e.target.value)} placeholder="e.g. 4 or 2-4" style={inputStyle} />
              </div>

              {/* Difficulty */}
              <div style={{ marginBottom: '16px' }}>
                <label style={labelStyle}>Difficulty <span style={{ color: '#999', fontWeight: 400 }}>(optional)</span></label>
                <div style={{ display: 'flex', gap: '8px' }}>
                  {[1, 2, 3, 4, 5].map(v => (
                    <button key={v} type="button" onClick={() => setMealDifficulty(mealDifficulty === v ? null : v)}
                      style={{ width: '40px', height: '40px', borderRadius: '50%', border: `1.5px solid ${mealDifficulty === v ? '#dd0031' : '#ddd'}`, background: mealDifficulty === v ? '#dd0031' : '#fafafa', color: mealDifficulty === v ? 'white' : '#888', fontSize: '14px', fontWeight: 600, cursor: 'pointer' }}>
                      {v}
                    </button>
                  ))}
                  {mealDifficulty && <span style={{ alignSelf: 'center', fontSize: '13px', color: '#888' }}>{DIFFICULTY_LABELS[mealDifficulty]}</span>}
                </div>
              </div>

              {/* Tags */}
              <div style={{ marginBottom: '24px' }}>
                <label style={labelStyle}>Tags <span style={{ color: '#999', fontWeight: 400 }}>(up to 3)</span></label>
                <TagPicker selected={mealTags} onChange={setMealTags} />
              </div>

              {publishError && (
                <div style={{ background: '#fff0f0', border: '1px solid #ffcccc', borderRadius: '8px', padding: '12px', marginBottom: '16px', fontSize: '14px', color: '#c40029' }}>
                  {publishError}
                </div>
              )}

              <div style={{ display: 'flex', gap: '12px' }}>
                <button type="submit" disabled={publishing} style={{ flex: 1, background: publishing ? '#aaa' : '#dd0031', color: 'white', border: 'none', borderRadius: '8px', padding: '12px', fontSize: '14px', fontWeight: 600, cursor: publishing ? 'not-allowed' : 'pointer' }}>
                  {publishing ? 'Publishing…' : 'Publish Meal'}
                </button>
                <button type="button" onClick={() => { setShowForm(false); setPublishError(''); }} style={{ padding: '12px 20px', border: '1px solid #ddd', borderRadius: '8px', background: 'white', fontSize: '14px', cursor: 'pointer', color: '#666' }}>
                  Cancel
                </button>
              </div>
            </form>
          </div>
        )}

        {/* Published meals */}
        <h3 style={{ margin: '0 0 12px', fontSize: '16px', color: '#333' }}>Your Published Meals</h3>
        {meals.length === 0 ? (
          <div style={{ background: 'white', borderRadius: '10px', padding: '32px', textAlign: 'center', color: '#aaa', boxShadow: '0 1px 3px rgba(0,0,0,0.08)' }}>
            No meals published yet. Publish your first meal above!
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {meals.map(meal => (
              <div key={meal.id} style={{ background: 'white', borderRadius: '10px', padding: '14px 16px', boxShadow: '0 1px 3px rgba(0,0,0,0.08)', display: 'flex', alignItems: 'center', gap: '14px' }}>
                {meal.photo_url && <img src={meal.photo_url} alt={meal.name} style={{ width: '52px', height: '52px', borderRadius: '8px', objectFit: 'cover', flexShrink: 0 }} />}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: '14px', color: '#222' }}>{meal.name}</div>
                  <div style={{ fontSize: '12px', color: '#999', marginTop: '2px' }}>
                    {meal.saves_all.toLocaleString()} all-time save{meal.saves_all !== 1 ? 's' : ''} · Trending {meal.trending_score}/100
                  </div>
                </div>
                <button
                  onClick={() => setEditingMeal(meal)}
                  style={{ background: 'none', border: '1px solid #e5e7eb', borderRadius: '6px', color: '#6b7280', fontSize: '12px', fontWeight: 600, padding: '4px 10px', cursor: 'pointer', flexShrink: 0 }}
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
                  style={{ background: 'none', border: '1px solid #e5e7eb', borderRadius: '6px', color: copiedMealId === meal.id ? '#16a34a' : '#6b7280', fontSize: '12px', fontWeight: 600, padding: '4px 10px', cursor: 'pointer', flexShrink: 0 }}
                >
                  {copiedMealId === meal.id ? '✓ Copied' : 'Share'}
                </button>
                <button onClick={() => handleDeleteMeal(meal.id, meal.name)} style={{ background: 'none', border: 'none', cursor: 'pointer', flexShrink: 0, padding: '2px 6px', lineHeight: 1 }} title="Unpublish">
                  <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#dd0031" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="3 6 5 6 21 6" />
                    <path d="M19 6l-1 14H6L5 6" />
                    <path d="M10 11v6M14 11v6" />
                    <path d="M9 6V4h6v2" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>

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

const labelStyle: React.CSSProperties = {
  display: 'block', fontSize: '13px', fontWeight: 600, color: '#444', marginBottom: '6px',
};

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '10px 12px', border: '1px solid #e0e0e0', borderRadius: '8px',
  fontSize: '14px', boxSizing: 'border-box', outline: 'none', marginBottom: 0,
};
