'use client';

import { useRef, useState } from 'react';
import ImportFieldNotice from '@/components/ImportFieldNotice';
// The render the cap exists for: a tag past this one is invisible on the card
// and still matches a Discover filter.
import { MAX_MEAL_TAGS } from '@/lib/import/vocab';
import { unitLabel } from '@/lib/import/ingredients';
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

/**
 * One ingredient line, the way a recipe writes it: amount, unit, ingredient.
 *
 * It used to be the other way round — "chopped tomatoes, 2 cans" — which is how
 * the row is *stored*, not how anyone reads a recipe. On the draft review card
 * that put our rendering directly beneath the source line we had quoted, and the
 * source line was plainly the easier of the two to read. Now they read the same
 * way round, which is also what makes comparing them worth anything.
 *
 * The unit is spelled for the number beside it (`unitLabel`), because units are
 * stored plural and "1 cans" is the storage decision showing through.
 */
export function fmtMeasurement(ing: Ingredient): string {
  // Countables answer to `measure` like everything else.
  //
  // The old rule read `qty` and hid any count of one, because an unquantified
  // line ("salt to taste") arrives as a countable 1 and printing it would state
  // an amount nobody wrote. But that hid "1 onion" too — `qty: 1` cannot tell
  // the two apart, so suppressing both was the only safe answer available.
  //
  // `measure` can tell them apart, and always could: it is what the source
  // said, where `qty` is how many products to buy. Present means the recipe
  // gave a number, so print it; absent means it did not, so "salt" stays salt.
  //
  // The `qty` fallback stays underneath for now. Most preset rows still carry
  // their amount there with `measure` null (MEAL-103), and dropping to the name
  // alone would turn "12 corn tortillas" into "corn tortillas" — a regression
  // until that migration lands. It can go once it has.
  if (!ing.unit || ing.unit === 'qty') {
    const counted = (ing.measure ?? '').trim() || ((ing.qty ?? 1) > 1 ? String(ing.qty) : '');
    return counted ? `${counted} ${ing.ingredientName}` : ing.ingredientName;
  }
  // A unit with no measure is the same case one step along: "a handful of
  // parsley" keeps its unit but has no number. Singular, because there is no
  // number for it to agree with — "handful parsley" is a line a cook writes and
  // "handfuls parsley" is not.
  const amount = (ing.measure ?? '').trim();
  return amount
    ? `${amount} ${unitLabel(ing.unit, amount)} ${ing.ingredientName}`
    : `${unitLabel(ing.unit, 1)} ${ing.ingredientName}`;
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
 * The small uppercase label above a field. The type the card already used for
 * "Measurements" and "Recipe" — those two were the only fields that had one.
 */
const labelClass = 'text-xs font-semibold uppercase tracking-widest';
const labelStyle: React.CSSProperties = { color: 'var(--text-3)', letterSpacing: '0.08em' };

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <p className={`${labelClass} mb-1.5`} style={labelStyle}>{children}</p>;
}

/**
 * A labelled slot with nothing in it.
 *
 * Only ever drawn on a review card, where a field can be empty *and* have
 * something said about it. Drawing the slot anyway is what gives the note under
 * it a field to belong to.
 */
function NotFilledIn() {
  return <span className="text-sm" style={{ color: 'var(--text-3)' }}>Not filled in</span>;
}

// ── Pointing at a field from outside the card ────────────────────────────────

/**
 * The names a caller can point at. One per slot this component draws, plus
 * `ingredient-<row>` for a measurement line.
 *
 * Stringly typed on purpose: the ingredient rows are open-ended and a template
 * union that has to be built at every call site buys nothing a typo in a
 * `data-field` would not also survive.
 */
export type MealField = 'photo' | 'tags' | 'serves' | 'difficulty' | 'story' | 'recipe' | string;

/** The anchor name for one measurement row. One spelling, both ends. */
export function ingredientField(index: number): MealField {
  return `ingredient-${index}`;
}

/**
 * The ring drawn on the field a reader has just asked to be shown.
 *
 * `outline` rather than `border`, because it is drawn outside the box and so
 * moves nothing — a highlight that reflows the recipe under the reader's eye is
 * worse than no highlight. The brand red is the same red the link that sent
 * them here is drawn in, which is what makes the two ends read as one gesture.
 */
const FOCUS_RING: React.CSSProperties = {
  outline: '2px solid #dd0031',
  outlineOffset: '4px',
  borderRadius: '6px',
};

