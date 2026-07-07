-- Idempotency for the Stripe webhook's subscription_events log. Stripe retries
-- deliver the same event.id more than once (on any non-2xx or at-least-once
-- delivery), double-counting 'started'/'cancelled' rows. A unique
-- stripe_event_id lets the webhook upsert(onConflict) so retries no-op.
--
-- Additive + backward-compatible (existing rows keep stripe_event_id = NULL).
-- Run this in the Supabase SQL editor BEFORE deploying the code that sets it.

ALTER TABLE subscription_events
  ADD COLUMN IF NOT EXISTS stripe_event_id text;

-- Partial unique index: legacy rows with NULL stripe_event_id are exempt.
CREATE UNIQUE INDEX IF NOT EXISTS subscription_events_stripe_event_id_key
  ON subscription_events (stripe_event_id) WHERE stripe_event_id IS NOT NULL;
