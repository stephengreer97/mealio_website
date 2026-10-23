'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import ImportFieldNotice from '@/components/ImportFieldNotice';
import DraftEditor, { FlagBadge, hostOf, input, label, primaryButton, secondaryButton } from '@/components/DraftEditor';
import { MealDetailBody, type MealNotices, type PresetMeal } from '@/components/MealCard';
import { FIELD_LABELS, noticesFor, publishBlockers, summaryLine } from '@/lib/import/draft-form';
import type { CreatorMealDraft } from '@/lib/import/types';
// Type-only: `lib/import-drafts` reaches Supabase, Resend and the photo copier,
// and must never be bundled into the client. Erased at compile time.
import type { DraftReview, QueuedDraft } from '@/lib/import-drafts';

/**
 * A creator's imported drafts, as an admin sees them (MEAL-91).
 *
 * One list: every pending draft of the creator's, however it was imported, with
 * the flagged ones first and a badge saying what to check. A row opens into
 * **the meal card exactly as a saver would see it** — the same component
 * Discover renders — because the question is "would I put my name on this?".
 *
 * Fields that verified are simply shown; only flagged ones get a note with the
 * reason and the span we read (MEAL-73's `ImportFieldNotice`).
 *
 * Edit, Approve and Delete appear only on drafts whose creator ticked "Allow
 * Mealio admins to edit, approve or deny your imported posts" (`adminMayDecide`).
 * Without it the admin can read every draft and decide none of them.
 */

/** What GET returns: the queue rows with their rendered review attached. */
type ReviewRow = QueuedDraft & { review: DraftReview };

/**
 * When a draft was extracted, in the one place every row shows it.
 *
 * A queue is a backlog, and a backlog without dates cannot be triaged: "three
 * drafts waiting" is a completely different situation depending on whether they
 * arrived this morning or in June. The full timestamp goes in the `title` so the
 * short form can stay short.
 */
function DraftDate({ at }: { at: string | null }) {
  if (!at) return null;
  const when = new Date(at);
  if (Number.isNaN(when.getTime())) return null;
  return (
    <span
      title={when.toLocaleString()}
      style={{ fontSize: '11px', color: '#aaa', whiteSpace: 'nowrap', flexShrink: 0 }}
      data-testid="draft-created-at"
    >
      {when.toLocaleDateString()}
    </span>
  );
}

type Action = 'approve' | 'delete';

/** The creator has not ticked "Allow Mealio admins to edit, approve or deny". The route refuses too. */
const NOT_ALLOWED =
  'This creator has not allowed Mealio admins to edit, approve or delete their posts. You can read them.';

const card: React.CSSProperties = {
  background: 'white',
  borderRadius: '12px',
  boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
  padding: '22px 24px',
};

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

