'use client';

import { useState } from 'react';
import { ALL_UNITS } from '@/lib/import/ingredients';
import { canonicalizeTags, MAX_MEAL_TAGS, MEAL_TAGS, tagCapError, toggleTag } from '@/lib/import/vocab';
import type { CreatorMealDraft, DraftIngredient } from '@/lib/import/types';

/**
 * The publish form's nine fields, pre-filled from a queued draft.
 *
 * So a wrong measure is a fix rather than a delete-and-redo. Saving does **not**
 * publish: the reviewer lands back on the card and still has to approve it,
 * because someone correcting a typo has not thereby said the recipe is right.
 *
 * The vocabularies come from `lib/import/vocab.ts` and `lib/import/ingredients.ts`
 * — the same lists the pipeline canonicalises against, so the picker cannot
 * offer a tag or a unit the server would then strip back out.
 *
 * Lifted out of `AdminReviewQueue` when the creator's queue (MEAL-89) needed the
 * same form. Shared rather than copied, because the two screens are the same
 * decision seen from either side: a second nine-field editor is a second place
 * for the tag cap, the unit list and the countable-vs-measured split to drift,
 * and every one of those drifts ends as a value the server silently rewrites
 * after the person editing it has stopped looking.
 */

// ── Shared chrome ────────────────────────────────────────────────────────────
//
// Exported because both review queues draw the same buttons and boxes around
// this form, and a review screen whose Approve button does not look like the
// other review screen's Approve button is two designs by accident.

export const secondaryButton: React.CSSProperties = {
  padding: '6px 14px',
  background: 'white',
  color: '#374151',
  border: '1px solid #e0e0e0',
  borderRadius: '6px',
  fontSize: '12px',
  fontWeight: 600,
  cursor: 'pointer',
};

export const primaryButton: React.CSSProperties = {
  padding: '7px 16px',
  background: '#dd0031',
  color: 'white',
  border: 'none',
  borderRadius: '8px',
  fontSize: '13px',
  fontWeight: 600,
  cursor: 'pointer',
};

export const input: React.CSSProperties = {
  width: '100%',
  padding: '7px 10px',
  border: '1px solid #ddd',
  borderRadius: '6px',
  fontSize: '13px',
  fontFamily: 'inherit',
};

export const label: React.CSSProperties = {
  display: 'block',
  fontSize: '11px',
  fontWeight: 700,
  color: '#6b7280',
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  marginBottom: '4px',
};

/** Bare hostname, for saying which page a draft was read from. */
export function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

