-- Where a paid tier came from: user_profiles.subscription_source.
--
-- ############################################################################
-- #  RUN THIS BEFORE DEPLOYING THE CODE THAT GOES WITH IT (branch            #
-- #  feat/subscription-source). That code reads and writes the column, and   #
-- #  PostgREST refuses a select or update naming a column that does not      #
-- #  exist: on the old database every payment webhook would fail.            #
-- #                                                                          #
-- #  The old code ignores the column, so running this early is harmless.     #
-- ############################################################################
--
-- WHY. `subscription_tier` says a user has Full Access and nothing about who
-- gave it to them. Three different things grant it:
--
--   stripe      a web subscription (payments/webhook)
--   app_store   an in-app purchase through RevenueCat, by store
--   play_store
--   store       a RevenueCat purchase from any other store (promotional etc.)
--   comp        Full Access comped to an approved creator (admin/applications)
--
-- and any of their "it ended" events used to set the tier to free, whichever
-- one had granted it. So a Stripe cancellation could take access from someone
-- paying through the App Store, and a RevenueCat EXPIRATION or a Stripe
-- subscription.updated could take a comped creator's access away. The code
-- that goes with this only lets a system end access IT granted, and never
-- ends `comp`.
--
-- `unknown` is for rows this backfill cannot place (below). It keeps today's
-- behaviour exactly: either system may end it. The next real purchase event
-- for that user overwrites it with the true source.
--
-- NULL means free, or never set.
--
-- Idempotent; safe to re-run. Safe to run while the app is live: one nullable
-- column, a CHECK, and a backfill that only touches rows where the column is
-- still NULL.

ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS subscription_source text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'user_profiles_subscription_source_check'
  ) THEN
    ALTER TABLE user_profiles
      ADD CONSTRAINT user_profiles_subscription_source_check
      CHECK (subscription_source IS NULL
             OR subscription_source IN ('stripe', 'app_store', 'play_store', 'store', 'comp', 'unknown'));
  END IF;
END $$;

-- BACKFILL, in this order, each step only filling what is still NULL.
--
-- 1. Approved creators who are paid are comped, even if they also hold a Stripe
--    subscription: the comp is what keeps them paid if that subscription ends,
--    so it is the source that must survive. (On 2026-09-18: 2 rows, one of
--    which also had a Stripe subscription.)
UPDATE user_profiles p
   SET subscription_source = 'comp'
 WHERE p.subscription_tier = 'paid'
   AND p.subscription_source IS NULL
   AND EXISTS (SELECT 1 FROM creators c WHERE c.user_id = p.id);

-- 2. Paid with a Stripe subscription on record. (On 2026-09-18: 0 rows.)
UPDATE user_profiles
   SET subscription_source = 'stripe'
 WHERE subscription_tier = 'paid'
   AND subscription_source IS NULL
   AND stripe_subscription_id IS NOT NULL;

-- 3. Everything else that is paid. Store purchases leave nothing behind in this
--    database (RevenueCat events write no subscription_events rows), so a store
--    buyer and a hand-granted account look identical here. `unknown` says so
--    instead of guessing, and behaves as before. (On 2026-09-18: 5 rows.)
UPDATE user_profiles
   SET subscription_source = 'unknown'
 WHERE subscription_tier = 'paid'
   AND subscription_source IS NULL;

-- Check: every paid row has a source, and no free row has one.
--   SELECT subscription_tier, subscription_source, count(*)
--     FROM user_profiles GROUP BY 1, 2 ORDER BY 1, 2;
