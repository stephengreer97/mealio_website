-- When a poll last failed. MEAL-96.
-- Run in Supabase SQL Editor. Safe to re-run.

-- ---------------------------------------------------------------------------
-- The poller has written `creator_source_state.last_error` and `last_status` on
-- every failure since it shipped, so the *reason* was always stored. When it
-- broke was not, and could not be inferred: `last_polled_at` deliberately does
-- not advance on a failure, because a failed read recorded as a poll makes the
-- next successful one treat a whole back catalogue as new.
--
-- So the timestamp had nowhere to live, and the admin Sources tab cannot say
-- "failing since Tuesday" without it — which is the difference between a source
-- that broke this morning and one nobody has looked at for a week.
--
-- Written only on a failure and never cleared by a later success: an operator
-- asking "when did this start going wrong" is often asking about a source that
-- is working again now.
-- ---------------------------------------------------------------------------

ALTER TABLE creator_source_state
  ADD COLUMN IF NOT EXISTS last_failed_at timestamptz;
