'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import ImportFieldNotice from '@/components/ImportFieldNotice';
import { MealDetailBody, type MealNotices, type PresetMeal } from '@/components/MealCard';
import { noticesFor, summaryLine, type ImportSummary } from '@/lib/import/draft-form';
import { UNITS } from '@/lib/import/ingredients';
import { MEAL_TAGS } from '@/lib/import/vocab';
import type { CreatorMealDraft, DraftIngredient } from '@/lib/import/types';
// Type-only: `lib/import-drafts` reaches Supabase, Resend and the photo copier,
// and must never be bundled into the client. Erased at compile time.
import type { DraftReview, QueuedDraft } from '@/lib/import-drafts';

/**
 * The admin review queue (MEAL-91).
 *
 * Admin sync used to publish straight to Discover. It now queues, and this is
 * the screen where a person decides. The question being answered is "would I
 * put my name on this?", so the row opens into **the meal card exactly as a
 * saver would see it** — the same component Discover renders — rather than a
 * diff or a field list. Nothing else answers that question.
 *
 * Two things shape the layout:
 *
 *  1. **Exceptions only.** Fields that verified against the source are simply
 *     shown; only flagged ones get a note with the reason and the span we read
 *     (MEAL-73's `ImportFieldNotice`, reused rather than re-presented). That is
 *     the difference between reading nine fields on every recipe and looking at
 *     the two we flagged.
 *  2. **Clean is visibly separate from flagged.** Two groups, flagged first. An
 *     operator with forty drafts should be able to see where the work is
 *     without opening anything.
 *
 * Four actions, and **Send to creator** is the one that matters most: it is the
 * escape hatch for "this looks right but I am not the person who cooked it".
 * Without it an unsure operator has only approve or delete, and both are worse
 * than asking.
 */

/** What GET returns: the queue rows with their rendered review attached. */
type ReviewRow = QueuedDraft & { review: DraftReview };

type Action = 'approve' | 'send-to-creator' | 'delete' | 'reclaim';

/**
 * Why **Send to creator** is a disabled button with an explanation rather than a
 * working one.
 *
 * Nothing reads `review_by = 'creator'`: there is no creator endpoint and no
 * creator screen (MEAL-89). Pressing it moved the draft out of the only queue
 * anybody reads, into nothing, with `creator_source_items` saying `imported` so
 * no later sync would bring the post back — while this screen said "It is in
 * their queue now, not yours." Kept visible and disabled, because an operator
 * looking for the escape hatch deserves to be told where it went rather than to
 * find the button missing. The server refuses it too.
 */
const HANDOFF_DISABLED =
  'Send to creator needs the creator’s own review queue (MEAL-89), which is not built yet. ' +
  'Handing a draft over today would move it somewhere nobody can see it.';

const card: React.CSSProperties = {
  background: 'white',
  borderRadius: '12px',
  boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
  padding: '22px 24px',
};

const secondaryButton: React.CSSProperties = {
  padding: '6px 14px',
  background: 'white',
  color: '#374151',
  border: '1px solid #e0e0e0',
  borderRadius: '6px',
  fontSize: '12px',
  fontWeight: 600,
  cursor: 'pointer',
};

const primaryButton: React.CSSProperties = {
  padding: '7px 16px',
  background: '#dd0031',
  color: 'white',
  border: 'none',
  borderRadius: '8px',
  fontSize: '13px',
  fontWeight: 600,
  cursor: 'pointer',
};

const input: React.CSSProperties = {
  width: '100%',
  padding: '7px 10px',
  border: '1px solid #ddd',
  borderRadius: '6px',
  fontSize: '13px',
  fontFamily: 'inherit',
};

const label: React.CSSProperties = {
  display: 'block',
  fontSize: '11px',
  fontWeight: 700,
  color: '#6b7280',
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  marginBottom: '4px',
};

function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

/**
 * A draft, shaped as the meal card renders it.
 *
 * `id` is the draft's, not a meal's — nothing has been published yet, and the
 * card only uses it as a key. `author` is the creator whose name this would go
 * out under, which is the fact the whole screen is about.
 */