interface AnchorProps extends React.HTMLAttributes<HTMLElement> {
  'data-field'?: string;
  'data-focused'?: 'true';
}

/**
 * Everything inside the detail modal below the title: photo, tags, serves,
 * difficulty, source, story, measurements and recipe.
 *
 * Split out from the modal so the review queue can render the same body inline
 * without a dialog around it — an operator working through a queue should not
 * have to open and dismiss a modal per recipe.
 *
 * ## Every field says what it is
 *
 * It used to be a stack of unlabelled values: the name, a row of tag chips, a
 * paragraph in italics, a person icon beside "4-6", and a link. Only
 * Measurements and Recipe carried a heading. That reads as a wall of text
 * because it *is* one — nothing on screen tells you that the italic paragraph is
 * the Story or that "4-6" is how many it serves, so a reader has to infer every
 * field from its shape and position.
 *
 * So the fields are labelled and grouped the way the recipe is put together:
 * what it is (photo, tags), what it is like (serves, difficulty, source, story),
 * what goes in it, and how to make it. The labels are the ones the publish form
 * and `FIELD_LABELS` already use, so the creator reviewing a draft, the editor
 * they fix it in, and the saver who reads it all name the same field the same
 * way.
 *
 * A field with no value normally draws nothing — Discover passes no `notices`
 * and renders as it always did, minus the icons. On a review card an empty field
 * that has a note about it keeps its labelled slot, because "Not found in the
 * source — add this" three times over, floating between other fields, names
 * nothing at all.
 */
