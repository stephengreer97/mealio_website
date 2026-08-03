// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { CreatorMealDraft, ImportConfidence, ImportSuccess } from '@/lib/import/types';

// `lib/import-drafts` is imported for `reviewDraft` alone, so the queue payload
// in this file is built by the same code the route builds it with rather than a
// hand-written literal that could drift from it. Its server-only dependencies
// are mocked away; none of them is reached.
vi.mock('@/lib/supabase', () => ({ createServerSupabaseClient: () => ({}) }));
vi.mock('@/lib/logger', () => ({ log: vi.fn() }));
vi.mock('@/lib/email', () => ({ sendCreatorSyncPublishedEmail: vi.fn() }));
vi.mock('@/lib/creator-meals', () => ({ publishCreatorMeal: vi.fn() }));

import CreatorReviewQueue from '@/components/CreatorReviewQueue';
import { reviewDraft, type ImportDraft } from '@/lib/import-drafts';
import { importedGuacamole } from '../helpers/import-ui-fixtures';

/**
 * The creator's own review queue (MEAL-89).
 *
 * The ticket's shape, and what this file is about:
 *
 *   1. **The queue is the feature, not the popup.** Position is shown as
 *      "3 of 10" so the end is visible, and it survives a remount — the thing
 *      that makes ten drafts reviewable in one sitting instead of a stack of
 *      cards people force-quit.
 *   2. **Nothing blocks.** No modal, and an empty queue renders nothing at all
 *      rather than a box on the portal saying there is nothing to do.
 *   3. **Exceptions only.** A verified field says nothing; a flagged one
 *      carries its reason and the span we read.
 *   4. **No "approve all".** Deciding is per draft, and skipping decides
 *      nothing.
 */

let guacamole: ImportSuccess;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function draft(overrides: Partial<ImportDraft> = {}): ImportDraft {
  return {
    id: 'd1',
    creatorId: 'c1',
    creatorName: 'Chef Sarah',
    sourceUrl: 'https://chefsarah.test/guacamole',
    source: 'website',
    itemId: 'guid-1',
    syncRunId: null,
    draft: guacamole.draft,
    confidence: guacamole.confidence,
    status: 'pending_review',
    reviewBy: 'creator',
    editedAt: null,
    decidedAt: null,
    decidedBy: null,
    publishedMealId: null,
    createdAt: '2026-08-02T10:00:00.000Z',
    ...overrides,
  };
}

/** A draft whose every field verified against the source. */
function cleanDraft(id = 'd2'): ImportDraft {
  const green = guacamole.confidence.name;
  const confidence: ImportConfidence = {
    name: green, recipe: green, story: green, photoUrl: green,
    difficulty: green, tags: green, serves: green,
    ingredients: guacamole.confidence.ingredients.map(() => green),
  };
  const body: CreatorMealDraft = { ...guacamole.draft, name: 'Black bean soup', story: 'A weeknight staple.', serves: '4' };
  return draft({ id, draft: body, confidence, createdAt: '2026-08-03T00:00:00.000Z' });
}

/** The payload GET returns: each row with its rendered review attached. */
function payload(drafts: ImportDraft[]) {
  const rows = drafts.map((row) => {
    const review = reviewDraft(row);
    return { ...row, summary: review.summary, review };
  });
  return {
    drafts: rows,
    totals: { waiting: rows.length, flagged: rows.filter((r) => r.summary.needALook > 0).length },
  };
}

/** Routes the one endpoint the screen talks to, recording what it was asked. */
function harness(drafts: ImportDraft[] = [draft()], overrides: { post?: unknown; postStatus?: number } = {}) {
  const bodies: Array<{ method: string; body: any }> = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (init?.body) bodies.push({ method, body: JSON.parse(String(init.body)) });
    if (method === 'GET') return json(payload(drafts));
    if (method === 'PATCH') return json({ draft: payload(drafts).drafts[0] });
    return json(
      overrides.post ?? { done: 1, published: [{ id: 'meal-1', name: 'Best Guacamole' }], errors: [], waiting: drafts.length - 1 },
      overrides.postStatus ?? 200,
    );
  }) as unknown as typeof fetch;

  vi.stubGlobal('fetch', impl);
  const view = render(<CreatorReviewQueue />);
  return { view, bodies };
}

