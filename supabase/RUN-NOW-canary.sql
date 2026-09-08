-- MEAL-7. The nightly canary: what to run per store, and what happened.
--
-- TWO TABLES, because they answer different questions and change at different
-- rates. A plan is edited by hand, rarely, by a person looking at a shelf. A
-- result is written by a machine, nightly, and is never edited.

-- ── What to run ─────────────────────────────────────────────────────────────
--
-- Only the two CURATED lines live here. The other three (a plain add, a
-- by-weight item, and something nothing on earth matches) need no curation and
-- are in code, because a line that needs a human before the canary can run at
-- all is a line that stops the canary running.
--
-- A NULL or blank field SKIPS that branch. That is deliberate: a branch we are
-- honestly not testing beats one we are pretending to, and inventing a
-- plausible-looking out-of-stock item tests nothing while reporting confidently.
CREATE TABLE IF NOT EXISTS canary_plans (
  store_id           text PRIMARY KEY,
  meal_name          text NOT NULL DEFAULT 'Canary',
  out_of_stock_item  text,
  unmatched_item     text,
  enabled            boolean NOT NULL DEFAULT true,
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- ── What happened ───────────────────────────────────────────────────────────
--
-- `ran` is false when the RIG was the problem -- device asleep, not signed in,
-- app missing. Those must never read as a store failure: an unplugged night
-- that shows up red trains everyone to ignore the colour, which costs more than
-- the missed run. `passed` is therefore nullable, and means nothing when ran is
-- false.
CREATE TABLE IF NOT EXISTS canary_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id      text NOT NULL,
  started_at    timestamptz NOT NULL DEFAULT now(),
  ran           boolean NOT NULL,
  skip_reason   text,
  passed        boolean,
  shape         text NOT NULL DEFAULT 'single',   -- single | combination | repeat
  lines         jsonb,                            -- the scored verdict, per item
  detail        jsonb,
  automation_run_id uuid                          -- the run its telemetry came from
);

CREATE INDEX IF NOT EXISTS canary_runs_store_time_idx
  ON canary_runs (store_id, started_at DESC);

-- Both tables are admin-only and are read and written through API routes using
-- the service role, exactly like automation_runs. RLS is enabled so that a
-- client key cannot reach them directly even by accident.
ALTER TABLE canary_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE canary_runs  ENABLE ROW LEVEL SECURITY;
