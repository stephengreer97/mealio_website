'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import ImportFieldNotice from '@/components/ImportFieldNotice';
import DraftEditor, { hostOf, primaryButton, secondaryButton } from '@/components/DraftEditor';
import { MealDetailBody, type MealNotices, type PresetMeal } from '@/components/MealCard';
import { noticesFor, summaryLine } from '@/lib/import/draft-form';
import type { CreatorMealDraft } from '@/lib/import/types';
// Type-only: `lib/import-drafts` reaches Supabase, Resend and the photo copier,
// and must never be bundled into the client. Erased at compile time.
import type { DraftReview, QueuedDraft } from '@/lib/import-drafts';

/**
 * The creator's own review queue (MEAL-89).
 *
 * The same decision the admin queue presents, seen from the other side. It is
 * literally the same card — `MealDetailBody`, the component Discover renders —
 * with the same exceptions-only callouts from `lib/import/draft-form.ts`,
 * because "would I put my name on this?" is the question either reviewer is
 * answering and the answer has to be visible in the thing a saver will read.
 *
 * ## The queue is the feature, not the popup
 *
 * A single-draft modal is the easy case and the wrong thing to design for. A
 * creator who has been away for a week can face ten pending drafts, so:
 *
 *  - **Position is shown.** "3 of 10", so the end is visible. An unbounded stack
 *    of cards is the thing people force-quit.
 *  - **Position survives a reload.** The cursor is the draft's *id*, kept in
 *    localStorage, not an index — decide two drafts on a phone and an index
 *    points at the wrong recipe next time, which is worse than starting over
 *    because it looks right.
 *  - **Nothing here blocks.** No modal, no redirect, no interstitial. It is a
 *    card on the portal a creator can scroll past on their way to something
 *    else, and it renders nothing at all when the queue is empty.
 *
 * ## No "approve all"
 *
 * Deliberately absent, and the server refuses a batched approve as well.
 * Bulk-approving unreviewed extractions publishes under a creator's name on the
 * strength of a model's output that nobody read, which is the failure the
 * whole confidence model exists to prevent. Declining several at once is fine
 * and is offered — nothing is published, and the cost of a mistake is a recipe
 * that has to be offered again.
 */

/** What GET returns: the queue rows with their rendered review attached. */
type ReviewRow = QueuedDraft & { review: DraftReview };

/**
 * Where the creator had got to, by draft id.
 *
 * localStorage rather than component state, because "backgrounded the app" on a
 * phone browser is indistinguishable from "closed the tab": both come back as a
 * fresh mount, and losing the place on either is the same annoyance. Scoped to
 * one key because a creator has one queue.
 */
const CURSOR_KEY = 'mealio_draft_cursor';

function readCursor(): string | null {
  try { return localStorage.getItem(CURSOR_KEY); } catch { return null; }
}

function writeCursor(id: string | null): void {
  try {
    if (id) localStorage.setItem(CURSOR_KEY, id);
    else localStorage.removeItem(CURSOR_KEY);
  } catch { /* Safari private mode. A lost cursor costs a scroll, not a decision. */ }
}

const card: React.CSSProperties = {
  background: 'white',
  borderRadius: '16px',
  boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
  padding: '20px 22px',
};

