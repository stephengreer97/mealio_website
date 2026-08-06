-- MEAL-4's failure taxonomy, stored.
--
-- The app now attaches a `code` to every non-ok terminal step —
--   selector_miss | waf_block | auth_required | no_candidates |
--   match_rejected | confirm_failed | timeout | nav_failed
-- — as a TOP-LEVEL field on the step record, not inside `detail`. The server was
-- dropping it on the floor because there was nowhere to put it. This is that
-- somewhere.
--
-- Why it matters for the funnel dashboard (MEAL-2): `outcome` alone says a step
-- failed, not why. "HEB's add_click is at 60%" is not actionable; "HEB's
-- add_click is at 60% and every failure is selector_miss" is a config push, and
-- "…every failure is waf_block" is an entirely different problem that must never
-- be averaged into the same number.
--
-- NO BACKFILL IS POSSIBLE. Step rows upsert with ignoreDuplicates, so a
-- redelivered batch is a no-op and pre-existing rows never gain a code. Expect
-- `code IS NULL` for:
--   * every row written before the app build that emits codes ships, and
--   * every ok/skipped row, forever — a code only describes a failure.
-- The dashboard buckets those as "uncoded" rather than showing a misleading zero.
--
-- Additive and re-runnable. Run this in the Supabase SQL editor BEFORE deploying
-- the code that reads it; until then the funnel simply reports everything uncoded.

ALTER TABLE automation_steps
  ADD COLUMN IF NOT EXISTS code text;

-- Mirrors idx_automation_steps_store_step_time for the query the dashboard's
-- failure-taxonomy breakdown actually runs: one store, one code, newest first.
CREATE INDEX IF NOT EXISTS idx_automation_steps_store_code_time
  ON automation_steps (store_id, code, occurred_at DESC);
