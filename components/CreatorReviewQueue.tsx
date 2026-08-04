'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import ImportFieldNotice from '@/components/ImportFieldNotice';
import DraftEditor, { FlagBadge, hostOf, label as fieldLabelStyle, primaryButton, secondaryButton } from '@/components/DraftEditor';
import {
  ingredientField,
  MealDetailBody,
  normIng,
  type MealField,
  type MealNotices,
  type PresetMeal,
} from '@/components/MealCard';
import {
  FIELD_LABELS,
  noticesFor,
  publishBlockers,
  summaryLine,
  type FieldNotice,
  type PublishBlocker,
} from '@/lib/import/draft-form';
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
 *  - **A row opens in place**, onto two panes: the meal as it will actually be
 *    published, and — beside it — everything we have to say about how we read
 *    it. See "Two panes" below. One row at a time, so the decision on screen is
 *    unambiguous.
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
 * ## Two panes: the meal, and what we read
 *
 * An open draft used to be one card with our working threaded through it — a
 * field notice under the photo, a reason under Serves, "we read: …" under eight
 * of twelve ingredient rows. The question a creator is answering is "is this the
 * recipe I want on Discover under my name", and they were being asked it about a
 * card that no saver will ever see, because half of what was on it was ours.
 *
 * So the two things are two columns:
 *
 *  - **Left, the meal.** `MealDetailBody` with `notices` deliberately *not*
 *    passed — the same component and the same arguments Discover renders, so the
 *    preview is the published card rather than an imitation of it that can
 *    drift. Nothing of the import apparatus is in it.
 *  - **Right, our commentary.** Every notice, its reason, and the span we read,
 *    presented as notes *about* the recipe rather than as part of it.
 *
 * The reader is matching two things side by side, so the two ends are tied
 * together three ways, and the third is the one that does the work:
 *
 *  1. Every comment names its field, in the same words the card labels it with
 *     (`FIELD_LABELS`) — an ingredient comment is named for its ingredient.
 *  2. The comments are in the card's own order, top to bottom.
 *  3. **A comment can point at its field.** "Show me on the card" scrolls the
 *     line into view and rings it, in the same red the link is drawn in.
 *     Naming and ordering alone stop working at exactly the point this screen
 *     gets hard — a twelve-ingredient import with eight flagged rows, where
 *     "lime juice" is the fourth of twelve lines and counting is the reader's
 *     job. The anchors are an optional prop on `MealDetailBody`; without a
 *     caller passing one, not a single attribute of Discover's markup changes.
 *
 * A comment about a field the card does not draw — a missing Story, a Serves we
 * could not read — has nothing to point at and says so by having no link. That
 * is the honest answer: the field is not on the card, which is what the comment
 * is telling them.
 *
 * ## What would stop this publishing, before they press Approve
 *
 * The rules `publishCreatorMeal` enforces were only discoverable by pressing
 * Approve and losing — an eight-tag draft written before the cap shipped fails,
 * `approveDraft` rolls it back, and the creator was left holding a row they
 * could not publish and could not see why. `publishBlockers` reads the same
 * helpers the server does and says so on the preview, and Approve is off while
 * one stands. See `lib/import/draft-form.ts`.
 *
 * ## A completed request is not a successful one
 *
 * A refusal comes back 200 with `errors[]` populated, and this screen used to
 * resolve the row for any of them — so a publish that failed and rolled back
 * read as "Already decided", the row locked, and the editor that would have
 * fixed it was behind the row it had just locked. `stillPending` from the POST
 * is the server answering which drafts are still waiting on this creator; a row
 * in it did not get decided, keeps its buttons, shows the reason, and opens the
 * editor, because every reason a publish fails is something the editor fixes.
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
  /**
   * Why a decision on this row did not happen, per row.
   *
   * Beside the row rather than in the banner at the top of the card: the banner
   * is one line for a list of ten, and "Publishing failed: that is 8 tags" above
   * a screen of recipes says nothing about which recipe. This is the sentence
   * that has to be next to the button that did not work.
   */
  const [failures, setFailures] = useState<Record<string, string>>({});
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

  /**
   * Reload when an import has just put drafts in this queue.
   *
   * The sync section is a sibling on the same page and it finishes long after
   * this card last read. Without this the creator watches "9 waiting in your
   * review queue" appear, opens Drafts, and finds the queue as it was before the
   * import — which reads as the import having failed.
   */
  useEffect(() => {
    const onImported = () => { void load(); };
    window.addEventListener('mealio:drafts-imported', onImported);
    return () => window.removeEventListener('mealio:drafts-imported', onImported);
  }, [load]);

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

    const errors: string[] = Array.isArray(data.errors) ? data.errors : [];
    const stillPending: string[] = Array.isArray(data.stillPending) ? data.stillPending : [];

    /**
     * Refused, and the draft is still sitting in the queue waiting on them.
     *
     * The real case is a draft written before the tag cap shipped: publishing
     * throws, `approveDraft` puts the row back to `pending_review`, and the
     * database is correct. Only this screen was wrong — it read a 200 with an
     * `errors[]` as a decision and resolved the row, which took away Approve,
     * Edit and Decline in one go and left no way back but a database edit.
     *
     * So: no outcome, no resolve, the row keeps every button it had, the reason
     * goes on the row, and the editor opens — every reason a publish is refused
     * (too many tags, a Serves that is not a head count, a missing name) is
     * something the nine fields below can fix, and making them find it
     * themselves is making them do our work.
     */
    if (errors.length > 0 && stillPending.includes(id)) {
      const text = errors.join(' ');
      setFailures(prev => ({ ...prev, [id]: text }));
      setOpenId(id);
      writeCursor(id);
      setEditing(true);
      // Deliberately no `setError`: the sentence belongs beside the draft it is
      // about, and the same words twice on one screen reads as two problems.
      if (typeof data.waiting === 'number') { setWaiting(data.waiting); announce(data.waiting); }
      return;
    }

    let outcome: Outcome;
    if (errors.length > 0) {
      // The common one is "already decided in another tab", which is a decision
      // landing twice rather than a failure — the conditional write did its job
      // and exactly one publish happened. Say so and move on. The row still
      // resolves, because it *is* decided; it is only this tab that did not do
      // the deciding. Told apart from the case above by `stillPending`, which is
      // the row's own status rather than a guess made from the wording.
      const text = errors.join(' ');
      setError(text);
      outcome = { tone: 'bad', badge: 'Already decided', text };
    } else if (action === 'approve') {
      const name = data.published?.[0]?.name;
      const text = name
        ? `“${name}” is live. Savers can add it to a cart now.`
        : 'That one is live. Savers can add it to a cart now.';
      setNotice(text);
      outcome = { tone: 'ok', badge: 'Published', text };
      // A meal now exists that did not a moment ago. The Meals tab and the
      // back-catalogue checklist are siblings on this page with their own
      // fetches, and both were last read before this publish — so without this
      // a creator approves a draft, opens Meals, and finds it empty.
      window.dispatchEvent(new CustomEvent('mealio:meals-changed'));
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
    // The saved draft is what the blockers are recomputed from, so the reason a
    // publish was refused is answered by the row itself now. Keeping the old
    // sentence would leave "that is 8 tags" beside a draft carrying three.
    setFailures(prev => {
      if (!prev[id]) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
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
      failure={failures[row.id] ?? null}
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
        'Something in these did not match the page we read. The row says how many fields, and the notes beside the card say which.',
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
  row, open, editing, busy, outcome, failure, onToggle, onEdit, onCancelEdit, onSaveEdit, onDecide,
}: {
  row: ReviewRow;
  open: boolean;
  editing: boolean;
  busy: boolean;
  outcome: Outcome | null;
  /** Why the last decision on this row did not happen. Null when none has failed. */
  failure: string | null;
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
        {open && (
          <div style={{ marginTop: '12px' }}>
            {/* The refusal, beside the draft it is about and above whatever the
                creator is looking at — the editor if we opened it for them, the
                panes if they closed it again. */}
            {failure && (
              <div
                style={{ background: '#fff0f0', border: '1px solid #ffcccc', borderRadius: '8px', padding: '10px 12px', marginBottom: '12px' }}
                data-testid="draft-failed"
                role="status"
              >
                <p style={{ margin: 0, fontSize: '12px', fontWeight: 700, color: '#c40029' }}>
                  That did not publish, and nothing has changed
                </p>
                <p style={{ margin: '4px 0 0', fontSize: '12px', color: '#c40029', lineHeight: 1.6 }}>{failure}</p>
                <p style={{ margin: '4px 0 0', fontSize: '11px', color: '#6b7280', lineHeight: 1.6 }}>
                  It is still waiting on you. Fix it below and approve it again.
                </p>
              </div>
            )}

            {editing ? (
              <DraftEditor draft={row.draft} busy={busy} onCancel={onCancelEdit} onSave={onSaveEdit} />
            ) : (
              <DraftPanes
                row={row}
                notices={notices}
                busy={busy}
                onEdit={onEdit}
                onDecide={onDecide}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── The two panes ────────────────────────────────────────────────────────────

/**
 * One note in the right-hand pane: what we have to say, about which field, and
 * where that field is drawn on the left.
 */
interface Comment {
  /** The anchor to point at, or null when the card draws nothing for this field. */
  field: MealField | null;
  /** Names the field, in the words the card labels it with. */
  label: string;
  notice: FieldNotice;
}

/**
 * Every notice, in the order the card draws the fields it is about.
 *
 * Order is one of the three things tying the two panes together, and it is the
 * cheapest: a reader going down the comments is going down the recipe. It is
 * therefore this list, and not `noticesFor`'s key order, that decides what the
 * pane looks like — they agree today and the card is the one that gets to be
 * right.
 */
function commentsFor(row: ReviewRow, notices: MealNotices): Comment[] {
  const draft = row.draft;
  const ingredients = draft.ingredients ?? [];
  const entries: Array<{ field: MealField | null; label: string; notice: FieldNotice | null }> = [
    { field: draft.name ? 'name' : null, label: FIELD_LABELS.name, notice: notices.name },
    { field: draft.photoUrl ? 'photo' : null, label: FIELD_LABELS.photoUrl, notice: notices.photoUrl },
    { field: (draft.tags ?? []).length > 0 ? 'tags' : null, label: FIELD_LABELS.tags, notice: notices.tags },
    { field: draft.serves ? 'serves' : null, label: FIELD_LABELS.serves, notice: notices.serves },
    { field: draft.difficulty != null ? 'difficulty' : null, label: FIELD_LABELS.difficulty, notice: notices.difficulty },
    { field: draft.story ? 'story' : null, label: FIELD_LABELS.story, notice: notices.story },
    // Named for the ingredient rather than for "Measurements", because there are
    // twelve of them and eleven would otherwise carry the same name.
    ...ingredients.map((ing, i) => ({
      field: ingredientField(i),
      label: normIng(ing).ingredientName || `Measurement ${i + 1}`,
      notice: notices.ingredients[i] ?? null,
    })),
    { field: draft.recipe ? 'recipe' : null, label: FIELD_LABELS.recipe, notice: notices.recipe },
  ];
  return entries.filter((entry): entry is Comment => Boolean(entry.notice));
}

/** The small uppercase heading over each pane. The type the editor already uses. */
const paneHeading: React.CSSProperties = { ...fieldLabelStyle, margin: '0 0 6px' };

function DraftPanes({
  row, notices, busy, onEdit, onDecide,
}: {
  row: ReviewRow;
  notices: MealNotices;
  busy: boolean;
  onEdit: () => void;
  onDecide: (action: 'approve' | 'cancel') => void;
}) {
  /**
   * The field a comment has asked to be shown, if any.
   *
   * Held here rather than in `QueueRow` so it clears itself: closing the row
   * unmounts this, and a ring left on a field from the last time they looked at
   * a recipe points at nothing they asked about.
   */
  const [focused, setFocused] = useState<MealField | null>(null);
  const comments = commentsFor(row, notices);
  const blockers = publishBlockers(row.draft);

  const anchorId = (field: MealField) => `draft-${row.id}-field-${field}`;

  const pointAt = (field: MealField) => {
    const next = focused === field ? null : field;
    setFocused(next);
    if (!next) return;
    const target = typeof document !== 'undefined' ? document.getElementById(anchorId(field)) : null;
    // Guarded because jsdom has no layout and therefore no `scrollIntoView`, and
    // a test that has to stub a browser API to render a card is a test about the
    // stub. `nearest` so a field already on screen does not jump under them.
    if (target && typeof target.scrollIntoView === 'function') {
      target.scrollIntoView({ block: 'nearest' });
    }
  };

  return (
    <>
      {/*
        Two panes, and no media query anywhere near them. `flex-wrap` with a
        basis on each pane is the same rule at every width: side by side when
        both fit, the preview alone on the first line when they do not. That is
        what makes this right inside a 900px column on a 1440px screen — a
        viewport breakpoint would have been measuring the wrong box. `minWidth:
        0` on both is what stops a long ingredient line from pushing the page
        sideways at 390px.
      */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '16px', alignItems: 'flex-start' }} data-testid="draft-panes">
        <section style={{ flex: '3 1 320px', minWidth: 0 }} data-testid="draft-preview">
          <p style={paneHeading}>How it will look on Discover</p>

          {/*
            What would stop this publishing, before they press the button that
            would find out. On the preview because it is a fact about the meal,
            not about the request that failed. `publishBlockers` reads the same
            helpers `publishCreatorMeal` enforces — see `draft-form.ts`.
          */}
          {blockers.length > 0 && (
            <div
              style={{ background: '#fff0f0', border: '1px solid #ffcccc', borderRadius: '8px', padding: '10px 12px', marginBottom: '10px' }}
              data-testid="publish-blockers"
            >
              <p style={{ margin: 0, fontSize: '12px', fontWeight: 700, color: '#c40029' }}>
                {blockers.length === 1
                  ? 'One thing has to change before this can be published'
                  : `${blockers.length} things have to change before this can be published`}
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
                    {' — '}
                    {blocker.message}
                  </li>
                ))}
              </ul>
              <button onClick={onEdit} disabled={busy} style={{ ...secondaryButton, marginTop: '8px' }}>
                Fix it now
              </button>
            </div>
          )}

          {/*
            The meal, and only the meal. `notices` is deliberately not passed:
            this is the same component with the same arguments Discover renders
            it with, so the preview is the published card rather than a second
            rendering of it that can drift. Everything we have to say about it is
            in the pane beside this one.
          */}
          <div
            className="space-y-4"
            style={{ background: 'var(--surface-raised, #fff)', border: '1px solid #eee', borderRadius: '12px', padding: '16px' }}
            data-testid="draft-card"
          >
            {/* The header the modal draws in its own chrome: the name, and the
                name it goes out under. "Would I put my name on this" is easier
                to answer with the name on the card. */}
            <div
              id={anchorId('name')}
              data-field="name"
              {...(focused === 'name' ? { 'data-focused': 'true' } : {})}
              style={focused === 'name' ? { outline: '2px solid #dd0031', outlineOffset: '4px', borderRadius: '6px' } : undefined}
            >
              <h4 style={{ margin: 0, fontSize: '15px', fontWeight: 700, color: '#18181B' }}>{row.draft.name}</h4>
              {row.creatorName && (
                <p style={{ margin: '2px 0 0', fontSize: '12px', color: '#dd0031', fontWeight: 500 }}>by {row.creatorName}</p>
              )}
            </div>
            <MealDetailBody meal={asPresetMeal(row)} fieldAnchorId={anchorId} focusedField={focused} />
          </div>
        </section>

        {/*
          Ours, and said to look like ours: the same card shape and the same
          hairline, on the page background rather than on card white, so it
          reads as a note pinned beside the recipe instead of part of it.
        */}
        <aside style={{ flex: '2 1 260px', minWidth: 0 }} data-testid="draft-comments">
          <p style={paneHeading}>What we read</p>
          <div style={{ background: '#f4f3f1', border: '1px solid #e8e6e2', borderRadius: '12px', padding: '14px 16px' }}>
          <p style={{ margin: '0 0 10px', fontSize: '11px', color: '#52525B', lineHeight: 1.6 }} data-testid="comments-summary">
            {row.summary.needALook === 0
              ? 'Every field we filled matched the page we read. Nothing here needs checking — it is still yours to read before it goes out.'
              : `${summaryLine(row.summary)} Each one below says which field it is about.`}
          </p>

          {comments.length > 0 && (
            <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {comments.map(comment => (
                <li
                  key={comment.field ?? comment.label}
                  data-testid="draft-comment"
                  data-field={comment.field ?? ''}
                  {...(focused && comment.field === focused ? { 'data-active': 'true' } : {})}
                  style={{
                    borderLeft: `2px solid ${focused && comment.field === focused ? '#dd0031' : '#e8e6e2'}`,
                    paddingLeft: '10px',
                  }}
                >
                  {/* The same notice component the import form and the admin
                      queue draw, so a reason is worded once. It already names
                      its own field and already keeps the span we read one tap
                      behind "See what we read". */}
                  <ImportFieldNotice notice={comment.notice} fieldLabel={comment.label} />
                  {comment.field ? (
                    <button
                      type="button"
                      onClick={() => pointAt(comment.field!)}
                      aria-controls={anchorId(comment.field)}
                      aria-pressed={focused === comment.field}
                      data-testid="comment-jump"
                      // Ink Muted until it is the one pointing, which is the
                      // whole reason it is not brand red by default: a comment
                      // per flagged row means ten of these, and ten red links
                      // beside a recipe is our working shouting over it again in
                      // a different column. The red is for the pair that is
                      // live — this button and the ring on the field it named.
                      style={{
                        background: 'none', border: 'none', padding: '2px 0 0', font: 'inherit',
                        fontSize: '11px', cursor: 'pointer', textDecoration: 'underline',
                        textDecorationStyle: 'dotted',
                        color: focused === comment.field ? '#dd0031' : '#52525B',
                        fontWeight: focused === comment.field ? 600 : 400,
                      }}
                    >
                      {focused === comment.field ? 'Stop showing me' : 'Show me on the card'}
                    </button>
                  ) : (
                    /* Nothing to point at, and that is the comment's own point:
                       the field is not on the card because we could not fill it.
                       A link to an empty slot would be a link to nothing. */
                    <span style={{ display: 'block', fontSize: '11px', color: '#9ca3af', paddingTop: '2px' }} data-testid="comment-absent">
                      Not on the card — nothing was filled in.
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
          </div>
        </aside>
      </div>

      {/*
        Approve / Edit / Decline: unchanged in what they do, and under both panes
        because they decide the draft rather than either column. Reading order on
        a phone is the meal, then our notes, then the decision.
      */}
      <div style={{ display: 'flex', gap: '8px', marginTop: '12px', flexWrap: 'wrap', alignItems: 'center' }}>
        <button
          onClick={() => onDecide('approve')}
          disabled={busy || blockers.length > 0}
          // Off rather than merely failing: pressing it would roll back
          // server-side and come back as a refusal, which is a worse way to be
          // told something we already know.
          title={blockers.length > 0 ? blockers.map(blocker => blocker.message).join(' ') : undefined}
          style={blockers.length > 0
            ? { ...primaryButton, background: '#f3f4f6', color: '#9ca3af', cursor: 'not-allowed' }
            : primaryButton}
        >
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
        {blockers.length > 0 && (
          <span style={{ fontSize: '11px', color: '#c40029', lineHeight: 1.6 }} data-testid="approve-blocked-note">
            Approving is off until the {blockers.length === 1 ? 'thing' : 'things'} above {blockers.length === 1 ? 'is' : 'are'} fixed.
          </span>
        )}
      </div>
    </>
  );
}
