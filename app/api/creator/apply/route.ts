import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';
import { verifyAccessToken, extractTokenFromHeader } from '@/lib/tokens';
import { log } from '@/lib/logger';
import { sendCreatorApplicationEmail, sendCreatorAppliedEmail } from '@/lib/email';

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
  const { displayName, phone, findUs, photoUrl } = body;

  if (!displayName?.trim()) {
    return NextResponse.json({ error: 'Display name is required' }, { status: 400 });
  }

  const { error } = await supabase.from('creator_applications').insert({
    user_id:      decoded.userId,
    display_name: displayName.trim(),
    phone:        phone?.trim() || null,
    find_us:      findUs?.trim() || null,
    photo_url:    photoUrl || null,
  });

  if (error) {
    log({ event: 'CREATOR:APPLY', status: 'error', userId: decoded.userId, error });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Notify admins
  const [{ data: profile }, { data: admins }] = await Promise.all([
    supabase.from('user_profiles').select('email').eq('id', decoded.userId).maybeSingle(),
    supabase.from('user_profiles').select('email').eq('is_admin', true),
  ]);
  const adminEmails = (admins ?? []).map((a: { email: string }) => a.email).filter(Boolean);
  sendCreatorApplicationEmail(displayName.trim(), profile?.email ?? '', adminEmails).catch(() => {});
  if (profile?.email) sendCreatorAppliedEmail(profile.email, displayName.trim()).catch(() => {});

  log({ event: 'CREATOR:APPLY', status: 'success', userId: decoded.userId });
  return NextResponse.json({ ok: true }, { status: 201 });
}
