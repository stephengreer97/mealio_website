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

import AdminReviewQueue from '@/components/AdminReviewQueue';
import { reviewDraft, type ImportDraft } from '@/lib/import-drafts';
import { importedGuacamole } from '../helpers/import-ui-fixtures';

/**
 * The admin review queue screen (MEAL-91).
 *
 * Three things are worth testing here, and they are the three the ticket is
 * about:
 *
 *   1. The row opens into **the meal card a saver would see** — the ingredients
 *      and the recipe, not a JSON dump. "Would I put my name on this?" is not
 *      answerable from a field list.
 *   2. **Exceptions only.** A field that verified says nothing; a flagged one
 *      carries its reason and the span we read. Silence is the signal, and a
 *      note on all nine fields would destroy it.
 *   3. Clean drafts are **visibly separate** from flagged ones, so an operator
 *      can see where the work is without opening anything.
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
    syncRunId: 'r1',
    draft: guacamole.draft,
    confidence: guacamole.confidence,
    status: 'pending_review',
    reviewBy: 'admin',
    editedAt: null,
    decidedAt: null,
    decidedBy: null,
    publishedMealId: null,
    createdAt: '2026-08-02T10:00:00.000Z',
    ...overrides,
  };
}

/** A draft whose every field verified against the source. */
function cleanDraft(): ImportDraft {
  const green = guacamole.confidence.name;
  const confidence: ImportConfidence = {
    name: green, recipe: green, story: green, photoUrl: green,
    difficulty: green, tags: green, serves: green,
    ingredients: guacamole.confidence.ingredients.map(() => green),
  };
  const body: CreatorMealDraft = { ...guacamole.draft, name: 'Black bean soup', story: 'A weeknight staple.', serves: '4' };
  return draft({ id: 'd2', draft: body, confidence, createdAt: '2026-08-01T00:00:00.000Z' });
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
    return json(overrides.post ?? { done: 1, published: [{ id: 'meal-1', name: 'Best Guacamole' }], emailsSent: 1, errors: [] }, overrides.postStatus ?? 200);
  }) as unknown as typeof fetch;

  vi.stubGlobal('fetch', impl);
  const view = render(<AdminReviewQueue />);
  return { view, bodies };
}

/** Opens the first row of a group, returning the card. */
async function openFirstRow() {
  const rows = await screen.findAllByTestId('draft-row');
  fireEvent.click(within(rows[0]).getByRole('button'));
  return screen.findByTestId('draft-card');
}

