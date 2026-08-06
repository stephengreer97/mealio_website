import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';
import { requireAdmin } from '@/lib/requireAdmin';
import { sendCreatorApprovedEmail, sendCreatorRejectedEmail } from '@/lib/email';
import { log } from '@/lib/logger';
import { fetchAllPages } from '@/lib/paged-select';

// GET /api/admin/applications — list all creator applications
export async function GET(request: NextRequest) {
  const admin = await requireAdmin(request);
  if (!admin) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const supabase = createServerSupabaseClient();

  // Paged, because the unpaged version of this read was MEAL-135 and it truncated
  // in the worst possible direction: the list is newest-first, so the 1000-row
  // ceiling dropped the OLDEST applications — the ones that have been waiting
  // longest and are most likely to still need a decision. An applicant could sit
  // unreviewed forever without appearing anywhere on this screen.
  //
  // Paged on `id` rather than on `created_at`: `created_at` is the order the
  // screen wants but it is not unique, and two applications sharing a timestamp
  // make an OFFSET walk ambiguous at exactly the page boundary — one row repeated
  // and another skipped. Ordering for display happens in memory below, which is
  // free since this fetches all of them anyway.
  const read = await fetchAllPages<Record<string, any>>((from, to) =>
    supabase
      .from('creator_applications')
      .select(`
        id,
        display_name,
        phone,
        find_us,
        website_url,
        youtube_url,
        instagram_url,
        tiktok_url,
        status,
        created_at,
        user_profiles!user_id ( email )
      `)
      .order('id', { ascending: true })
      .range(from, to));

  if (read.error) {
    return NextResponse.json({ error: read.error.message }, { status: 500 });
  }

  const applications = [...read.rows].sort((a, b) =>
    String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')));

  if (!read.complete) {
    // Said out loud rather than absorbed. A truncated queue that looks whole is
    // how an application goes unreviewed, so the screen is told the list is short
    // instead of being left to render a plausible one. Convention is MEAL-127's.
    log({
      event: 'ADMIN:APPLICATION_LIST',
      status: 'error',
      userId: admin.userId,
      email: admin.email,
      detail: `incomplete read after ${applications.length} rows`,
    });
  }

  return NextResponse.json({ applications, incomplete: read.complete ? [] : ['applications'] });
}

// PATCH /api/admin/applications — approve or reject an application
export async function PATCH(request: NextRequest) {
  const admin = await requireAdmin(request);
  if (!admin) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const body = await request.json();
  const { id, action } = body;

  if (!id || !['approve', 'reject'].includes(action)) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }

  const supabase = createServerSupabaseClient();

  // Fetch the application
  const { data: app, error: fetchError } = await supabase
    .from('creator_applications')
    .select('user_id, display_name, photo_url, handle, website_url, youtube_url, instagram_url, tiktok_url, user_profiles!user_id ( email )')
    .eq('id', id)
    .single();

  if (fetchError || !app) {
    return NextResponse.json({ error: 'Application not found' }, { status: 404 });
  }

  if (action === 'reject') {
    const { error } = await supabase
      .from('creator_applications')
      .update({ status: 'rejected' })
      .eq('id', id);

    if (error) {
      log({ event: 'ADMIN:APPLICATION_REVIEW', status: 'error', userId: admin.userId, email: admin.email, error });
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const applicantEmail = (app.user_profiles as unknown as { email: string } | null)?.email;
    // Not fatal — the rejection is already written and re-running it is not a
    // thing an operator can do — but not nothing either. Resend reports a
    // refusal in `{ error }`, which `lib/email.ts` turns into a throw, and
    // swallowing it here meant an applicant who was never told looked exactly
    // like one who was.
    if (applicantEmail) {
      await sendCreatorRejectedEmail(applicantEmail, app.display_name).catch((error) =>
        log({ event: 'ADMIN:APPLICATION_EMAIL', status: 'error', userId: admin.userId, email: applicantEmail, detail: 'action=reject', error }));
    }

    log({ event: 'ADMIN:APPLICATION_REVIEW', status: 'success', userId: admin.userId, email: admin.email, detail: `action=reject applicant=${applicantEmail ?? app.user_id} name=${app.display_name}` });
    return NextResponse.json({ ok: true });
  }

  // approve: update status + insert into creators
  const { error: statusError } = await supabase
    .from('creator_applications')
    .update({ status: 'approved' })
    .eq('id', id);

  if (statusError) {
    log({ event: 'ADMIN:APPLICATION_REVIEW', status: 'error', userId: admin.userId, email: admin.email, error: statusError });
    return NextResponse.json({ error: statusError.message }, { status: 500 });
  }

  // Check if creator row already exists (idempotent)
  const { data: existing } = await supabase
    .from('creators')
    .select('id')
    .eq('user_id', app.user_id)
    .maybeSingle();

  if (!existing) {
    const { error: creatorError } = await supabase.from('creators').insert({
      user_id:      app.user_id,
      display_name: app.display_name,
      ...(app.photo_url ? { photo_url: app.photo_url } : {}),
      // Carry the immutable referral handle chosen at application time.
      ...(app.handle ? { handle: app.handle } : {}),
      // All four platform links come across as-is (MEAL-81). `primary_source`
      // and `import_opt_in` keep their defaults — 'none' and false — so an
      // approval never starts polling anyone. That is a separate, deliberate
      // decision made in the Sources tab after a viability check.
      website_url:   app.website_url ?? null,
      youtube_url:   app.youtube_url ?? null,
      instagram_url: app.instagram_url ?? null,
      tiktok_url:    app.tiktok_url ?? null,
    });

    if (creatorError) {
      log({ event: 'ADMIN:APPLICATION_REVIEW', status: 'error', userId: admin.userId, email: admin.email, error: creatorError });
      return NextResponse.json({ error: creatorError.message }, { status: 500 });
    }

    // Comp Full Access for approved creators
    await supabase
      .from('user_profiles')
      .update({ subscription_tier: 'paid' })
      .eq('id', app.user_id);
  }

  // Email the applicant
  const applicantEmail = (app.user_profiles as unknown as { email: string } | null)?.email;
  // Same as the rejection path: the creator row is written and the tier is
  // comped, so this must not fail the request — but an approved creator who was
  // never told to go and publish is worth a log line rather than nothing.
  if (applicantEmail) {
    await sendCreatorApprovedEmail(applicantEmail, app.display_name).catch((error) =>
      log({ event: 'ADMIN:APPLICATION_EMAIL', status: 'error', userId: admin.userId, email: applicantEmail, detail: 'action=approve', error }));
  }

  log({ event: 'ADMIN:APPLICATION_REVIEW', status: 'success', userId: admin.userId, email: admin.email, detail: `action=approve applicant=${applicantEmail ?? app.user_id} name=${app.display_name}` });
  return NextResponse.json({ ok: true });
}
