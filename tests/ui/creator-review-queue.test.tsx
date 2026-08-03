// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
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

/**
 * The payload GET returns: each row with its rendered review attached.
 *
 * `waiting` is a separate argument from the list because the server counts it
 * separately — the list is capped at 200 rows and the count is not.
 */
function payload(drafts: ImportDraft[], waiting = drafts.length) {
  const rows = drafts.map((row) => {
    const review = reviewDraft(row);
    return { ...row, summary: review.summary, review };
  });
  return {
    waiting,
    drafts: rows,
    totals: { waiting, showing: rows.length, flagged: rows.filter((r) => r.summary.needALook > 0).length },
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

  it('says it could not look, rather than that there is nothing to look at', async () => {
    // The badge in the header deliberately keeps its last number on a failed
    // read. Rendering nothing here put "3 recipes waiting" and a portal with no
    // queue on one screen — two contradictory statements, the reassuring one
    // wrong. Still not a red box: this card is one thing on a portal full of
    // other things.
    vi.stubGlobal('fetch', (async () => json({ error: 'nope' }, 500)) as unknown as typeof fetch);
    render(<CreatorReviewQueue />);

    expect((await screen.findByTestId('queue-unreadable')).textContent).toMatch(/we do not know what is waiting/i);
    // And no count, in either direction: the card claims neither a number nor
    // an emptiness it did not observe.
    expect(screen.queryByTestId('queue-position')).toBeNull();
    expect(screen.queryByText(/^That’s everything$/)).toBeNull();
    expect(screen.getByTestId('queue-retry')).toBeTruthy();
  });

  it('does not tell the badge the queue is empty when it could not read it', async () => {
    // The failure the badge's own rule exists to prevent, from the other side:
    // announcing 0 here would zero a count nobody verified.
    const announced: number[] = [];
    window.addEventListener('mealio:draft-queue-changed', (event) => {
      announced.push((event as CustomEvent<{ waiting: number }>).detail.waiting);
    });
    vi.stubGlobal('fetch', (async () => json({ error: 'nope' }, 500)) as unknown as typeof fetch);
    render(<CreatorReviewQueue />);

    await screen.findByTestId('queue-unreadable');
    expect(announced).toEqual([]);
  });

  it('treats a dropped connection as a failed read, not as a queue that never loads', async () => {
    // An unhandled rejection out of the effect left the card in its loading
    // state forever, which renders as nothing — the same wrong answer by a
    // different route.
    vi.stubGlobal('fetch', (async () => { throw new TypeError('Failed to fetch'); }) as unknown as typeof fetch);
    render(<CreatorReviewQueue />);

    expect(await screen.findByTestId('queue-unreadable')).toBeTruthy();
  });

  it('recovers on Try again without a reload', async () => {
    let fail = true;
    vi.stubGlobal('fetch', (async () => (fail ? json({ error: 'nope' }, 500) : json(payload([draft()])))) as unknown as typeof fetch);
    render(<CreatorReviewQueue />);

    await screen.findByTestId('queue-unreadable');
    fail = false;
    fireEvent.click(screen.getByTestId('queue-retry'));

    expect((await screen.findByTestId('queue-position')).textContent).toBe('1 of 1');
  });

  it('still renders nothing when the queue really is empty', async () => {
    // The distinction only means something if the empty case is unchanged.
    harness([]);
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

  /**
   * A draft carrying a cook's unit — the shape `canonicalizeIngredient` really
   * produces for "3 cloves garlic". `qty` stays 1 because the amount is three
   * cloves and not three heads.
   */
  const withCloves = () => {
    const ingredients = guacamole.draft.ingredients.map((row, i) =>
      i === 0 ? { ...row, ingredientName: 'garlic', unit: 'cloves', measure: '3', qty: 1 } : row);
    return draft({ draft: { ...guacamole.draft, ingredients } });
  };

  it('keeps a cook’s unit selectable, rather than showing it back as "Qty"', async () => {
    // The editor offered the eleven MEASURED units, and the pipeline
    // canonicalises to ALL_UNITS. A `cloves` row therefore matched no option,
    // the select fell back to its first, and the row read "garlic, 3, Qty" — the
    // exact failure COOK_UNITS was added to prevent ("told the cart to buy three
    // heads of garlic for three cloves"), shown on the screen whose job is
    // catching wrong measures.
    harness([withCloves()]);
    await screen.findByTestId('queue-position');
    fireEvent.click(screen.getByRole('button', { name: 'Edit first' }));

    const editor = await screen.findByTestId('draft-editor');
    const unit = within(editor).getByLabelText('Ingredient 1 unit') as HTMLSelectElement;

    expect(unit.value).toBe('cloves');
    // And it is a real option, so touching the dropdown is not a one-way trip:
    // a creator who opened it could not previously get `cloves` back.
    expect([...unit.options].map((option) => option.value)).toContain('cloves');
  });

  it('saves the cook’s unit it displayed, after the creator has opened the picker', async () => {
    // The trap was one-way rather than immediate: a blind save preserved
    // `cloves`, so the bug only bit the creator who actually used the control.
    const { bodies } = harness([withCloves()]);
    await screen.findByTestId('queue-position');
    fireEvent.click(screen.getByRole('button', { name: 'Edit first' }));

    const editor = await screen.findByTestId('draft-editor');
    const unit = within(editor).getByLabelText('Ingredient 1 unit');
    fireEvent.change(unit, { target: { value: 'tbsp' } });
    fireEvent.change(unit, { target: { value: 'cloves' } });
    fireEvent.click(within(editor).getByRole('button', { name: 'Save edits' }));

    await waitFor(() => expect(bodies.some((b) => b.method === 'PATCH')).toBe(true));
    expect(bodies.find((b) => b.method === 'PATCH')!.body.draft.ingredients[0]).toMatchObject({
      ingredientName: 'garlic',
      unit: 'cloves',
      measure: '3',
    });
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

  it('announces the server’s count, not the length of the page it loaded', async () => {
    // The read is capped at 200 rows and the count is not. Announcing the list
    // rewrote a creator's 250 down to 200 the moment they opened the queue,
    // before they had decided anything — and the next decision put it back to
    // 249.
    const seen: number[] = [];
    const listener = (e: Event) => seen.push((e as CustomEvent<{ waiting: number }>).detail.waiting);
    window.addEventListener('mealio:draft-queue-changed', listener);

    const loaded = [draft(), cleanDraft()];
    vi.stubGlobal('fetch', (async () => json(payload(loaded, 250))) as unknown as typeof fetch);
    render(<CreatorReviewQueue />);

    await screen.findByTestId('queue-position');
    expect(seen).toEqual([250]);

    window.removeEventListener('mealio:draft-queue-changed', listener);
  });

  it('says how many there are and how many of them it loaded', async () => {
    const loaded = [draft(), cleanDraft()];
    vi.stubGlobal('fetch', (async () => json(payload(loaded, 250))) as unknown as typeof fetch);
    render(<CreatorReviewQueue />);

    // The heading is the true number; the position is where they are in the
    // page. A heading of 2 next to a badge of 250 is the disagreement.
    expect(await screen.findByText('250 recipes are waiting for you')).toBeTruthy();
    expect(screen.getByTestId('queue-position').textContent).toBe('1 of 2');
    expect(screen.getByTestId('queue-truncated').textContent).toMatch(/Showing the first 2\b/);
  });

  it('says nothing about truncation when nothing was truncated', async () => {
    harness([draft(), cleanDraft()]);
    await screen.findByTestId('queue-position');
    expect(screen.getByText('2 recipes are waiting for you')).toBeTruthy();
    expect(screen.queryByTestId('queue-truncated')).toBeNull();
  });
});
