import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';
import { verifyAccessToken, checkTokenRevoked, extractTokenFromHeader } from '@/lib/tokens';
import { log } from '@/lib/logger';
import { revalidateTag } from 'next/cache';
import { fetchAllPages, chunkIds } from '@/lib/paged-select';
import { purgeUserPhotos } from '@/lib/account-photos';
import { cancelStripeSubscriptions, IN_APP_SUBSCRIPTION_NOTICE } from '@/lib/stripe-cancel';

/**
 * Every step below checks its own error and stops here on failure. Carrying on
 * past a failed step is how a deletion used to end half-done: a creator row that
 * would not delete was ignored, the profile delete then failed on it with a bare
 * 500, and the creator's platform tokens stayed live for the poller.
 *
 * Stopping is safe because every step is safe to run twice (deletes of rows that
 * are already gone, updates to values already set, a tombstone only written
 * while the profile still exists), so the answer to any failure is "try again".
 */
function stepFailed(
  step: string,
  userId: string,
  error: unknown,
): NextResponse {
  log({ event: 'ACCOUNT:DELETE', status: 'error', userId, error, detail: `step failed: ${step}` });
  return NextResponse.json(
    { error: 'We could not finish deleting your account. Please try again. If it keeps failing, email contact@mealio.co.' },
    { status: 500 },
  );
}

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

    // 0) Money first, before anything is deleted. A deleted account with a live
    //    Stripe subscription is charged every month for a product nobody can
    //    sign in to, and once the profile is gone nothing links the Stripe
    //    customer back to a person who could ask for it to stop. So if the
    //    cancellation cannot be made, nothing is deleted.
    const { data: billing, error: billingError } = await supabase
      .from('user_profiles')
      .select('subscription_tier, stripe_customer_id, stripe_subscription_id')
      .eq('id', userId)
      .maybeSingle();
    if (billingError) return stepFailed('billing read', userId, billingError);

    const stripeCancel = await cancelStripeSubscriptions(
      billing?.stripe_customer_id,
      billing?.stripe_subscription_id,
    );
    if (!stripeCancel.ok) {
      log({ event: 'ACCOUNT:DELETE', status: 'error', userId, detail: `stripe cancel failed: ${stripeCancel.reason}` });
      return NextResponse.json(
        { error: 'We could not cancel your Mealio subscription, so your account was not deleted. Please try again, or cancel it from Manage Subscription first.' },
        { status: 502 },
      );
    }
    if (stripeCancel.cancelled.length > 0) {
      log({ event: 'ACCOUNT:DELETE', status: 'pending', userId, detail: `cancelled stripe ${stripeCancel.cancelled.join(',')}` });
    }
    // Paid with nothing live on Stripe: an in-app (App Store / Google Play)
    // subscription, which only the store can cancel.
    const maybeInApp = billing?.subscription_tier === 'paid' && stripeCancel.cancelled.length === 0
      && !billing?.stripe_subscription_id;

    // Delete user data in a foreign-key-safe order. Several tables carry NOT NULL
    // FKs to user_profiles (or to a creator's preset_meals), so their rows must be
    // removed before the profile — otherwise the profile delete and then the auth
    // user delete fail on the constraint (surfacing as a 500).

    // 1) Creator content first.
    const { data: creator, error: creatorError } = await supabase
      .from('creators')
      .select('id')
      .eq('user_id', userId)
      .maybeSingle();
    // A failed lookup must not read as "not a creator": that skips the creator
    // cleanup and leaves the row that blocks the profile delete.
    if (creatorError) return stepFailed('creator lookup', userId, creatorError);
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
        const { error } = await supabase.from('preset_meal_saves').delete().in('preset_meal_id', chunk);
        if (error) return stepFailed('preset_meal_saves', userId, error);
      }
      {
        const { error } = await supabase.from('preset_meals').delete().eq('creator_id', creator.id);
        if (error) return stepFailed('preset_meals', userId, error);
      }
      // Trending is cached for ten minutes; without this the deleted creator's
      // meals stay on Discover until the cache happens to expire.
      revalidateTag('trending-meals', 'max');

      {
        const { error } = await supabase.from('creator_follows').delete().eq('creator_id', creator.id);
        if (error) return stepFailed('creator_follows (creator)', userId, error);
      }
      // Their connected YouTube / Instagram / TikTok accounts, tokens included.
      // The FK cascades from `creators`, but deleted by name so the tokens are
      // gone even if the creator delete below is the step that fails, and the
      // poller has nothing left to import with.
      {
        const { error } = await supabase.from('creator_platform_accounts').delete().eq('creator_id', creator.id);
        if (error) return stepFailed('creator_platform_accounts', userId, error);
      }
      // `meals.creator_id` REFERENCES creators(id) with no ON DELETE rule, and it
      // is set on OTHER users' saved copies of this creator's meals (Discover
      // sends it with the save). Those meals belong to the people who saved
      // them and stay; they just stop pointing at a creator who is gone.
      {
        const { error } = await supabase.from('meals').update({ creator_id: null }).eq('creator_id', creator.id);
        if (error) return stepFailed('meals.creator_id', userId, error);
      }
      {
        const { error } = await supabase.from('creators').delete().eq('id', creator.id);
        if (error) return stepFailed('creators', userId, error);
      }
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
    //
    //    Written only while the profile still exists. A retry after the profile
    //    is already gone (the auth delete failed last time) would otherwise
    //    overwrite a good tombstone with nulls.
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('created_at, acquisition_source, subscribed_at, subscription_tier')
      .eq('id', userId)
      .maybeSingle();

    const { error: tombstoneError } = !profile ? { error: null } : await supabase
      .from('deleted_users')
      .upsert(
        {
          user_id: userId,
          signed_up_at: profile.created_at ?? null,
          acquisition_source: profile.acquisition_source ?? null,
          subscribed_at: profile.subscribed_at ?? null,
          subscription_tier: profile.subscription_tier ?? null,
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
    for (const table of ['creator_follows', 'creator_applications', 'meals', 'remembered_devices', 'otp_codes']) {
      const { error } = await supabase.from(table).delete().eq('user_id', userId);
      if (error) return stepFailed(table, userId, error);
    }

    // 4) Anonymize the marketing/lifecycle send log (user_id is nullable): keep the
    //    rows for aggregate reporting but scrub the PII and detach the profile.
    //
    //    Detached rather than kept-with-uuid, unlike the tables above, and the
    //    difference is what the row holds: this one has an email address in it.
    //    Scrubbing that is the whole point, and once it is scrubbed the row is
    //    only ever read as an aggregate, so there is nothing for a uuid to do.
    {
      const { error } = await supabase.from('email_sends').update({ email: '[deleted]', user_id: null }).eq('user_id', userId);
      if (error) return stepFailed('email_sends', userId, error);
    }

    // 5) Detach any preset meals still authored by this user (nullable author_id).
    {
      const { error } = await supabase.from('preset_meals').update({ author_id: null }).eq('author_id', userId);
      if (error) return stepFailed('preset_meals.author_id', userId, error);
    }

    // 5b) Their uploaded photos. After their own meals, creator row and preset
    //     meals are gone, so any row still pointing at one of these objects is
    //     someone else's, and that object stays (see lib/account-photos.ts).
    {
      const purge = await purgeUserPhotos(supabase, userId);
      if (!purge.ok) return stepFailed(`photos: ${purge.reason}`, userId, null);
      if (purge.kept > 0) {
        log({ event: 'ACCOUNT:DELETE', status: 'pending', userId, detail: `kept ${purge.kept} photo(s) still shown on other accounts` });
      }
    }

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
    return NextResponse.json(maybeInApp ? { success: true, notice: IN_APP_SUBSCRIPTION_NOTICE } : { success: true });
  } catch (error) {
    log({ event: 'ACCOUNT:DELETE', status: 'error', ip, error });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
