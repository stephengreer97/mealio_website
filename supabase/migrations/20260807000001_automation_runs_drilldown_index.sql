-- MEAL-143: indexes for the per-run drilldown's "recent failing runs" list.
--
-- OPTIONAL. The drilldown works without this migration — every query it issues is
-- correct and bounded either way, and nothing in the code checks for these indexes.
-- Applying it changes how fast one list is, not what it answers. It is written as a
-- migration rather than left as a comment because it is the one new query shape the
-- schema does not already serve, and next year's version of this question deserves
-- to find the answer in the tree rather than re-derive it.
--
-- Run in the Supabase SQL editor. Safe to re-run.
--
-- ── What is already covered, and needed nothing ──────────────────────────────
--
-- The TRACE read — `WHERE run_id = $1 ORDER BY seq` — is served exactly by
-- `automation_steps_run_seq_key`, the unique index ingest already relies on for
-- idempotency. It is the leading column and then the sort column, so the read is an
-- index scan returning rows in order with no sort step. `idx_automation_steps_run`
-- (run_id alone) is redundant with it for this purpose and is left alone: dropping
-- an index is not worth doing on a guess about which of them the planner prefers.
--
-- So the drilldown's expensive half needed no SQL at all. That is worth stating
-- plainly, because "add an index on run_id" was the assumed shape of this work and
-- the index has existed since the steps table shipped.
--
-- ── What this adds ───────────────────────────────────────────────────────────
--
-- The LIST read is `WHERE started_at >= $1 [AND store_id = $2] ORDER BY started_at
-- DESC LIMIT 50`. `automation_runs` currently has `(user_id, started_at)` and
-- `(store_id)`. Neither leads with `started_at`, and the `(store_id)` index cannot
-- supply the ordering, so both shapes of the list end in a sort over every run in
-- the window — fine today, and the wrong thing to leave behind on an interactive
-- query an operator hits repeatedly while chasing one failure.
--
-- Both indexes are DESC to match the query's ORDER BY. Postgres can walk an index
-- backwards, so ASC would also work; DESC simply makes the intent legible.

-- The unscoped list: recent runs across every store.
CREATE INDEX IF NOT EXISTS idx_automation_runs_started
  ON automation_runs (started_at DESC);

-- The scoped list, which is how someone actually arrives here — from a funnel row
-- that named one store. store_id first so the equality prefixes the range, then
-- started_at so the LIMIT can stop walking early instead of sorting the match set.
CREATE INDEX IF NOT EXISTS idx_automation_runs_store_started
  ON automation_runs (store_id, started_at DESC);

-- Deliberately NOT indexed: `status` / `outcome`, the columns the failing filter
-- reads. The predicate is a three-way OR over two low-cardinality columns, which a
-- b-tree cannot help with in a way the planner would choose, and it is applied to a
-- set already narrowed by the window above. A partial index over "not a clean
-- success" would be the version worth having if this ever gets slow, and it should
-- be written then against a real plan rather than guessed at now.
