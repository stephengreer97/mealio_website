// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import type { DuplicateMatch } from '@/lib/import/duplicates';
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
import { MEAL_TAGS } from '@/lib/import/vocab';
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
 *   7. **Two panes.** The meal on the left with none of our working in it, and
 *      what we read on the right — named for its field, in the card's order, and
 *      able to point at the line it is about.
 *   8. **A completed request is not a successful one.** A publish that failed
 *      and rolled back leaves the draft exactly where it was, so the row must
 *      not resolve — and the reason is something the editor fixes.
 *   9. **What would stop a publish is shown before Approve is pressed**, in the
 *      server's own words.
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
function payload(
  drafts: ImportDraft[],
  waiting = drafts.length,
  duplicates: Record<string, DuplicateMatch[]> = {},
) {
  const rows = drafts.map((row) => {
    const review = reviewDraft(row);
    return { ...row, summary: review.summary, review, duplicates: duplicates[row.id] ?? [] };
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

/** Every note in the right-hand pane, in the order it draws them. */
const comments = () => screen.queryAllByTestId('draft-comment');

/** The field a comment names — the bold lead before the em dash. */
const commentField = (comment: HTMLElement) =>
  (within(comment).getByTestId('import-notice').textContent ?? '').split(' — ')[0];

/** The comment about a named field. */
const commentFor = (field: string) =>
  comments().find((comment) => commentField(comment) === field) as HTMLElement;

/** A draft carrying more tags than a meal can be published with. */
function overTagged(id = 'd1'): ImportDraft {
  // Eight real tags, which is what the extractor was asked for before the cap
  // shipped and what the row in production actually holds.
  const tags = ['Mexican', 'No Cook', 'Appetizer', 'Snack', 'Vegan', 'Healthy', 'Party', 'Dinner']
    .filter((tag) => (MEAL_TAGS as readonly string[]).includes(tag));
  return draft({ id, draft: { ...guacamole.draft, tags } });
}

/** Routes the one endpoint the screen talks to, recording what it was asked. */
function harness(
  drafts: ImportDraft[] = [draft()],
  overrides: { post?: unknown; postStatus?: number; duplicates?: Record<string, DuplicateMatch[]> } = {},
) {
  const bodies: Array<{ method: string; body: any }> = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (init?.body) bodies.push({ method, body: JSON.parse(String(init.body)) });
    if (method === 'GET') return json(payload(drafts, drafts.length, overrides.duplicates));
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
    expect(labelled).toEqual(expect.arrayContaining(['Difficulty', 'Source']));
    expect(within(card).getByText('Measurements')).toBeTruthy();
    expect(within(card).getByText('Recipe')).toBeTruthy();
  });

  it('draws no slot for a field a published card would not have', async () => {
    // This changed with the two panes, and the change is the point. An empty
    // field used to keep a labelled slot on the card so the note under it had
    // something to belong to. The notes are not on the card any more, so the
    // reason is gone with them — and a preview that shows "Story: not filled in"
    // is not a preview of anything a saver will see. Serves and Story are both
    // empty on this fixture; what we could not fill in is said on the right.
    harness();
    const card = await screen.findByTestId('draft-card');

    expect(Array.from(card.querySelectorAll('dt')).map((dt) => dt.textContent)).not.toContain('Serves');
    expect(within(card).queryByText('Story')).toBeNull();
    expect(card.textContent).not.toContain('Not filled in');

    const named = comments().map(commentField);
    expect(named).toContain('Serves');
    expect(named).toContain('Story');
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

// ── The two panes ────────────────────────────────────────────────────────────

describe('the meal on one side, what we read on the other', () => {
  it('keeps every bit of the import apparatus out of the preview', async () => {
    // The question the preview is there to answer is "is this the recipe I want
    // on Discover under my name", and it was being asked about a card no saver
    // will ever see: a field notice under the photo, a reason under Serves, "we
    // read: …" under most of the ingredient rows.
    harness();
    const card = await screen.findByTestId('draft-card');

    expect(within(card).queryAllByTestId('import-notice')).toHaveLength(0);
    expect(within(card).queryAllByTestId('evidence-toggle')).toHaveLength(0);
    expect(within(card).queryAllByTestId('evidence')).toHaveLength(0);
    expect(card.textContent).not.toMatch(/we read/i);
    expect(card.textContent).not.toMatch(/could not confirm|couldn’t find/i);
    // And it is still the meal: the same component Discover renders.
    expect(card.textContent).toMatch(/avocado/i);
  });

  it('moves every notice to the pane beside it, and loses none of them', async () => {
    harness();
    await screen.findByTestId('draft-card');

    const pane = screen.getByTestId('draft-comments');
    const notices = screen.getAllByTestId('import-notice');
    // Every one of them, and all of them in the one place.
    expect(notices.length).toBeGreaterThan(0);
    for (const notice of notices) expect(pane.contains(notice)).toBe(true);
    // One comment per flagged field, which is what the row's badge counts.
    const badge = within(rowFor('Best Guacamole')).getByTestId('flag-badge').textContent ?? '';
    expect(comments()).toHaveLength(Number(/(\d+) to check/.exec(badge)?.[1] ?? 0));
  });

  it('names the field every comment is about, and names an ingredient for itself', async () => {
    // The reader is matching two columns by eye. A comment that does not say
    // what it is about is a sentence about the recipe in general.
    harness();
    await screen.findByTestId('draft-card');

    const named = comments().map(commentField);
    expect(named.every((field) => field.length > 0)).toBe(true);
    // Named in the words the card labels the field with, not in ours.
    expect(named).toContain('Recipe instructions');
    // An ingredient comment is named for its ingredient — "Measurements" twelve
    // times over would name nothing.
    expect(named).toContain('smoked paprika');
  });

  it('draws the comments in the order the card draws the fields', async () => {
    // The cheapest of the three ties, and the one that works while the reader is
    // scrolling rather than clicking.
    harness();
    await screen.findByTestId('draft-card');

    const named = comments().map(commentField);
    const recipe = named.indexOf('Recipe instructions');
    const paprika = named.indexOf('smoked paprika');
    expect(paprika).toBeGreaterThan(-1);
    // Measurements come before the recipe on the card, so they do here.
    expect(recipe).toBeGreaterThan(paprika);
  });

  it('lets a comment point at the line it is about', async () => {
    // Naming and ordering stop working at exactly the point this screen gets
    // hard: a long recipe where "smoked paprika" is one of twelve lines and
    // counting is the reader's job.
    harness();
    const card = await screen.findByTestId('draft-card');
    const comment = commentFor('smoked paprika');

    const jump = within(comment).getByTestId('comment-jump');
    const targetId = jump.getAttribute('aria-controls')!;
    const target = document.getElementById(targetId) as HTMLElement;

    // It points at something real, on the card, and at the right something.
    expect(target).toBeTruthy();
    expect(card.contains(target)).toBe(true);
    expect(target.textContent).toMatch(/smoked paprika/i);

    // Nothing is ringed until it is asked for.
    expect(card.querySelectorAll('[data-focused="true"]')).toHaveLength(0);
    fireEvent.click(jump);

    expect(target.getAttribute('data-focused')).toBe('true');
    // And the comment says it is the one doing the pointing, so the pairing
    // reads from either end.
    expect(comment.getAttribute('data-active')).toBe('true');
    // Only ever one at a time.
    expect(card.querySelectorAll('[data-focused="true"]')).toHaveLength(1);

    fireEvent.click(within(comment).getByTestId('comment-jump'));
    expect(card.querySelectorAll('[data-focused="true"]')).toHaveLength(0);
  });

  it('offers nothing to point at when the card has no such field', async () => {
    // Serves is empty on this fixture — the page's only yield is a volume — so
    // the published card will not have it. A link to an empty slot is a link to
    // nothing, and the comment already says why the field is missing.
    harness();
    await screen.findByTestId('draft-card');

    const serves = commentFor('Serves');
    expect(within(serves).queryByTestId('comment-jump')).toBeNull();
    expect(within(serves).getByTestId('comment-absent').textContent).toMatch(/not on the card/i);
  });

  it('says the pane is empty rather than drawing an empty pane', async () => {
    harness([cleanDraft('d1')]);
    await screen.findByTestId('draft-card');

    expect(comments()).toHaveLength(0);
    expect(screen.getByTestId('comments-summary').textContent).toMatch(/matched the page we read/i);
  });
});

// ── What would stop it publishing ────────────────────────────────────────────

describe('a draft that cannot be published says so before Approve is pressed', () => {
  it('names what would stop it, in the words the server would use', async () => {
    // The real row: eight tags, written before the cap shipped. The only way to
    // find out used to be pressing Approve and having it fail.
    harness([overTagged()]);
    await screen.findByTestId('draft-card');

    const blockers = screen.getAllByTestId('publish-blocker');
    expect(blockers).toHaveLength(1);
    expect(blockers[0].getAttribute('data-field')).toBe('tags');
    // `tagCapError`'s own sentence, not a paraphrase of it.
    expect(blockers[0].textContent).toContain('A meal takes at most 3.');
  });

  it('turns Approve off rather than letting it fail', async () => {
    const { bodies } = harness([overTagged()]);
    await screen.findByTestId('draft-card');

    const approve = screen.getByRole('button', { name: /Approve & publish/ }) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    fireEvent.click(approve);

    expect(bodies.some((b) => b.method === 'POST')).toBe(false);
    expect(screen.getByTestId('approve-blocked-note').textContent).toMatch(/until the thing above is fixed/i);
  });

  it('offers the one screen that can fix it', async () => {
    harness([overTagged()]);
    await screen.findByTestId('draft-card');

    fireEvent.click(screen.getByRole('button', { name: 'Fix it now' }));
    expect(await screen.findByTestId('draft-editor')).toBeTruthy();
  });

  it('says nothing at all about a draft that would publish', async () => {
    harness();
    await screen.findByTestId('draft-card');

    expect(screen.queryByTestId('publish-blockers')).toBeNull();
    expect((screen.getByRole('button', { name: /Approve & publish/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('catches a Serves that is not a head count', async () => {
    // The other rule `publishCreatorMeal` throws on, and the one the guacamole
    // page is the standing example of.
    harness([draft({ draft: { ...guacamole.draft, serves: '2 1/2 cups' } })]);
    await screen.findByTestId('draft-card');

    expect(screen.getByTestId('publish-blocker').getAttribute('data-field')).toBe('serves');
    expect(screen.getByTestId('publish-blocker').textContent).toContain('Serves must be a number or a range');
  });
});

// ── A decision that did not happen ───────────────────────────────────────────

describe('a refused decision is not a decision', () => {
  /** What the route returns when publishing threw and `approveDraft` rolled it back. */
  const rolledBack = {
    done: 0,
    published: [],
    errors: ['Publishing failed: That is 8 tags. A meal takes at most 3.'],
    stillPending: ['d1'],
    waiting: 1,
  };

  it('leaves the row undecided when the publish failed', async () => {
    // The bug, exactly: the row went to "Already decided" and locked. Approve,
    // Edit and Decline all went with it, and the only way back was a database
    // edit — while the row in the database was still `pending_review`, which is
    // correct. It is only this screen that believed a completed request.
    harness([draft()], { post: rolledBack });
    await screen.findByTestId('draft-card');

    fireEvent.click(screen.getByRole('button', { name: /Approve & publish/ }));

    await waitFor(() => expect(screen.getByTestId('draft-failed')).toBeTruthy());
    expect(screen.getByTestId('draft-row').getAttribute('data-decided')).toBeNull();
    expect(screen.queryByTestId('draft-resolved')).toBeNull();
    // Still one row, still waiting on them.
    expect(screen.getByText('A recipe is waiting for you')).toBeTruthy();
  });

  it('says why, where they are looking', async () => {
    harness([draft(), cleanDraft()], { post: rolledBack });
    await screen.findAllByTestId('draft-row');
    await open('Best Guacamole');

    fireEvent.click(screen.getByRole('button', { name: /Approve & publish/ }));

    // On the row it is about, not in a banner at the top of a list of ten.
    const failed = await within(rowFor('Best Guacamole')).findByTestId('draft-failed');
    expect(failed.textContent).toContain('That is 8 tags. A meal takes at most 3.');
    expect(failed.textContent).toMatch(/nothing has changed/i);
  });

  it('opens the editor on it, because that is what fixes every one of these', async () => {
    harness([draft()], { post: rolledBack });
    await screen.findByTestId('draft-card');

    fireEvent.click(screen.getByRole('button', { name: /Approve & publish/ }));

    expect(await screen.findByTestId('draft-editor')).toBeTruthy();
  });

  it('gives the buttons back, so a fixed draft can be approved again', async () => {
    const { bodies } = harness([draft()], { post: rolledBack });
    await screen.findByTestId('draft-card');
    fireEvent.click(screen.getByRole('button', { name: /Approve & publish/ }));
    await screen.findByTestId('draft-editor');

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    // Everything it had before the failure, on the same row.
    await screen.findByTestId('draft-card');
    fireEvent.click(screen.getByRole('button', { name: /Approve & publish/ }));
    await waitFor(() => expect(bodies.filter((b) => b.method === 'POST')).toHaveLength(2));
  });

  it('does not resolve a refused decline either', async () => {
    harness([draft()], {
      post: { done: 0, published: [], errors: ['That draft no longer exists.'], stillPending: ['d1'], waiting: 1 },
    });
    await screen.findByTestId('draft-card');

    fireEvent.click(screen.getByRole('button', { name: /Not this one/ }));

    await waitFor(() => expect(screen.getByTestId('draft-failed')).toBeTruthy());
    expect(screen.getByTestId('draft-row').getAttribute('data-decided')).toBeNull();
  });

  it('drops the reason once the edit that fixes it is saved', async () => {
    // Otherwise "that is 8 tags" sits beside a draft carrying three.
    harness([draft()], { post: rolledBack });
    await screen.findByTestId('draft-card');
    fireEvent.click(screen.getByRole('button', { name: /Approve & publish/ }));
    await screen.findByTestId('draft-editor');

    fireEvent.click(screen.getByRole('button', { name: 'Save edits' }));

    await waitFor(() => expect(screen.queryByTestId('draft-failed')).toBeNull());
  });

  it('still resolves a draft that really was decided in another tab', async () => {
    // The distinction, from the other side. `stillPending` is empty because the
    // row is not pending any more: the conditional write did its job and exactly
    // one publish happened. This one *is* decided, and pretending otherwise
    // would offer an editor for a draft that is already on Discover.
    harness([draft()], {
      post: { done: 0, published: [], errors: ['That draft was already approved.'], stillPending: [], waiting: 0 },
    });
    await screen.findByTestId('draft-card');

    fireEvent.click(screen.getByRole('button', { name: /Approve & publish/ }));

    await waitFor(() =>
      expect(screen.getByTestId('draft-row').getAttribute('data-decided')).toBe('declined'));
    expect(screen.queryByTestId('draft-editor')).toBeNull();
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

describe('a draft that repeats one already published', () => {
  const repeat: Record<string, DuplicateMatch[]> = {
    d1: [{ id: 'live-1', name: 'Best Guacamole', kind: 'published', overlap: 0.91, sameTitle: false }],
  };

  it('says so on the collapsed row, before anything is opened', async () => {
    // A different kind of problem from the field flags beside it: those say
    // "check this value", this says "you may already have this recipe", and the
    // second is answered by looking somewhere else entirely.
    harness([draft()], { duplicates: repeat });

    expect(await screen.findByTestId('duplicate-badge')).toBeTruthy();
  });

  it('names what it collides with once opened', async () => {
    // One waiting draft opens itself — there is nothing to choose between — so
    // this reads the open pane rather than clicking, which would close it.
    harness([draft()], { duplicates: repeat });
    await screen.findByTestId('draft-card');

    const notice = screen.getByTestId('duplicate-notice');
    expect(notice.textContent).toMatch(/Best Guacamole/);
    expect(notice.textContent).toMatch(/already published/);
  });

  it('shows nothing at all for the ordinary draft', async () => {
    // Almost every draft. A badge on all of them would be furniture.
    harness();
    // Wait for the queue to draw before asserting an absence.
    await screen.findAllByTestId('draft-row');

    expect(screen.queryByTestId('duplicate-badge')).toBeNull();
  });
});