export default function DraftEditor({
  draft, busy, onCancel, onSave,
}: {
  draft: CreatorMealDraft;
  busy: boolean;
  onCancel: () => void;
  onSave: (draft: CreatorMealDraft) => void;
}) {
  const [form, setForm] = useState<CreatorMealDraft>(draft);
  const set = <K extends keyof CreatorMealDraft>(key: K, value: CreatorMealDraft[K]) =>
    setForm(prev => ({ ...prev, [key]: value }));

  const setIngredient = (index: number, patch: Partial<DraftIngredient>) =>
    setForm(prev => ({
      ...prev,
      ingredients: prev.ingredients.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    }));

  const removeIngredient = (index: number) =>
    setForm(prev => ({ ...prev, ingredients: prev.ingredients.filter((_, i) => i !== index) }));

  const addIngredient = () =>
    setForm(prev => ({
      ...prev,
      ingredients: [...prev.ingredients, { ingredientName: '', qty: 1, productQty: 1, unit: 'qty', measure: null, searchTerm: null }],
    }));

  // The same rule `editableDraft` refuses on, and now the same *function*: the
  // cap was client-only in both editors until MEAL-89's review — a PATCH that
  // did not come from one of them stored as many tags as it was sent, and
  // approving published all of them. `toggleTag` is that rule written once, in
  // `vocab.ts`, because three pickers were each carrying their own copy and one
  // of them counted to a literal `3`.
  const onTagClick = (tag: string) =>
    setForm(prev => ({ ...prev, tags: toggleTag(prev.tags ?? [], tag) }));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }} data-testid="draft-editor">
      <div>
        <label style={label} htmlFor="draft-name">Meal name</label>
        <input id="draft-name" style={input} value={form.name} onChange={e => set('name', e.target.value)} />
      </div>

      <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 120px' }}>
          <label style={label} htmlFor="draft-serves">Serves</label>
          <input id="draft-serves" style={input} placeholder="4 or 2-4" value={form.serves ?? ''} onChange={e => set('serves', e.target.value)} />
        </div>
        <div style={{ flex: '1 1 120px' }}>
          <label style={label} htmlFor="draft-difficulty">Difficulty</label>
          <select
            id="draft-difficulty"
            style={input}
            value={form.difficulty ?? ''}
            onChange={e => set('difficulty', e.target.value ? Number(e.target.value) : null)}
          >
            <option value="">—</option>
            {[1, 2, 3, 4, 5].map(level => <option key={level} value={level}>{level}</option>)}
          </select>
        </div>
      </div>

      <div>
        <label style={label} htmlFor="draft-photo">Photo URL</label>
        <input id="draft-photo" style={input} value={form.photoUrl ?? ''} onChange={e => set('photoUrl', e.target.value)} />
      </div>

      <div>
        {/* The count as well as the cap, because a draft can arrive from
            extraction carrying more than the cap — the model is asked for up to
            eight — and the picker refusing a fourth is confusing next to five
            already-lit chips. Saving says which. */}
        <label style={label}>
          Tags ({(form.tags ?? []).length} of {MAX_MEAL_TAGS})
        </label>
        {/* Over the cap, the count above is not enough on its own: it says five
            of three without saying what to do about it. Saving is refused by
            the PATCH rather than trimmed, so naming how many to deselect is
            what turns a Save that comes back 400 into something the reviewer
            can see and fix before pressing it. Counted over the canonicalised
            list because that is the list the PATCH counts: a draft carrying
            three in-vocabulary tags and two the picker has no chip for would
            otherwise read "deselect 2" while offering nothing to deselect,
            about a Save that would have worked. */}
        {tagCapError(canonicalizeTags(form.tags ?? [])) && (
          <p style={{ fontSize: '11px', color: '#b91c1c', margin: '0 0 4px' }} data-testid="tag-cap-note">
            {tagCapError(canonicalizeTags(form.tags ?? []))} Deselect {canonicalizeTags(form.tags ?? []).length - MAX_MEAL_TAGS} before saving.
          </p>
        )}
        <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap', maxHeight: '110px', overflowY: 'auto' }} data-testid="tag-picker">
          {MEAL_TAGS.map(tag => {
            const on = (form.tags ?? []).includes(tag);
            return (
              <button
                key={tag}
                type="button"
                onClick={() => onTagClick(tag)}
                style={{
                  fontSize: '11px', padding: '2px 8px', borderRadius: '99px', cursor: 'pointer',
                  background: on ? '#dd0031' : 'white', color: on ? 'white' : '#6b7280',
                  border: `1px solid ${on ? '#dd0031' : '#e0e0e0'}`,
                }}
              >
                {tag}
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <label style={label}>Measurements</label>
        {form.ingredients.map((row, i) => (
          <div key={i} style={{ display: 'flex', gap: '6px', marginBottom: '6px', alignItems: 'center' }}>
            <input
              style={{ ...input, flex: '2 1 160px' }}
              aria-label={`Ingredient ${i + 1} name`}
              value={row.ingredientName}
              onChange={e => setIngredient(i, { ingredientName: e.target.value })}
            />
            <input
              style={{ ...input, flex: '0 1 80px' }}
              aria-label={`Ingredient ${i + 1} amount`}
              value={row.unit === 'qty' ? String(row.qty ?? 1) : (row.measure ?? '')}
              onChange={e => setIngredient(i, row.unit === 'qty'
                ? { qty: Number(e.target.value) || 1 }
                : { measure: e.target.value })}
            />
            <select
              style={{ ...input, flex: '0 1 90px' }}
              aria-label={`Ingredient ${i + 1} unit`}
              value={row.unit}
              onChange={e => setIngredient(i, { unit: e.target.value })}
            >
              {/*
                ALL_UNITS, not UNITS: the pipeline canonicalises to
                UNITS + COOK_UNITS, so offering only the eleven measured ones
                left a `cloves` row matching no option. The select fell back to
                its first and the row read "garlic, 3, Qty" — the exact failure
                COOK_UNITS was added to prevent, on the screen whose job is
                catching wrong measures. A blind save still wrote `cloves`, so
                the trap was one-way: touching the dropdown lost the unit and
                there was no way to put it back.
              */}
              <option value="qty">Qty</option>
              {ALL_UNITS.map(unit => <option key={unit} value={unit}>{unit}</option>)}
            </select>
            <button type="button" onClick={() => removeIngredient(i)} style={{ ...secondaryButton, padding: '6px 10px' }}>×</button>
          </div>
        ))}
        <button type="button" onClick={addIngredient} style={secondaryButton}>Add a row</button>
      </div>

      <div>
        <label style={label} htmlFor="draft-recipe">Recipe instructions</label>
        <textarea id="draft-recipe" rows={6} style={{ ...input, resize: 'vertical' }} value={form.recipe ?? ''} onChange={e => set('recipe', e.target.value)} />
      </div>

      <div>
        <label style={label} htmlFor="draft-story">Story</label>
        <textarea id="draft-story" rows={3} style={{ ...input, resize: 'vertical' }} value={form.story ?? ''} onChange={e => set('story', e.target.value)} />
      </div>

      <div>
        <label style={label} htmlFor="draft-source">Recipe URL</label>
        <input id="draft-source" style={input} value={form.source ?? ''} onChange={e => set('source', e.target.value)} />
      </div>

      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
        <button onClick={() => onSave(form)} disabled={busy} style={primaryButton}>Save edits</button>
        <button onClick={onCancel} disabled={busy} style={secondaryButton}>Cancel</button>
        <span style={{ fontSize: '11px', color: '#aaa', alignSelf: 'center' }}>
          Saving does not publish. It stays in this queue, and every field you change drops our check of it.
        </span>
      </div>
    </div>
  );
}
