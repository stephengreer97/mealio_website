'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import ImportFieldNotice from '@/components/ImportFieldNotice';
import DraftEditor, { FlagBadge, hostOf, primaryButton, secondaryButton } from '@/components/DraftEditor';
import { MealDetailBody, type MealNotices, type PresetMeal } from '@/components/MealCard';
import { noticesFor } from '@/lib/import/draft-form';
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
 * ## A list, not a pager
 *
 * This screen used to show one draft at a time behind "1 of 3" and Previous /
 * Skip. The owner's report was that the page was confusing, and the pager is
 * why: a creator could not see what was waiting, could not choose which to do,
 * and could not tell what they had already decided in this sitting. Three
 * recipes and three copies of the same recipe looked identical until you had
 * paged through all three.
 *
 * So the queue is now what it always claimed to be — a queue you can see:
 *
 *  - **Everything waiting is on screen at once**, one row each: the name, the
 *    photo, where we read it, how many ingredients we found, and how many
 *    fields we could not confirm. Enough to tell two drafts apart and to pick
 *    one, without opening anything.
 *  - **Flagged first, and said out loud.** The server already sorts by
 *    `needALook` (see `listDraftQueue`); that order was invisible, so the same
 *    fact is now a heading and a badge per row.
 *  - **A row opens in place.** The full meal card and Approve / Edit / Decline
 *    appear under the row, exactly as they were. One at a time, so the decision
 *    on screen is unambiguous.
 *  - **A decided row resolves where it sits.** It does not vanish. Approving
 *    the last draft used to make the whole card disappear mid-tap and "your
 *    recipe is live" was never shown; that was fixed for the last row only, and
 *    a row silently leaving the list has the same problem — the creator cannot
 *    tell an approval from a mis-tap. Every row now stays and says what became
 *    of it until the next load.
 *  - **Nothing here blocks.** No modal, no redirect, no interstitial. It is a
 *    card on the portal a creator can scroll past on their way to something
 *    else, and it renders nothing at all when the queue is empty.
 *
 * ## No "approve all"
 *
 * Deliberately absent, and the server refuses a batched approve as well.
 * Bulk-approving unreviewed extractions publishes under a creator's name on the
 * strength of a model's output that nobody read, which is the failure the
 * whole confidence model exists to prevent. Seeing the whole list at once makes
 * a select-all tempting in a way the pager did not, which is a reason to say
 * this again rather than a reason to reconsider it: the list is for *finding*
 * and *choosing*, and deciding is still one recipe at a time.
 */

/** What GET returns: the queue rows with their rendered review attached. */
type ReviewRow = QueuedDraft & { review: DraftReview };

/**
 * What became of a draft decided in this sitting.
 *
 * Kept per row rather than as a single banner, because a banner says what
 * happened and not *to which one* — after three decisions the only honest place
 * for "this one is live" is on the row it is about.
 */
type Outcome = { tone: 'ok' | 'bad'; badge: string; text: string };

/**
 * Which row the creator has open, by draft id.
 *
 * localStorage rather than component state, because "backgrounded the app" on a
 * phone browser is indistinguishable from "closed the tab": both come back as a
 * fresh mount, and losing your place in a long recipe on either is the same
 * annoyance. An id and not an index — decide two drafts on a phone and an index
 * points at the wrong recipe next time, which is worse than nothing because it
 * looks right. Scoped to one key because a creator has one queue.
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

/**
 * Where we read it, in the creator's own terms.
 *
 * `hostOf` for a website, because the hostname is what a creator recognises. For
 * the platforms we read through an API the hostname is noise — every YouTube
 * draft would say `youtube.com`, which distinguishes nothing from nothing — so
 * the platform is named instead. There is no post title stored on the draft to
 * use here; if one is ever recorded, this is where it goes.
 */
