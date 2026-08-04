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
 * The queue was a one-at-a-time pager — "1 of 3", Previous, Skip — and the
 * owner's report was that the page was confusing. What this file is about now:
 *
 *   1. **The queue is a list you can see.** Every waiting draft is a row, with
 *      enough on it to tell two drafts apart without opening either. Opening one
 *      is what reveals the card and the decision.
 *   2. **Flagged is legible.** The server already sorted by `needALook`; the
 *      order is now a group heading and a per-row badge instead of a fact you
 *      could only infer by paging through everything.
 *   3. **A decision resolves where it sits.** The row stays and says what became
 *      of it. It used to leave the list, which is indistinguishable from a
 *      mis-tap, and made "your recipe is live" unshowable on the last one.
 *   4. **Nothing blocks.** No modal, and an empty queue renders nothing at all
 *      rather than a box on the portal saying there is nothing to do.
 *   5. **Exceptions only.** A verified field says nothing; a flagged one carries
 *      its reason, and the span we read is one tap behind it.
 *   6. **No "approve all".** Deciding is per draft.
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

/** Every row on screen, in the order the list draws them. */
const rows = () => screen.queryAllByTestId('draft-row');

/** The list row for a draft, found by the name it shows. */
const rowFor = (name: string) =>
  rows().find(row => row.textContent?.includes(name)) as HTMLElement;

/**
 * The row's own header button — the control that opens and closes it. Always
 * first in the row; an open row also holds the decision buttons.
 */
const toggleOf = (name: string) => within(rowFor(name)).getAllByRole('button')[0];

/** Opens a row and returns the card underneath it. */
function open(name: string) {
  fireEvent.click(toggleOf(name));
  return screen.findByTestId('draft-card');
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
    expect(screen.queryAllByTestId('draft-row')).toHaveLength(0);
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

    expect(await screen.findByTestId('draft-row')).toBeTruthy();
  });

  it('still renders nothing when the queue really is empty', async () => {
    // The distinction only means something if the empty case is unchanged.
    harness([]);
    await waitFor(() => expect(screen.queryByTestId('creator-review-queue')).toBeNull());
  });
});

// ── The list ─────────────────────────────────────────────────────────────────

describe('everything waiting is on screen at once', () => {
  it('draws a row per waiting draft rather than one draft at a time', async () => {
    // The pager showed one recipe and "1 of 3". Three dinners and three copies
    // of the same dinner were indistinguishable until you had paged through all
    // of them, which is the thing a queue is supposed to save you.
    harness([draft(), cleanDraft(), cleanDraft('d3')]);

    expect(await screen.findAllByTestId('draft-row')).toHaveLength(3);
    expect(screen.getByText('3 recipes are waiting for you')).toBeTruthy();
    // And nothing is open: the list is the landing view, not a recipe nobody
    // chose with nine more hidden behind it.
    expect(screen.queryByTestId('draft-card')).toBeNull();
  });

  it('says enough on a row to tell two drafts apart without opening either', async () => {
    harness([draft(), cleanDraft()]);
    await screen.findAllByTestId('draft-row');

    const guacamole = rowFor('Best Guacamole');
    // Where we read it, and how much of a recipe came back.
    expect(guacamole.textContent).toContain('chefsarah.test');
    expect(guacamole.textContent).toMatch(/\d+ ingredients/);
    // The photo, which is the fastest way to tell two recipes apart.
    expect(guacamole.querySelector('img')).toBeTruthy();
  });

  it('names the platform rather than its hostname, where the hostname says nothing', async () => {
    // Every YouTube draft would otherwise read "youtube.com", which
    // distinguishes nothing from nothing.
    harness([draft({ source: 'youtube', sourceUrl: 'https://www.youtube.com/watch?v=abc' })]);
    await screen.findAllByTestId('draft-row');

    expect(rowFor('Best Guacamole').textContent).toContain('YouTube');
  });

  it('makes the flagged ones distinguishable before anything is opened', async () => {
    // `listDraftQueue` has always sorted most-flagged first and nothing on
    // screen admitted it, so the order looked arbitrary and the creator had no
    // way to see where the work was.
    harness([draft(), cleanDraft(), cleanDraft('d3')]);
    await screen.findAllByTestId('draft-row');

    // Per row: how many fields, counted, never scored.
    expect(within(rowFor('Best Guacamole')).getByTestId('flag-badge').textContent).toMatch(/\d+ to check/);
    expect(within(rowFor('Black bean soup')).getByTestId('flag-badge').textContent).toBe('all verified');

    // As a group, and as a sentence.
    const flagged = screen.getByTestId('group-flagged');
    expect(within(flagged).getAllByTestId('draft-row')).toHaveLength(1);
    expect(within(screen.getByTestId('group-clean')).getAllByTestId('draft-row')).toHaveLength(2);
    expect(screen.getByTestId('queue-flagged-count').textContent).toMatch(/One of the ones below/);

    // And the flagged group is drawn first, which is the order the server sorted
    // in — the list is the sort made visible, not a second opinion about it.
    expect(rows()[0].textContent).toContain('Best Guacamole');
  });
});

