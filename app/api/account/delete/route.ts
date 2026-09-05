import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';
import { verifyAccessToken, checkTokenRevoked, extractTokenFromHeader } from '@/lib/tokens';
import { log } from '@/lib/logger';
import { fetchAllPages, chunkIds } from '@/lib/paged-select';

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

    // Delete user data in a foreign-key-safe order. Several tables carry NOT NULL
    // FKs to user_profiles (or to a creator's preset_meals), so their rows must be
    // removed before the profile — otherwise the profile delete and then the auth
    // user delete fail on the constraint (surfacing as a 500).

    // 1) Creator content first.
    const { data: creator } = await supabase
      .from('creators')
      .select('id')
      .eq('user_id', userId)
      .maybeSingle();
    if (creator?.id) {
      // preset_meal_saves.preset_meal_id is NOT NULL, so clear saves of this
      // creator's meals before deleting the meals.
      // Paged, and this one has teeth. `preset_meal_saves.preset_meal_id` is NOT
      // NULL with a foreign key onto `preset_meals`, so any save left behind here
      // makes the `preset_meals` delete two lines down fail outright — a truncated
      // id list does not delete slightly less, it aborts the account deletion and
      // leaves the account half-erased. A user exercising a deletion right is
      // exactly who must not get a partial answer.
      const authored = await fetchAllPages<{ id: string }>((from, to) =>
        supabase
          .from('preset_meals')
          .select('id')
          .eq('creator_id', creator.id)
          .order('id', { ascending: true })
          .range(from, to));

      if (!authored.complete) {
        // Refuse rather than delete what we can. A cascade driven by an
        // incomplete list is the orphan-cleanup failure (MEAL-126) with the rows
        // reversed: there, an incomplete keep-set deleted live data.
        log({
          event: 'ACCOUNT:DELETE', status: 'error', userId,
          detail: `authored-meal read incomplete after ${authored.rows.length} rows`,
        });
        return NextResponse.json(
          { error: 'Could not read all of your published meals. Nothing was deleted. Please try again.' },
          { status: 503 },
        );
      }

      const mealIds = authored.rows.map((m) => m.id);
      // Chunked for the URI ceiling: ids travel in the query string, and a creator
      // with a few hundred meals would otherwise build a DELETE URL past the
      // proxy's limit and get a 414 that reads as "nothing to delete".
      for (const chunk of chunkIds(mealIds)) {
        await supabase.from('preset_meal_saves').delete().in('preset_meal_id', chunk);
      }
      await supabase.from('preset_meals').delete().eq('creator_id', creator.id);
      await supabase.from('creator_follows').delete().eq('creator_id', creator.id);
      await supabase.from('creators').delete().eq('id', creator.id);
    }

    // 2) The user's own rows with NOT NULL FKs to user_profiles (creator_follows
    //    follows by user_id, not follower_id).
    await supabase.from('preset_meal_saves').delete().eq('user_id', userId);
    await supabase.from('creator_follows').delete().eq('user_id', userId);
    await supabase.from('creator_applications').delete().eq('user_id', userId);
    await supabase.from('subscription_events').delete().eq('user_id', userId);
    await supabase.from('meals').delete().eq('user_id', userId);
    await supabase.from('remembered_devices').delete().eq('user_id', userId);
    await supabase.from('otp_codes').delete().eq('user_id', userId);

    // 3) Anonymize the marketing/lifecycle send log (user_id is nullable): keep the
    //    rows for aggregate reporting but scrub the PII and detach the profile.
    await supabase.from('email_sends').update({ email: '[deleted]', user_id: null }).eq('user_id', userId);

    // 4) Detach any preset meals still authored by this user (nullable author_id).
    await supabase.from('preset_meals').update({ author_id: null }).eq('author_id', userId);

    // 5) The profile itself — check the error so any remaining FK surfaces as a
    //    clear log line instead of a generic failure at deleteUser.
    const { error: profileError } = await supabase.from('user_profiles').delete().eq('id', userId);
    if (profileError) {
      log({ event: 'ACCOUNT:DELETE', status: 'error', userId, email, ip, error: profileError });
      return NextResponse.json({ error: 'Failed to delete account. Please try again.' }, { status: 500 });
    }

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
