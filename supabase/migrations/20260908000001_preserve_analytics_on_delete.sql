-- Revenue on the subscription log, and analytics that survive a deletion.
--
-- ############################################################################
-- #  RUN THIS BEFORE DEPLOYING THE CODE THAT GOES WITH IT. NOT AFTER.        #
-- #                                                                          #
-- #  `preset_meal_saves.user_id` is NOT NULL REFERENCES user_profiles(id)    #
-- #  with NO ON DELETE clause, so it is NO ACTION -- it does not cascade, it #
-- #  BLOCKS. The account-delete route used to delete those saves by hand,    #
-- #  which is the only reason the profile delete underneath it ever          #
-- #  succeeded. The new route deliberately stops deleting them.              #
-- #                                                                          #
-- #  So on the old database, the new code cannot delete an account at all:   #
-- #  every deletion fails the constraint and returns a 500. Section 3 below  #
-- #  is what makes the new code work. Run it first.                          #
-- #                                                                          #
-- #  Rolling back is the same rule in reverse: put the old code back before  #
-- #  restoring the constraints, or deletions break the other way.            #
-- ############################################################################
--
-- TWO CHANGES, one reason: neither lifetime value nor retention was computable
-- from this database, and both failed for the same shape of reason -- the facts
-- were either never written or deleted along with the person.
--
--   1. `subscription_events` recorded THAT a subscription started and stopped,
--      and nothing about money. No amount, no currency, no interval. Revenue per
--      user lived only in Stripe, so LTV needed a Stripe export to answer at all.
--
--   2. Every behavioural table cascaded from `user_profiles`. A user who churned
--      and then deleted their account took their entire history with them --
--      every app open, every automation run, every subscription event -- so a
--      cohort that was 400 people in March is 380 today and will be 350 next
--      year. Retention curves computed over it bend upward for a reason that has
--      nothing to do with the product.
--
-- WHAT IS DELETED IS STILL DELETED. Nothing here keeps an email address, a name,
-- a Stripe id, a saved recipe, a device or an OTP. What survives is a uuid with
-- no row behind it and the timestamps of things that happened. See section 2 for
-- exactly what the tombstone holds and why each field is in it.
--
-- Idempotent; safe to re-run. Safe to run while the app is live: every column is
-- nullable with no default, so nothing is rewritten and no long lock is taken.


-- ── 1 · money on the subscription log ────────────────────────────────────────
--
-- HOW TO SUM THIS WITHOUT DOUBLE COUNTING, because the obvious way is wrong:
--
--     SELECT user_id, sum(amount_cents)
--     FROM subscription_events
--     WHERE event = 'payment_succeeded'      -- <- the WHERE is load-bearing
--     GROUP BY user_id;
--
-- `amount_cents` is populated ONLY on `payment_succeeded` rows, which is one per
-- invoice Stripe actually collected. `started` and `cancelled` are lifecycle
-- markers and carry NULL money on purpose: a `started` row with the first
-- month's amount on it, summed alongside the payment row for that same month,
-- counts the first month twice. `interval` is plan metadata rather than money
-- and is set wherever Stripe hands it over, on any of the three.

ALTER TABLE public.subscription_events
  -- Minor units, as Stripe reports them. Integer cents rather than a float:
  -- money summed as a float over a few thousand rows drifts, and it drifts in
  -- the direction of whoever wrote the query.
  ADD COLUMN IF NOT EXISTS amount_cents integer,
  -- Three-letter ISO, lowercased as Stripe sends it. Stored rather than assumed:
  -- a sum over mixed currencies is a wrong number that looks right, and the only
  -- thing that can stop someone computing one is the column being there.
  ADD COLUMN IF NOT EXISTS currency text,
  -- 'month' | 'year'. What separates 40 dollars of monthly from 40 dollars of
  -- annual, which is the whole of the difference between two very different LTVs.
  ADD COLUMN IF NOT EXISTS interval text;

-- Revenue is always asked per user over a window.
CREATE INDEX IF NOT EXISTS idx_subscription_events_user_event
  ON public.subscription_events (user_id, event, created_at);


-- ── 2 · the tombstone ────────────────────────────────────────────────────────
--
-- Preserving `app_opens` without this preserves activity that cannot be
-- cohorted. Every retention question is "of the people who signed up in March,
-- how many opened it in June", and the signup date lives on `user_profiles` --
-- the row that is about to be deleted. So the handful of non-PII facts that
-- anchor a cohort are copied out before it goes.
--
-- WHAT IS DELIBERATELY NOT HERE: email, display name, phone, Stripe customer and
-- subscription ids, saved recipes, devices, OTPs. Everything in this table is
-- either a timestamp, a tier word, or a creator handle the user chose to arrive
-- through. `user_id` is a uuid that no longer resolves to anything -- it is what
-- lets two rows be told apart, which is what a cohort count needs, and it is not
-- a way back to a person.

