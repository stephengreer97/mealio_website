import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeDb } from '../helpers/supabase-mock';
import { jsonRequest } from '../helpers/request';
import { importedGuacamole } from '../helpers/import-ui-fixtures';
import type { ImportSuccess } from '@/lib/import/types';

vi.mock('@/lib/supabase', async () =>
  (await import('../helpers/supabase-mock')).mockSupabaseModule());
vi.mock('@/lib/logger', () => ({ log: vi.fn() }));

const revalidateTag = vi.fn();
vi.mock('next/cache', () => ({ revalidateTag: (...args: unknown[]) => revalidateTag(...args) }));

/**
 * Mocked at the module boundary rather than injected, because the point of
 * these tests is what the *route* reaches for. A guard that returns 403 while
 * the publish has already happened is the failure mode being tested against,
 * and it is only visible from out here.
 */
const publishCreatorMeal = vi.fn();
// Publishing only. `releaseImportedItem` is left real: it writes to the same
// fake database these tests already read, and stubbing it would hide the
// decline's bookkeeping from the very tests that check a decline writes no
// delete.
vi.mock('@/lib/creator-meals', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/creator-meals')>()),
  publishCreatorMeal: (...args: unknown[]) => publishCreatorMeal(...args),
}));

const sendCreatorSyncPublishedEmail = vi.fn();
vi.mock('@/lib/email', () => ({
  sendCreatorSyncPublishedEmail: (...args: unknown[]) => sendCreatorSyncPublishedEmail(...args),
}));

import { GET, PATCH, POST } from '@/app/api/creator/import-drafts/route';
import { clearRevocationCache, createAccessToken } from '@/lib/tokens';

/**
 * The HTTP surface of the creator's own review queue (MEAL-89).
 *
 * Two shipped features write into this queue — `sendDraftToCreator` and the
 * poller — and until this route existed neither had a reader. So the tests here
 * are about the four rules the ticket turns on:
 *
 *   1. A creator sees **their own** drafts and can decide only those.
 *   2. Approving twice publishes **once**.
 *   3. Declining **marks**, never deletes, or the next poll asks again.
 *   4. There is no "approve all" — the server refuses a batched approve even
 *      though no button in the product sends one.
 *
 * Every assertion is on persisted state rather than on call arguments: the
 * fake Supabase stores rows and evaluates predicates, so "the second approve
 * matched no row" is a fact about the table and not about what was passed.
 */

let guacamole: ImportSuccess;
let token: string;

/** Signs the request in as `u1`, who is Chef Sarah (creator `c1`). */
function asCreator(row: Record<string, unknown> | null = { id: 'c1', display_name: 'Chef Sarah', user_id: 'u1' }) {
  clearRevocationCache();
  fakeDb.queue('user_profiles', { data: { tokens_invalidated_at: null } });
  if (row) fakeDb.seed('creators', [row]);
  else fakeDb.seed('creators', []);
}

function draftRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'd1',
    creator_id: 'c1',
    source_url: 'https://chefsarah.test/guacamole',
    source: 'website',
    item_id: 'guid-1',
    sync_run_id: null,
    draft: guacamole.draft,
    confidence: guacamole.confidence,
    status: 'pending_review',
    review_by: 'creator',
    edited_at: null,
    decided_at: null,
    decided_by: null,
    published_meal_id: null,
    created_at: '2026-08-02T10:00:00.000Z',
    creators: { id: 'c1', display_name: 'Chef Sarah', user_id: 'u1', user_profiles: { email: 'sarah@chefsarah.test' } },
    ...overrides,
  };
}

beforeEach(async () => {
  fakeDb.reset();
  publishCreatorMeal.mockReset();
  publishCreatorMeal.mockResolvedValue({ id: 'meal-1', name: 'Best Guacamole' });
  sendCreatorSyncPublishedEmail.mockReset();
  revalidateTag.mockReset();
  guacamole = await importedGuacamole();
  token = await createAccessToken('u1', 'sarah@chefsarah.test');
});

// ── Reading the queue ────────────────────────────────────────────────────────