/**
 * A draft, shaped as the meal card renders it.
 *
 * `id` is the draft's, not a meal's — nothing has been published yet, and the
 * card only uses it as a key.
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

export default function CreatorReviewQueue() {
  const [rows, setRows] = useState<ReviewRow[] | null>(null);
  /**
   * The read failed, as distinct from the queue being empty.
   *
   * Two different facts that rendered identically: `setRows([])` on a failure
   * made "we looked and there is nothing" out of "we could not look". The
   * header badge deliberately does *not* zero on a failed read — it keeps the
   * last number it was told, which is right — so the pair put "3 recipes
   * waiting" and a portal with no queue on the same screen, and the half that
   * looked reassuring was the wrong one.
   */
  const [failed, setFailed] = useState(false);
  /**
   * Everything pending, which is not the same as `rows.length`.
   *
   * The queue reads at most 200 drafts and the count is uncapped, so the
   * heading says how many there are and the position says where in the loaded
   * page they stand. They agree in every ordinary case and the heading is the
   * one that must not go quietly wrong when they do not.
   */
  const [waiting, setWaiting] = useState(0);
  const [cursor, setCursor] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  // A decision outlives a render and the reload that follows it. Without this a
  // response landing after the component unmounts writes to dead state.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const token = () => localStorage.getItem('accessToken');

  /**
   * Tells the header what the count is now.
   *
   * The badge lives in `AppHeader`, which is a sibling of this component under a
   * page neither of them owns. An event is the cheap honest wire between them:
   * without it a creator watches the queue empty while the header keeps saying
   * 3, in the one place they can see it be wrong.
   */
  const announce = (waiting: number) => {
    window.dispatchEvent(new CustomEvent('mealio:draft-queue-changed', { detail: { waiting } }));
  };

  const load = useCallback(async () => {
    let res: Response;
    let data: { drafts?: unknown; waiting?: unknown };
    try {
      res = await fetch('/api/creator/import-drafts', { headers: { Authorization: `Bearer ${token()}` } });
      data = await res.json().catch(() => ({}));
    } catch {
      // A dropped connection is a failed read like any other. Left unhandled it
      // rejected out of the effect and stranded the card in its loading state,
      // which renders as nothing — the same wrong answer by a different route.
      if (mountedRef.current) { setRows([]); setFailed(true); }
      return;
    }
    if (!mountedRef.current) return;
    if (!res.ok) {
      // Still not an error banner. This card is one thing on a portal full of
      // other things, and a creator who came here to edit a published meal
      // should not be met with a red box about a queue they were not thinking
      // about. But it must not render as an empty queue either: `announce` is
      // deliberately not called, so the badge keeps whatever it had, and the
      // card below says we could not look rather than that there is nothing.
      setRows([]);
      setFailed(true);
      return;
    }

    const list = (data.drafts ?? []) as ReviewRow[];
    setRows(list);
    setFailed(false);
    // The server's count, not the length of this list: the list is capped at
    // 200 and the count is not. Badging from the list rewrote a creator's "250"
    // to "200" the moment they opened the queue, before they had decided
    // anything.
    setWaiting(typeof data.waiting === 'number' ? data.waiting : list.length);
    announce(typeof data.waiting === 'number' ? data.waiting : list.length);

    // Resume where they were. A cursor pointing at a draft that is no longer
    // pending — decided here, decided on the phone, taken back by an operator —
    // falls back to the front of the queue rather than to an index that would
    // now name a different recipe.
    const saved = readCursor();
    const resumed = saved && list.some(row => row.id === saved) ? saved : (list[0]?.id ?? null);
    setCursor(resumed);
    writeCursor(resumed);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const index = rows && cursor ? rows.findIndex(row => row.id === cursor) : -1;
  const current = index >= 0 ? rows![index] : null;

  const goTo = (id: string | null) => {
    setEditing(false);
    setCursor(id);
    writeCursor(id);
  };

  /**
   * Decides the draft in front of them and advances.
   *
   * The row is dropped from local state rather than the whole queue refetched,
   * so "3 of 10" does not become "3 of 9" underneath a creator's finger and make
   * the end of the queue look like it moved. The server's own `waiting` count
   * goes to the badge, which is a different question — how many are left — and
   * is allowed to differ from the length of this sitting's list.
   */
  const decide = async (action: 'approve' | 'cancel', id: string) => {
    if (busy) return;
    setBusy(true);
    setError('');
    setNotice('');

    const res = await fetch('/api/creator/import-drafts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
      body: JSON.stringify({ action, ids: [id] }),
    });
    const data = await res.json().catch(() => ({}));
    if (!mountedRef.current) return;
    setBusy(false);

    if (!res.ok) { setError(data.error || 'That did not work. Nothing has been published.'); return; }
    if (Array.isArray(data.errors) && data.errors.length > 0) {
      // The common one is "already decided in another tab", which is a decision
      // landing twice rather than a failure — the conditional write did its job
      // and exactly one publish happened. Say so and move on.
      setError(data.errors.join(' '));
    } else if (action === 'approve' && data.published?.[0]) {
      setNotice(`“${data.published[0].name}” is live. Savers can add it to a cart now.`);
    } else if (action === 'cancel') {
      setNotice('Declined. We will not offer that one again.');
    }

    // The server counts what is left as part of the decision, so the heading and
    // the badge both settle without a second round trip — and a draft decided in
    // another tab is reflected on this one.
    if (typeof data.waiting === 'number') { setWaiting(data.waiting); announce(data.waiting); }

    // Advance to the next undecided draft, or to the previous one if this was
    // the last. Deciding should never end with an empty card and no next step.
    const remaining = (rows ?? []).filter(row => row.id !== id);
    const next = remaining[Math.min(Math.max(index, 0), remaining.length - 1)] ?? null;
    setRows(remaining);
    goTo(next?.id ?? null);
  };

  const saveEdit = async (id: string, draft: CreatorMealDraft) => {
    if (busy) return;
    setBusy(true);
    setError('');
    setNotice('');

    const res = await fetch('/api/creator/import-drafts', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
      body: JSON.stringify({ id, draft }),
    });
    const data = await res.json().catch(() => ({}));
    if (!mountedRef.current) return;
    setBusy(false);
    if (!res.ok) { setError(data.error || 'Those edits could not be saved.'); return; }

    // Swapped in place rather than refetched, so the queue does not reorder
    // under them: an edit drops our confidence on every field they rewrote,
    // which changes `needALook`, which is part of the sort key.
    setRows(prev => (prev ?? []).map(row => (row.id === id ? { ...row, ...(data.draft as ReviewRow) } : row)));
    setEditing(false);
    setNotice('Saved. It is still waiting on you — editing does not publish it.');
  };

  // The read failed. Said plainly, because the badge on this same screen is
  // still showing whatever it last heard: a creator looking at "3" and a portal
  // with no queue card would conclude the queue is broken or that the badge is
  // lying, and one of those is true but neither is something to leave them to
  // work out. Quiet rather than alarming — no red box, and a way to try again.
  if (failed) {
    return (
      <div style={card} data-testid="creator-review-queue">
        <h2 style={{ margin: '0 0 6px', fontSize: '15px', fontWeight: 700, color: '#111' }}>
          We could not load your queue
        </h2>
        <p style={{ margin: '0 0 12px', fontSize: '12px', color: '#6b7280', lineHeight: 1.6 }} data-testid="queue-unreadable">
          Something went wrong at our end, so we do not know what is waiting for you right now. Nothing has been
          decided and nothing has been published.
        </p>
        <button onClick={() => void load()} style={secondaryButton} data-testid="queue-retry">Try again</button>
      </div>
    );
  }

  // Nothing waiting, or not a creator: no card at all. The portal does not grow
  // an empty box to tell a creator there is nothing to do.
  //
  // The one exception is the message from the decision that just emptied it.
  // Without it, approving the last draft made the whole card disappear mid-tap
  // and "your recipe is live" was never shown — the creator would be left
  // guessing whether the last one went through, which is the moment they are
  // most likely to tap Approve a second time.
  if (!rows || rows.length === 0 || !current) {
    if (!rows || rows.length > 0 || (!notice && !error)) return null;
    return (
      <div style={card} data-testid="creator-review-queue">
        <h2 style={{ margin: '0 0 6px', fontSize: '15px', fontWeight: 700, color: '#111' }}>That’s everything</h2>
        <p style={{ margin: 0, fontSize: '12px', color: error ? '#c40029' : '#1a7a3a', lineHeight: 1.6 }}>
          {error || notice}
        </p>
      </div>
    );
  }

  const notices = noticesFor(current.review.states) as MealNotices;
  // The count can only lag the list while a decision is in flight; never let the
  // heading claim fewer recipes than the card is willing to page through.
  const total = Math.max(waiting, rows.length);

  return (
    <div style={card} data-testid="creator-review-queue">
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0, fontSize: '15px', fontWeight: 700, color: '#111' }}>
          {total === 1 ? 'A recipe is waiting for you' : `${total} recipes are waiting for you`}
        </h2>
        {/* Position, so the end is visible. An unbounded stack is the thing
            people give up on. Against the loaded page rather than the total,
            because that is the set these buttons move through. */}
        <span style={{ fontSize: '12px', fontWeight: 600, color: '#6b7280' }} data-testid="queue-position">
          {index + 1} of {rows.length}
        </span>
      </div>
      {/* Only ever seen past the 200-row read, and better said than left as a
          heading and a position that quietly disagree. */}
      {total > rows.length && (
        <p style={{ margin: '4px 0 0', fontSize: '11px', color: '#aaa' }} data-testid="queue-truncated">
          Showing the first {rows.length}. The rest are still here — decide these and reload for more.
        </p>
      )}
      <p style={{ margin: '4px 0 14px', fontSize: '12px', color: '#888', lineHeight: 1.6 }}>
        We read {hostOf(current.sourceUrl)} and filled this in. Nothing is live until you approve it, and nothing here
        is in a hurry — come back to it whenever.
      </p>

      {error && (
        <div style={{ background: '#fff0f0', border: '1px solid #ffcccc', borderRadius: '8px', padding: '10px 12px', fontSize: '12px', color: '#c40029', marginBottom: '12px' }}>
          {error}
        </div>
      )}
      {notice && (
        <div style={{ background: '#e6f9ed', border: '1px solid #b7e4c7', borderRadius: '8px', padding: '10px 12px', fontSize: '12px', color: '#1a7a3a', marginBottom: '12px' }}>
          {notice}
        </div>
      )}

      {editing ? (
        <DraftEditor
          draft={current.draft}
          busy={busy}
          onCancel={() => setEditing(false)}
          onSave={draft => saveEdit(current.id, draft)}
        />
      ) : (
        <>
          {/*
            The saver's view, not a review view — the same component Discover
            renders, so what a creator approves and what a saver reads cannot
            drift apart.
          */}
          <div
            className="space-y-4"
            style={{ background: 'var(--surface-raised, #fff)', border: '1px solid #eee', borderRadius: '12px', padding: '16px' }}
            data-testid="draft-card"
          >
            {/* The title the modal would draw in its own header, so a flagged
                name has somewhere to be called out. */}
            <div>
              <h3 style={{ margin: 0, fontSize: '15px', fontWeight: 700, color: '#18181B' }}>{current.draft.name}</h3>
              <ImportFieldNotice notice={notices.name} fieldLabel="Meal name" />
            </div>
            <MealDetailBody meal={asPresetMeal(current)} notices={notices} />
          </div>

          <p style={{ margin: '10px 0 0', fontSize: '12px', color: '#6b7280' }} data-testid="draft-summary">
            {summaryLine(current.summary)}{' '}
            {current.summary.needALook === 0
              ? 'Everything we filled in matched the page we read.'
              : 'The notes under those fields say what we read and why we could not confirm it.'}
          </p>

          {/*
            Approve / Edit / Decline, and nothing that decides more than one
            recipe. There is no "approve all" here on purpose — see the note at
            the top of the file, and the server refuses a batched approve too.
          */}
          <div style={{ display: 'flex', gap: '8px', marginTop: '12px', flexWrap: 'wrap' }}>
            <button onClick={() => decide('approve', current.id)} disabled={busy} style={primaryButton}>
              Approve &amp; publish
            </button>
            <button onClick={() => setEditing(true)} disabled={busy} style={secondaryButton}>Edit first</button>
            <button
              onClick={() => decide('cancel', current.id)}
              disabled={busy}
              style={{ ...secondaryButton, color: '#c40029', borderColor: '#ffcccc' }}
            >
              Not this one
            </button>
            <a
              href={current.sourceUrl}
              target="_blank"
              rel="noopener noreferrer nofollow"
              style={{ ...secondaryButton, textDecoration: 'none', display: 'inline-block' }}
            >
              Open my post
            </a>
          </div>

          {/*
            Skipping is a first-class move, not an omission. A creator who is not
            sure about this one must be able to get to the next without deciding
            it — the alternative is deciding it in order to leave, and the
            decision that gets made under that pressure is Approve.
          */}
          {rows.length > 1 && (
            <div style={{ display: 'flex', gap: '8px', marginTop: '10px', flexWrap: 'wrap', alignItems: 'center' }}>
              <button
                onClick={() => goTo(rows[(index - 1 + rows.length) % rows.length].id)}
                disabled={busy}
                style={{ ...secondaryButton, padding: '4px 10px' }}
              >
                ← Previous
              </button>
              <button
                onClick={() => goTo(rows[(index + 1) % rows.length].id)}
                disabled={busy}
                style={{ ...secondaryButton, padding: '4px 10px' }}
                data-testid="skip-draft"
              >
                Skip for now →
              </button>
              <span style={{ fontSize: '11px', color: '#aaa' }}>
                Skipping decides nothing. It stays here until you do.
              </span>
            </div>
          )}

          <p style={{ margin: '10px 0 0', fontSize: '11px', color: '#aaa', lineHeight: 1.6 }} data-testid="queue-actions-note">
            Approving publishes it to Discover under your name. Not this one declines it — we will not offer that
            recipe again, and it does not come back the next time we check your posts.
          </p>
        </>
      )}
    </div>
  );
}