function asPresetMeal(row: ReviewRow): PresetMeal {
  const draft = row.draft;
  return {
    id: row.id,
    name: draft.name,
    author: row.creatorName,
    ingredients: (draft.ingredients ?? []) as PresetMeal['ingredients'],
    source: draft.source || row.sourceUrl,
    recipe: draft.recipe,
    story: draft.story,
    photo_url: draft.photoUrl,
    difficulty: draft.difficulty,
    serves: draft.serves,
    tags: draft.tags,
  };
}

export default function AdminReviewQueue() {
  const [rows, setRows] = useState<ReviewRow[] | null>(null);
  const [handedOver, setHandedOver] = useState<ReviewRow[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [notify, setNotify] = useState(true);

  // A decision outlives a render and the reload that follows it. Without this a
  // response landing after the tab moves on writes to dead state.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const token = () => localStorage.getItem('accessToken');

  const load = async () => {
    const res = await fetch('/api/admin/import-drafts', { headers: { Authorization: `Bearer ${token()}` } });
    const data = await res.json().catch(() => ({}));
    if (!mountedRef.current) return;
    if (!res.ok) { setError(data.error || 'Could not read the queue.'); setRows([]); return; }
    setRows((data.drafts ?? []) as ReviewRow[]);
    setHandedOver((data.handedOver ?? []) as ReviewRow[]);
    setSelected([]);
  };

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  /**
   * One request for however many drafts, which is what makes the batching in
   * `notifyApproved` reachable.
   *
   * It groups approvals by creator and sends one email each — but this screen
   * only ever sent `ids: [id]`, so approving a 40-item sync sent that creator 40
   * separate emails. The server code was right and nothing in the product took
   * the path.
   */
  const act = async (action: Action, ids: string[]) => {
    if (busy || ids.length === 0) return;
    setBusy(true);
    setError('');
    setNotice('');
    const res = await fetch('/api/admin/import-drafts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
      body: JSON.stringify({ action, ids, notifyCreator: notify }),
    });
    const data = await res.json().catch(() => ({}));
    if (!mountedRef.current) return;
    setBusy(false);
    if (!res.ok) { setError(data.error || 'That did not work.'); return; }
    if (Array.isArray(data.errors) && data.errors.length > 0) setError(data.errors.join(' '));
    if (action === 'approve' && data.published?.length > 0) {
      setNotice(
        `Published ${data.published.map((meal: { name: string }) => meal.name).join(', ')}.` +
        (data.emailsSent > 0
          ? ` ${data.emailsSent === 1 ? 'One email' : `${data.emailsSent} emails`} sent — one per creator, listing everything of theirs that went live.`
          : ''),
      );
    }
    if (action === 'reclaim') setNotice('Back in your queue. It is yours to decide again.');
    if (action === 'delete') setNotice('Declined. It will not be imported again by a later sync or poll.');
    setOpenId(null);
    setEditingId(null);
    await load();
  };

  const saveEdit = async (id: string, draft: CreatorMealDraft) => {
    if (busy) return;
    setBusy(true);
    setError('');
    const res = await fetch('/api/admin/import-drafts', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
      body: JSON.stringify({ id, draft }),
    });
    const data = await res.json().catch(() => ({}));
    if (!mountedRef.current) return;
    setBusy(false);
    if (!res.ok) { setError(data.error || 'Those edits could not be saved.'); return; }
    setEditingId(null);
    setNotice('Saved. It is still waiting on you — editing does not publish it.');
    await load();
  };

  const flagged = useMemo(() => (rows ?? []).filter(row => row.summary.needALook > 0), [rows]);
  const clean = useMemo(() => (rows ?? []).filter(row => row.summary.needALook === 0), [rows]);

  if (rows === null) {
    return <p style={{ color: '#888', fontSize: '13px' }}>Reading the queue…</p>;
  }

  const toggleSelected = (id: string) =>
    setSelected(prev => (prev.includes(id) ? prev.filter(other => other !== id) : [...prev, id]));

  const group = (title: string, blurb: string, list: ReviewRow[]) =>
    list.length === 0 ? null : (
      <div style={card} key={title}>
        <h3 style={{ margin: '0 0 2px', fontSize: '14px', fontWeight: 700, color: '#222' }}>
          {title} ({list.length})
        </h3>
        <p style={{ margin: '0 0 12px', fontSize: '12px', color: '#888' }}>{blurb}</p>
        {list.map(row => (
          <DraftRow
            key={row.id}
            row={row}
            open={openId === row.id}
            editing={editingId === row.id}
            busy={busy}
            selected={selected.includes(row.id)}
            onSelect={() => toggleSelected(row.id)}
            onToggle={() => { setOpenId(prev => (prev === row.id ? null : row.id)); setEditingId(null); }}
            onEdit={() => setEditingId(row.id)}
            onCancelEdit={() => setEditingId(null)}
            onSaveEdit={draft => saveEdit(row.id, draft)}
            onAct={action => act(action, [row.id])}
          />
        ))}
      </div>
    );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }} data-testid="admin-review-queue">

      <div style={{ background: '#f8f9fa', border: '1px solid #e5e7eb', borderRadius: '12px', padding: '18px 20px' }}>
        <h2 style={{ margin: '0 0 6px', fontSize: '14px', fontWeight: 700, color: '#374151' }}>Waiting on you</h2>
        <p style={{ margin: 0, fontSize: '12px', color: '#6b7280', lineHeight: 1.6 }} data-testid="queue-totals">
          {rows.length === 0
            ? 'Nothing is waiting. Synced recipes land here as drafts and stay invisible to savers until approved.'
            : <>
                {rows.length} {rows.length === 1 ? 'recipe' : 'recipes'} extracted and <strong>not live</strong> ·{' '}
                {flagged.length} with something flagged. Open one to see the card as a saver would, then decide.
              </>}
        </p>
      </div>

      {rows.length > 0 && (
        <div style={card}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: '#333', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={notify}
              onChange={e => setNotify(e.target.checked)}
              style={{ accentColor: '#dd0031', width: '16px', height: '16px' }}
            />
            Email the creator when I approve something
          </label>
          {/* Default on, and turning it off is the deliberate act. A creator who
              learns from a follower that nine recipes went live under their name
              is the failure this checkbox exists to keep one click away. */}
          <p style={{ margin: '6px 0 0 24px', fontSize: '12px', color: '#888', lineHeight: 1.6 }}>
            One email per creator per approval — tick several and approve them together and they get one message
            listing all of them, not one each. It links to every meal and says how to edit or unpublish.
            Turning this off means the creator finds out from a follower.
          </p>
        </div>
      )}

      {/*
        The reason multi-select exists. `notifyApproved` groups by creator and
        sends one message per batch; approving one draft per request meant a
        40-item sync sent that creator 40 separate emails, and the batching was
        code no path in the product reached.
      */}
      {selected.length > 0 && (
        <div
          style={{ ...card, display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}
          data-testid="bulk-bar"
        >
          <strong style={{ fontSize: '13px', color: '#222' }}>{selected.length} selected</strong>
          <button onClick={() => act('approve', selected)} disabled={busy} style={primaryButton}>
            Approve &amp; publish {selected.length}
          </button>
          <button
            onClick={() => act('delete', selected)}
            disabled={busy}
            style={{ ...secondaryButton, color: '#c40029', borderColor: '#ffcccc' }}
          >
            Decline {selected.length}
          </button>
          <button onClick={() => setSelected([])} disabled={busy} style={secondaryButton}>Clear</button>
          <span style={{ fontSize: '11px', color: '#888' }}>
            One email per creator for the whole batch.
          </span>
        </div>
      )}

      {error && (
        <div style={{ background: '#fff0f0', border: '1px solid #ffcccc', borderRadius: '8px', padding: '10px 12px', fontSize: '12px', color: '#c40029' }}>
          {error}
        </div>
      )}
      {notice && (
        <div style={{ background: '#e6f9ed', border: '1px solid #b7e4c7', borderRadius: '8px', padding: '10px 12px', fontSize: '12px', color: '#1a7a3a' }}>
          {notice}
        </div>
      )}

      {group('Needs a look', 'Something in these did not verify against the source. The card says which.', flagged)}
      {group('Verified clean', 'Every field we filled matched the page we read. Still worth a glance.', clean)}

      {/*
        Drafts an operator handed over while Send to creator still worked. There
        is no creator queue that received them, so without this section they are
        in no queue at all and nobody would ever know they existed. Take it back
        puts one in front of the only person who can currently decide it.
      */}
      {handedOver.length > 0 && (
        <div style={card} data-testid="handed-over">
          <h3 style={{ margin: '0 0 2px', fontSize: '14px', fontWeight: 700, color: '#b45309' }}>
            Handed over, waiting on nobody ({handedOver.length})
          </h3>
          <p style={{ margin: '0 0 12px', fontSize: '12px', color: '#888', lineHeight: 1.6 }}>
            These were sent to their creator before that button was switched off. The creator’s review queue does not
            exist yet (MEAL-89), so nothing is showing them to anyone — and a later sync will not re-import the post,
            because it is already recorded as imported. Take one back to decide it here.
          </p>
          {handedOver.map(row => (
            <div key={row.id} style={{ borderTop: '1px solid #f0f0f0', padding: '10px 0', display: 'flex', gap: '10px', alignItems: 'center' }}>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ fontSize: '13px', fontWeight: 600, color: '#222' }}>{row.draft.name || row.sourceUrl}</span>
                <span style={{ display: 'block', fontSize: '11px', color: '#aaa' }}>
                  {row.creatorName ?? 'Unknown creator'} · {hostOf(row.sourceUrl)}
                </span>
              </span>
              <button onClick={() => act('reclaim', [row.id])} disabled={busy} style={secondaryButton}>
                Take it back
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── One row ──────────────────────────────────────────────────────────────────

function DraftRow({
  row, open, editing, busy, selected, onSelect, onToggle, onEdit, onCancelEdit, onSaveEdit, onAct,
}: {
  row: ReviewRow;
  open: boolean;
  editing: boolean;
  busy: boolean;
  selected: boolean;
  onSelect: () => void;
  onToggle: () => void;
  onEdit: () => void;
  onCancelEdit: () => void;
  onSaveEdit: (draft: CreatorMealDraft) => void;
  onAct: (action: Action) => void;
}) {
  const notices = noticesFor(row.review.states) as MealNotices;

  return (
    <div style={{ borderTop: '1px solid #f0f0f0', padding: '10px 0' }} data-testid="draft-row">
      <div style={{ display: 'flex', gap: '10px', alignItems: 'baseline' }}>
        <input
          type="checkbox"
          checked={selected}
          onChange={onSelect}
          aria-label={`Select ${row.draft.name || row.sourceUrl}`}
          style={{ accentColor: '#dd0031', width: '15px', height: '15px', flexShrink: 0 }}
        />
        <button
          onClick={onToggle}
          style={{ display: 'flex', gap: '10px', alignItems: 'baseline', flex: 1, minWidth: 0, background: 'none', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left' }}
        >
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ fontSize: '13px', fontWeight: 600, color: '#222' }}>{row.draft.name || row.sourceUrl}</span>
            <span style={{ display: 'block', fontSize: '11px', color: '#aaa', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {row.creatorName ?? 'Unknown creator'} · {hostOf(row.sourceUrl)}
            </span>
          </span>
          <FlagBadge summary={row.summary} />
        </button>
      </div>

      {open && (
        <div style={{ marginTop: '12px' }}>
          {editing ? (
            <DraftEditor draft={row.draft} busy={busy} onCancel={onCancelEdit} onSave={onSaveEdit} />
          ) : (
            <>
              {/*
                The saver's view, not a review view. This is the same component
                Discover renders, so what an operator approves and what a saver
                reads cannot drift apart.
              */}
              <div
                className="space-y-4"
                style={{ background: 'var(--surface-raised, #fff)', border: '1px solid #eee', borderRadius: '12px', padding: '16px' }}
                data-testid="draft-card"
              >
                {/* The title and byline the modal draws in its own header, so a
                    flagged name has somewhere to be called out — and so the
                    creator whose name this goes out under is on the card. */}
                <div>
                  <h4 style={{ margin: 0, fontSize: '15px', fontWeight: 700, color: '#18181B' }}>{row.draft.name}</h4>
                  <p style={{ margin: '2px 0 0', fontSize: '12px', color: '#dd0031', fontWeight: 500 }}>
                    by {row.creatorName ?? 'this creator'}
                  </p>
                  <ImportFieldNotice notice={notices.name} fieldLabel="Meal name" />
                </div>
                <MealDetailBody meal={asPresetMeal(row)} notices={notices} />
              </div>

              <p style={{ margin: '10px 0 0', fontSize: '12px', color: '#6b7280' }} data-testid="draft-summary">
                {summaryLine(row.summary)}{' '}
                {row.summary.needALook === 0 && 'Nothing to check — the notes below fields are what a flagged one looks like.'}
              </p>

              <div style={{ display: 'flex', gap: '8px', marginTop: '12px', flexWrap: 'wrap' }}>
                <button onClick={() => onAct('approve')} disabled={busy} style={primaryButton}>Approve &amp; publish</button>
                <button
                  disabled
                  title={HANDOFF_DISABLED}
                  style={{ ...secondaryButton, color: '#aaa', cursor: 'not-allowed' }}
                  data-testid="send-to-creator"
                >
                  Send to creator
                </button>
                <button onClick={onEdit} disabled={busy} style={secondaryButton}>Edit</button>
                <button
                  onClick={() => onAct('delete')}
                  disabled={busy}
                  style={{ ...secondaryButton, color: '#c40029', borderColor: '#ffcccc' }}
                >
                  Delete
                </button>
                <a
                  href={row.sourceUrl}
                  target="_blank"
                  rel="noopener noreferrer nofollow"
                  style={{ ...secondaryButton, textDecoration: 'none', display: 'inline-block' }}
                >
                  Open the source page
                </a>
              </div>
              <p style={{ margin: '8px 0 0', fontSize: '11px', color: '#aaa', lineHeight: 1.6 }} data-testid="draft-actions-note">
                {HANDOFF_DISABLED} Delete declines it and stops a later sync re-importing the same post.
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** Counts, never a score — a "92% confident" badge is the anti-pattern MEAL-72 exists to avoid. */
function FlagBadge({ summary }: { summary: ImportSummary }) {
  const clean = summary.needALook === 0;
  return (
    <span
      style={{
        fontSize: '11px', fontWeight: 700, borderRadius: '99px', padding: '2px 8px', flexShrink: 0,
        background: clean ? '#f3f4f6' : '#fff8e1',
        color: clean ? '#6b7280' : '#b45309',
      }}
      data-testid="flag-badge"
    >
      {clean ? 'all verified' : `${summary.needALook} to check`}
    </span>
  );
}

// ── Edit ─────────────────────────────────────────────────────────────────────

/**
 * The publish form's nine fields, pre-filled from the draft.
 *
 * So a wrong measure is a fix rather than a delete-and-redo. Saving does **not**
 * publish: the operator lands back on the card and still has to approve it,
 * because someone correcting a typo has not thereby said the recipe is right.
 *
 * The vocabularies come from `lib/import/vocab.ts` and `lib/import/ingredients.ts`
 * — the same lists the pipeline canonicalises against, so the picker cannot
 * offer a tag or a unit the server would then strip back out.
 */
function DraftEditor({
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

  const toggleTag = (tag: string) =>
    setForm(prev => {
      const tags = prev.tags ?? [];
      if (tags.includes(tag)) return { ...prev, tags: tags.filter(t => t !== tag) };
      // Three is what the publish form accepts, and a fourth would be silently
      // dropped on save rather than visibly refused here.
      return tags.length >= 3 ? prev : { ...prev, tags: [...tags, tag] };
    });

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
        <label style={label}>Tags (up to 3)</label>
        <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap', maxHeight: '110px', overflowY: 'auto' }} data-testid="tag-picker">
          {MEAL_TAGS.map(tag => {
            const on = (form.tags ?? []).includes(tag);
            return (
              <button
                key={tag}
                type="button"
                onClick={() => toggleTag(tag)}
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
              <option value="qty">Qty</option>
              {UNITS.map(unit => <option key={unit} value={unit}>{unit}</option>)}
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