// ── Opening one ──────────────────────────────────────────────────────────────

describe('opening a row is what reveals the decision', () => {
  it('opens the row that was clicked, and only that one', async () => {
    harness([draft(), cleanDraft()]);
    await screen.findAllByTestId('draft-row');

    const card = await open('Black bean soup');

    expect(card.textContent).toContain('Black bean soup');
    expect(screen.getAllByTestId('draft-card')).toHaveLength(1);
    expect(screen.getByRole('button', { name: /Approve & publish/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Edit first' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Not this one/ })).toBeTruthy();
  });

  it('closes again without deciding anything', async () => {
    // Getting out of a recipe you are not sure about has to be free. The
    // alternative is deciding it in order to leave it, and the decision that
    // gets made under that pressure is Approve.
    const { bodies } = harness([draft(), cleanDraft()]);
    await screen.findAllByTestId('draft-row');

    await open('Best Guacamole');
    fireEvent.click(toggleOf('Best Guacamole'));

    expect(screen.queryByTestId('draft-card')).toBeNull();
    expect(bodies.some((b) => b.method === 'POST')).toBe(false);
    expect(rows()).toHaveLength(2);
  });

  it('opens the one waiting draft, because there is nothing to choose between', async () => {
    harness([draft()]);
    expect(await screen.findByTestId('draft-card')).toBeTruthy();
  });

  it('resumes the row they had open after a remount', async () => {
    // Backgrounding the app on a phone browser is indistinguishable from closing
    // the tab: both come back as a fresh mount, and losing your place in a long
    // recipe on either is the same annoyance.
    const drafts = [draft(), cleanDraft(), cleanDraft('d3')];
    harness(drafts);
    await screen.findAllByTestId('draft-row');
    await open('Black bean soup');

    cleanup();
    harness(drafts);

    await waitFor(() => expect(screen.getByTestId('draft-card').textContent).toContain('Black bean soup'));
  });

  it('opens nothing when the remembered draft is no longer pending', async () => {
    // Decided on the phone, decided in another tab, taken back by an operator.
    // The cursor is the draft's id rather than an index precisely so this case
    // is detectable — an index would silently open a different recipe.
    localStorage.setItem('mealio_draft_cursor', 'gone');
    harness([draft(), cleanDraft()]);

    await screen.findAllByTestId('draft-row');
    expect(screen.queryByTestId('draft-card')).toBeNull();
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

  it('says what every field is', async () => {
    // The card was a stack of unlabelled values: a row of chips, a paragraph in
    // italics, a person icon beside "4-6", a link. Only Measurements and Recipe
    // had a heading, so a reader had to infer every other field from its shape.
    harness();
    const card = await screen.findByTestId('draft-card');

    const labelled = Array.from(card.querySelectorAll('dt')).map((dt) => dt.textContent);
    expect(labelled).toEqual(expect.arrayContaining(['Serves', 'Difficulty', 'Source']));
    expect(within(card).getByText('Measurements')).toBeTruthy();
    expect(within(card).getByText('Recipe')).toBeTruthy();
    // Story is empty on this fixture and still gets its labelled slot, because
    // that is what gives the note under it a field to belong to.
    expect(within(card).getAllByText('Story').length).toBeGreaterThan(0);
  });

  it('calls out only the flagged fields', async () => {
    harness();
    await screen.findByTestId('draft-card');

    const notices = screen.getAllByTestId('import-notice');
    const badge = within(rowFor('Best Guacamole')).getByTestId('flag-badge').textContent ?? '';
    const needALook = Number(/(\d+) to check/.exec(badge)?.[1] ?? 0);

    // Exceptions only. Silence on the rest is the signal that we checked them —
    // a note on all nine fields would destroy it.
    expect(notices.length).toBeGreaterThan(0);
    expect(notices.length).toBe(needALook);
  });

  it('names the field each notice is about', async () => {
    // Three copies of "Not found in the source — add this", three different
    // missing things, and nothing on screen saying which was which. The label
    // was there all along and was screen-reader-only.
    harness();
    await screen.findByTestId('draft-card');

    const absent = screen.getAllByTestId('import-notice').filter((n) => n.dataset.kind === 'absent');
    expect(absent.length).toBeGreaterThan(1);
    for (const notice of absent) expect(notice.textContent).toMatch(/^[^—]+ — /);
    // And no two of them say the same thing.
    const leads = absent.map((n) => (n.textContent ?? '').split(' — ')[0]);
    expect(new Set(leads).size).toBe(leads.length);
  });

  it('keeps the span we read one tap away instead of under every row', async () => {
    // It printed under every flagged field and every flagged ingredient at
    // nearly the weight of the value itself, which roughly doubled the card and
    // buried the recipe in our working. The reason stays in plain text; only the
    // quotation moved.
    harness();
    await screen.findByTestId('draft-card');

    const quoted = screen.getAllByTestId('import-notice').filter(
      (n) => within(n).queryByTestId('evidence-toggle') !== null);
    expect(quoted.length).toBeGreaterThan(0);
    expect(screen.queryAllByTestId('evidence')).toHaveLength(0);

    fireEvent.click(within(quoted[0]).getByTestId('evidence-toggle'));
    expect(within(quoted[0]).getByTestId('evidence').textContent).toMatch(/We read:/);
  });

  it('writes an ingredient line the way a recipe writes one', async () => {
    // "chopped tomatoes, 2 cans" is the order the row is stored in, and it was
    // printed directly beneath the source line we had quoted — which was plainly
    // the easier of the two to read.
    const ingredients = guacamole.draft.ingredients.map((row, i) =>
      i === 0 ? { ...row, ingredientName: 'chopped tomatoes', unit: 'cans', measure: '2', qty: 1 } : row);
    harness([draft({ draft: { ...guacamole.draft, ingredients } })]);
    const card = await screen.findByTestId('draft-card');

    expect(within(card).getByText(/2 cans chopped tomatoes/)).toBeTruthy();
  });

  it('spells a unit for the number beside it', async () => {
    // Units are stored plural on purpose — one token per unit — and that storage
    // decision had leaked onto the card as "cannellini beans, 1 cans".
    const ingredients = guacamole.draft.ingredients.map((row, i) =>
      i === 0 ? { ...row, ingredientName: 'cannellini beans', unit: 'cans', measure: '1', qty: 1 } : row);
    harness([draft({ draft: { ...guacamole.draft, ingredients } })]);
    const card = await screen.findByTestId('draft-card');

    expect(within(card).getByText(/1 can cannellini beans/)).toBeTruthy();
    expect(card.textContent).not.toContain('1 cans');
  });

  it('leaves a fraction alone, which is not one of anything', async () => {
    // "1 1/2 tsp" starts with a 1 and is not singular. Anything that is not the
    // bare character "1" keeps the stored spelling, which is the safe way for
    // this to be wrong.
    const ingredients = guacamole.draft.ingredients.map((row, i) =>
      i === 0 ? { ...row, ingredientName: 'flour', unit: 'cups', measure: '1 1/2', qty: 1 } : row);
    harness([draft({ draft: { ...guacamole.draft, ingredients } })]);
    const card = await screen.findByTestId('draft-card');

    expect(within(card).getByText(/1 1\/2 cups flour/)).toBeTruthy();
  });

  it('says nothing at all when everything verified', async () => {
    harness([cleanDraft('d1')]);
    await screen.findByTestId('draft-card');

    expect(screen.queryAllByTestId('import-notice')).toHaveLength(0);
    expect(within(rowFor('Black bean soup')).getByTestId('flag-badge').textContent).toBe('all verified');
  });
});

// ── Deciding ─────────────────────────────────────────────────────────────────

describe('approve, edit, decline — and no approve-all', () => {
  it('offers no way to decide more than one draft at once', async () => {
    harness([draft(), cleanDraft(), cleanDraft('d3')]);
    await screen.findAllByTestId('draft-row');

    // Bulk-approving unreviewed extractions is exactly what the per-field
    // confidence model exists to prevent, so the button does not exist. Seeing
    // the whole list at once makes a select-all tempting in a way the pager did
    // not, which is a reason to keep checking rather than to reconsider.
    expect(screen.queryByRole('button', { name: /approve all/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /approve 3/i })).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('approves exactly the draft that was opened', async () => {
    const { bodies } = harness([draft(), cleanDraft()]);
    await screen.findAllByTestId('draft-row');
    await open('Black bean soup');

    fireEvent.click(screen.getByRole('button', { name: /Approve & publish/ }));

    await waitFor(() => expect(bodies.some((b) => b.method === 'POST')).toBe(true));
    expect(bodies.find((b) => b.method === 'POST')!.body).toMatchObject({ action: 'approve', ids: ['d2'] });
  });

  it('says a second tap published nothing new, rather than reporting a failure', async () => {
    // A slow network invites a second tap. The conditional write server-side is
    // what makes that safe; this is the creator being told so.
    harness([draft()], { post: { done: 0, published: [], errors: ['That draft was already approved.'], waiting: 0 } });
    await screen.findByTestId('draft-card');

    fireEvent.click(screen.getByRole('button', { name: /Approve & publish/ }));

    await waitFor(() => expect(screen.getAllByText(/already approved/i).length).toBeGreaterThan(0));
  });

  it('declines without deleting, and does not delete the row either', async () => {
    const { bodies } = harness([draft(), cleanDraft()], { post: { done: 1, published: [], errors: [], waiting: 1 } });
    await screen.findAllByTestId('draft-row');
    await open('Best Guacamole');

    fireEvent.click(screen.getByRole('button', { name: /Not this one/ }));

    await waitFor(() => expect(bodies.some((b) => b.method === 'POST')).toBe(true));
    expect(bodies.find((b) => b.method === 'POST')!.body).toMatchObject({ action: 'cancel', ids: ['d1'] });
    await waitFor(() =>
      expect(rowFor('Best Guacamole').getAttribute('data-decided')).toBe('declined'));
    expect(within(rowFor('Best Guacamole')).getByTestId('draft-resolved').textContent)
      .toMatch(/will not offer that one again/i);
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
    await screen.findByTestId('draft-card');
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
    await screen.findByTestId('draft-card');
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
    await screen.findByTestId('draft-card');

    fireEvent.click(screen.getByRole('button', { name: 'Edit first' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Save edits' }));

    await waitFor(() => expect(bodies.some((b) => b.method === 'PATCH')).toBe(true));
    // A PATCH and no POST: correcting a measure has not said the recipe is right.
    expect(bodies.some((b) => b.method === 'POST')).toBe(false);
    await waitFor(() => expect(screen.getByText(/editing does not publish it/i)).toBeTruthy());
  });
});

// ── A decision that resolves where it was made ───────────────────────────────

describe('a decided row resolves instead of vanishing', () => {
  it('leaves the row on screen saying what became of it', async () => {
    // A row that disappears the instant it is decided is indistinguishable from
    // a mis-tap, and after six decisions a creator cannot check which of six
    // recipes they published.
    harness([draft(), cleanDraft()], { post: { done: 1, published: [{ id: 'm1', name: 'Best Guacamole' }], errors: [], waiting: 1 } });
    await screen.findAllByTestId('draft-row');
    await open('Best Guacamole');

    fireEvent.click(screen.getByRole('button', { name: /Approve & publish/ }));

    await waitFor(() =>
      expect(rowFor('Best Guacamole').getAttribute('data-decided')).toBe('published'));
    expect(within(rowFor('Best Guacamole')).getByTestId('draft-resolved').textContent).toMatch(/is live/i);
    // Still two rows: nothing left the list.
    expect(rows()).toHaveLength(2);
    // And it is no longer work — the heading counts what is left to decide.
    expect(screen.getByText('A recipe is waiting for you')).toBeTruthy();
  });

  it('collapses the row it resolved, rather than leaving the card open', async () => {
    // There is no decision left on it, and the card would otherwise sit open
    // pushing everything undecided off the bottom of the screen.
    harness([draft(), cleanDraft()]);
    await screen.findAllByTestId('draft-row');
    await open('Best Guacamole');

    fireEvent.click(screen.getByRole('button', { name: /Approve & publish/ }));

    await waitFor(() => expect(screen.queryByTestId('draft-card')).toBeNull());
  });

  it('confirms the last decision instead of vanishing mid-tap', async () => {
    // Approving the last draft used to make the whole card disappear, so "your
    // recipe is live" was never shown — leaving the creator guessing at exactly
    // the moment they are most likely to tap Approve a second time. That was
    // fixed for the last row only; every row now resolves the same way.
    harness([draft()], { post: { done: 1, published: [{ id: 'm1', name: 'Best Guacamole' }], errors: [], waiting: 0 } });
    await screen.findByTestId('draft-card');

    fireEvent.click(screen.getByRole('button', { name: /Approve & publish/ }));

    await waitFor(() => expect(screen.getByText(/That’s everything/)).toBeTruthy());
    expect(screen.getByTestId('creator-review-queue').textContent).toMatch(/is live/i);
    expect(screen.getByTestId('draft-row')).toBeTruthy();
  });

  it('resolves a draft decided in another tab as decided, not as a failure', async () => {
    // The conditional write did its job and exactly one publish happened. It is
    // this tab that did not do the deciding, which is a different thing from the
    // decision not having been made.
    harness([draft()], { post: { done: 0, published: [], errors: ['That draft was already approved.'], waiting: 0 } });
    await screen.findByTestId('draft-card');

    fireEvent.click(screen.getByRole('button', { name: /Approve & publish/ }));

    await waitFor(() =>
      expect(screen.getByTestId('draft-row').getAttribute('data-decided')).toBe('declined'));
    expect(screen.getByTestId('draft-resolved').textContent).toMatch(/already approved/i);
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
    await screen.findAllByTestId('draft-row');
    expect(seen).toEqual([2]);

    await open('Best Guacamole');
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

    await screen.findAllByTestId('draft-row');
    expect(seen).toEqual([250]);

    window.removeEventListener('mealio:draft-queue-changed', listener);
  });

  it('says how many there are and how many of them it loaded', async () => {
    const loaded = [draft(), cleanDraft()];
    vi.stubGlobal('fetch', (async () => json(payload(loaded, 250))) as unknown as typeof fetch);
    render(<CreatorReviewQueue />);

    // The heading is the true number; the list is what it managed to read. A
    // heading of 2 next to a badge of 250 is the disagreement.
    expect(await screen.findByText('250 recipes are waiting for you')).toBeTruthy();
    expect(rows()).toHaveLength(2);
    expect(screen.getByTestId('queue-truncated').textContent).toMatch(/Showing the first 2\b/);
  });

  it('never claims fewer recipes than there are rows left to decide', async () => {
    // The count can only lag the list while a decision is in flight, and the
    // heading is the one that must not go quietly wrong when they disagree.
    const loaded = [draft(), cleanDraft(), cleanDraft('d3')];
    vi.stubGlobal('fetch', (async () => json(payload(loaded, 0))) as unknown as typeof fetch);
    render(<CreatorReviewQueue />);

    expect(await screen.findByText('3 recipes are waiting for you')).toBeTruthy();
  });

  it('says nothing about truncation when nothing was truncated', async () => {
    harness([draft(), cleanDraft()]);
    await screen.findAllByTestId('draft-row');
    expect(screen.getByText('2 recipes are waiting for you')).toBeTruthy();
    expect(screen.queryByTestId('queue-truncated')).toBeNull();
  });
});
