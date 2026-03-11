import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';
import { requireAdmin } from '@/lib/requireAdmin';
import { sendCreatorApprovedEmail, sendCreatorRejectedEmail } from '@/lib/email';

// GET /api/admin/applications — list all creator applications
export async function GET(request: NextRequest) {
  const admin = await requireAdmin(request);
  if (!admin) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const supabase = createServerSupabaseClient();
  const { data, error } = await supabase
    .from('creator_applications')
    .select(`
      id,
      display_name,
      phone,
      find_us,
      status,
      created_at,
      user_profiles!user_id ( email )
    `)
    .order('created_at', { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ applications: data });
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
    .select('user_id, display_name, photo_url, user_profiles!user_id ( email )')
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

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const applicantEmail = (app.user_profiles as unknown as { email: string } | null)?.email;
    if (applicantEmail) await sendCreatorRejectedEmail(applicantEmail, app.display_name).catch(() => {});

    return NextResponse.json({ ok: true });
  }

  // approve: update status + insert into creators
  const { error: statusError } = await supabase
    .from('creator_applications')
    .update({ status: 'approved' })
    .eq('id', id);

  if (statusError) return NextResponse.json({ error: statusError.message }, { status: 500 });

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
    });

    if (creatorError) return NextResponse.json({ error: creatorError.message }, { status: 500 });

    // Comp Full Access for approved creators
    await supabase
      .from('user_profiles')
      .update({ subscription_tier: 'paid' })
      .eq('id', app.user_id);
  }

  // Email the applicant
  const applicantEmail = (app.user_profiles as unknown as { email: string } | null)?.email;
  if (applicantEmail) await sendCreatorApprovedEmail(applicantEmail, app.display_name).catch(() => {});

  return NextResponse.json({ ok: true });
}
