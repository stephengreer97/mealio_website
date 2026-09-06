-- IS THE NIGHTLY ROLLUP AND THE 30-DAY PRUNE ACTUALLY SCHEDULED (MEAL-219).
--
-- Separate from CHECK-migrations.sql because the answer can be "the functions
-- exist and nothing calls them", which is the state the migration leaves you
-- in. Creating `roll_up_automation_day` does not schedule it.
--
-- Read-only. `cron` is Supabase's pg_cron extension; if it is not installed the
-- first query says so and the second is the one that would error, so run them
-- in order and stop if the first says false.

SELECT
  EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') AS pg_cron_installed;

-- Only meaningful if the above is true. Empty result = nothing is scheduled.
SELECT jobid, jobname, schedule, active, command
FROM cron.job
ORDER BY jobname;
