import { NextRequest, NextResponse } from 'next/server';
import { revalidateTag } from 'next/cache';
import { createServerSupabaseClient } from '@/lib/supabase';
import { requireAdmin } from '@/lib/requireAdmin';
import { log } from '@/lib/logger';
import {
  approveDraft,
  cancelDraft,
  draftsAdminMayNotDecide,
  editDraft,
  editableDraft,
  listDraftQueue,
  notifyApproved,
  reviewDraft,
  type ApprovedMeal,
} from '@/lib/import-drafts';

/**
 * The admin's view of imported drafts (MEAL-91).
 *
 * GET   — every pending draft, whichever way it was imported. `?creatorId=`
 *         narrows it to one creator, which is how the Creator integrations card
 *         asks. Each draft says whether the admin may decide it.
 * POST  — approve / delete, one or many at a time.
 * PATCH — save an admin's edits to one draft, without deciding it.
 *
 * Every draft lives in its creator's queue. An admin can always read them, and
 * may edit, approve or delete them only when the creator ticked "Allow Mealio
 * admins to edit, approve or deny your imported posts" (`allow_admin_review`).
 * Every route here is behind `requireAdmin` because each of them either writes
 * to Discover under a creator's name or emails that creator about it.
 */

/** A batch bigger than this is not a review, it is a rubber stamp. */
const MAX_BATCH = 50;

const NOT_ALLOWED = 'This creator has not allowed Mealio admins to edit, approve or delete their drafts.';

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

  const creatorId = request.nextUrl.searchParams.get('creatorId') || null;
  const supabase = createServerSupabaseClient();
  const drafts = await listDraftQueue(supabase, 'any', creatorId ? { creatorId } : {});

  return NextResponse.json({
    // Echoed so a card rendering these rows can check they are the creator it
    // asked about, not whoever the last request was.
    creatorId,
    drafts: drafts.map((draft) => ({ ...draft, review: reviewDraft(draft) })),
    totals: {
      waiting: drafts.length,
      flagged: drafts.filter((draft) => draft.summary.needALook > 0).length,
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
  if (action !== 'approve' && action !== 'delete') {
    return NextResponse.json({ error: "action must be 'approve' or 'delete'" }, { status: 400 });
  }
  const targets = [...new Set([...ids(body.ids), ...ids(body.id)])];
  if (targets.length === 0) {
    return NextResponse.json({ error: 'Select at least one draft.' }, { status: 400 });
  }
  if (targets.length > MAX_BATCH) {
    return NextResponse.json({ error: `That is ${targets.length} drafts. Act on at most ${MAX_BATCH} at once.` }, { status: 400 });
  }

  const supabase = createServerSupabaseClient();
  // `any`: the draft is in its creator's queue, and the permission that lets an
  // admin decide it there is checked just below.
  const deps = { supabase, queue: 'any' as const };
  const errors: string[] = [];

  const notAllowed = await draftsAdminMayNotDecide(supabase, targets);
  const approved: ApprovedMeal[] = [];
  let done = 0;

  for (const id of targets) {
    if (notAllowed.has(id)) {
      errors.push(NOT_ALLOWED);
      continue;
    }
    if (action === 'approve') {
      const result = await approveDraft(deps, id, admin.userId);
      if (result.ok) { approved.push(result.approved); done += 1; } else errors.push(result.error);
      continue;
    }
    // Delete marks `cancelled` and never removes the row — a declined recipe has
    // to stay declined, or the next sync of the same post asks again.
    const result = await cancelDraft(deps, id, admin.userId);
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
  if ((await draftsAdminMayNotDecide(supabase, [id])).has(id)) {
    return NextResponse.json({ error: NOT_ALLOWED }, { status: 403 });
  }
  const result = await editDraft({ supabase, queue: 'any' }, id, next.draft, admin.userId);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }

  return NextResponse.json({ draft: { ...result.draft, review: reviewDraft(result.draft) } });
}
