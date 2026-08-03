'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import ImportFieldNotice from '@/components/ImportFieldNotice';
import DraftEditor, { hostOf, input, label, primaryButton, secondaryButton } from '@/components/DraftEditor';
import { MealDetailBody, type MealNotices, type PresetMeal } from '@/components/MealCard';
import { noticesFor, summaryLine, type ImportSummary } from '@/lib/import/draft-form';
import type { CreatorMealDraft } from '@/lib/import/types';
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
 * What **Send to creator** now does, said on the card rather than left to be
 * discovered.
 *
 * It was a disabled button until MEAL-89: nothing read `review_by = 'creator'`,
 * so pressing it moved the draft out of the only queue anybody read and into
 * nothing, with `creator_source_items` saying `imported` so no later sync
 * brought the post back — while this screen said "It is in their queue now, not
 * yours." That sentence is true now, and this says where the draft lands and
 * that it can still be retrieved, because an operator handing over a decision
 * should know whether they can change their mind.
 */
const HANDOFF_NOTE =
  'Send to creator moves it to their own review queue — it shows up as a count on their Creator tab, ' +
  'and on the portal here. It stays yours to take back until they decide it.';

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
    if (action === 'send-to-creator') {
      setNotice('Sent. It is on their Creator tab now, as a count they will see next time they open the app — and you can take it back below until they decide it.');
    }
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
        Drafts this operator has handed over and the creator has not decided.
        Not stranded any more — MEAL-89 built the queue that reads them — but
        still worth a section: handing over is a decision to stop deciding, and
        a creator who has gone quiet for a month should not be the reason a
        recipe sits forever. Take it back is the way out of that.
      */}
      {handedOver.length > 0 && (
        <div style={card} data-testid="handed-over">
          <h3 style={{ margin: '0 0 2px', fontSize: '14px', fontWeight: 700, color: '#b45309' }}>
            Waiting on their creator ({handedOver.length})
          </h3>
          <p style={{ margin: '0 0 12px', fontSize: '12px', color: '#888', lineHeight: 1.6 }}>
            You sent these to the creator, and they are counted on that creator’s Creator tab until they approve, edit
            or decline them. Nothing here is live and a later sync will not re-import the post, because it is already
            recorded as imported — so if one has been sitting a while, take it back and decide it here.
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
                  onClick={() => onAct('send-to-creator')}
                  disabled={busy}
                  title={HANDOFF_NOTE}
                  style={secondaryButton}
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
                {HANDOFF_NOTE} Delete declines it and stops a later sync re-importing the same post.
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
