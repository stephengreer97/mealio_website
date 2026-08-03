-- Operator-driven sync runs (MEAL-90).
-- Run in Supabase SQL Editor. Safe to re-run.
--
-- Additive only: nothing in `add-creator-sources.sql` changes. `creator_source_items`
-- stays exactly the record it already is — this table is the *batch* around it.

-- ---------------------------------------------------------------------------
-- One row per "an operator pressed Sync"
--
-- A 200-item selection does not fit in a Vercel function, so the run has to
-- outlive the request that created it. That means run state is a row, not a
-- variable: which items were selected, how far the worker got, and whether the
-- creator has been told. A process-local queue would lose all three on the first
-- cold start, and lose them silently.
--
-- `items` is jsonb rather than a child table on purpose. The whole selection is
-- written once and read back whole every time the screen polls; there is no
-- query that wants one item without its siblings, and no join anyone needs. The
-- durable per-item record — the one the poller and the next operator read — is
-- `creator_source_items`, which every finished item still writes to.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS creator_sync_runs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id     uuid NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
  -- Matches creator_source_items.source, so the (creator, source, item) key
  -- lines up between the batch and the record it writes.
  source         text NOT NULL,
  -- 'link'    a single pasted URL
  -- 'catalog' a selection made from the feed checklist
  mode           text NOT NULL,
  -- 'queued'  created, no worker has taken it yet
  -- 'running' a worker holds the lease
  -- 'done'    every item reached a terminal outcome
  status         text NOT NULL DEFAULT 'queued',
  -- Default ON at the UI. Stored per run because it is a decision made about
  -- this batch, and the run is what sends the email.
  notify_creator boolean NOT NULL DEFAULT true,
  -- The admin who triggered it. Direct publish is defensible because a human
  -- read the extraction first; this is which human.
  requested_by   uuid,
  -- [{ itemId, url, title, publishedAt, status, detail, mealId, mealName, costUsd }]
  items          jsonb NOT NULL DEFAULT '[]',
  -- Held by whichever worker is currently processing. Two browser tabs polling
  -- the same run must not import the same post twice, and a worker that dies
  -- mid-chunk must not wedge the run forever — hence a lease with an expiry
  -- rather than a boolean.
  lease_until    timestamptz,
  -- Claimed before the notification is sent, so a retry cannot send it twice.
  notified_at    timestamptz,
  notify_error   text,
  created_at     timestamptz DEFAULT now(),
  started_at     timestamptz,
  finished_at    timestamptz,
  updated_at     timestamptz DEFAULT now()
);

ALTER TABLE creator_sync_runs
  DROP CONSTRAINT IF EXISTS creator_sync_runs_status_check;
ALTER TABLE creator_sync_runs
  ADD CONSTRAINT creator_sync_runs_status_check
  CHECK (status IN ('queued', 'running', 'done'));

ALTER TABLE creator_sync_runs
  DROP CONSTRAINT IF EXISTS creator_sync_runs_mode_check;
ALTER TABLE creator_sync_runs
  ADD CONSTRAINT creator_sync_runs_mode_check
  CHECK (mode IN ('link', 'catalog'));

-- The admin screen's query: this creator's runs, newest first.
CREATE INDEX IF NOT EXISTS idx_sync_runs_creator
  ON creator_sync_runs (creator_id, created_at DESC);

-- Unfinished work, for resuming a run whose operator closed the tab.
CREATE INDEX IF NOT EXISTS idx_sync_runs_unfinished
  ON creator_sync_runs (status)
  WHERE status <> 'done';

-- Written only by admin server routes using the service role, which bypasses
-- RLS. Enabled with no permissive policy so the anon and authenticated keys are
-- denied outright.
ALTER TABLE creator_sync_runs ENABLE ROW LEVEL SECURITY;