describe('GET — what is waiting on this creator', () => {
  it('returns their pending drafts, rendered', async () => {
    asCreator();
    fakeDb.seed('creator_import_drafts', [draftRow()]);

    const res = await GET(jsonRequest('/api/creator/import-drafts', { method: 'GET', token }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.drafts).toHaveLength(1);
    // The callouts come rendered from `lib/import/draft-form.ts` rather than
    // being recomputed on the client, which is also what lets the app show the
    // same queue without shipping the confidence model to a phone.
    expect(body.drafts[0].review.summary.total).toBeGreaterThan(0);
    expect(body.totals.waiting).toBe(1);
  });

  it('sends the callouts already worded, so a phone never has to derive them', async () => {
    // The web queue could call `noticesFor` and `summaryLine` itself — same
    // bundle. The app cannot, without a port of the exceptions rules living in
    // a second repository and drifting behind whatever version a creator has
    // installed. Sending the sentences is what stops the phone and the browser
    // disagreeing about which fields were verified.
    asCreator();
    fakeDb.seed('creator_import_drafts', [draftRow()]);

    const body = await (await GET(jsonRequest('/api/creator/import-drafts', { method: 'GET', token }))).json();
    const review = body.drafts[0].review;

    expect(review.summaryText).toMatch(/verified/);
    // Exceptions only: a flagged field carries a notice, a verified one is null.
    const scalars = ['name', 'recipe', 'story', 'photoUrl', 'difficulty', 'tags', 'serves'];
    const called = scalars.filter((f) => review.notices[f]).length
      + review.notices.ingredients.filter(Boolean).length;
    expect(called).toBe(review.summary.needALook);
  });

  it('never returns another creator’s drafts', async () => {
    // `review_by = 'creator'` is true of every poller draft in the table, for
    // every creator. Scoping on it alone would hand this creator the whole
    // platform's unpublished recipes with Approve underneath them.
    asCreator();
    fakeDb.seed('creator_import_drafts', [
      draftRow(),
      draftRow({ id: 'd2', creator_id: 'c2' }),
    ]);

    const body = await (await GET(jsonRequest('/api/creator/import-drafts', { method: 'GET', token }))).json();

    expect(body.drafts.map((d: { id: string }) => d.id)).toEqual(['d1']);
    expect(body.totals.waiting).toBe(1);
  });

  it('does not count a draft an operator is still holding', async () => {
    // `review_by = 'admin'` is waiting on an operator, not on the creator. A
    // badge that counted it would send them to a queue with nothing in it.
    asCreator();
    fakeDb.seed('creator_import_drafts', [draftRow({ review_by: 'admin' })]);

    const body = await (await GET(jsonRequest('/api/creator/import-drafts?count=1', { method: 'GET', token }))).json();
    expect(body.waiting).toBe(0);
  });

  it('answers a count without reading the recipes', async () => {
    asCreator();
    fakeDb.seed('creator_import_drafts', [draftRow(), draftRow({ id: 'd2' })]);

    const res = await GET(jsonRequest('/api/creator/import-drafts?count=1', { method: 'GET', token }));
    const body = await res.json();

    expect(body.waiting).toBe(2);
    // The badge fires on every page load and every app foreground; the drafts
    // are jsonb recipes and have no business crossing the wire to make a number.
    expect(body.drafts).toBeUndefined();
    const select = fakeDb.calls.find((c) => c.table === 'creator_import_drafts' && c.method === 'select');
    expect(select?.args[1]).toMatchObject({ head: true, count: 'exact' });
  });

  it('carries `waiting` on the full read too, not only on `?count=1`', async () => {
    // The mirror of the bug the count shape was fixed for. A non-creator got
    // `{waiting: 0, …}` and a creator got no top-level `waiting` at all, so a
    // caller reading `data.waiting` off the full GET saw `undefined` for
    // precisely the people who have a queue — and a badge that updates on
    // `typeof waiting === 'number'` kept whatever it had.
    asCreator();
    fakeDb.seed('creator_import_drafts', [draftRow(), draftRow({ id: 'd2' })]);

    const body = await (await GET(jsonRequest('/api/creator/import-drafts', { method: 'GET', token }))).json();

    expect(body.waiting).toBe(2);
    expect(body.totals).toMatchObject({ waiting: 2, showing: 2 });
  });

  it('counts what is waiting rather than measuring the page it returned', async () => {
    // `listDraftQueue` reads at most 200 rows and `countPendingDrafts` counts
    // all of them. Both clients badged from the list, so a creator with more
    // than 200 pending watched the badge fall to 200 the moment they opened the
    // queue — with nothing decided — and jump back up on the next decision.
    asCreator();
    fakeDb.seed(
      'creator_import_drafts',
      Array.from({ length: 205 }, (_, i) => draftRow({ id: `d${i}`, created_at: `2026-08-02T10:${String(i % 60).padStart(2, '0')}:00.000Z` })),
    );

    const body = await (await GET(jsonRequest('/api/creator/import-drafts', { method: 'GET', token }))).json();

    expect(body.drafts).toHaveLength(200);
    expect(body.totals.showing).toBe(200);
    // The number a creator is shown is the number there are.
    expect(body.waiting).toBe(205);
    expect(body.totals.waiting).toBe(205);
  });

  it('answers zero for a user who is not a creator, rather than failing', async () => {
    // So the header and the app can ask unconditionally instead of gating the
    // call on a creator check with a round trip and a moment of being wrong.
    asCreator(null);
    const res = await GET(jsonRequest('/api/creator/import-drafts?count=1', { method: 'GET', token }));
    expect(res.status).toBe(200);
    expect((await res.json()).waiting).toBe(0);
  });

  it('refuses an unauthenticated read', async () => {
    const res = await GET(jsonRequest('/api/creator/import-drafts', { method: 'GET' }));
    expect(res.status).toBe(401);
  });
});

// ── Deciding ─────────────────────────────────────────────────────────────────

describe('POST approve — the only path from this queue to Discover', () => {
  it('publishes once and records the creator as the decider', async () => {
    asCreator();
    fakeDb.seed('creator_import_drafts', [draftRow()]);

    const res = await POST(jsonRequest('/api/creator/import-drafts', { token, body: { action: 'approve', ids: ['d1'] } }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.done).toBe(1);
    expect(publishCreatorMeal).toHaveBeenCalledTimes(1);
    expect(fakeDb.row('creator_import_drafts', 'd1')).toMatchObject({
      status: 'approved',
      decided_by: 'u1',
      published_meal_id: 'meal-1',
    });
    expect(revalidateTag).toHaveBeenCalledWith('trending-meals', 'max');
  });

  it('approving twice publishes once', async () => {
    // The risk is real rather than theoretical: a slow network invites a second
    // tap. The guarantee is the conditional write in `decideDraft` — the second
    // update matches no row because the first one took it out of
    // `pending_review` — not anything this route remembers.
    asCreator();
    fakeDb.seed('creator_import_drafts', [draftRow()]);

    const first = await POST(jsonRequest('/api/creator/import-drafts', { token, body: { action: 'approve', ids: ['d1'] } }));
    asCreator();
    const second = await POST(jsonRequest('/api/creator/import-drafts', { token, body: { action: 'approve', ids: ['d1'] } }));

    expect((await first.json()).done).toBe(1);
    const retry = await second.json();
    expect(retry.done).toBe(0);
    expect(retry.errors[0]).toMatch(/already approved/i);

    // One meal, and the row still points at the one that exists. Two would be
    // two Discover entries under one name, which nothing in `preset_meals`
    // would have stopped.
    expect(publishCreatorMeal).toHaveBeenCalledTimes(1);
    expect(fakeDb.row('creator_import_drafts', 'd1')).toMatchObject({ published_meal_id: 'meal-1' });
  });

  it('refuses to approve a batch, and publishes nothing while refusing', async () => {
    // Bulk-approving unreviewed extractions is exactly the failure the
    // per-field confidence model exists to prevent. Refused server-side as well
    // as absent from the UI, because the rule is about what gets published and
    // not about what a button does.
    asCreator();
    fakeDb.seed('creator_import_drafts', [draftRow(), draftRow({ id: 'd2' })]);

    const res = await POST(jsonRequest('/api/creator/import-drafts', { token, body: { action: 'approve', ids: ['d1', 'd2'] } }));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/one at a time/i);
    expect(publishCreatorMeal).not.toHaveBeenCalled();
    expect(fakeDb.row('creator_import_drafts', 'd1')).toMatchObject({ status: 'pending_review' });
    expect(fakeDb.row('creator_import_drafts', 'd2')).toMatchObject({ status: 'pending_review' });
  });

  it('does not email the creator about their own tap', async () => {
    // `notifyApproved` exists to tell a creator what went live under their name
    // when somebody *else* decided it. Here they pressed the button.
    asCreator();
    fakeDb.seed('creator_import_drafts', [draftRow()]);

    await POST(jsonRequest('/api/creator/import-drafts', { token, body: { action: 'approve', ids: ['d1'] } }));

    expect(sendCreatorSyncPublishedEmail).not.toHaveBeenCalled();
  });

  it('returns the remaining count, so the badge settles without another round trip', async () => {
    asCreator();
    fakeDb.seed('creator_import_drafts', [draftRow(), draftRow({ id: 'd2' })]);

    const body = await (await POST(jsonRequest('/api/creator/import-drafts', { token, body: { action: 'approve', ids: ['d1'] } }))).json();

    expect(body.waiting).toBe(1);
  });

  /**
   * Two refusals, one wording, opposite meanings — and the client cannot tell
   * them apart from the sentence.
   *
   * A draft written before the tag cap shipped fails to publish,
   * `approveDraft` rolls it back to `pending_review`, and the row is still the
   * creator's to fix. A draft approved in another tab is gone. Both come back
   * 200 with `done: 0` and a populated `errors[]`, and the creator queue
   * resolved the row for either — so a publish that failed locked its own row
   * and took Approve, Edit and Decline with it.
   *
   * `stillPending` is the row's own status, asked for only when something was
   * refused. Nothing decides differently because of it.
   */
  it('says a rolled-back publish is still waiting on the creator', async () => {
    asCreator();
    fakeDb.seed('creator_import_drafts', [draftRow(), draftRow({ id: 'd2' })]);
    // What an eight-tag draft does: `publishCreatorMeal` refuses it.
    publishCreatorMeal.mockRejectedValueOnce(new Error('That is 8 tags. A meal takes at most 3.'));

    const body = await (await POST(jsonRequest('/api/creator/import-drafts', { token, body: { action: 'approve', ids: ['d1'] } }))).json();

    expect(body.done).toBe(0);
    expect(body.errors[0]).toMatch(/Publishing failed: That is 8 tags/);
    // The database is right — `approveDraft` put it back — and the response
    // says so, so the client can leave the row alone.
    expect(fakeDb.row('creator_import_drafts', 'd1')).toMatchObject({
      status: 'pending_review',
      decided_at: null,
      published_meal_id: null,
    });
    expect(body.stillPending).toEqual(['d1']);
  });

  it('says a draft decided in another tab is not waiting on anyone', async () => {
    asCreator();
    fakeDb.seed('creator_import_drafts', [draftRow()]);

    await POST(jsonRequest('/api/creator/import-drafts', { token, body: { action: 'approve', ids: ['d1'] } }));
    asCreator();
    const retry = await (await POST(jsonRequest('/api/creator/import-drafts', { token, body: { action: 'approve', ids: ['d1'] } }))).json();

    expect(retry.errors[0]).toMatch(/already approved/i);
    expect(retry.stillPending).toEqual([]);
  });

  it('asks nothing extra when nothing was refused', async () => {
    // One `in` query, only on the path that already failed.
    asCreator();
    fakeDb.seed('creator_import_drafts', [draftRow()]);

    const body = await (await POST(jsonRequest('/api/creator/import-drafts', { token, body: { action: 'approve', ids: ['d1'] } }))).json();

    expect(body.errors).toEqual([]);
    expect(body.stillPending).toEqual([]);
  });

  it('does not report another creator’s draft as waiting on this one', async () => {
    // `pendingAmong` is scoped to the caller for the same reason every other
    // read here is: an id is a uuid, and answering about somebody else's row
    // would make this a way to probe for them.
    asCreator();
    fakeDb.seed('creator_import_drafts', [draftRow({ id: 'd9', creator_id: 'c2' })]);

    const body = await (await POST(jsonRequest('/api/creator/import-drafts', { token, body: { action: 'cancel', ids: ['d9'] } }))).json();

    expect(body.errors[0]).toMatch(/not one of yours/i);
    expect(body.stillPending).toEqual([]);
  });
});

describe('POST cancel — declining is a state, not a deletion', () => {
  it('marks the row cancelled and issues no delete', async () => {
    // `creator_source_items` still records the post as imported. A row that
    // disappeared would leave the next poll re-importing the same post and
    // asking this creator about a recipe they already said no to.
    asCreator();
    fakeDb.seed('creator_import_drafts', [draftRow()]);

    const res = await POST(jsonRequest('/api/creator/import-drafts', { token, body: { action: 'cancel', ids: ['d1'] } }));

    expect(res.status).toBe(200);
    expect(fakeDb.row('creator_import_drafts', 'd1')).toMatchObject({ status: 'cancelled', decided_by: 'u1' });
    expect(fakeDb.calls.some((c) => c.method === 'delete')).toBe(false);
    expect(publishCreatorMeal).not.toHaveBeenCalled();
  });

  it('allows declining several at once', async () => {
    // Safe in the way approving is not: nothing is published, nothing goes out
    // under anyone's name, and the cost of a mistake is a recipe that has to be
    // offered again rather than one the world has already seen.
    asCreator();
    fakeDb.seed('creator_import_drafts', [draftRow(), draftRow({ id: 'd2' })]);

    const body = await (await POST(jsonRequest('/api/creator/import-drafts', { token, body: { action: 'cancel', ids: ['d1', 'd2'] } }))).json();

    expect(body.done).toBe(2);
    expect(fakeDb.rows('creator_import_drafts').map((r) => r.status)).toEqual(['cancelled', 'cancelled']);
  });

  it('a cancelled draft is gone from the queue and from the badge', async () => {
    asCreator();
    fakeDb.seed('creator_import_drafts', [draftRow({ status: 'cancelled' })]);

    const body = await (await GET(jsonRequest('/api/creator/import-drafts', { method: 'GET', token }))).json();
    expect(body.drafts).toHaveLength(0);
    expect(body.totals.waiting).toBe(0);
  });
});

// ── Whose draft is it ────────────────────────────────────────────────────────

describe('a creator can only decide their own drafts', () => {
  it('will not approve another creator’s draft', async () => {
    // Without the ownership check, a draft id — a uuid in a response body — is
    // enough to publish to Discover under somebody else's name.
    asCreator();
    fakeDb.seed('creator_import_drafts', [draftRow({ creator_id: 'c2' })]);

    const body = await (await POST(jsonRequest('/api/creator/import-drafts', { token, body: { action: 'approve', ids: ['d1'] } }))).json();

    expect(body.done).toBe(0);
    expect(publishCreatorMeal).not.toHaveBeenCalled();
    expect(fakeDb.row('creator_import_drafts', 'd1')).toMatchObject({ status: 'pending_review' });
  });

  it('will not decline another creator’s draft', async () => {
    asCreator();
    fakeDb.seed('creator_import_drafts', [draftRow({ creator_id: 'c2' })]);

    await POST(jsonRequest('/api/creator/import-drafts', { token, body: { action: 'cancel', ids: ['d1'] } }));

    expect(fakeDb.row('creator_import_drafts', 'd1')).toMatchObject({ status: 'pending_review' });
  });

  it('will not edit another creator’s draft, and says the same thing as for one that does not exist', async () => {
    // Distinguishing the two would turn this endpoint into a way to probe for
    // other people's draft ids.
    asCreator();
    fakeDb.seed('creator_import_drafts', [draftRow({ creator_id: 'c2' })]);

    const mine = await PATCH(jsonRequest('/api/creator/import-drafts', {
      method: 'PATCH', token, body: { id: 'd1', draft: guacamole.draft },
    }));
    asCreator();
    const missing = await PATCH(jsonRequest('/api/creator/import-drafts', {
      method: 'PATCH', token, body: { id: 'nope', draft: guacamole.draft },
    }));

    expect(mine.status).toBe(403);
    expect(missing.status).toBe(403);
    expect(await mine.json()).toEqual(await missing.json());
    expect(fakeDb.row('creator_import_drafts', 'd1')).toMatchObject({ draft: guacamole.draft, edited_at: null });
  });

  it('will not approve a draft an operator has taken back', async () => {
    // Reclaim was defeated by an authorisation check that asked only *whose*
    // draft it is. `creator_id` never changes, so a creator holding the queue
    // open when an operator pressed "Take it back" could still publish it to
    // Discover — out of their own GET, out of their badge, and live anyway.
    asCreator();
    fakeDb.seed('creator_import_drafts', [draftRow({ review_by: 'admin' })]);

    const body = await (await POST(jsonRequest('/api/creator/import-drafts', { token, body: { action: 'approve', ids: ['d1'] } }))).json();

    expect(body.done).toBe(0);
    expect(publishCreatorMeal).not.toHaveBeenCalled();
    expect(fakeDb.row('creator_import_drafts', 'd1')).toMatchObject({ status: 'pending_review', review_by: 'admin' });
  });

  it('will not decline a draft an operator has taken back', async () => {
    // The mirror of the approve case, and the quieter one: declining it out
    // from under an operator who is mid-review leaves them looking at a card
    // for a recipe that has already been refused.
    asCreator();
    fakeDb.seed('creator_import_drafts', [draftRow({ review_by: 'admin' })]);

    await POST(jsonRequest('/api/creator/import-drafts', { token, body: { action: 'cancel', ids: ['d1'] } }));

    expect(fakeDb.row('creator_import_drafts', 'd1')).toMatchObject({ status: 'pending_review' });
  });

  it('will not edit a draft an operator has taken back', async () => {
    asCreator();
    fakeDb.seed('creator_import_drafts', [draftRow({ review_by: 'admin' })]);

    const res = await PATCH(jsonRequest('/api/creator/import-drafts', {
      method: 'PATCH', token, body: { id: 'd1', draft: { ...guacamole.draft, name: 'Rewritten underneath them' } },
    }));

    expect(res.status).toBe(400);
    expect(fakeDb.row('creator_import_drafts', 'd1')).toMatchObject({ edited_at: null });
    expect(fakeDb.row('creator_import_drafts', 'd1').draft.name).toBe(guacamole.draft.name);
  });

  it('refuses a decision from a user who is not a creator at all', async () => {
    asCreator(null);
    fakeDb.seed('creator_import_drafts', [draftRow()]);

    const res = await POST(jsonRequest('/api/creator/import-drafts', { token, body: { action: 'approve', ids: ['d1'] } }));

    expect(res.status).toBe(403);
    expect(publishCreatorMeal).not.toHaveBeenCalled();
    expect(fakeDb.row('creator_import_drafts', 'd1')).toMatchObject({ status: 'pending_review' });
  });
});

// ── Editing ──────────────────────────────────────────────────────────────────

describe('PATCH — an edit is a fix, not a decision', () => {
  it('saves the change and leaves the draft in the queue', async () => {
    asCreator();
    fakeDb.seed('creator_import_drafts', [draftRow()]);

    const res = await PATCH(jsonRequest('/api/creator/import-drafts', {
      method: 'PATCH',
      token,
      body: { id: 'd1', draft: { ...guacamole.draft, name: 'Sarah’s guacamole' } },
    }));

    expect(res.status).toBe(200);
    const row = fakeDb.row('creator_import_drafts', 'd1');
    expect(row).toMatchObject({ status: 'pending_review' });
    expect(row.draft.name).toBe('Sarah’s guacamole');
    expect(row.edited_at).not.toBeNull();
    // Correcting a measure has not said the recipe is right.
    expect(publishCreatorMeal).not.toHaveBeenCalled();
  });

  // MEAL-171. This is the assertion the ticket was filed on, and it has to be
  // made HERE rather than against `editableDraft`: the measured bug was a 200
  // from the ROUTE with the preparation gone, and a unit test of the validator
  // cannot tell you whether the route calls it.
  it('refuses an over-cap preparation instead of answering 200 with it deleted', async () => {
    asCreator();
    fakeDb.seed('creator_import_drafts', [draftRow()]);
    const before = fakeDb.row('creator_import_drafts', 'd1');

    const tooLong = 'finely diced and then '.repeat(12);
    expect(tooLong.length).toBeGreaterThan(120);

    const res = await PATCH(jsonRequest('/api/creator/import-drafts', {
      method: 'PATCH',
      token,
      body: {
        id: 'd1',
        draft: {
          ...guacamole.draft,
          ingredients: [{ ...(guacamole.draft.ingredients[0] as object), prep: tooLong }],
        },
      },
    }));

    expect(res.status).toBe(400);
    const { error } = await res.json();
    expect(error).toMatch(/preparation/i);
    // And nothing was written. A refusal that still saved would be the same
    // data loss wearing a different status code.
    expect(fakeDb.row('creator_import_drafts', 'd1').draft).toEqual(before.draft);
  });

  it('returns the same enriched shape GET does, so a client can swap it in place', async () => {
    asCreator();
    fakeDb.seed('creator_import_drafts', [draftRow()]);

    const res = await PATCH(jsonRequest('/api/creator/import-drafts', {
      method: 'PATCH', token, body: { id: 'd1', draft: { ...guacamole.draft, name: 'Sarah’s guacamole' } },
    }));
    const { draft } = await res.json();

    // Otherwise the phone gets a differently-shaped `review` back from a PATCH
    // than it got from the list it is holding, and the card it re-renders from
    // is missing its callouts.
    expect(draft.review.summaryText).toMatch(/verified/);
    expect(draft.review.notices).toBeTruthy();
    expect(draft.summary.total).toBeGreaterThan(0);
  });

  it('drops our check of every field they rewrote', async () => {
    // A green on `name` is a claim that *the model's* value matched the source.
    // It says nothing about what a human typed over it, and leaving it would
    // have our verification vouching for their edit.
    asCreator();
    fakeDb.seed('creator_import_drafts', [draftRow()]);

    await PATCH(jsonRequest('/api/creator/import-drafts', {
      method: 'PATCH',
      token,
      body: { id: 'd1', draft: { ...guacamole.draft, name: 'Something else entirely' } },
    }));

    expect(fakeDb.row('creator_import_drafts', 'd1').confidence.name.level).toBe('red');
  });

  it('refuses a draft that could not be published, while the creator is still looking at it', async () => {
    asCreator();
    fakeDb.seed('creator_import_drafts', [draftRow()]);

    const res = await PATCH(jsonRequest('/api/creator/import-drafts', {
      method: 'PATCH',
      token,
      body: { id: 'd1', draft: { ...guacamole.draft, name: '   ' } },
    }));

    expect(res.status).toBe(400);
    expect(fakeDb.row('creator_import_drafts', 'd1').draft.name).toBe(guacamole.draft.name);
  });

  it('refuses more tags than a meal is shown under, rather than storing them', async () => {
    // The cap was in both editors and in neither server. A PATCH that did not
    // come from one of them stored everything it was sent and approving
    // published all of it — `MealCard` renders `.slice(0, 3)`, so the extras
    // were invisible on the card and still filterable in Discover.
    asCreator();
    fakeDb.seed('creator_import_drafts', [draftRow()]);

    const res = await PATCH(jsonRequest('/api/creator/import-drafts', {
      method: 'PATCH',
      token,
      body: { id: 'd1', draft: { ...guacamole.draft, tags: ['Mexican', 'No Cook', 'Appetizer', 'Italian', 'Vegan'] } },
    }));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/at most 3/);
    expect(fakeDb.row('creator_import_drafts', 'd1').draft.tags).toEqual(guacamole.draft.tags);
  });

  it('still accepts the cap itself', async () => {
    asCreator();
    fakeDb.seed('creator_import_drafts', [draftRow()]);

    const res = await PATCH(jsonRequest('/api/creator/import-drafts', {
      method: 'PATCH',
      token,
      body: { id: 'd1', draft: { ...guacamole.draft, tags: ['Mexican', 'No Cook', 'Vegan'] } },
    }));

    expect(res.status).toBe(200);
    expect(fakeDb.row('creator_import_drafts', 'd1').draft.tags).toEqual(['Mexican', 'No Cook', 'Vegan']);
  });

  it('counts tags after dropping the ones outside the vocabulary', async () => {
    // Otherwise "five tags, two of them nonsense" is refused for being five
    // when what would have been stored is three.
    asCreator();
    fakeDb.seed('creator_import_drafts', [draftRow()]);

    const res = await PATCH(jsonRequest('/api/creator/import-drafts', {
      method: 'PATCH',
      token,
      body: { id: 'd1', draft: { ...guacamole.draft, tags: ['Mexican', 'not-a-tag', 'No Cook', 'also-not', 'Vegan'] } },
    }));

    expect(res.status).toBe(200);
    expect(fakeDb.row('creator_import_drafts', 'd1').draft.tags).toEqual(['Mexican', 'No Cook', 'Vegan']);
  });

  it('refuses an edit that lands on a draft already decided', async () => {
    // Otherwise a correction rewrites the recipe out from under a meal already
    // on Discover, and the creator is told their edit was saved.
    asCreator();
    fakeDb.seed('creator_import_drafts', [draftRow({ status: 'approved' })]);

    const res = await PATCH(jsonRequest('/api/creator/import-drafts', {
      method: 'PATCH', token, body: { id: 'd1', draft: { ...guacamole.draft, name: 'Too late' } },
    }));

    expect(res.status).toBe(400);
    expect(fakeDb.row('creator_import_drafts', 'd1').draft.name).toBe(guacamole.draft.name);
  });
});