function sourceLabel(row: ReviewRow): string {
  if (row.source === 'youtube') return 'YouTube';
  if (row.source === 'instagram') return 'Instagram';
  if (row.source === 'tiktok') return 'TikTok';
  return hostOf(row.sourceUrl);
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
   * heading says how many there are and the list says how many of them are on
   * screen. They agree in every ordinary case and the heading is the one that
   * must not go quietly wrong when they do not.
   */
  const [waiting, setWaiting] = useState(0);
  /** The one row expanded into its full card, if any. */
  const [openId, setOpenId] = useState<string | null>(null);
  const [decided, setDecided] = useState<Record<string, Outcome>>({});
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

    // Re-open what they had open. A cursor pointing at a draft that is no
    // longer pending — decided here, decided on the phone, taken back by an
    // operator — opens nothing rather than an index that would now name a
    // different recipe.
    //
    // With nothing remembered the list stays closed, because the list is the
    // point: opening the first row for them is the pager's habit and it hides
    // the other nine behind a recipe nobody chose. The exception is a queue of
    // one, where there is nothing to choose between and a collapsed row is a
    // click charged for no decision. Decided at load only, so deciding one of
    // two never yanks the survivor open under a creator's finger.
    const saved = readCursor();
    const resumed = saved && list.some(row => row.id === saved) ? saved : (list.length === 1 ? list[0].id : null);
    setOpenId(resumed);
    writeCursor(resumed);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const openRow = (id: string | null) => {
    setEditing(false);
    setOpenId(id);
    writeCursor(id);
  };

  /**
   * Decides one draft, and leaves it where it is.
   *
   * The row is marked rather than dropped: a row that disappears the instant it
   * is decided is indistinguishable from a mis-tap, and the creator cannot
   * check afterwards which of six recipes they published. It stays, collapsed,
   * saying what became of it, until the next load clears the list.
   *
   * The server's own `waiting` count goes to the heading and the badge, which is
   * a different question — how many are left — and is allowed to differ from
   * the length of this sitting's list.
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

    // Nothing happened, so nothing resolves: the row stays open and undecided
    // and the creator can press the same button again.
    if (!res.ok) { setError(data.error || 'That did not work. Nothing has been published.'); return; }

    let outcome: Outcome;
    if (Array.isArray(data.errors) && data.errors.length > 0) {
      // The common one is "already decided in another tab", which is a decision
      // landing twice rather than a failure — the conditional write did its job
      // and exactly one publish happened. Say so and move on. The row still
      // resolves, because it *is* decided; it is only this tab that did not do
      // the deciding.
      const text = data.errors.join(' ');
      setError(text);
      outcome = { tone: 'bad', badge: 'Already decided', text };
    } else if (action === 'approve') {
      const name = data.published?.[0]?.name;
      const text = name
        ? `“${name}” is live. Savers can add it to a cart now.`
        : 'That one is live. Savers can add it to a cart now.';
      setNotice(text);
      outcome = { tone: 'ok', badge: 'Published', text };
    } else {
      const text = 'Declined. We will not offer that one again.';
      setNotice(text);
      outcome = { tone: 'bad', badge: 'Declined', text };
    }

    setDecided(prev => ({ ...prev, [id]: outcome }));
    // Collapsed, because there is no decision left to make on it and the card
    // would otherwise sit open pushing everything they have not decided off the
    // bottom of the screen.
    if (openId === id) openRow(null);

    // The server counts what is left as part of the decision, so the heading and
    // the badge both settle without a second round trip — and a draft decided in
    // another tab is reflected on this one.
    if (typeof data.waiting === 'number') { setWaiting(data.waiting); announce(data.waiting); }
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

    // Swapped in place rather than refetched, so the list does not reorder
    // under them: an edit drops our confidence on every field they rewrote,
    // which changes `needALook`, which is part of the sort key — and which
    // group the row is sitting in.
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
  // Only ever the queue the server sent, never a queue emptied by deciding: a
  // decided row stays in the list saying what became of it. That is what keeps
  // "your recipe is live" on screen after the last approval, which is the moment
  // a creator is most likely to tap Approve a second time.
  if (!rows || rows.length === 0) return null;

  /** Still to decide. The decided ones are on screen but are not work. */
  const pending = rows.filter(row => !decided[row.id]);
  const flaggedPending = pending.filter(row => row.summary.needALook > 0).length;
  const done = pending.length === 0;
  // The count can only lag the list while a decision is in flight; never let the
  // heading claim fewer recipes than there are rows still to decide.
  const total = Math.max(waiting, pending.length);

  // Flagged first, which is the order `listDraftQueue` already sorts in — drawn
  // as two groups so that order is legible rather than something a creator has
  // to infer from the badges. Decided rows keep their place in their group
  // rather than being collected somewhere else: the row you just pressed should
  // still be where you pressed it.
  const needsALook = rows.filter(row => row.summary.needALook > 0);
  const verified = rows.filter(row => row.summary.needALook === 0);

  const renderRow = (row: ReviewRow) => (
    <QueueRow
      key={row.id}
      row={row}
      open={openId === row.id}
      editing={editing && openId === row.id}
      busy={busy}
      outcome={decided[row.id] ?? null}
      onToggle={() => openRow(openId === row.id ? null : row.id)}
      onEdit={() => setEditing(true)}
      onCancelEdit={() => setEditing(false)}
      onSaveEdit={draft => saveEdit(row.id, draft)}
      onDecide={action => decide(action, row.id)}
    />
  );

  const group = (title: string, blurb: string, list: ReviewRow[], testId: string) =>
    list.length === 0 ? null : (
      <section style={{ marginTop: '18px' }} data-testid={testId} key={testId}>
        <h3 style={{ margin: '0 0 2px', fontSize: '12px', fontWeight: 700, color: '#374151' }}>{title}</h3>
        <p style={{ margin: '0 0 6px', fontSize: '11px', color: '#9ca3af', lineHeight: 1.6 }}>{blurb}</p>
        <div style={{ borderTop: '1px solid #f0f0f0' }}>{list.map(renderRow)}</div>
      </section>
    );

  return (
    <div style={card} data-testid="creator-review-queue">
      <h2 style={{ margin: 0, fontSize: '15px', fontWeight: 700, color: '#111' }}>
        {done
          ? 'That’s everything'
          : total === 1
            ? 'A recipe is waiting for you'
            : `${total} recipes are waiting for you`}
      </h2>

      {done ? (
        <p style={{ margin: '4px 0 0', fontSize: '12px', color: '#888', lineHeight: 1.6 }} data-testid="queue-all-done">
          You have decided everything that was waiting. What you chose is on each row below. Anything new we read from
          your posts turns up here.
        </p>
      ) : (
        <>
          {/* The sort order, said out loud. It was already true and entirely
              invisible: the flagged ones came first and nothing on screen
              admitted it. Counted over the rows below rather than over `total`,
              because past the 200-row read we have not seen the rest. */}
          {flaggedPending > 0 && pending.length > 1 && (
            <p style={{ margin: '6px 0 0', fontSize: '12px', color: '#b45309', fontWeight: 600 }} data-testid="queue-flagged-count">
              {flaggedPending === 1
                ? 'One of the ones below has something worth checking, and it is first.'
                : `${flaggedPending} of the ones below have something worth checking, and they are first.`}
            </p>
          )}
          {/* Only ever seen past the 200-row read, and better said than left as
              a heading and a list that quietly disagree. */}
          {total > pending.length && (
            <p style={{ margin: '4px 0 0', fontSize: '11px', color: '#aaa' }} data-testid="queue-truncated">
              Showing the first {pending.length}. The rest are still here — decide these and reload for more.
            </p>
          )}
        </>
      )}

      {error && (
        <div style={{ background: '#fff0f0', border: '1px solid #ffcccc', borderRadius: '8px', padding: '10px 12px', fontSize: '12px', color: '#c40029', marginTop: '12px' }}>
          {error}
        </div>
      )}
      {notice && (
        <div style={{ background: '#e6f9ed', border: '1px solid #b7e4c7', borderRadius: '8px', padding: '10px 12px', fontSize: '12px', color: '#1a7a3a', marginTop: '12px' }}>
          {notice}
        </div>
      )}

      {/*
        Two groups, and nothing that decides more than one recipe. There is no
        "approve all" here on purpose — see the note at the top of the file, and
        the server refuses a batched approve too.
      */}
      {group(
        'Worth a look first',
        'Something in these did not match the page we read. The row says how many fields, and the card says which.',
        needsALook,
        'group-flagged',
      )}
      {group(
        'Everything checked out',
        'Every field we filled matched the page we read. Still yours to read before it goes out.',
        verified,
        'group-clean',
      )}
    </div>
  );
}

