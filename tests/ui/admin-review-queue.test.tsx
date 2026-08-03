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
import { ALL_UNITS } from '@/lib/import/ingredients';
import { MAX_MEAL_TAGS } from '@/lib/import/vocab';
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

  it('hands a draft to the creator, and says where it lands', async () => {
    // The button was disabled while nothing read `review_by = 'creator'`:
    // pressing it moved the draft out of the only queue anybody read, and
    // `creator_source_items` said `imported` so no later sync brought the post
    // back. MEAL-89 built the far side, so it works — and the note has to say
    // where the draft goes, because an operator handing over a decision needs to
    // know whether they can change their mind.
    const { bodies } = harness([draft()], { post: { done: 1, published: [], emailsSent: 0, errors: [] } });

    await openFirstRow();
    const send = screen.getByTestId('send-to-creator') as HTMLButtonElement;
    expect(send.disabled).toBe(false);
    // Read before the click: acting closes the row, and the note is what tells
    // an operator the handoff is reversible *before* they make it.
    expect(screen.getByTestId('draft-actions-note').textContent).toMatch(/take back/i);
    fireEvent.click(send);

    await waitFor(() => expect(bodies.some((b) => b.method === 'POST')).toBe(true));
    expect(bodies.find((b) => b.method === 'POST')!.body).toMatchObject({ action: 'send-to-creator', ids: ['d1'] });
  });

  it('approves a selection in one request, so one creator gets one email', async () => {
    // The batching in `notifyApproved` groups by creator and sends one message
    // per batch. This screen only ever sent `ids: [id]`, so approving a 40-item
    // sync sent that creator 40 separate emails.
    const { bodies } = harness([draft(), cleanDraft()], {
      post: { done: 2, published: [{ id: 'meal-1', name: 'Best Guacamole' }, { id: 'meal-2', name: 'Black bean soup' }], emailsSent: 1, errors: [] },
    });

    const rows = await screen.findAllByTestId('draft-row');
    for (const row of rows) fireEvent.click(within(row).getByRole('checkbox'));
    fireEvent.click(await screen.findByRole('button', { name: /Approve & publish 2/ }));

    await waitFor(() => expect(bodies.some((b) => b.method === 'POST')).toBe(true));
    const posts = bodies.filter((b) => b.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toMatchObject({ action: 'approve', ids: ['d1', 'd2'], notifyCreator: true });
  });

  it('lists drafts handed over before the button was switched off, and takes one back', async () => {
    // Otherwise these rows are in no queue at all: out of the admin's by
    // `review_by`, and into one that was never built.
    const stranded = draft({ id: 'd9', reviewBy: 'creator' });
    const { bodies } = harness([], { post: { done: 1, published: [], emailsSent: 0, errors: [] } });
    void bodies;
    cleanup();

    const posted: Array<{ method: string; body: any }> = [];
    vi.stubGlobal('fetch', (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (init?.body) posted.push({ method, body: JSON.parse(String(init.body)) });
      if (method === 'GET') {
        const rendered = { ...stranded, summary: reviewDraft(stranded).summary, review: reviewDraft(stranded) };
        return json({ drafts: [], handedOver: [rendered], totals: { waiting: 0, flagged: 0, handedOver: 1 } });
      }
      return json({ done: 1, published: [], emailsSent: 0, errors: [] });
    }) as unknown as typeof fetch);
    render(<AdminReviewQueue />);

    const section = await screen.findByTestId('handed-over');
    // No longer "waiting on nobody": the creator's queue reads these rows now,
    // so the section says who it is waiting on and offers the way back.
    expect(section.textContent).toMatch(/waiting on their creator/i);
    fireEvent.click(within(section).getByRole('button', { name: 'Take it back' }));

    await waitFor(() => expect(posted.some((b) => b.method === 'POST')).toBe(true));
    expect(posted.find((b) => b.method === 'POST')!.body).toMatchObject({ action: 'reclaim', ids: ['d9'] });
  });

  it('delete declines it and says it will not come back', async () => {
    const { bodies } = harness();
    await openFirstRow();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(bodies.some((b) => b.method === 'POST')).toBe(true));
    expect(bodies.find((b) => b.method === 'POST')!.body).toMatchObject({ action: 'delete', ids: ['d1'] });
    expect(await screen.findByText(/will not be imported again/)).toBeTruthy();
  });

  it('does not congratulate the operator on a reclaim that was refused', async () => {
    // A per-draft failure comes back 200 with a populated `errors[]`. The notice
    // used to print regardless, so the screen said "That draft is already in your
    // queue." and "Back in your queue. It is yours to decide again." at once —
    // and the row is still there afterwards, so the operator clicks again.
    const stranded = draft({ id: 'd9', reviewBy: 'creator' });
    vi.stubGlobal('fetch', (async (_input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? 'GET') !== 'GET') {
        return json({ done: 0, published: [], emailsSent: 0, errors: ['That draft is already in your queue.'] });
      }
      const row = { ...stranded, summary: reviewDraft(stranded).summary, review: reviewDraft(stranded) };
      return json({ drafts: [], handedOver: [row], totals: { waiting: 0, flagged: 0, handedOver: 1 } });
    }) as unknown as typeof fetch);
    render(<AdminReviewQueue />);

    const section = await screen.findByTestId('handed-over');
    fireEvent.click(within(section).getByRole('button', { name: 'Take it back' }));

    expect(await screen.findByText('That draft is already in your queue.')).toBeTruthy();
    expect(screen.queryByText(/Back in your queue/)).toBeNull();
  });

  it('does not report a decline that declined nothing', async () => {
    const { bodies } = harness([draft()], { post: { done: 0, published: [], emailsSent: 0, errors: ['That draft no longer exists.'] } });
    await openFirstRow();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(bodies.some((b) => b.method === 'POST')).toBe(true));
    expect(await screen.findByText('That draft no longer exists.')).toBeTruthy();
    expect(screen.queryByText(/will not be imported again/)).toBeNull();
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

// ── Show every pending draft ─────────────────────────────────────────────────

/**
 * The escape hatch, from the operator's side.
 *
 * The default queue is narrow deliberately, and what that costs is a pending
 * draft in neither of its two queries — nothing shows it to anyone. The mode has
 * to be opt-in (a poller draft is the creator's work, not the operator's), so
 * the things worth asserting are that it is *reachable*, that the extra rows are
 * *labelled as extra*, and that turning it on does not quietly become the
 * normal view.
 */
describe('AdminReviewQueue — showing every pending draft', () => {
  const rendered = (row: ImportDraft) => ({ ...row, summary: reviewDraft(row).summary, review: reviewDraft(row) });

  /**
   * A stranded row as the route sends it: three strings and the id that takes it
   * back. Not a draft — there is no card to open in this list, so the recipe
   * body and the per-field assessment are kilobytes a row for nothing.
   */
  const strandedRow = (row: ImportDraft) => ({
    id: row.id,
    name: row.draft.name,
    sourceUrl: row.sourceUrl,
    creatorName: row.creatorName,
  });

  /** Serves the default payload until `?scope=all` is asked for, recording every URL. */
  function scopeHarness(
    unqueued: ImportDraft[],
    mine: ImportDraft[] = [],
    counts: { allPending?: number; truncated?: boolean; limit?: number } = {},
  ) {
    const urls: string[] = [];
    vi.stubGlobal('fetch', (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (method !== 'GET') return json({ done: 1, published: [], emailsSent: 0, errors: [] });
      urls.push(url);
      const all = url.includes('scope=all');
      return json({
        scope: all ? 'all' : 'default',
        drafts: mine.map(rendered),
        handedOver: [],
        unqueued: all ? unqueued.map(strandedRow) : [],
        totals: {
          waiting: mine.length, flagged: 0, handedOver: 0,
          allPending: all ? counts.allPending ?? mine.length + unqueued.length : null,
          unqueued: all ? unqueued.length : null,
          truncated: all ? counts.truncated ?? false : null,
          limit: all ? counts.limit ?? 500 : null,
        },
      });
    }) as unknown as typeof fetch);
    render(<AdminReviewQueue />);
    return { urls };
  }

  it('does not ask for every draft until an operator asks', async () => {
    const { urls } = scopeHarness([draft({ id: 'd9', reviewBy: 'creator' })]);

    await screen.findByTestId('toggle-scope');
    expect(urls).toHaveLength(1);
    expect(urls[0]).not.toMatch(/scope=all/);
    // The default view is unchanged: no banner, no extra section.
    expect(screen.queryByTestId('scope-banner')).toBeNull();
    expect(screen.queryByTestId('unqueued')).toBeNull();
  });

  it('reaches a draft that is in no queue, and says why it is on screen', async () => {
    // `review_by = 'creator'` with nothing that ever sent it there: the admin
    // query skips it, the handed-over query skips it, and the creator queue that
    // would show it was never built (MEAL-89).
    const stranded = draft({ id: 'd9', reviewBy: 'creator' });
    const { urls } = scopeHarness([stranded]);

    fireEvent.click(await screen.findByTestId('toggle-scope'));

    const section = await screen.findByTestId('unqueued');
    await waitFor(() => expect(urls.some((u) => u.includes('scope=all'))).toBe(true));
    expect(section.textContent).toMatch(/In their queue, never handed over \(1\)/);
    expect(section.textContent).toMatch(/Best Guacamole/);

    // The mode is named on screen, and so is the reason the extra row is there —
    // an operator must not mistake this for the queue having grown.
    const banner = screen.getByTestId('scope-banner');
    expect(banner.textContent).toMatch(/Showing every pending draft/);
    expect(banner.textContent).toMatch(/1 draft is on this screen only because this mode is on/);
  });

  it('claims completeness only from the count, not from the length of the page', async () => {
    // `allPending` is the database's own count over the same WHERE clause, so
    // this is the one sentence on the screen that can honestly say the list is
    // all of it.
    scopeHarness([draft({ id: 'd9', reviewBy: 'creator' })], [draft()], { allPending: 2, truncated: false });
    fireEvent.click(await screen.findByTestId('toggle-scope'));

    const banner = await screen.findByTestId('scope-banner');
    expect(banner.textContent).toMatch(/All 2 pending drafts are on this screen, so none of them is unreachable/);
  });

  it('stops promising completeness once the page is full', async () => {
    // The steady state this mode exists for: poller drafts accumulate and no
    // queue drains them, so a screen that says "nothing can be unreachable" over
    // the oldest 500 of 812 is telling an operator to stop looking for the 312
    // it cannot see.
    scopeHarness(
      [draft({ id: 'd9', reviewBy: 'creator' })],
      [],
      { allPending: 812, truncated: true, limit: 500 },
    );
    fireEvent.click(await screen.findByTestId('toggle-scope'));

    const banner = await screen.findByTestId('scope-banner');
    expect(banner.textContent).toMatch(/this page is full/);
    expect(banner.textContent).toMatch(/812 drafts are pending in all and these are the oldest 500/);
    expect(banner.textContent).toMatch(/as unreachable as they were before this mode existed/);
    // And it must not also carry the sentence that says the opposite.
    expect(banner.textContent).not.toMatch(/none of them is unreachable/);
  });

  it('does not describe a state the schema cannot produce', async () => {
    // `creator_id` is NOT NULL REFERENCES creators(id) ON DELETE CASCADE, so a
    // draft whose creator record "no longer resolves" cannot exist — an operator
    // reading an empty list was being told a check had come back clean when the
    // check could never find anything. The hazard that IS real gets said instead.
    scopeHarness([draft({ id: 'd9', reviewBy: 'creator' })]);
    fireEvent.click(await screen.findByTestId('toggle-scope'));

    const section = await screen.findByTestId('unqueued');
    expect(section.textContent).not.toMatch(/no longer resolves|creator record has since gone/);
    expect(section.textContent).toMatch(/Their creator can\s+see them; you cannot/);
    expect(screen.getByTestId('scope-banner').textContent).not.toMatch(/creator record/);
  });

  it('is honest when the escape hatch turns nothing up', async () => {
    scopeHarness([], [draft()]);
    fireEvent.click(await screen.findByTestId('toggle-scope'));

    const banner = await screen.findByTestId('scope-banner');
    expect(banner.textContent).toMatch(/There are none right now/);
    // No empty section pretending to be a finding.
    expect(screen.queryByTestId('unqueued')).toBeNull();
  });

  it('takes a stranded draft back into the queue that can decide it', async () => {
    const posted: Array<{ method: string; body: any }> = [];
    const stranded = draft({ id: 'd9', reviewBy: 'creator' });
    vi.stubGlobal('fetch', (async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (init?.body) posted.push({ method, body: JSON.parse(String(init.body)) });
      if (method !== 'GET') return json({ done: 1, published: [], emailsSent: 0, errors: [] });
      const all = String(input).includes('scope=all');
      return json({
        scope: all ? 'all' : 'default',
        drafts: [], handedOver: [], unqueued: all ? [strandedRow(stranded)] : [],
        totals: {
          waiting: 0, flagged: 0, handedOver: 0,
          allPending: all ? 1 : null, unqueued: all ? 1 : null,
          truncated: all ? false : null, limit: all ? 500 : null,
        },
      });
    }) as unknown as typeof fetch);
    render(<AdminReviewQueue />);

    fireEvent.click(await screen.findByTestId('toggle-scope'));
    const section = await screen.findByTestId('unqueued');
    fireEvent.click(within(section).getByRole('button', { name: 'Take it back' }));

    await waitFor(() => expect(posted.some((b) => b.method === 'POST')).toBe(true));
    expect(posted.find((b) => b.method === 'POST')!.body).toMatchObject({ action: 'reclaim', ids: ['d9'] });
  });

  it('drops the banner and the rows when the next read is refused', async () => {
    // The banner is a claim about the payload. Leaving it up beside a 403, over
    // rows from a response that is now arbitrarily old, is this screen making
    // exactly the kind of unsupported statement it exists to prevent.
    const stranded = draft({ id: 'd9', reviewBy: 'creator' });
    let forbidden = false;
    vi.stubGlobal('fetch', (async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (method !== 'GET') return json({ done: 1, published: [], emailsSent: 0, errors: [] });
      if (forbidden) return json({ error: 'Forbidden' }, 403);
      const all = String(input).includes('scope=all');
      return json({
        scope: all ? 'all' : 'default',
        drafts: [], handedOver: [], unqueued: all ? [strandedRow(stranded)] : [],
        totals: {
          waiting: 0, flagged: 0, handedOver: 0,
          allPending: all ? 1 : null, unqueued: all ? 1 : null,
          truncated: all ? false : null, limit: all ? 500 : null,
        },
      });
    }) as unknown as typeof fetch);
    render(<AdminReviewQueue />);

    fireEvent.click(await screen.findByTestId('toggle-scope'));
    await screen.findByTestId('unqueued');

    // The token expires between loads: the reload that follows an action is
    // refused, and nothing on screen may still be describing the old payload.
    forbidden = true;
    fireEvent.click(within(screen.getByTestId('unqueued')).getByRole('button', { name: 'Take it back' }));

    expect(await screen.findByText('Forbidden')).toBeTruthy();
    await waitFor(() => expect(screen.queryByTestId('scope-banner')).toBeNull());
    expect(screen.queryByTestId('unqueued')).toBeNull();
    expect(screen.getByTestId('toggle-scope').textContent).toMatch(/Show every pending draft/);
  });

  it('does not freeze the screen when the network drops under it', async () => {
    // `busy` gates approve, decline, edit, reclaim and this button. A rejected
    // fetch that skips `setBusy(false)` disables all of them until a reload, with
    // nothing on screen saying why.
    let offline = false;
    vi.stubGlobal('fetch', (async () => {
      if (offline) throw new TypeError('Failed to fetch');
      return json({
        scope: 'default', drafts: [], handedOver: [], unqueued: [],
        totals: { waiting: 0, flagged: 0, handedOver: 0, allPending: null, unqueued: null, truncated: null, limit: null },
      });
    }) as unknown as typeof fetch);
    render(<AdminReviewQueue />);

    const toggle = await screen.findByTestId('toggle-scope');
    offline = true;
    fireEvent.click(toggle);

    expect(await screen.findByText(/Check the connection/)).toBeTruthy();
    await waitFor(() => expect((screen.getByTestId('toggle-scope') as HTMLButtonElement).disabled).toBe(false));
  });

  it('goes back to the normal queue, and stops showing the extra rows', async () => {
    const { urls } = scopeHarness([draft({ id: 'd9', reviewBy: 'creator' })]);

    fireEvent.click(await screen.findByTestId('toggle-scope'));
    await screen.findByTestId('unqueued');

    fireEvent.click(screen.getByTestId('toggle-scope'));
    await waitFor(() => expect(screen.queryByTestId('unqueued')).toBeNull());
    expect(screen.queryByTestId('scope-banner')).toBeNull();
    expect(urls.at(-1)).not.toMatch(/scope=all/);
  });

  it('believes the response about which mode it is in, not the click', async () => {
    // A server that ignores the parameter must not leave the screen announcing a
    // mode it is not showing — the banner is a claim about the data on screen.
    vi.stubGlobal('fetch', (async () =>
      json({ scope: 'default', drafts: [], handedOver: [], unqueued: [], totals: { waiting: 0, flagged: 0, handedOver: 0, allPending: null, unqueued: null } })
    ) as unknown as typeof fetch);
    render(<AdminReviewQueue />);

    fireEvent.click(await screen.findByTestId('toggle-scope'));

    await waitFor(() => expect(screen.getByTestId('toggle-scope').textContent).toMatch(/Show every pending draft/));
    expect(screen.queryByTestId('scope-banner')).toBeNull();
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

  it('offers every unit the pipeline canonicalises to, not only the measured ones', async () => {
    // `DraftEditor` is shared with the creator's queue, so this list is checked
    // on both screens. It offered UNITS (11 measured units) while the pipeline
    // canonicalises to ALL_UNITS = UNITS + COOK_UNITS, which meant a `cloves`
    // row matched no option and the select fell back to "Qty" — a wrong measure
    // displayed on the screen whose job is catching wrong measures.
    harness();
    await openFirstRow();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));

    const editor = await screen.findByTestId('draft-editor');
    const options = [...(within(editor).getByLabelText('Ingredient 1 unit') as HTMLSelectElement).options]
      .map((option) => option.value);

    expect(options).toEqual(['qty', ...ALL_UNITS]);
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

  it('says so when the draft itself arrives over the cap', async () => {
    // The extraction prompt allows up to eight tags, so a stored draft can carry
    // more than the publish form takes. The editor opens on all of them and the
    // picker can only *stop* a fourth being added, so without this line the
    // operator's first sign of trouble is a 400 on Save.
    const overCap = draft({
      draft: { ...guacamole.draft, tags: ['Mexican', 'No Cook', 'Appetizer', 'Vegan', 'Healthy'] },
    });
    harness([overCap]);
    await openFirstRow();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));

    const note = await screen.findByTestId('tag-cap-note');
    expect(note.textContent).toMatch(/That is 5 tags\. A meal takes at most 3\./);
    expect(note.textContent).toMatch(/Deselect 2 before saving\./);

    // And it goes away once they are down to the cap.
    const picker = within(await screen.findByTestId('draft-editor')).getByTestId('tag-picker');
    fireEvent.click(within(picker).getByRole('button', { name: 'Vegan' }));
    fireEvent.click(within(picker).getByRole('button', { name: 'Healthy' }));
    await waitFor(() => expect(screen.queryByTestId('tag-cap-note')).toBeNull());
  });

  it('counts the tags the PATCH counts, not the strings on the row', async () => {
    // The note counted `form.tags` raw while the validator counts the
    // canonicalised list, so a draft carrying three in-vocabulary tags and two
    // the picker has no chip for read "That is 5 tags … Deselect 2" — an
    // instruction with nothing to click, about a Save that would have worked.
    const outOfVocab = draft({
      draft: { ...guacamole.draft, tags: ['Mexican', 'No Cook', 'Appetizer', 'Artisanal', 'Farm To Table'] },
    });
    harness([outOfVocab]);
    await openFirstRow();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    await screen.findByTestId('draft-editor');

    expect(screen.queryByTestId('tag-cap-note')).toBeNull();
  });

  it('shows the count against the cap, because a draft can arrive over it', async () => {
    // The model is asked for up to eight tags, so a picker that silently
    // refuses a fourth next to five already-lit chips reads as broken. The
    // number says which of the two is happening.
    harness();
    await openFirstRow();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const editor = await screen.findByTestId('draft-editor');

    expect(within(editor).getByText(`Tags (3 of ${MAX_MEAL_TAGS})`)).toBeTruthy();

    fireEvent.click(within(within(editor).getByTestId('tag-picker')).getByRole('button', { name: 'No Cook' }));
    expect(within(editor).getByText(`Tags (2 of ${MAX_MEAL_TAGS})`)).toBeTruthy();
  });
});
