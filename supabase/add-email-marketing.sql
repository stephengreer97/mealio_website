-- Email marketing foundation (M0)
-- Adds per-user opt-out + unsubscribe token, and an email_sends log used for
-- suppression, idempotency (dedup_key), and Resend webhook event tracking
-- (opens/clicks/bounces) that powers the admin dashboard metrics.
--
-- gen_random_uuid() is built into Postgres 13+ (Supabase is 15) — no extension
-- needed. Re-runnable (IF NOT EXISTS everywhere).

ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS marketing_opt_out boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS unsubscribe_token uuid    NOT NULL DEFAULT gen_random_uuid();

CREATE UNIQUE INDEX IF NOT EXISTS user_profiles_unsubscribe_token_key
  ON user_profiles (unsubscribe_token);

-- One row per marketing/lifecycle email we attempt. dedup_key makes cron
-- re-runs idempotent; resend_message_id links Resend webhook events back.
CREATE TABLE IF NOT EXISTS email_sends (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid REFERENCES user_profiles (id) ON DELETE SET NULL,
  email             text NOT NULL,
  type              text NOT NULL,                 -- campaign, e.g. 'user_upsell_1', 'creator_reminder'
  dedup_key         text,                          -- unique per (campaign, user, window)
  resend_message_id text,
  status            text NOT NULL DEFAULT 'sent',  -- sent|delivered|opened|clicked|bounced|complained|suppressed|error
  error             text,
  opened_at         timestamptz,
  clicked_at        timestamptz,
  sent_at           timestamptz NOT NULL DEFAULT now()
);

-- Partial unique index: many rows may have NULL dedup_key, but a non-null key
-- can appear only once (the idempotency guarantee).
CREATE UNIQUE INDEX IF NOT EXISTS email_sends_dedup_key_key
  ON email_sends (dedup_key) WHERE dedup_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_email_sends_type              ON email_sends (type);
CREATE INDEX IF NOT EXISTS idx_email_sends_resend_message_id ON email_sends (resend_message_id);
CREATE INDEX IF NOT EXISTS idx_email_sends_user_id           ON email_sends (user_id);