export function MealDetailBody({ meal, notices, fieldAnchorId, focusedField }: {
  meal: PresetMeal;
  notices?: MealNotices | null;
  /**
   * Gives each field slot a DOM id, so something outside this card can point at
   * one. The creator review queue's comment pane is the caller: its notes sit in
   * a second column and have to be able to say *which* line they are about.
   *
   * Optional, and absent everywhere else. Without it not one attribute changes
   * — Discover and the admin queue render exactly the markup they always have.
   */
  fieldAnchorId?: (field: MealField) => string;
  /** The field a reader has just asked to be shown. Drawn with a ring, nothing else. */
  focusedField?: MealField | null;
}) {
  const sourceHost = meal.source ? (() => {
    try { return new URL(meal.source!).hostname.replace('www.', ''); } catch { return meal.source; }
  })() : null;

  /**
   * The id, the marker and the ring for one field, merged onto whatever the slot
   * already carries. Nothing at all when no caller asked for anchors.
   */
  const anchor = (field: MealField, style?: React.CSSProperties): AnchorProps => {
    if (!fieldAnchorId) return style ? { style } : {};
    const focused = focusedField === field;
    return {
      id: fieldAnchorId(field),
      'data-field': field,
      ...(focused ? { 'data-focused': 'true' as const } : {}),
      style: focused ? { ...style, ...FOCUS_RING } : style,
    };
  };

  const tags = (meal.tags ?? []).slice(0, MAX_MEAL_TAGS);
  /** Draw the slot if there is a value in it, or anything to say about it. */
  const show = (value: unknown, notice?: FieldNotice | null) => Boolean(value) || Boolean(notice);

  const ingredients = meal.ingredients ?? [];
  const ingredientNotices = notices?.ingredients ?? [];

  return (
    <>
      {/* ── What it is ── */}
      {meal.photo_url ? (
        <div {...anchor('photo', { position: 'relative' })}>
          <img src={meal.photo_url} alt={meal.name} className="w-full rounded-xl object-cover" style={{ maxHeight: '220px' }} />
          {tags.length > 0 && (
            <div {...anchor('tags', { position: 'absolute', top: 8, right: 8, display: 'flex', gap: 4, flexWrap: 'wrap', justifyContent: 'flex-end' })}>
              {tags.map(tag => (
                <span key={tag} className="text-xs px-2.5 py-1 rounded-full font-medium"
                  style={{ background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(4px)', color: '#fff', border: 'none' }}>
                  {tag}
                </span>
              ))}
            </div>
          )}
        </div>
      ) : null}
      <ImportFieldNotice notice={notices?.photoUrl ?? null} fieldLabel="Photo" />

      {/* Tags sit on the photo when there is one — that is the design, and a
          second labelled copy underneath is the same three words twice. Without
          a photo they need the label like anything else, and a note about them
          needs the slot whether or not there are any. */}
      {!meal.photo_url && show(tags.length, notices?.tags) && (
        <div {...anchor('tags')}>
          <FieldLabel>Tags</FieldLabel>
          {tags.length > 0 ? (
            <div className="flex items-center gap-1.5 flex-wrap">
              {tags.map(tag => (
                <span key={tag} className="text-xs px-2.5 py-1 rounded-full font-medium"
                  style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text-2)' }}>
                  {tag}
                </span>
              ))}
            </div>
          ) : <NotFilledIn />}
        </div>
      )}
      {/* Outside the slot above, because the chips may be on the photo instead.
          The note names its own field, so it does not need one drawn for it. */}
      <ImportFieldNotice notice={notices?.tags ?? null} fieldLabel="Tags" />

      {/* ── What it is like ──
          A definition list, because that is what these are: three short values
          that mean nothing without their labels. The person icon beside "4-6"
          was the clearest case — an icon a reader has to decode into the word
          the label could simply have said. */}
      {(show(meal.serves, notices?.serves) || show(meal.difficulty != null, notices?.difficulty) || sourceHost) && (
        <dl className="flex flex-wrap" style={{ columnGap: '28px', rowGap: '12px' }}>
          {show(meal.serves, notices?.serves) && (
            <div {...anchor('serves', { minWidth: 0 })}>
              <dt className={labelClass} style={labelStyle}>Serves</dt>
              <dd className="text-sm mt-1" style={{ color: 'var(--text-1)' }}>
                {meal.serves || <NotFilledIn />}
                <ImportFieldNotice notice={notices?.serves ?? null} fieldLabel="Serves" />
              </dd>
            </div>
          )}
          {show(meal.difficulty != null, notices?.difficulty) && (
            <div {...anchor('difficulty', { minWidth: 0 })}>
              <dt className={labelClass} style={labelStyle}>Difficulty</dt>
              <dd className="text-sm mt-1" style={{ color: 'var(--text-1)' }}>
                {meal.difficulty != null
                  ? <span className="flex items-center gap-2" style={{ height: '20px' }}><DifficultyDots level={meal.difficulty} /></span>
                  : <NotFilledIn />}
                <ImportFieldNotice notice={notices?.difficulty ?? null} fieldLabel="Difficulty" />
              </dd>
            </div>
          )}
          {sourceHost && (
            <div style={{ minWidth: 0 }}>
              <dt className={labelClass} style={labelStyle}>Source</dt>
              <dd className="text-sm mt-1" style={{ minWidth: 0 }}>
                <a href={meal.source!} target="_blank" rel="noopener noreferrer"
                  className="hover:underline" style={{ color: 'var(--text-2)' }}>
                  {sourceHost}
                </a>
              </dd>
            </div>
          )}
        </dl>
      )}

      {show(meal.story, notices?.story) && (
        <div {...anchor('story')}>
          <FieldLabel>Story</FieldLabel>
          {meal.story
            ? <p className="text-sm italic whitespace-pre-wrap leading-relaxed" style={{ color: 'var(--text-2)' }}>{meal.story}</p>
            : <NotFilledIn />}
          <ImportFieldNotice notice={notices?.story ?? null} fieldLabel="Story" />
        </div>
      )}

      {/* ── What goes in it ── */}
      {/* No guard for a notice with no row: the ingredient notices are
          index-aligned with the rows themselves, so an empty list has none. */}
      {ingredients.length > 0 && (
        <div>
          <p className={`${labelClass} mb-3`} style={labelStyle}>Measurements</p>
          <ul className="space-y-1.5">
            {ingredients.map((ing, i) => (
              <li
                key={i}
                className="py-2 text-sm"
                {...anchor(ingredientField(i), { borderBottom: '1px solid var(--border)', color: 'var(--text-1)' })}
              >
                {fmtMeasurement(normIng(ing))}
                <ImportFieldNotice notice={ingredientNotices[i] ?? null} fieldLabel={normIng(ing).ingredientName} />
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ── How to make it ── */}
      {show(meal.recipe, notices?.recipe) && (
        <div {...anchor('recipe')}>
          <p className={`${labelClass} mb-3`} style={labelStyle}>Recipe</p>
          {meal.recipe
            ? <p className="text-sm whitespace-pre-wrap leading-relaxed" style={{ color: 'var(--text-2)' }}>{meal.recipe}</p>
            : <NotFilledIn />}
          <ImportFieldNotice notice={notices?.recipe ?? null} fieldLabel="Recipe instructions" />
        </div>
      )}
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
              {meal.tags.slice(0, MAX_MEAL_TAGS).map(tag => (
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
