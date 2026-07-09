import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';
import { verifyAccessToken, checkTokenRevoked, extractTokenFromHeader } from '@/lib/tokens';
import { log } from '@/lib/logger';

export async function DELETE(request: NextRequest) {
  const ip = request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || 'unknown';
  try {
    const token = extractTokenFromHeader(request.headers.get('authorization'));
    if (!token) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const decoded = await verifyAccessToken(token);
    if (!decoded) {
      return NextResponse.json({ error: 'Invalid token' }, { status: 401 });
    }

    const { userId, email } = decoded;
    const supabase = createServerSupabaseClient();
    if (await checkTokenRevoked(supabase, decoded.userId, decoded.issuedAt)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Delete user data in a foreign-key-safe order.
    // 1) Creator content first: find the creator row, drop its published meals
    //    and any follows pointing at it, then the creator row — so nothing
    //    references the profile once it's removed.
    const { data: creator } = await supabase
      .from('creators')
      .select('id')
      .eq('user_id', userId)
      .maybeSingle();
    if (creator?.id) {
      await supabase.from('preset_meals').delete().eq('creator_id', creator.id);
      await supabase.from('creator_follows').delete().eq('creator_id', creator.id);
      await supabase.from('creators').delete().eq('id', creator.id);
    }

    // 2) Anonymize the marketing/lifecycle send log instead of deleting it: keep
    //    the rows for aggregate reporting but scrub the PII and detach them from
    //    the profile we're about to remove (null user_id keeps the delete FK-safe).
    await supabase
      .from('email_sends')
      .update({ email: '[deleted]', user_id: null })
      .eq('user_id', userId);

    // 3) Everything else keyed to the user.
    await supabase.from('creator_follows').delete().eq('follower_id', userId);
    await supabase.from('creator_applications').delete().eq('user_id', userId);
    await supabase.from('meals').delete().eq('user_id', userId);
    await supabase.from('refresh_tokens').delete().eq('user_id', userId);
    await supabase.from('remembered_devices').delete().eq('user_id', userId);
    await supabase.from('otp_codes').delete().eq('user_id', userId);
    await supabase.from('user_profiles').delete().eq('id', userId);

    // Delete the Supabase Auth account (also removes from auth.users)
    const { error: deleteError } = await supabase.auth.admin.deleteUser(userId);
    if (deleteError) {
      log({ event: 'ACCOUNT:DELETE', status: 'error', userId, email, ip, error: deleteError });
      return NextResponse.json({ error: 'Failed to delete account. Please try again.' }, { status: 500 });
    }

    log({ event: 'ACCOUNT:DELETE', status: 'success', userId, email, ip });
    return NextResponse.json({ success: true });
  } catch (error) {
    log({ event: 'ACCOUNT:DELETE', status: 'error', ip, error });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
