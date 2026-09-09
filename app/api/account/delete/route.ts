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

    // 2) The cohort anchor, copied out BEFORE the profile goes.
    //
    //    Everything preserved below is activity, and activity with no signup date
    //    cannot be cohorted — "of the people who joined in March, how many were
    //    still opening it in June" is the only question retention asks, and the
    //    March half of it lives on the row about to be deleted. So the handful of
    //    non-PII facts that anchor a cohort are copied to `deleted_users` first.
    //
    //    Deliberately NOT copied: email, display name, phone, Stripe ids. What
    //    goes in is timestamps, a tier word, and the creator handle the user
    //    chose to arrive through. `user_id` is a uuid with nothing behind it once
    //    the profile is gone; it is what lets two deleted users be counted as two
    //    people rather than as an anonymous heap.
    //
    //    Non-fatal by design. A tombstone that cannot be written must not block a
    //    person exercising a deletion right — the deletion is the obligation and
    //    the analytics are the convenience, and that ordering is not close.
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('created_at, acquisition_source, subscribed_at, subscription_tier')
      .eq('id', userId)
      .maybeSingle();

    const { error: tombstoneError } = await supabase
      .from('deleted_users')
      .upsert(
        {
          user_id: userId,
          signed_up_at: profile?.created_at ?? null,
          acquisition_source: profile?.acquisition_source ?? null,
          subscribed_at: profile?.subscribed_at ?? null,
          subscription_tier: profile?.subscription_tier ?? null,
          deleted_at: new Date().toISOString(),
        },
        { onConflict: 'user_id' },
      );
    if (tombstoneError) {
      // Logged loudly and then ignored: the rows it would have anchored are
      // still there and still countable, they simply lose their cohort. Silence
      // here would mean discovering months later that a slice of the curve is
      // uncohortable with nothing saying when it started.
      log({ event: 'ACCOUNT:DELETE', status: 'error', userId, detail: `tombstone failed: ${tombstoneError.message}` });
    }

    // 3) The user's own rows with NOT NULL FKs to user_profiles (creator_follows
    //    follows by user_id, not follower_id).
    //
    //    `preset_meal_saves` and `subscription_events` are NO LONGER deleted here.
    //    They are behaviour and money, they carry no PII beyond the uuid, and
    //    deleting them is what made every historical figure move: a cohort that
    //    was 400 people in March became 380 today, and the saves total on the
    //    admin page fell for a month that had already ended. Their foreign keys
    //    onto `user_profiles` are dropped in
    //    supabase/migrations/20260908000001_preserve_analytics_on_delete.sql —
    //    WITHOUT THAT MIGRATION the database still cascades them away and this
    //    change does nothing.
    //
    //    What is still deleted is personal content: their saved recipes, the
    //    devices they trusted, their one-time codes, their application.
    await supabase.from('creator_follows').delete().eq('user_id', userId);
    await supabase.from('creator_applications').delete().eq('user_id', userId);
    await supabase.from('meals').delete().eq('user_id', userId);
    await supabase.from('remembered_devices').delete().eq('user_id', userId);
    await supabase.from('otp_codes').delete().eq('user_id', userId);

    // 4) Anonymize the marketing/lifecycle send log (user_id is nullable): keep the
    //    rows for aggregate reporting but scrub the PII and detach the profile.
    //
    //    Detached rather than kept-with-uuid, unlike the tables above, and the
    //    difference is what the row holds: this one has an email address in it.
    //    Scrubbing that is the whole point, and once it is scrubbed the row is
    //    only ever read as an aggregate, so there is nothing for a uuid to do.
    await supabase.from('email_sends').update({ email: '[deleted]', user_id: null }).eq('user_id', userId);

    // 5) Detach any preset meals still authored by this user (nullable author_id).
    await supabase.from('preset_meals').update({ author_id: null }).eq('author_id', userId);

    // 6) The profile itself — check the error so any remaining FK surfaces as a
    //    clear log line instead of a generic failure at deleteUser.
    const { error: profileError } = await supabase.from('user_profiles').delete().eq('id', userId);
    if (profileError) {
      // NAME THE LIKELY CAUSE RATHER THAN LOGGING A CONSTRAINT NAME. There is one
      // way this fails that is not a bug in this file: the migration that drops
      // the blocking foreign keys has not been run on this database. Step 3 above
      // stopped deleting `preset_meal_saves`, whose `user_id` is NOT NULL
      // REFERENCES user_profiles(id) with no ON DELETE clause — NO ACTION, so it
      // blocks rather than cascades. Until
      // supabase/migrations/20260908000001_preserve_analytics_on_delete.sql has
      // run, every deletion lands here, and "Failed to delete account" is a
      // sentence nobody can act on.
      const looksLikeFk = /foreign key|violates|constraint/i.test(profileError.message ?? '');
      log({
        event: 'ACCOUNT:DELETE', status: 'error', userId, email, ip, error: profileError,
        detail: looksLikeFk
          ? 'profile delete blocked by a foreign key: is 20260908000001_preserve_analytics_on_delete.sql applied?'
          : 'profile delete failed',
      });
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
