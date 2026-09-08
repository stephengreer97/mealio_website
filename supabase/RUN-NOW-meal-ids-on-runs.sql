-- MEAL-214 part 1. A run does not know WHICH meal it was.
--
-- automation_runs records store, outcome and counts, and `meal_count` -- a
-- number of meals, not their ids. So "you have added this to your cart 8 times"
-- cannot be asked of the data we already keep, and every day without this is a
-- day of runs that can never be attributed afterwards.
--
-- An ARRAY rather than a join table: a run covers a handful of meals at most
-- (which is why meal_count exists), the only query is "runs containing meal X",
-- and a GIN index answers that directly. A join table would be the right call
-- if runs-per-meal were ever going to be written independently, and they are not.

ALTER TABLE automation_runs
  ADD COLUMN IF NOT EXISTS meal_ids text[];

-- Answers "how many runs included this meal" without scanning.
CREATE INDEX IF NOT EXISTS automation_runs_meal_ids_idx
  ON automation_runs USING GIN (meal_ids);

-- Deliberately NOT backfilled. Existing rows carry meal_count and nothing that
-- could reconstruct the ids, so a backfill would have to invent them. NULL here
-- means "this run predates attribution", which every read must treat as unknown
-- rather than as zero.
