-- MEAL-143: one generated column and two indexes for the per-run drilldown's
-- "recent failing runs" list.
--
-- The drilldown works without this migration and degrades explicitly: the list
-- route tries its filter with `partial_adds`, retries without it on Postgres
-- `42703`, and restores the caveat saying so. Applying it changes WHAT ONE LIST
-- FINDS (the column) and how fast it finds it (the indexes).
--
-- Run in the Supabase SQL editor. Safe to re-run.
--
-- ── The generated column ─────────────────────────────────────────────────────
--
-- The failing filter's fourth term. A run reporting `outcome = 'success'` while
-- adding fewer items than it was asked for is a failure — a selector regression
-- that drops one item per basket looks exactly like this — and PostgREST cannot
-- express it: it compares a column to a VALUE, never to another column, and it
-- cannot ORDER BY a computed difference either. So the only way to filter on it is
-- to have a column that already holds the answer.
--
-- Without it the default failing list is EMPTY for that regression, and the
-- documented workaround (filter=all, read the PARTIAL badge) reads a page of the
-- most recent runs of any kind — so at a store doing hundreds of runs a day the
-- broken ones are diluted into a mostly-clean sample and read as noise.
--
-- NULL, not FALSE, when either count is missing: `items_requested` and
-- `items_added` are nullable, a comparison against NULL is NULL, and `is.true`
-- therefore does not match those rows. That is the right answer — a run that never
-- reported its counts is not evidence of a partial add — and it is why the filter
-- term is `is.true` rather than `neq.false`.
--
-- STORED because Postgres has no VIRTUAL generated columns. Adding one rewrites
-- the table and takes an ACCESS EXCLUSIVE lock for the duration; `automation_runs`
-- is small and append-only, so this is seconds, but it is not a zero-cost DDL and
-- is worth running when nobody is mid-run.
--
-- Idempotent via IF NOT EXISTS, which Postgres supports for ADD COLUMN including
-- generated ones.

ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS partial_adds boolean
  GENERATED ALWAYS AS (items_added < items_requested) STORED;
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
-- ── What the indexes add ─────────────────────────────────────────────────────
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

-- Deliberately NOT indexed: `status` / `outcome` / `partial_adds`, the columns the
-- failing filter reads. The predicate is a four-way OR over low-cardinality
-- columns, which a b-tree cannot help with in a way the planner would choose, and
-- it is applied to a set already narrowed by the window above. A partial index over
-- "not a clean success" would be the version worth having if this ever gets slow,
-- and it should be written then against a real plan rather than guessed at now.
