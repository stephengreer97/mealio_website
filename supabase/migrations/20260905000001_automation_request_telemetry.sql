-- MEAL-219. The network rail's requests, stored as facts rather than as prose.
--
-- Stephen, 2026-09-05: "now that we are 100% on network... it should be much
-- easier to collect data since it all traces back to http codes."
--
-- It does, and none of it was reaching this database. Every rail computes an
-- HTTP status -- it is what the retry policy decides on -- and there were 25
-- telemetry calls in the cart engine carrying exactly zero of them. The one
-- status that arrived did so smuggled inside a reason STRING as 'http-403', so
-- the single most queryable fact about a run had to be parsed out of text.
--
-- FOUR NEW COLUMNS, and they are columns rather than `detail` keys on purpose.
-- The questions worth asking are "which stores are 5xx-ing this week" and "did
-- the 429s stop after the backoff shipped", and neither is answerable against
-- unindexed jsonb without a full scan.
--
-- SAFE TO RUN WHILE THE APP IS LIVE. Every column is nullable with no default,
-- so this rewrites no rows and takes no long lock. Existing rows keep NULL and
-- always will: automation_steps upserts with ignoreDuplicates, so an old row can
-- never gain a value here. The dashboard must therefore render correctly when
-- these are NULL, which is every row written before this ships.

-- ── 1 · the columns ──────────────────────────────────────────────────────────

ALTER TABLE public.automation_steps
  -- The store's own answer. NULL means the request never got one -- a dropped
  -- connection or an abort -- which is a different fact from a 500 and must
  -- stay distinguishable from it.
  ADD COLUMN IF NOT EXISTS http_status smallint,
  -- session | search | add | cart_read. NOT derived from `step`, which cannot
  -- answer it: that vocabulary was named for the DOM era and one of its values
  -- is literally 'add_click'.
  ADD COLUMN IF NOT EXISTS phase text,
  -- How many times the request was ASKED. 1 means it worked first time.
  -- Distinct from detail.attempt, which only the deleted click path ever set.
  ADD COLUMN IF NOT EXISTS attempts smallint,
  -- Which RAIL answered, which is not the same as store_id: fifteen Albertsons
  -- banners and every Instacart tenant share one implementation, and a
  -- rail-level regression shows up as fifteen unrelated store problems without
  -- this column.
  ADD COLUMN IF NOT EXISTS rail text;

-- Deliberately NOT a CHECK constraint on `phase`. A newer client shipping a
-- fifth phase must not have its rows rejected by an older database -- losing the
-- rows we most want to see, at exactly the moment something new is happening.
-- The app validates against STEP_PHASES before sending; this stores what
-- arrives.

COMMENT ON COLUMN public.automation_steps.http_status IS
  'MEAL-219. The store''s HTTP status for this request. NULL = no answer at all (dropped/aborted), which is not the same as a 5xx.';
COMMENT ON COLUMN public.automation_steps.phase IS
  'MEAL-219. session|search|add|cart_read. Unconstrained on purpose so a newer client is never rejected.';
COMMENT ON COLUMN public.automation_steps.attempts IS
  'MEAL-219. Times asked, including the first. >1 means the retry policy fired.';
COMMENT ON COLUMN public.automation_steps.rail IS
  'MEAL-219. The rail implementation, not the banner. albertsons covers 15 stores; instacart covers every tenant.';

-- ── 2 · the index the dashboard actually queries ─────────────────────────────
--
-- Per store, per status, over a window -- the status histogram. Partial on
-- http_status IS NOT NULL so it does not carry a row for every pre-MEAL-219
-- step, which is most of the table and none of the answers.

CREATE INDEX IF NOT EXISTS idx_automation_steps_store_status_time
  ON public.automation_steps (store_id, http_status, occurred_at DESC)
  WHERE http_status IS NOT NULL;

-- The phase funnel: per store, per phase, over a window.
CREATE INDEX IF NOT EXISTS idx_automation_steps_store_phase_time
  ON public.automation_steps (store_id, phase, occurred_at DESC)
  WHERE phase IS NOT NULL;
