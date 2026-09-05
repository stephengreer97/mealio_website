import { NextRequest, NextResponse } from 'next/server';
import { revalidateTag } from 'next/cache';
import { createServerSupabaseClient } from '@/lib/supabase';
import { requireAuth } from '@/lib/requireAuth';
import { log } from '@/lib/logger';
import { noticesFor, summaryLine } from '@/lib/import/draft-form';
import {
  approveDraft,
  cancelDraft,
  countPendingDrafts,
  draftBelongsToCreator,
  editDraft,
  editableDraft,
  listDraftQueue,
  pendingAmong,
  reviewDraft,
} from '@/lib/import-drafts';

/**
 * The creator's own review queue (MEAL-89).
 *
 * GET          — everything waiting on this creator, plus the badge count.
 * GET ?count=1 — the badge count alone.
 * POST         — approve one, or decline one or several.
 * PATCH        — save an edit to one draft, without deciding it.
 *
 * Two shipped features already write into this queue and until now it had no
 * reader: `sendDraftToCreator` flips `review_by` to `'creator'`, and the poller
 * writes drafts with that as the column default. Both pointed at nothing, which
 * is why the handoff was a disabled button.
 *
 * Deliberately the same four functions the admin queue calls, from
 * `lib/import-drafts.ts`, rather than a creator-flavoured copy of them. Every
 * one is a conditional write on `status = 'pending_review'` and that is what
 * makes a decision idempotent — approving twice publishes once because the
 * second update matches no row, not because this route remembers the first. A
 * second implementation would be a second place for that to be got wrong, and
 * the failure it prevents (two `preset_meals` rows for one draft, two Discover
 * entries under one name) is silent.
 *
 * What is NOT shared with the admin route is authorisation. `requireAdmin` is
 * the whole check there; here the draft id is the only thing in the request, so
 * every id is checked against this caller's own creator row before any decision
 * function sees it.
 */

/**
 * The most drafts one request may decline.
 *
 * There is no equivalent for approve, which takes exactly one id: bulk-
 * approving unreviewed extractions is the failure MEAL-72's confidence model
 * exists to prevent, and an "approve all" button is that failure with a
 * shortcut. Declining in bulk is safe in the way approving is not — nothing is
 * published, nothing goes out under anyone's name, and a mistake is a recipe
 * that has to be re-offered rather than one the world has already seen.
 */
const MAX_DECLINE = 50;

/** The caller's creator row, or null if this user is not an approved creator. */
async function creatorFor(supabase: ReturnType<typeof createServerSupabaseClient>, userId: string) {
  const { data } = await supabase
    .from('creators')
    .select('id, display_name')
    .eq('user_id', userId)
    .maybeSingle();
  return (data as { id: string; display_name: string } | null) ?? null;
}

