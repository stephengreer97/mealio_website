-- Creator acquisition attribution — Phase 1
-- Adds attribution + subscription-timing columns and reserves creator handles.
-- Idempotent: safe to re-run.

-- user_profiles: which creator brought this user in (a creator handle string).
-- Plain text, NO foreign key — deleting a creator must never break/orphan the
-- users they referred. subscribed_at records the first real paid conversion.
ALTER TABLE public.user_profiles ADD COLUMN IF NOT EXISTS acquisition_source text;
ALTER TABLE public.user_profiles ADD COLUMN IF NOT EXISTS subscribed_at       timestamptz;
CREATE INDEX IF NOT EXISTS idx_user_profiles_acquisition_source
  ON public.user_profiles (acquisition_source);

-- creators.handle: the immutable referral path (mealio.co/<handle>). The column
-- already exists in the live DB (used in app code) but is missing from schema.sql;
-- ensure it, and back the app-level uniqueness check with a case-insensitive
-- unique index (handles are stored lowercased by normalizeHandle()).
ALTER TABLE public.creators ADD COLUMN IF NOT EXISTS handle text;
CREATE UNIQUE INDEX IF NOT EXISTS creators_handle_lower_key
  ON public.creators (lower(handle)) WHERE handle IS NOT NULL;

-- creator_applications.handle: reserve the handle at application time so two
-- applicants cannot claim the same path before either is approved.
ALTER TABLE public.creator_applications ADD COLUMN IF NOT EXISTS handle text;
CREATE UNIQUE INDEX IF NOT EXISTS creator_applications_handle_lower_key
  ON public.creator_applications (lower(handle)) WHERE handle IS NOT NULL;
