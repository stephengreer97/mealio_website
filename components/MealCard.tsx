'use client';

import { useRef, useState } from 'react';
import ImportFieldNotice from '@/components/ImportFieldNotice';
import type { FieldNotice } from '@/lib/import/draft-form';

/**
 * The meal card, as a saver sees it.
 *
 * Lifted out of `app/discover/page.tsx` unchanged (MEAL-91). The admin review
 * queue asks "would I put my name on this?", and that is only answerable
 * looking at the thing itself — not at a diff and not at a JSON dump. Rendering
 * it with a second component would mean the screen an operator approves from
 * and the screen a saver reads could drift apart, which is the one difference
 * that would make the review worthless.
 *
 * The only addition is `notices`: MEAL-73's exceptions-only field notes, so a
 * flagged measure can be called out under the row it belongs to. Discover
 * passes none and renders exactly as before.
 */

export interface Ingredient {
  ingredientName: string;
  searchTerm?: string | null;
  qty: number;
  unit: string;
  measure?: string | null;
}

export function normIng(raw: any): Ingredient {
  return {
    ingredientName: raw.ingredientName ?? raw.productName ?? raw.product_name ?? raw.name ?? '',
    searchTerm: raw.searchTerm ?? raw.search_term ?? null,
    qty: raw.qty ?? raw.quantity ?? 1,
    unit: raw.unit ?? 'qty',
    measure: raw.measure ?? null,
  };
}

export function fmtMeasurement(ing: Ingredient): string {
  if (!ing.unit || ing.unit === 'qty') return `${ing.ingredientName}, ${ing.qty ?? 1}`;
  return `${ing.ingredientName}, ${ing.measure ?? ing.qty ?? ''} ${ing.unit}`;
}

export interface PresetMeal {
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

/**
 * Per-field notes to show alongside the meal, exceptions only.
 *
 * A field that verified against the source has no entry and renders nothing —
 * silence is the signal (MEAL-73). Null throughout means this is a published
 * meal with no import behind it, which is Discover's case.
 */
export interface MealNotices {
  name: FieldNotice | null;
  recipe: FieldNotice | null;
  story: FieldNotice | null;
  photoUrl: FieldNotice | null;
  difficulty: FieldNotice | null;
  tags: FieldNotice | null;
  serves: FieldNotice | null;
  ingredients: (FieldNotice | null)[];
}

export function DifficultyDots({ level }: { level: number }) {
  return (
    <span className="flex gap-1 items-center">
      {[1, 2, 3, 4, 5].map(i => (
        <span key={i} style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', background: i <= level ? 'var(--brand)' : 'var(--border)' }} />
      ))}
    </span>
  );
}

// ── Meal Detail Body ──────────────────────────────────────────────────────────

/**
 * Everything inside the detail modal below the title: photo, tags, the
 * difficulty/serves/source line, story, measurements and recipe.
 *
 * Split out from the modal so the review queue can render the same body inline
 * without a dialog around it — an operator working through a queue should not
 * have to open and dismiss a modal per recipe.
 */
export function MealDetailBody({ meal, notices }: { meal: PresetMeal; notices?: MealNotices | null }) {
  const sourceHost = meal.source ? (() => {
    try { return new URL(meal.source!).hostname.replace('www.', ''); } catch { return meal.source; }
  })() : null;

  return (
    <>
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
      <ImportFieldNotice notice={notices?.photoUrl ?? null} fieldLabel="Photo" />
      <ImportFieldNotice notice={notices?.tags ?? null} fieldLabel="Tags" />

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
      <ImportFieldNotice notice={notices?.difficulty ?? null} fieldLabel="Difficulty" />
      <ImportFieldNotice notice={notices?.serves ?? null} fieldLabel="Serves" />

      {meal.story && (
        <p className="text-sm italic whitespace-pre-wrap leading-relaxed" style={{ color: 'var(--text-2)' }}>{meal.story}</p>
      )}
      <ImportFieldNotice notice={notices?.story ?? null} fieldLabel="Story" />

      <div>
        <p className="text-xs font-semibold uppercase tracking-widest mb-3" style={{ color: 'var(--text-3)', letterSpacing: '0.08em' }}>Measurements</p>
        <ul className="space-y-1.5">
          {meal.ingredients.map((ing, i) => (
            <li key={i} className="py-2 text-sm" style={{ borderBottom: '1px solid var(--border)', color: 'var(--text-1)' }}>
              {fmtMeasurement(normIng(ing))}
              <ImportFieldNotice notice={notices?.ingredients[i] ?? null} fieldLabel={normIng(ing).ingredientName} />
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
      <ImportFieldNotice notice={notices?.recipe ?? null} fieldLabel="Recipe instructions" />
    </>
  );
}

// ── Meal Detail Modal ─────────────────────────────────────────────────────────

export function MealDetailModal({
  meal, savedStores, onAdd, onClose, onCreatorClick,
}: {
  meal: PresetMeal; savedStores?: string[]; onAdd: () => void; onClose: () => void; onCreatorClick?: (id: string) => void;
}) {
  const dragRef = useRef(false);
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
          <MealDetailBody meal={meal} />
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

export default function MealCard({
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
        className="flex items-start gap-3 p-4 rounded-2xl cursor-pointer transition-all"
        style={{ background: 'var(--surface-raised)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-sm)' }}
        onClick={() => setDetailOpen(true)}
        onMouseEnter={e => (e.currentTarget as HTMLElement).style.boxShadow = 'var(--shadow-md)'}
        onMouseLeave={e => (e.currentTarget as HTMLElement).style.boxShadow = 'var(--shadow-sm)'}
      >
        <div className="flex-shrink-0">
          {meal.photo_url ? (
            <img
              src={meal.photo_url}
              alt={meal.name}
              className="object-cover rounded-xl w-48 h-[100px] sm:w-[240px] sm:h-[126px]"
              style={{ border: '1px solid var(--border)' }}
            />
          ) : (
            <div className="rounded-xl flex items-center justify-center w-48 h-[100px] sm:w-[240px] sm:h-[126px]" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
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
