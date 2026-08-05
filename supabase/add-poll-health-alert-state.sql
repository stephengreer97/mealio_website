-- What an operator has already been emailed about. MEAL-109.
-- Run in Supabase SQL Editor. Safe to re-run.

-- ---------------------------------------------------------------------------
-- The alert is about a TRANSITION — a source that was fine and is not any more —
-- and every fact needed to compute the current status was already stored. What
-- was missing is the other half of a transition: what we last decided about this
-- source, so a status that has not moved since the last sweep can be recognised
-- as a standing problem rather than announced again.
--
-- Without it the only honest implementations are both wrong. Emailing whenever
-- the status is unhealthy sends the same digest every day until somebody fixes
-- the source, which is how an operator learns to filter these to a folder.
-- Emailing only on the first pass after a deploy means a source that breaks,
-- gets fixed, and breaks again never raises the second alert.
--
-- The STATUS is stored, not a boolean, because `failing` and `silent` are
-- different problems: a source that was quietly producing nothing and has now
-- started erroring has changed in a way worth a second email.
--
-- Cleared back to NULL when the source recovers, which is what arms the next
-- alert. `health_alerted_at` is not read by the sweep — it is there so "when
-- were we told about this?" is answerable from the row rather than from an inbox.
-- ---------------------------------------------------------------------------

ALTER TABLE creator_source_state
  ADD COLUMN IF NOT EXISTS health_alerted_status text,
  ADD COLUMN IF NOT EXISTS health_alerted_at timestamptz;