function ids(raw: unknown): string[] {
  if (typeof raw === 'string' && raw) return [raw];
  if (!Array.isArray(raw)) return [];
  return raw.filter((value): value is string => typeof value === 'string' && Boolean(value));
}

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const supabase = createServerSupabaseClient();
  const creator = await creatorFor(supabase, auth.userId);
  // Not a 403. A user who is not a creator has an empty queue and a badge of
  // zero, which is the true answer and the one that lets the app and the header
  // ask unconditionally instead of gating the call on a creator check that has
  // its own round trip and its own moment of being wrong.
  //
  // Carries `waiting` as well as `totals`, so it answers the `?count=1` shape
  // too. Returning only `totals` here left a count caller with no `waiting`
  // field, and a badge that reads `typeof waiting === 'number'` before it
  // updates keeps whatever it had — so a creator whose row disappeared would
  // have gone on being told three recipes were waiting, in a queue that would
  // then render empty.
  if (!creator) return NextResponse.json({ waiting: 0, drafts: [], totals: { waiting: 0, showing: 0, flagged: 0 } });

  // The badge asks for this on every portal load and every app foreground, and
  // wants a number rather than ten jsonb recipes to count. `countPendingDrafts`
  // is a HEAD request against the partial index; the full list below is not.
  if (request.nextUrl.searchParams.get('count') === '1') {
    return NextResponse.json({ waiting: await countPendingDrafts(supabase, creator.id) });
  }

  const drafts = await listDraftQueue(supabase, 'creator', { creatorId: creator.id });

  // Counted, not measured off the list. `listDraftQueue` returns at most 200
  // rows and `countPendingDrafts` counts all of them, so the two are the same
  // number right up until they are not — and both clients used to badge from
  // the list. A creator with 250 pending watched the badge fall to 200 the
  // moment they opened the queue, with no decision made, and jump back to 249
  // when they approved one.
  const waiting = await countPendingDrafts(supabase, creator.id);

  // Rendered here, not on the client: which fields get called out, with what
  // reason and which source span, is decided by `lib/import/draft-form.ts`, and
  // a second copy of those rules on a client is a second copy to keep true.
  //
  // `notices` and `summaryText` are derived here rather than left to the caller
  // because there are two callers. The web queue could call `noticesFor` and
  // `summaryLine` itself — same bundle — but the app cannot without a
  // TypeScript port of the exceptions rules living in a second repository,
  // drifting on its own release cycle behind whatever version of the app a
  // creator happens to have installed. Sending the sentences means the phone
  // and the browser cannot disagree about which fields were verified.
  return NextResponse.json({
    // Top level as well as under `totals`, so the full read and `?count=1`
    // answer the same question under the same key. Without it a caller reading
    // `data.waiting` off the full GET got `undefined` for a creator and `0` for
    // a non-creator — the same shape as the bug the count fix was for, and
    // inverted, so a badge reading `typeof waiting === 'number'` kept its old
    // value for exactly the people who have a queue.
    waiting,
    drafts: drafts.map((draft) => {
      const review = reviewDraft(draft);
      return {
        ...draft,
        review: { ...review, notices: noticesFor(review.states), summaryText: summaryLine(review.summary) },
      };
    }),
    totals: {
      /** Everything pending on this creator. The badge's number. */
      waiting,
      /** How much of it is in `drafts` — what "3 of 10" counts against. */
      showing: drafts.length,
      flagged: drafts.filter((draft) => draft.summary.needALook > 0).length,
    },
  });
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: { action?: unknown; ids?: unknown; id?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const action = body.action;
  if (action !== 'approve' && action !== 'cancel') {
    return NextResponse.json({ error: "action must be 'approve' or 'cancel'" }, { status: 400 });
  }

  const supabase = createServerSupabaseClient();
  const creator = await creatorFor(supabase, auth.userId);
  // 403 here where GET returns an empty queue: reading nothing is a true
  // answer, but a write asks to publish under a creator name this user does not
  // have.
  if (!creator) {
    return NextResponse.json({ error: 'Only approved creators have a review queue.' }, { status: 403 });
  }

  const targets = [...new Set([...ids(body.ids), ...ids(body.id)])];
  if (targets.length === 0) {
    return NextResponse.json({ error: 'Choose at least one draft.' }, { status: 400 });
  }
  // One at a time, and the message says why rather than just refusing. The
  // client never sends more; this is the server half of the same rule, because
  // the rule is about what gets published and not about what a button does.
  if (action === 'approve' && targets.length > 1) {
    return NextResponse.json(
      {
        error:
          'Recipes are approved one at a time. Approving a batch without reading it is exactly what the ' +
          'per-field checks are for. Open each one and decide it.',
      },
      { status: 400 },
    );
  }
  if (targets.length > MAX_DECLINE) {
    return NextResponse.json({ error: `That is ${targets.length} drafts. Decline at most ${MAX_DECLINE} at once.` }, { status: 400 });
  }

  // `role` selects the log event and nothing else — every rule below is the
  // admin queue's, unchanged. See `DraftDeps.role`.
  const deps = { supabase, role: 'creator' as const };
  const errors: string[] = [];
  const published: Array<{ id: string; name: string }> = [];
  let done = 0;

  for (const id of targets) {
    if (!(await draftBelongsToCreator(supabase, id, creator.id))) {
      // Same sentence whether the draft belongs to another creator or does not
      // exist. Telling the two apart would turn this endpoint into a way to
      // probe for other people's draft ids.
      errors.push('That draft is not one of yours.');
      log({
        event: 'CREATOR:DRAFT_DECIDE',
        status: 'error',
        userId: auth.userId,
        email: auth.email,
        reason: `draft=${id} not owned by creator=${creator.id}`,
      });
      continue;
    }

    if (action === 'approve') {
      const result = await approveDraft(deps, id, auth.userId);
      if (result.ok) {
        published.push({ id: result.approved.meal.id, name: result.approved.meal.name });
        done += 1;
      } else {
        errors.push(result.error);
      }
      continue;
    }

    // Declining marks `cancelled` and never removes the row. `creator_source_items`
    // still records the post as imported, so a row that disappeared would leave
    // the next poll re-importing it and asking this creator about a recipe they
    // already said no to.
    const result = await cancelDraft(deps, id, auth.userId);
    if (result.ok) done += 1;
    else errors.push(result.error);
  }

  // Once for the request rather than once per meal, and only when something
  // actually published — Discover's feed is cached for ten minutes.
  if (published.length > 0) revalidateTag('trending-meals', 'max');

  // No email. `notifyApproved` exists to tell a creator what went live under
  // their name when somebody else decided it; here they are the one who pressed
  // the button, and a "your recipe is live" message a second later is a
  // notification about their own tap.

  log({
    event: 'CREATOR:DRAFT_DECIDE',
    status: errors.length > 0 ? 'error' : 'success',
    userId: auth.userId,
    email: auth.email,
    detail: `action=${action} asked=${targets.length} done=${done} creator=${creator.id}`,
  });

  return NextResponse.json({
    done,
    published,
    errors,
    // Which of the drafts we were asked about are *still waiting on this
    // creator*. Only asked when something was refused, because that is the only
    // case it answers: a refusal can mean "already decided elsewhere" or
    // "nothing happened, this is still yours to fix", the sentences are prose
    // and identical in shape, and a client that guesses locks a fixable draft.
    // See `pendingAmong`. Additive: nothing decides differently because of it.
    stillPending: errors.length > 0 ? await pendingAmong(supabase, targets, creator.id) : [],
    // So the badge and the "3 of 10" can settle without a second round trip,
    // and so a decision made in another tab is reflected on this one.
    waiting: await countPendingDrafts(supabase, creator.id),
  });
}

