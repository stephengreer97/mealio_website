-- Clear the Add-to-cart funnel and the Requests panel.
--
-- Run in the Supabase SQL editor for the mealio_central project. Not a
-- migration: it is a one-off clear-down that lives here so it is reviewable
-- rather than pasted from a chat window, and running it twice is harmless.
--
-- ── WHAT THIS TOUCHES ───────────────────────────────────────────────────────
--
--   automation_runs    one row per add-to-cart run. Every run-level tile on the
--                      Health Dashboard: terminal success, items added, blocked
--                      rate, week over week, the daily trend line.
--   automation_steps   one row per step, and since MEAL-219 also per request
--                      (http_status, phase, attempts, rail). Both the funnel's
--                      step table AND the whole Requests panel. Cascades from
--                      automation_runs, listed anyway so the intent is on the page.
--   automation_daily   the nightly aggregate of automation_steps. Clearing steps
--                      and leaving this behind keeps the old numbers alive in the
--                      table the retention design reads after 30 days.
--
-- ── WHAT THIS DOES NOT TOUCH, DELIBERATELY ──────────────────────────────────
--
--   automation_config      the live per-store network switches. Telemetry is a
--                          record of what happened; this is what happens next.
--   automation_alert_state MEAL-6's "have I already emailed about this store".
--                          Left alone on purpose: wiping it alongside the rows
--                          means the next sweep treats every store as newly
--                          broken and sends a fresh alert for each.
--   canary_runs /          the nightly canary keeps its own history. It is a
--   canary_plans           different question asked against a fixed meal.
--
-- ── THE COST, BEFORE YOU RUN IT ─────────────────────────────────────────────
--
-- The MEAL-6 alert sweep computes its thresholds from these rows: each store's
-- own trailing 7-day median item-success, and week over week. With the tables
-- empty there is no baseline, so for roughly the first two weeks afterwards the
-- drop and week-over-week alerts have nothing to compare against and go quiet.
-- Terminal success and the blocked rate are absolute and start working again as
-- soon as there are runs. Nothing else in the product reads these three tables:
-- the app writes them (/api/usage/automation) and only the admin dashboard and
-- MEAL-143's per-run drilldown read them.

-- ── 1 · what you are about to delete ────────────────────────────────────────
SELECT 'automation_runs'  AS table_name, count(*) AS rows, min(started_at)  AS oldest, max(started_at)  AS newest FROM public.automation_runs
UNION ALL
SELECT 'automation_steps', count(*), min(occurred_at), max(occurred_at) FROM public.automation_steps
UNION ALL
SELECT 'automation_daily', count(*), min(day)::timestamptz, max(day)::timestamptz FROM public.automation_daily;

-- ── 2 · the clear-down ──────────────────────────────────────────────────────
-- One statement, all three tables. automation_steps has a NOT NULL FK to
-- automation_runs, so truncating the runs alone is refused; naming both in the
-- same TRUNCATE is what makes it legal without CASCADE reaching further than
-- intended. RESTART IDENTITY resets the two bigint sequences so new rows start
-- from 1 rather than carrying on from a history that no longer exists.
TRUNCATE TABLE
  public.automation_steps,
  public.automation_runs,
  public.automation_daily
RESTART IDENTITY;

-- ── 3 · confirm ─────────────────────────────────────────────────────────────
-- All three must read 0. Re-run the dashboard after this and the funnel says
-- "No runs in the last 30 days" and Requests says "No request rows" — which is
-- the honest empty state, not a healthy-looking one.
SELECT 'automation_runs'  AS table_name, count(*) AS rows FROM public.automation_runs
UNION ALL
SELECT 'automation_steps', count(*) FROM public.automation_steps
UNION ALL
SELECT 'automation_daily', count(*) FROM public.automation_daily;