CREATE TABLE IF NOT EXISTS public.deleted_users (
  -- The same uuid the surviving analytics rows carry. NOT a foreign key: the row
  -- it pointed at is the row being deleted.
  user_id       uuid        NOT NULL PRIMARY KEY,
  -- The cohort anchor. Without it every surviving app_open is uncohortable.
  signed_up_at  timestamptz,
  deleted_at    timestamptz NOT NULL DEFAULT now(),
  -- The creator handle that brought them in, when there was one. This is what
  -- makes "do referred users retain better" answerable after churn, which is the
  -- population it most matters for.
  acquisition_source text,
  -- First paid conversion, and the tier they were on when they left. Together
  -- with the payment rows below, that is a complete subscription lifetime.
  subscribed_at timestamptz,
  subscription_tier text
);

CREATE INDEX IF NOT EXISTS idx_deleted_users_signed_up ON public.deleted_users (signed_up_at);

-- RLS on with no policy, matching 20260905000004: denies anon outright and is
-- invisible to nobody who matters, because only the service role reads it.
ALTER TABLE public.deleted_users ENABLE ROW LEVEL SECURITY;


-- ── 3 · stop the cascade taking the analytics ────────────────────────────────
--
-- Found by sweeping the catalogue rather than by naming constraints. Two of
-- these tables were created in the Supabase dashboard and their DDL is not in
-- this repository at all, so a hand-written `DROP CONSTRAINT <name>` would work
-- on one machine and fail on the next. This drops whatever foreign key each of
-- these columns actually has onto `user_profiles`, by looking it up.
--
-- What is NOT touched, and must not be:
--   * automation_steps.run_id -> automation_runs   a deleted RUN still takes its
--     steps; that cascade is about a run, not about a person.
--   * preset_meal_saves.preset_meal_id -> preset_meals   a deleted MEAL still
--     takes its saves, which is what keeps the creator-deletion path working.
--   * every FK on a table holding personal content (meals, remembered_devices,
--     otp_codes, creator_applications). Those rows are meant to go.

DO $$
DECLARE
  target record;
  fk     record;
  dropped int := 0;
BEGIN
  FOR target IN
    SELECT * FROM (VALUES
      ('app_opens',           'user_id'),
      ('automation_runs',     'user_id'),
      ('automation_steps',    'user_id'),
      ('subscription_events', 'user_id'),
      ('preset_meal_saves',   'user_id')
    ) AS t(tbl, col)
  LOOP
    -- Skip a table this database does not have rather than aborting the file.
    CONTINUE WHEN to_regclass('public.' || target.tbl) IS NULL;

    FOR fk IN
      SELECT con.conname
      FROM pg_constraint con
      JOIN pg_class      rel  ON rel.oid = con.conrelid
      JOIN pg_namespace  nsp  ON nsp.oid = rel.relnamespace
      JOIN pg_class      frel ON frel.oid = con.confrelid
      WHERE con.contype = 'f'
        AND nsp.nspname = 'public'
        AND rel.relname = target.tbl
        AND frel.relname = 'user_profiles'
        AND con.conkey = ARRAY[(
          SELECT attnum FROM pg_attribute
          WHERE attrelid = rel.oid AND attname = target.col AND NOT attisdropped
        )]::smallint[]
    LOOP
      EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', target.tbl, fk.conname);
      dropped := dropped + 1;
      RAISE NOTICE 'dropped % on %.%', fk.conname, target.tbl, target.col;
    END LOOP;
  END LOOP;

  RAISE NOTICE 'preserve-analytics: % foreign key(s) dropped', dropped;
END $$;

-- The columns stay NOT NULL where they were. A surviving row keeps the uuid it
-- was written with -- that is the point, and it is what a nullable column with
-- ON DELETE SET NULL would have thrown away: every deleted user's rows would
-- collapse into one anonymous heap and stop being countable as people.


-- ── 4 · confirm ──────────────────────────────────────────────────────────────
-- Expect zero rows. Any row returned is a cascade still standing.
SELECT rel.relname AS still_cascading, con.conname
FROM pg_constraint con
JOIN pg_class     rel  ON rel.oid = con.conrelid
JOIN pg_class     frel ON frel.oid = con.confrelid
WHERE con.contype = 'f'
  AND frel.relname = 'user_profiles'
  AND rel.relname IN ('app_opens', 'automation_runs', 'automation_steps',
                      'subscription_events', 'preset_meal_saves');
