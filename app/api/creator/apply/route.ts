import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';
import { verifyAccessToken, extractTokenFromHeader } from '@/lib/tokens';
import { log } from '@/lib/logger';
import { sendCreatorApplicationEmail, sendCreatorAppliedEmail } from '@/lib/email';
import { isValidHandle, normalizeHandle } from '@/lib/handles';

// POST /api/creator/apply
export async function POST(request: NextRequest) {
  const token = extractTokenFromHeader(request.headers.get('authorization'));
  if (!token) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const decoded = await verifyAccessToken(token);
  if (!decoded) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = createServerSupabaseClient();

  // Check if already a creator
  const { data: existing } = await supabase
    .from('creators')
    .select('id')
    .eq('user_id', decoded.userId)
    .maybeSingle();

  if (existing) {
    return NextResponse.json({ error: 'Already a creator' }, { status: 409 });
  }

  // Check for existing pending application
  const { data: existingApp } = await supabase
    .from('creator_applications')
    .select('id, status')
    .eq('user_id', decoded.userId)
    .maybeSingle();

  if (existingApp) {
    return NextResponse.json(
      { error: 'Application already submitted', status: existingApp.status },
      { status: 409 }
    );
  }

  const body = await request.json();
  const { displayName, phone, findUs, photoUrl, handle } = body;

  if (!displayName?.trim()) {
    return NextResponse.json({ error: 'Display name is required' }, { status: 400 });
  }
  if (!photoUrl) {
    return NextResponse.json({ error: 'A profile photo is required' }, { status: 400 });
  }
  if (!findUs?.trim()) {
    return NextResponse.json({ error: 'Please provide a link where we can find you online' }, { status: 400 });
  }

  // Handle = the creator's permanent referral path (mealio.co/<handle>). Chosen
  // here and immutable once set, so validate format + reserve it uniquely.
  const normHandle = normalizeHandle(handle);
  if (!normHandle) {
    return NextResponse.json({ error: 'Choose a handle for your Mealio link' }, { status: 400 });
  }
  if (!isValidHandle(normHandle)) {
    return NextResponse.json(
      { error: 'Handle must be 3–30 characters (letters, numbers, hyphens, underscores) and not a reserved word.' },
      { status: 400 }
    );
  }
  // Reserve against both approved creators and other pending applications. The
  // partial unique indexes back this against races (handled below).
  const [{ data: takenCreator }, { data: takenApp }] = await Promise.all([
    supabase.from('creators').select('id').eq('handle', normHandle).maybeSingle(),
    supabase.from('creator_applications').select('id').eq('handle', normHandle).maybeSingle(),
  ]);
  if (takenCreator || takenApp) {
    return NextResponse.json({ error: 'That handle is already taken.' }, { status: 409 });
  }

  const { error } = await supabase.from('creator_applications').insert({
    user_id:      decoded.userId,
    display_name: displayName.trim(),
    phone:        phone?.trim() || null,
    find_us:      findUs?.trim() || null,
    photo_url:    photoUrl || null,
    handle:       normHandle,
  });

  if (error) {
    // Unique-index violation = someone claimed the handle between our check and insert.
    if ((error as { code?: string }).code === '23505') {
      return NextResponse.json({ error: 'That handle is already taken.' }, { status: 409 });
    }
    log({ event: 'CREATOR:APPLY', status: 'error', userId: decoded.userId, error });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Notify admins
  const [{ data: profile }, { data: admins }] = await Promise.all([
    supabase.from('user_profiles').select('email').eq('id', decoded.userId).maybeSingle(),
    supabase.from('user_profiles').select('email').eq('is_admin', true),
  ]);
  const dbAdminEmails = (admins ?? []).map((a: { email: string }) => a.email).filter(Boolean);
  const envAdminEmail = process.env.ADMIN_EMAIL;
  const adminEmails = dbAdminEmails.length > 0
    ? dbAdminEmails
    : envAdminEmail ? [envAdminEmail] : [];
  await Promise.allSettled([
    sendCreatorApplicationEmail(displayName.trim(), profile?.email ?? '', adminEmails)
      .catch(err => log({ event: 'CREATOR:EMAIL_ADMIN', status: 'error', error: err?.message })),
    profile?.email
      ? sendCreatorAppliedEmail(profile.email, displayName.trim())
          .catch(err => log({ event: 'CREATOR:EMAIL_APPLICANT', status: 'error', error: err?.message }))
      : Promise.resolve(),
  ]);

  log({ event: 'CREATOR:APPLY', status: 'success', userId: decoded.userId });
  return NextResponse.json({ ok: true }, { status: 201 });
}
