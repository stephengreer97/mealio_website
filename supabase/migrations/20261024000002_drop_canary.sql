-- The nightly canary (MEAL-7) is retired, with its admin panel, route and phone
-- runner. Its two tables go with it. Nothing reads or writes them once the code
-- that shipped with this file is deployed.
drop table if exists public.canary_runs;
drop table if exists public.canary_plans;