export default function AdminReviewQueue(
  { creatorId, onChanged }: { creatorId?: string; onChanged?: () => void } = {},
) {
  const [rows, setRows] = useState<ReviewRow[] | null>(null);
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
    const query = creatorId ? `?creatorId=${encodeURIComponent(creatorId)}` : '';
    const res = await fetch(`/api/admin/import-drafts${query}`, { headers: { Authorization: `Bearer ${token()}` } });
    const data = await res.json().catch(() => ({}));
    if (!mountedRef.current) return;
    if (!res.ok) {
      setError(data.error || 'Could not read the drafts.');
      setRows([]);
      setSelected([]);
      return;
    }
    setRows((data.drafts ?? []) as ReviewRow[]);
    setSelected([]);
  };

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [creatorId]);

  /**
   * One request for however many drafts, which is what makes the batching in
   * `notifyApproved` reachable: one email per creator per batch, not per meal.
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
    // A per-draft failure comes back 200 with a populated `errors[]`, so the
    // success notices are gated on it.
    const refused = Array.isArray(data.errors) && data.errors.length > 0;
    if (refused) setError(data.errors.join(' '));
    const landed = !refused && Number(data.done ?? 0) > 0;
    if (action === 'approve' && data.published?.length > 0) {
      setNotice(
        `Published ${data.published.map((meal: { name: string }) => meal.name).join(', ')}.` +
        (data.emailsSent > 0
          ? ` ${data.emailsSent === 1 ? 'One email' : `${data.emailsSent} emails`} sent, one per creator, listing everything of theirs that went live.`
          : ''),
      );
    }
    if (action === 'delete' && landed) setNotice('Declined. It will not be imported again by a later sync or poll.');
    // Only a decision that happened closes what the admin was reading. A refused
    // one leaves the draft open, so whatever stopped it can be fixed in place.
    if (!refused) {
      setOpenId(null);
      setEditingId(null);
    }
    await load();
    // The count in the card header was read with the creator list, so it is
    // stale after a decision until the parent re-reads it.
    onChanged?.();
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
    setNotice('Saved. Editing does not publish it.');
    await load();
  };

  const flagged = useMemo(() => (rows ?? []).filter(row => row.summary.needALook > 0).length, [rows]);

  if (rows === null) {
    return <p style={{ color: '#888', fontSize: '13px' }}>Reading the drafts…</p>;
  }

  const anyDecidable = rows.some(row => row.adminMayDecide);
  const toggleSelected = (id: string) =>
    setSelected(prev => (prev.includes(id) ? prev.filter(other => other !== id) : [...prev, id]));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }} data-testid="admin-review-queue">
      <p style={{ margin: 0, fontSize: '12px', color: '#6b7280', lineHeight: 1.6 }} data-testid="queue-totals">
        {rows.length === 0
          ? 'No imported drafts waiting. Nothing goes live until someone approves it.'
          : <>
              {rows.length} {rows.length === 1 ? 'draft' : 'drafts'}, <strong>not live</strong> until approved ·{' '}
              {flagged} with something flagged. Open one to see the card as a saver would.
            </>}
      </p>

      {rows.length > 0 && !anyDecidable && (
        <p style={{ margin: 0, fontSize: '12px', color: '#b45309', lineHeight: 1.6 }} data-testid="admin-not-allowed">
          {NOT_ALLOWED}
        </p>
      )}

      {anyDecidable && (
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
          {/* Default on, and turning it off is the deliberate act. */}
          <p style={{ margin: '6px 0 0 24px', fontSize: '12px', color: '#888', lineHeight: 1.6 }}>
            One email per creator per approval. Tick several and approve them together and they get one message
            listing all of them, not one each. It links to every meal and says how to edit or unpublish.
            Turning this off means the creator finds out from a follower.
          </p>
        </div>
      )}

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

      {rows.length > 0 && (
        <div style={card} data-testid="imported-drafts">
          <h3 style={{ margin: '0 0 12px', fontSize: '14px', fontWeight: 700, color: '#222' }}>
            Imported drafts ({rows.length})
          </h3>
          {rows.map(row => (
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
  const blockers = publishBlockers(row.draft);

  return (
    <div style={{ borderTop: '1px solid #f0f0f0', padding: '10px 0' }} data-testid="draft-row">
      <div style={{ display: 'flex', gap: '10px', alignItems: 'baseline' }}>
        {/* No tick for a draft the admins may not decide: the bulk bar only
            approves and declines. */}
        <input
          type="checkbox"
          checked={selected}
          onChange={onSelect}
          disabled={!row.adminMayDecide}
          aria-label={`Select ${row.draft.name || row.sourceUrl}`}
          style={{ accentColor: '#dd0031', width: '15px', height: '15px', flexShrink: 0, visibility: row.adminMayDecide ? 'visible' : 'hidden' }}
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
          <DraftDate at={row.createdAt} />
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

              {/*
                What would stop this publishing, before the operator presses the
                button that would find out. The same `publishBlockers` the
                creator's queue draws, reading the same helpers
                `publishCreatorMeal` enforces — an eight-tag draft written before
                the cap shipped fails, `approveDraft` rolls it back, and without
                this the only way to learn that is to lose a publish.

                Said, not enforced: this queue approves a *selection*, and a
                button that decides five drafts cannot be disabled by one of
                them. `Edit` is beside it and fixes it.
              */}
              {blockers.length > 0 && (
                <div
                  style={{ background: '#fff0f0', border: '1px solid #ffcccc', borderRadius: '8px', padding: '10px 12px', marginTop: '10px' }}
                  data-testid="publish-blockers"
                >
                  <p style={{ margin: 0, fontSize: '12px', fontWeight: 700, color: '#c40029' }}>
                    This will not publish as it stands
                  </p>
                  <ul style={{ margin: '6px 0 0', padding: 0, listStyle: 'none' }}>
                    {blockers.map(blocker => (
                      <li
                        key={blocker.field}
                        style={{ fontSize: '12px', color: '#c40029', lineHeight: 1.6 }}
                        data-testid="publish-blocker"
                        data-field={blocker.field}
                      >
                        <span style={{ fontWeight: 700 }}>{FIELD_LABELS[blocker.field]}</span>
                        {': '}
                        {blocker.message}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <p style={{ margin: '10px 0 0', fontSize: '12px', color: '#6b7280' }} data-testid="draft-summary">
                {summaryLine(row.summary)}{' '}
                {row.summary.needALook === 0 && 'Nothing to check. The notes below fields are what a flagged one looks like.'}
              </p>

              <div style={{ display: 'flex', gap: '8px', marginTop: '12px', flexWrap: 'wrap' }}>
                {row.adminMayDecide && (
                  <>
                    <button onClick={() => onAct('approve')} disabled={busy} style={primaryButton}>Approve &amp; publish</button>
                    <button onClick={onEdit} disabled={busy} style={secondaryButton}>Edit</button>
                    <button
                      onClick={() => onAct('delete')}
                      disabled={busy}
                      style={{ ...secondaryButton, color: '#c40029', borderColor: '#ffcccc' }}
                    >
                      Delete
                    </button>
                  </>
                )}
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
                {row.adminMayDecide
                  ? 'Delete declines it and stops a later sync re-importing the same post.'
                  : NOT_ALLOWED}
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
