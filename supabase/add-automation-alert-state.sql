-- What an operator has already been emailed about, per store. MEAL-6.
-- Run in Supabase SQL Editor. Safe to re-run.

-- ---------------------------------------------------------------------------
-- The alert is about a TRANSITION — a store that was fine and is not any more —
-- and every fact needed to decide whether a store is broken right now is
-- already in `automation_runs` and `automation_steps`. What is missing is the
-- other half of a transition: what we last said about this store, so a problem
-- that has not moved since yesterday can be recognised as a standing one rather
-- than announced again.
--
-- Without it the only honest implementations are both wrong. Emailing whenever a
-- store is alerting mails every admin every morning about one broken store until
-- somebody fixes it, which is how the alert earns a filter rule — and an alert
-- in a folder is worse than no alert, because everyone believes it is working.
-- Emailing only on the first sweep after a deploy means a store that breaks,
-- gets fixed, and breaks again never raises the second alarm.
--
-- The REASONS are stored, not a boolean, because they are different problems
-- with different fixes: a store that was drifting and is now also being walled
-- off by a WAF has changed in a way worth a second email, and one that is still
-- only drifting has not. The set only ever grows while a store stays unhealthy,
-- so the same fact bouncing in and out cannot raise a third — the mark stays at
-- the worst we have said.
--
-- Cleared back to NULL when the store stops alerting for every reason, which is
-- what arms the next alert. `alerted_at` is not read by the sweep; it is there
-- so "when were we told about this?" is answerable from the row rather than
-- from somebody's inbox.
--
-- `store_id` is text and matches `automation_runs.store_id` / `stores.id`. No
-- foreign key on purpose: a store id that appears in telemetry but not yet in
-- the catalog must still be alertable, and this table must never be the reason
-- an alert cannot be recorded.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS automation_alert_state (
  store_id   text PRIMARY KEY,
  alerted_reasons text[],
  alerted_at timestamptz
);

-- Service-role only. Nothing user-facing reads this; the sweep runs from
-- /api/cron/daily with the service key, and RLS with no policy denies everyone
-- else — which is the intent, not an oversight.
ALTER TABLE automation_alert_state ENABLE ROW LEVEL SECURITY;
