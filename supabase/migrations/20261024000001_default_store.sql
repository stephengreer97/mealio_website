-- user_profiles.default_store_id: the one store an account shops at.
--
-- Additive and safe to run before any code that reads it: older servers and
-- app versions never select it. Empty until the backfill
-- (scripts/backfill-default-store.mts) or the user's first save sets it.
--
-- With a default set, the server keeps every one of the user's meals at that
-- store (meals.store_id) and keeps each ingredient's choices per store in
-- `storeSearchTerms` / `storeProducts`, so old app versions, which still read
-- one store per meal, see all their meals under the default.

alter table public.user_profiles
  add column if not exists default_store_id text;