// ── One row ──────────────────────────────────────────────────────────────────

const rowIdentity: React.CSSProperties = {
  display: 'flex',
  gap: '10px',
  alignItems: 'center',
  width: '100%',
  minWidth: 0,
  textAlign: 'left',
};

/**
 * The photo, at the size a list wants it.
 *
 * The single strongest way to tell two drafts apart before opening either, and
 * the reason "three dinners or three copies of the same dinner" was unanswerable
 * on the pager. `alt=""` because the name is right beside it and a screen reader
 * reading the meal name twice is noise.
 */
function Thumb({ url }: { url: string | null }) {
  const box: React.CSSProperties = {
    width: '46px', height: '46px', borderRadius: '8px', flexShrink: 0,
    background: '#f3f4f6', objectFit: 'cover',
  };
  if (!url) {
    return (
      <span
        aria-hidden="true"
        style={{ ...box, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: '9px', fontWeight: 700, color: '#c0c0c0', letterSpacing: '0.04em' }}
      >
        NO
        <br />
        PIC
      </span>
    );
  }
  return <img src={url} alt="" style={box} />;
}

/** Name, where we read it, and how much of a recipe it is. */
function RowIdentity({ row }: { row: ReviewRow }) {
  const ingredients = (row.draft?.ingredients ?? []).length;
  return (
    <>
      <Thumb url={row.draft?.photoUrl ?? null} />
      <span style={{ flex: '1 1 auto', minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: '13px', fontWeight: 600, color: '#222', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {row.draft?.name || row.sourceUrl}
        </span>
        <span style={{ display: 'block', fontSize: '11px', color: '#9ca3af', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {sourceLabel(row)} · {ingredients} {ingredients === 1 ? 'ingredient' : 'ingredients'}
        </span>
      </span>
    </>
  );
}

function QueueRow({
  row, open, editing, busy, outcome, onToggle, onEdit, onCancelEdit, onSaveEdit, onDecide,
}: {
  row: ReviewRow;
  open: boolean;
  editing: boolean;
  busy: boolean;
  outcome: Outcome | null;
  onToggle: () => void;
  onEdit: () => void;
  onCancelEdit: () => void;
  onSaveEdit: (draft: CreatorMealDraft) => void;
  onDecide: (action: 'approve' | 'cancel') => void;
}) {
  const notices = noticesFor(row.review.states) as MealNotices;
  const panelId = `draft-panel-${row.id}`;

  // Decided in this sitting. Not a button any more — there is no decision left
  // on it — but still a row in the same place, saying what became of it.
  if (outcome) {
    return (
      <div
        style={{ borderBottom: '1px solid #f0f0f0', padding: '10px 0', opacity: 0.75 }}
        data-testid="draft-row"
        data-decided={outcome.tone === 'ok' ? 'published' : 'declined'}
      >
        <div style={rowIdentity}>
          <RowIdentity row={row} />
          <span
            style={{
              fontSize: '11px', fontWeight: 700, borderRadius: '99px', padding: '2px 8px', flexShrink: 0,
              background: outcome.tone === 'ok' ? '#e6f9ed' : '#f3f4f6',
              color: outcome.tone === 'ok' ? '#1a7a3a' : '#6b7280',
            }}
          >
            {outcome.badge}
          </span>
        </div>
        <p
          style={{ margin: '6px 0 0 56px', fontSize: '11px', lineHeight: 1.6, color: outcome.tone === 'ok' ? '#1a7a3a' : '#6b7280' }}
          data-testid="draft-resolved"
        >
          {outcome.text}
        </p>
      </div>
    );
  }

  return (
    <div style={{ borderBottom: '1px solid #f0f0f0', padding: '10px 0' }} data-testid="draft-row">
      <button
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={panelId}
        disabled={busy}
        style={{ ...rowIdentity, background: 'none', border: 'none', padding: 0, cursor: busy ? 'default' : 'pointer' }}
      >
        <RowIdentity row={row} />
        <FlagBadge summary={row.summary} />
        {/* Which way the row is about to move. A caret rather than the word
            "Open", because the word competes with Approve for the eye and this
            control is not the decision. */}
        <span aria-hidden="true" style={{ fontSize: '11px', color: '#9ca3af', flexShrink: 0, width: '12px' }}>
          {open ? '▾' : '▸'}
        </span>
      </button>

      <div id={panelId} hidden={!open}>
        {open && (editing ? (
          <div style={{ marginTop: '12px' }}>
            <DraftEditor draft={row.draft} busy={busy} onCancel={onCancelEdit} onSave={onSaveEdit} />
          </div>
        ) : (
          <div style={{ marginTop: '12px' }}>
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
                <h4 style={{ margin: 0, fontSize: '15px', fontWeight: 700, color: '#18181B' }}>{row.draft.name}</h4>
                <ImportFieldNotice notice={notices.name} fieldLabel="Meal name" />
              </div>
              <MealDetailBody meal={asPresetMeal(row)} notices={notices} />
            </div>

            {/*
              Approve / Edit / Decline, unchanged and still one recipe at a time.
            */}
            <div style={{ display: 'flex', gap: '8px', marginTop: '12px', flexWrap: 'wrap' }}>
              <button onClick={() => onDecide('approve')} disabled={busy} style={primaryButton}>
                Approve &amp; publish
              </button>
              <button onClick={onEdit} disabled={busy} style={secondaryButton}>Edit first</button>
              <button
                onClick={() => onDecide('cancel')}
                disabled={busy}
                style={{ ...secondaryButton, color: '#c40029', borderColor: '#ffcccc' }}
              >
                Not this one
              </button>
              <a
                href={row.sourceUrl}
                target="_blank"
                rel="noopener noreferrer nofollow"
                style={{ ...secondaryButton, textDecoration: 'none', display: 'inline-block' }}
              >
                Open my post
              </a>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
