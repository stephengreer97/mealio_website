-- Four columns the review passes asked for and the no-migrations rule withheld.
-- MEAL-75 / MEAL-93 / MEAL-94.
-- Run in Supabase SQL Editor. Safe to re-run.

-- ---------------------------------------------------------------------------
-- 1. Ordering the poll queue in SQL, not in memory
--
-- `refreshExpiringTokens`' sibling, the creator poll, reads eligible creators
-- with a LIMIT and then sorts the batch by longest-waiting in JavaScript.
-- Sorting after the cut only works while the cut holds everyone: past the limit
-- Postgres returns an arbitrary page, the sort orders that page, and the
-- creators outside it are never polled again. No error, no signal — the exact
-- silent-starvation shape this codebase has now been bitten by twice.
--
-- Named for what it is rather than for what it looks like. There is already a
-- `creator_source_state.last_polled_at`, and it answers a different question:
-- "when did we last successfully READ this source", which deliberately does not
-- advance on a failure — because a failed read recorded as a poll makes the next
-- successful one treat a whole back catalogue as new. This column answers "when
-- was this creator last at the front of the queue", and it advances every turn
-- whatever the outcome, so one permanently-failing creator cannot hold a slot
-- forever. Two columns, two facts; calling them both `last_polled_at` invited
-- exactly one bug and this name closes it.
--
-- Null sorts first on ASC (Postgres puts NULLs last, so the poller asks for
-- `nullsFirst`) and that is the behaviour wanted: a creator never polled is the
-- one who has waited longest.
--
-- Already applied and since renamed in place. On a database that ran the earlier
-- version of this file:
--   ALTER TABLE creators RENAME COLUMN last_polled_at TO poll_queue_position_at;
-- The index follows the rename; nothing else needs doing.
-- ---------------------------------------------------------------------------

ALTER TABLE creators
  ADD COLUMN IF NOT EXISTS poll_queue_position_at timestamptz;

-- The poll query: opted-in creators with a source, longest-waiting first.
CREATE INDEX IF NOT EXISTS idx_creators_poll_order
  ON creators (poll_queue_position_at)
  WHERE import_opt_in = true AND primary_source <> 'none';

-- ---------------------------------------------------------------------------
-- 2. Why a creator's import is paused, durably
--
-- A creator may now move the link we poll — they changed blogs, they renamed a
-- channel — and doing so clears `import_opt_in` so nothing is read from a
-- source no operator has looked at. That much is enforced in the route.
--
-- The operator is told by email, and an email is push-only: delete it and there
-- is no record anywhere but the logs, and no answer to "why is this creator not
-- being polled?" asked three months later. These two columns are that answer,
-- and they are what the Sources tab can render as a badge beside the existing
-- connection badges.
--
-- Deliberately not a CHECK-constrained enum. `broken_reason` on
-- `creator_platform_accounts` is the near neighbour and it is prose for the same
-- reason: the useful part is the sentence an operator reads, not a code.
-- ---------------------------------------------------------------------------

ALTER TABLE creators
  ADD COLUMN IF NOT EXISTS import_paused_reason text,
  ADD COLUMN IF NOT EXISTS import_paused_at     timestamptz;

-- ---------------------------------------------------------------------------
-- 3. One publish attempt, one meal
--
-- Publishing from a link a creator has already used warns them first, and
-- "Publish anyway" is the escape hatch for the legitimate case — a post that
-- really does hold two recipes. The claim that stops an accidental double
-- publish is deliberately skipped on that path, because it cannot tell the
-- second recipe from the second click.
--
-- So a double-click, a retried POST, or two tabs on that button still produce
-- two meals. A token minted once per publish *attempt* by the client — not per
-- click — closes it: the repeat carries the same token and loses on this index,
-- while a genuine second recipe carries a new one.
--
-- Scoped to the creator rather than global: two creators cannot collide, and a
-- token is meaningless outside the row it belongs to. Partial, so the column
-- stays null for every meal published before this existed and for every path
-- that does not mint one.
-- ---------------------------------------------------------------------------

ALTER TABLE preset_meals
  ADD COLUMN IF NOT EXISTS publish_token text;

CREATE UNIQUE INDEX IF NOT EXISTS preset_meals_publish_token_key
  ON preset_meals (creator_id, publish_token)
  WHERE publish_token IS NOT NULL;