beforeEach(async () => {
  localStorage.setItem('accessToken', 'test-token');
  guacamole = await importedGuacamole();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

// ── The queue ────────────────────────────────────────────────────────────────

describe('AdminReviewQueue — what is waiting', () => {
  it('says nothing is live, and how much of it needs attention', async () => {
    harness([draft(), cleanDraft()]);
    const totals = await screen.findByTestId('queue-totals');
    expect(totals.textContent).toMatch(/2 recipes/);
    expect(totals.textContent).toMatch(/not live/);
    expect(totals.textContent).toMatch(/1 with something flagged/);
  });

  it('separates the flagged from the clean, flagged first', async () => {
    harness([draft(), cleanDraft()]);
    await screen.findByText(/Needs a look \(1\)/);
    expect(screen.getByText(/Verified clean \(1\)/)).toBeTruthy();

    const badges = screen.getAllByTestId('flag-badge');
    // The order on screen is the order the queue hands back — most flagged
    // first, so where the work is does not have to be hunted for.
    expect(badges[0].textContent).toMatch(/to check/);
    expect(badges[1].textContent).toBe('all verified');
  });

  it('says so plainly when there is nothing waiting', async () => {
    harness([]);
    const totals = await screen.findByTestId('queue-totals');
    expect(totals.textContent).toMatch(/Nothing is waiting/);
    expect(screen.queryByTestId('draft-row')).toBeNull();
  });
});

// ── The card ─────────────────────────────────────────────────────────────────

describe('AdminReviewQueue — the meal card', () => {
  it('opens into the recipe itself, not a field list', async () => {
    harness();
    const card = await openFirstRow();

    // The measurements and the method a saver would read, rendered by the same
    // component Discover renders.
    expect(within(card).getByText('Measurements')).toBeTruthy();
    expect(within(card).getByText(/avocados, 4/)).toBeTruthy();
    expect(within(card).getByText('Recipe')).toBeTruthy();
    expect(within(card).getByText(/Scoop the avocados into a bowl/)).toBeTruthy();
    // And whose name it would go out under.
    expect(within(card).getByText('by Chef Sarah')).toBeTruthy();
  });

  it('calls out only the flagged fields, and quotes what we read', async () => {
    harness();
    const card = await openFirstRow();

    const notices = within(card).getAllByTestId('import-notice');
    const kinds = notices.map((n) => n.getAttribute('data-kind'));

    // The fixture puts a deliberate hallucination in the ingredient list; it has
    // to come back as something the operator is told to check.
    expect(kinds).toContain('unverified');
    // A restated value quotes the span it came from instead of explaining itself.
    expect(kinds).toContain('adjusted');
    // Two fields the page simply did not have.
    expect(kinds.filter((k) => k === 'absent').length).toBeGreaterThan(0);

    // Silence is the signal: strictly fewer notices than fields on the card.
    const rows = await screen.findAllByTestId('draft-row');
    const summary = within(rows[0]).getByTestId('draft-summary');
    expect(notices).toHaveLength(Number(summary.textContent!.match(/(\d+) needs? a look/)![1]));
  });

  it('says nothing at all about a draft that verified clean', async () => {
    harness([cleanDraft()]);
    const card = await openFirstRow();
    expect(within(card).queryAllByTestId('import-notice')).toHaveLength(0);
    expect(screen.getByTestId('draft-summary').textContent).toMatch(/fields verified/);
  });

  it('offers all four decisions, and a way back to the page we read', async () => {
    harness();
    await openFirstRow();
    expect(screen.getByRole('button', { name: /Approve & publish/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Send to creator' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Edit' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open the source page' }).getAttribute('href'))
      .toBe('https://chefsarah.test/guacamole');
  });
});

// ── The decisions ────────────────────────────────────────────────────────────

describe('AdminReviewQueue — deciding', () => {
  it('approve posts the approval and reports what went live', async () => {
    const { bodies } = harness();
    await openFirstRow();
    fireEvent.click(screen.getByRole('button', { name: /Approve & publish/ }));

    await waitFor(() => expect(bodies.some((b) => b.method === 'POST')).toBe(true));
    expect(bodies.find((b) => b.method === 'POST')!.body)
      .toMatchObject({ action: 'approve', ids: ['d1'], notifyCreator: true });
    expect(await screen.findByText(/Published Best Guacamole/)).toBeTruthy();
  });

  it('the notify checkbox defaults to on and its choice reaches the request', async () => {
    // Default on, and turning it off is the deliberate act: a creator who hears
    // from a follower that recipes went live under their name is the failure.
    const { bodies } = harness();
    const box = await screen.findByRole('checkbox', { name: /Email the creator/ });
    expect((box as HTMLInputElement).checked).toBe(true);

    fireEvent.click(box);
    await openFirstRow();
    fireEvent.click(screen.getByRole('button', { name: /Approve & publish/ }));

    await waitFor(() => expect(bodies.some((b) => b.method === 'POST')).toBe(true));
    expect(bodies.find((b) => b.method === 'POST')!.body.notifyCreator).toBe(false);
  });

  it('send to creator hands the decision over and says so', async () => {
    const { bodies } = harness([], { post: { done: 1, published: [], emailsSent: 0, errors: [] } });
    cleanup();
    const { bodies: sent } = harness([draft()], { post: { done: 1, published: [], emailsSent: 0, errors: [] } });

    await openFirstRow();
    fireEvent.click(screen.getByRole('button', { name: 'Send to creator' }));

    await waitFor(() => expect(sent.some((b) => b.method === 'POST')).toBe(true));
    expect(sent.find((b) => b.method === 'POST')!.body).toMatchObject({ action: 'send-to-creator', ids: ['d1'] });
    // Nothing published, so nothing is announced as live.
    expect(await screen.findByText(/Handed to the creator/)).toBeTruthy();
    expect(screen.queryByText(/Published/)).toBeNull();
    expect(bodies).toHaveLength(0);
  });

  it('delete declines it and says it will not come back', async () => {
    const { bodies } = harness();
    await openFirstRow();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(bodies.some((b) => b.method === 'POST')).toBe(true));
    expect(bodies.find((b) => b.method === 'POST')!.body).toMatchObject({ action: 'delete', ids: ['d1'] });
    expect(await screen.findByText(/will not be imported again/)).toBeTruthy();
  });

  it('surfaces a refusal rather than pretending the decision landed', async () => {
    harness([draft()], { post: { error: 'That draft was already approved.' }, postStatus: 400 });
    await openFirstRow();
    fireEvent.click(screen.getByRole('button', { name: /Approve & publish/ }));

    expect(await screen.findByText('That draft was already approved.')).toBeTruthy();
    // And the draft stays on screen: an operator whose approval was refused
    // still has one to decide.
    expect(screen.getAllByTestId('draft-row')).toHaveLength(1);
  });
});

// ── Edit ─────────────────────────────────────────────────────────────────────

describe('AdminReviewQueue — editing', () => {
  it('opens the publish form pre-filled, so a wrong measure is a fix', async () => {
    harness();
    await openFirstRow();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));

    const editor = await screen.findByTestId('draft-editor');
    expect((within(editor).getByLabelText('Meal name') as HTMLInputElement).value).toBe('Best Guacamole');
    // Every ingredient row is there to correct, not to retype.
    expect((within(editor).getByLabelText('Ingredient 1 name') as HTMLInputElement).value).toBe('avocados');
    expect((within(editor).getByLabelText('Ingredient 2 amount') as HTMLInputElement).value).toBe('3');
    expect((within(editor).getByLabelText('Ingredient 2 unit') as HTMLSelectElement).value).toBe('tbsp');
  });

  it('saves the edit without publishing it', async () => {
    const { bodies } = harness();
    await openFirstRow();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));

    const editor = await screen.findByTestId('draft-editor');
    fireEvent.change(within(editor).getByLabelText('Ingredient 2 amount'), { target: { value: '2' } });
    fireEvent.click(within(editor).getByRole('button', { name: 'Save edits' }));

    await waitFor(() => expect(bodies.some((b) => b.method === 'PATCH')).toBe(true));
    const patch = bodies.find((b) => b.method === 'PATCH')!.body;
    expect(patch.id).toBe('d1');
    expect(patch.draft.ingredients[1].measure).toBe('2');
    // Correcting a measure is not the same as saying the recipe is right.
    expect(bodies.some((b) => b.method === 'POST')).toBe(false);
    expect(await screen.findByText(/still waiting on you/)).toBeTruthy();
  });

  it('caps tags at the three the publish form accepts', async () => {
    harness();
    await openFirstRow();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const editor = await screen.findByTestId('draft-editor');

    const picker = within(editor).getByTestId('tag-picker');
    const chosen = () => new Set(
      within(picker).getAllByRole('button')
        .filter((button) => (button.getAttribute('style') ?? '').includes('rgb(221, 0, 49)'))
        .map((button) => button.textContent),
    );

    // The fixture already carries three. A fourth is refused here rather than
    // accepted and then silently dropped on save.
    expect(chosen()).toEqual(new Set(['Mexican', 'No Cook', 'Appetizer']));
    fireEvent.click(within(picker).getByRole('button', { name: 'Italian' }));
    expect(chosen()).toEqual(new Set(['Mexican', 'No Cook', 'Appetizer']));

    // Dropping one makes room again — the cap is a cap, not a freeze.
    fireEvent.click(within(picker).getByRole('button', { name: 'No Cook' }));
    fireEvent.click(within(picker).getByRole('button', { name: 'Italian' }));
    expect(chosen()).toEqual(new Set(['Mexican', 'Appetizer', 'Italian']));
  });
});
