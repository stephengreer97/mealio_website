import { NextRequest, NextResponse } from 'next/server';
import { revalidateTag } from 'next/cache';
import { createServerSupabaseClient } from '@/lib/supabase';
import { requireAdmin } from '@/lib/requireAdmin';
import { log } from '@/lib/logger';
import {
  approveDraft,
  cancelDraft,
  CREATOR_REVIEW_QUEUE_EXISTS,
  editDraft,
  editableDraft,
  HANDOFF_UNAVAILABLE,
  listAllPendingDrafts,
  listDraftQueue,
  listHandedOverDrafts,
  notifyApproved,
  queueOf,
  reclaimDraft,
  reviewDraft,
  sendDraftToCreator,
  type ApprovedMeal,
} from '@/lib/import-drafts';

/**
 * The admin review queue (MEAL-91).
 *
 * GET   — everything waiting on an operator, flagged items first.
 *         `?scope=all` additionally lists every pending draft, whichever queue
 *         it belongs to, for the rows the two narrow queries cannot reach.
 * POST  — approve / send to creator / delete, one or many at a time.
 * PATCH — save an operator's edits to one draft, without deciding it.
 *
 * Admin sync no longer publishes; this is where a synced recipe becomes live,
 * and every route here is behind `requireAdmin` because each of them either
 * writes to Discover under a creator's name or emails that creator about it.
 */

/** A batch bigger than this is not a review, it is a rubber stamp. */
const MAX_BATCH = 50;

function ids(raw: unknown): string[] {
  if (typeof raw === 'string' && raw) return [raw];
  if (!Array.isArray(raw)) return [];
  return raw.filter((value): value is string => typeof value === 'string' && Boolean(value));
}

export async function GET(request: NextRequest) {
  const admin = await requireAdmin(request);
  if (!admin) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  // Opt-in, and it has to stay that way: the two queries below are narrow on
  // purpose (poller drafts are not the admin's work), so widening the default
  // would put every creator's inbox on this screen. `?scope=all` is the escape
  // hatch for when a draft is in neither list and nobody can see it.
  const scope = request.nextUrl.searchParams.get('scope') === 'all' ? 'all' : 'default';

  const supabase = createServerSupabaseClient();
  // Three independent reads, so they go together. Nothing here depends on
  // anything else here — `unqueued` is decided from each row's own columns, not
  // by subtracting one result from another.
  const [drafts, handedOver, everything] = await Promise.all([
    listDraftQueue(supabase, 'admin'),
    // Anything an operator handed to a creator before that button was switched
    // off. There is no creator queue to have received it, so these rows are in
    // no queue at all — listing them is what keeps that recoverable instead of
    // silent.
    listHandedOverDrafts(supabase),
    // The escape hatch, and only when asked for: a poller draft with no
    // `sent_to_creator_at` is in neither list above and nothing shows it to
    // anybody.
    scope === 'all' ? listAllPendingDrafts(supabase) : null,
  ]);

  // `queueOf` reads the row, so this is exact whether or not the two lists above
  // were truncated by their own limits. An id already on screen is skipped as
  // well, which only matters if a row changed queue between the queries — but
  // showing the same draft twice under contradictory headings is the one thing
  // this screen must not do.
  const alreadyShown = new Set([...drafts, ...handedOver].map((draft) => draft.id));
  const unqueued = (everything?.drafts ?? [])
    .filter((draft) => queueOf(draft) === 'none' && !alreadyShown.has(draft.id));

  // Rendered on the card, not recomputed there: the rules that decide which
  // fields get called out live in `lib/import/draft-form.ts`, and a second copy
  // of them in the browser is a second copy to keep true.
  return NextResponse.json({
    // Echoed rather than assumed by the client: the screen states which mode it
    // is showing, and it should be saying so about the data it actually has.
    scope,
    drafts: drafts.map((draft) => ({ ...draft, review: reviewDraft(draft) })),
    handedOver: handedOver.map((draft) => ({ ...draft, review: reviewDraft(draft) })),
    // Four fields, not a draft: this list renders a name, a creator and a host,
    // and posts the id back to reclaim one. Shipping the full `draft` and
    // `confidence` jsonb plus a computed review — ~6 KB a row, megabytes at the
    // cap — to draw three strings is a response nobody can afford to page.
    unqueued: unqueued.map((draft) => ({
      id: draft.id,
      name: draft.name,
      sourceUrl: draft.sourceUrl,
      creatorName: draft.creatorName,
    })),
    totals: {
      waiting: drafts.length,
      flagged: drafts.filter((draft) => draft.summary.needALook > 0).length,
      handedOver: handedOver.length,
      // `null`, not `0`, in the default mode: nobody counted, and a zero here
      // would read as "checked, and there are none". In `all` mode it is the
      // database's own `count`, so it is a total and not a page length.
      allPending: everything?.total ?? null,
      unqueued: everything ? unqueued.length : null,
      // What the screen needs to stop promising completeness it does not have:
      // beyond `limit` pending drafts, the oldest `limit` are what came back and
      // the rest are as unreachable as they were before this mode existed.
      truncated: everything?.truncated ?? null,
      limit: everything?.limit ?? null,
    },
  });
}