beforeEach(async () => {
  localStorage.clear();
  localStorage.setItem('accessToken', 'test-token');
  guacamole = await importedGuacamole();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

// ── Never blocking ───────────────────────────────────────────────────────────

describe('the queue never gets in the way', () => {
  it('renders nothing at all when nothing is waiting', async () => {
    // A creator who opened the portal to edit a published meal should not meet a
    // box telling them they have no drafts. Silence is the empty state.
    harness([]);
    await waitFor(() => expect(screen.queryByTestId('creator-review-queue')).toBeNull());
  });

  it('renders nothing when the queue cannot be read, rather than a red box', async () => {
    // This card is one thing on a portal full of other things. A creator who
    // came here to do something else should not be met with an error about a
    // queue they were not thinking about; the server logs it.
    vi.stubGlobal('fetch', (async () => json({ error: 'nope' }, 500)) as unknown as typeof fetch);
    render(<CreatorReviewQueue />);
    await waitFor(() => expect(screen.queryByTestId('creator-review-queue')).toBeNull());
  });
});

// ── The queue, at ten drafts ─────────────────────────────────────────────────

describe('position and progress', () => {
  it('shows where in the queue they are, so the end is visible', async () => {
    harness([draft(), cleanDraft(), cleanDraft('d3')]);
    expect((await screen.findByTestId('queue-position')).textContent).toBe('1 of 3');
    expect(screen.getByText(/3 recipes are waiting for you/)).toBeTruthy();
  });

  it('advances on a decision without moving the end of the queue', async () => {
    // "3 of 10" becoming "3 of 9" under a creator's finger makes the end look
    // like it moved. The decided draft leaves the list; the position does not
    // reset.
    harness([draft(), cleanDraft(), cleanDraft('d3')]);
    await screen.findByTestId('queue-position');

    fireEvent.click(screen.getByRole('button', { name: /Approve & publish/ }));

    await waitFor(() => expect(screen.getByTestId('queue-position').textContent).toBe('1 of 2'));
  });

  it('resumes where they left off after a remount', async () => {
    // Backgrounding the app on a phone browser is indistinguishable from closing
    // the tab: both come back as a fresh mount, and losing the place on either
    // is the same annoyance.
    const drafts = [draft(), cleanDraft(), cleanDraft('d3')];
    harness(drafts);
    await screen.findByTestId('queue-position');

    fireEvent.click(screen.getByTestId('skip-draft'));
    expect(screen.getByTestId('queue-position').textContent).toBe('2 of 3');

    cleanup();
    harness(drafts);

    await waitFor(() => expect(screen.getByTestId('queue-position').textContent).toBe('2 of 3'));
  });

  it('falls back to the front when the remembered draft is no longer pending', async () => {
    // Decided on the phone, decided in another tab, taken back by an operator.
    // The cursor is the draft's id rather than an index precisely so this case
    // is detectable — an index would silently name a different recipe.
    localStorage.setItem('mealio_draft_cursor', 'gone');
    harness([draft(), cleanDraft()]);
    await waitFor(() => expect(screen.getByTestId('queue-position').textContent).toBe('1 of 2'));
  });

  it('skipping decides nothing', async () => {
    const { bodies } = harness([draft(), cleanDraft()]);
    await screen.findByTestId('queue-position');

    fireEvent.click(screen.getByTestId('skip-draft'));

    expect(screen.getByTestId('queue-position').textContent).toBe('2 of 2');
    expect(bodies.some((b) => b.method === 'POST')).toBe(false);
  });
});

// ── What a creator is shown ──────────────────────────────────────────────────

describe('the card is the card a saver would read', () => {
  it('shows the meal, not a field dump', async () => {
    harness();
    const card = await screen.findByTestId('draft-card');
    // The same component Discover renders, so what a creator approves and what a
    // saver reads cannot drift apart.
    expect(card.textContent).toMatch(/avocado/i);
  });

  it('calls out only the flagged fields', async () => {
    harness();
    await screen.findByTestId('draft-card');

    const notices = screen.getAllByTestId('import-notice');
    const summary = screen.getByTestId('draft-summary').textContent ?? '';
    const needALook = Number(/(\d+) need/.exec(summary)?.[1] ?? 0);

    // Exceptions only. Silence on the rest is the signal that we checked them —
    // a note on all nine fields would destroy it.
    expect(notices.length).toBeGreaterThan(0);
    expect(notices.length).toBe(needALook);
    expect(summary).toMatch(/verified/);
  });

  it('says nothing to check when everything verified', async () => {
    harness([cleanDraft('d1')]);
    await screen.findByTestId('draft-card');
    expect(screen.queryAllByTestId('import-notice')).toHaveLength(0);
    expect(screen.getByTestId('draft-summary').textContent).toMatch(/matched the page we read/);
  });
});

// ── Deciding ─────────────────────────────────────────────────────────────────

describe('approve, edit, decline — and no approve-all', () => {
  it('offers no way to decide more than one draft at once', async () => {
    harness([draft(), cleanDraft(), cleanDraft('d3')]);
    await screen.findByTestId('queue-position');

    // Bulk-approving unreviewed extractions is exactly what the per-field
    // confidence model exists to prevent, so the button does not exist. The
    // server refuses a batched approve as well.
    expect(screen.queryByRole('button', { name: /approve all/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /approve 3/i })).toBeNull();
  });

  it('approves exactly the draft on screen', async () => {
    const { bodies } = harness([draft(), cleanDraft()]);
    await screen.findByTestId('queue-position');

    fireEvent.click(screen.getByRole('button', { name: /Approve & publish/ }));

    await waitFor(() => expect(bodies.some((b) => b.method === 'POST')).toBe(true));
    expect(bodies.find((b) => b.method === 'POST')!.body).toMatchObject({ action: 'approve', ids: ['d1'] });
  });

  it('says a second tap published nothing new, rather than reporting a failure', async () => {
    // A slow network invites a second tap. The conditional write server-side is
    // what makes that safe; this is the creator being told so.
    harness([draft()], { post: { done: 0, published: [], errors: ['That draft was already approved.'], waiting: 0 } });
    await screen.findByTestId('queue-position');

    fireEvent.click(screen.getByRole('button', { name: /Approve & publish/ }));

    await waitFor(() => expect(screen.getByText(/already approved/i)).toBeTruthy());
  });

  it('confirms the last decision instead of vanishing mid-tap', async () => {
    // Approving the last draft used to make the whole card disappear, so "your
    // recipe is live" was never shown — leaving the creator guessing at exactly
    // the moment they are most likely to tap Approve a second time.
    harness([draft()], { post: { done: 1, published: [{ id: 'm1', name: 'Best Guacamole' }], errors: [], waiting: 0 } });
    await screen.findByTestId('queue-position');

    fireEvent.click(screen.getByRole('button', { name: /Approve & publish/ }));

    await waitFor(() => expect(screen.getByText(/That’s everything/)).toBeTruthy());
    expect(screen.getByTestId('creator-review-queue').textContent).toMatch(/is live/i);
  });

  it('declines without deleting, and says it will not come back', async () => {
    const { bodies } = harness([draft(), cleanDraft()], { post: { done: 1, published: [], errors: [], waiting: 1 } });
    await screen.findByTestId('queue-position');

    expect(screen.getByTestId('queue-actions-note').textContent).toMatch(/does not come back/i);
    fireEvent.click(screen.getByRole('button', { name: /Not this one/ }));

    await waitFor(() => expect(bodies.some((b) => b.method === 'POST')).toBe(true));
    expect(bodies.find((b) => b.method === 'POST')!.body).toMatchObject({ action: 'cancel', ids: ['d1'] });
  });

  it('edits in place, and saving does not publish', async () => {
    const { bodies } = harness([draft()]);
    await screen.findByTestId('queue-position');

    fireEvent.click(screen.getByRole('button', { name: 'Edit first' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Save edits' }));

    await waitFor(() => expect(bodies.some((b) => b.method === 'PATCH')).toBe(true));
    // A PATCH and no POST: correcting a measure has not said the recipe is right.
    expect(bodies.some((b) => b.method === 'POST')).toBe(false);
    await waitFor(() => expect(screen.getByText(/editing does not publish it/i)).toBeTruthy());
  });
});

// ── The badge ────────────────────────────────────────────────────────────────

describe('telling the header what the count is', () => {
  it('announces the count on load and again after a decision', async () => {
    // The badge lives in AppHeader, a sibling under a page neither owns. Without
    // this a creator watches the queue empty while the header keeps saying 2 —
    // in the one place they can see it be wrong.
    const seen: number[] = [];
    const listener = (e: Event) => seen.push((e as CustomEvent<{ waiting: number }>).detail.waiting);
    window.addEventListener('mealio:draft-queue-changed', listener);

    harness([draft(), cleanDraft()], { post: { done: 1, published: [{ id: 'm1', name: 'Best Guacamole' }], errors: [], waiting: 1 } });
    await screen.findByTestId('queue-position');
    expect(seen).toEqual([2]);

    fireEvent.click(screen.getByRole('button', { name: /Approve & publish/ }));
    await waitFor(() => expect(seen).toEqual([2, 1]));

    window.removeEventListener('mealio:draft-queue-changed', listener);
  });
});