export async function PATCH(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: { id?: unknown; draft?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const id = typeof body.id === 'string' ? body.id : '';
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 });

  const supabase = createServerSupabaseClient();
  const creator = await creatorFor(supabase, auth.userId);
  if (!creator) {
    return NextResponse.json({ error: 'Only approved creators have a review queue.' }, { status: 403 });
  }
  // Before the body is even validated. A stranger's draft is not something to
  // spend a validation error on, and a differently-worded rejection for a
  // well-formed body would leak which ids exist.
  if (!(await draftBelongsToCreator(supabase, id, creator.id))) {
    return NextResponse.json({ error: 'That draft is not one of yours.' }, { status: 403 });
  }

  // The same nine fields and the same constraints `POST /api/creator/meals`
  // publishes, because approving feeds this straight into `publishCreatorMeal`.
  // A draft that would be refused at publish time is better refused while the
  // creator is still looking at it.
  const next = editableDraft(body.draft);
  if (!next.ok) return NextResponse.json({ error: next.error }, { status: 400 });

  // Saving does not publish. Correcting a measure is a fix, not a decision —
  // the draft stays in the queue and the creator still has to approve it, and
  // `editDraft` drops our confidence on every field they rewrote so the card
  // stops vouching for a value we never checked.
  const result = await editDraft({ supabase, role: 'creator' }, id, next.draft, auth.userId);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });

  // The same enriched shape GET returns, so a client can swap the row in place
  // rather than refetch — and so the phone does not get a different `review`
  // object from a PATCH than it got from the list it is holding.
  const review = reviewDraft(result.draft);
  return NextResponse.json({
    draft: {
      ...result.draft,
      summary: review.summary,
      review: { ...review, notices: noticesFor(review.states), summaryText: summaryLine(review.summary) },
    },
  });
}