export async function POST(request: NextRequest) {
  const admin = await requireAdmin(request);
  if (!admin) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  let body: { action?: unknown; ids?: unknown; id?: unknown; notifyCreator?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const action = body.action;
  if (action !== 'approve' && action !== 'send-to-creator' && action !== 'delete' && action !== 'reclaim') {
    return NextResponse.json(
      { error: "action must be 'approve', 'send-to-creator', 'reclaim' or 'delete'" },
      { status: 400 },
    );
  }
  // Refused here as well as inside `sendDraftToCreator`, so the whole request
  // fails with the reason rather than returning 200 and a list of per-draft
  // errors for something that cannot work for any draft.
  if (action === 'send-to-creator' && !CREATOR_REVIEW_QUEUE_EXISTS) {
    return NextResponse.json({ error: HANDOFF_UNAVAILABLE }, { status: 400 });
  }

  const targets = [...new Set([...ids(body.ids), ...ids(body.id)])];
  if (targets.length === 0) {
    return NextResponse.json({ error: 'Select at least one draft.' }, { status: 400 });
  }
  if (targets.length > MAX_BATCH) {
    return NextResponse.json({ error: `That is ${targets.length} drafts. Act on at most ${MAX_BATCH} at once.` }, { status: 400 });
  }

  const supabase = createServerSupabaseClient();
  const deps = { supabase };
  const errors: string[] = [];
  const approved: ApprovedMeal[] = [];
  let done = 0;

  for (const id of targets) {
    if (action === 'approve') {
      const result = await approveDraft(deps, id, admin.userId);
      if (result.ok) { approved.push(result.approved); done += 1; } else errors.push(result.error);
      continue;
    }
    // Delete marks `cancelled` and never removes the row — a declined recipe has
    // to stay declined, or the next sync of the same post asks again.
    const result = action === 'send-to-creator'
      ? await sendDraftToCreator(deps, id, admin.userId)
      : action === 'reclaim'
        ? await reclaimDraft(deps, id, admin.userId)
        : await cancelDraft(deps, id, admin.userId);
    if (result.ok) done += 1;
    else errors.push(result.error);
  }

  // Once for the batch rather than once per meal: the Discover feed is cached
  // for ten minutes and approving twelve drafts would otherwise invalidate it
  // twelve times.
  if (approved.length > 0) revalidateTag('trending-meals', 'max');

  // Default ON, and turning it off has to be the deliberate act. The creator
  // hearing what went live under their name is the whole reason this may be
  // decided by an operator at all; a default of silence would make the quiet
  // path the easy one.
  const notify = body.notifyCreator === undefined ? true : Boolean(body.notifyCreator);
  const notified = notify ? await notifyApproved(deps, approved) : { sent: 0, errors: [] };

  log({
    event: 'ADMIN:DRAFT_APPROVE',
    status: errors.length > 0 ? 'error' : 'success',
    userId: admin.userId,
    email: admin.email,
    detail: `action=${action} asked=${targets.length} done=${done} emails=${notified.sent} notify=${notify}`,
  });

  return NextResponse.json({
    done,
    published: approved.map((entry) => ({ id: entry.meal.id, name: entry.meal.name })),
    emailsSent: notified.sent,
    errors: [...errors, ...notified.errors],
  });
}

export async function PATCH(request: NextRequest) {
  const admin = await requireAdmin(request);
  if (!admin) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  let body: { id?: unknown; draft?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const id = typeof body.id === 'string' ? body.id : '';
  if (!id) {
    return NextResponse.json({ error: 'id is required' }, { status: 400 });
  }

  // The edit form posts the same nine fields the publish form does, so it gets
  // the same validation. A draft that cannot be published is not a draft worth
  // saving — better to say so while the operator is still looking at it.
  const next = editableDraft(body.draft);
  if (!next.ok) {
    return NextResponse.json({ error: next.error }, { status: 400 });
  }

  const supabase = createServerSupabaseClient();
  const result = await editDraft({ supabase }, id, next.draft, admin.userId);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }

  return NextResponse.json({ draft: { ...result.draft, review: reviewDraft(result.draft) } });
}
