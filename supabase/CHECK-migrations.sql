-- WHICH MIGRATIONS HAVE ACTUALLY BEEN RUN.
--
-- Paste the whole file into the Supabase SQL editor. Read-only: it creates,
-- alters and deletes nothing.
--
-- Each row asks the database what the migration WOULD HAVE LEFT BEHIND rather
-- than trusting a filename or a memory of running it. `to_regclass` returns
-- null instead of raising for a table that does not exist, which is what lets
-- every check run even when an earlier one has not been applied.

SELECT * FROM (
  VALUES
    (
      'MEAL-23  · stores table',
      to_regclass('public.stores') IS NOT NULL
    ),
    (
      'MEAL-23  · store_catalog_version table',
      to_regclass('public.store_catalog_version') IS NOT NULL
    ),
    (
      'MEAL-23  · bump_store_catalog_version() trigger fn',
      EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname = 'bump_store_catalog_version')
    ),
    (
      -- Depends on MEAL-23: it DELETEs from `stores`. If that table is missing
      -- this reads false because the removal cannot have happened yet.
      'MEAL-202 · Amazon Fresh gone from stores',
      to_regclass('public.stores') IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM public.stores WHERE id = 'amazon')
    ),
    (
      'MEAL-202 · no meals left on the amazon store',
      to_regclass('public.meals') IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM public.meals WHERE store_id = 'amazon')
    ),
    (
      -- All four columns, not just one: a half-applied ALTER is the case a
      -- "does the first column exist" check would call done.
      'MEAL-219 · automation_steps http_status/phase/attempts/rail',
      (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'automation_steps'
         AND column_name IN ('http_status', 'phase', 'attempts', 'rail')) = 4
    ),
    (
      'MEAL-219 · automation_daily table',
      to_regclass('public.automation_daily') IS NOT NULL
    ),
    (
      'MEAL-219 · roll_up_automation_day() function',
      EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname = 'roll_up_automation_day')
    ),
    (
      'MEAL-219 · prune_automation_steps() function',
      EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname = 'prune_automation_steps')
    ),
    (
      -- THE ONE BEHIND THE 500 ON /api/account/notification-prefs.
      'MEAL-217 · user_profiles.notification_prefs column',
      EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'user_profiles'
                AND column_name = 'notification_prefs')
    ),
    (
      'MEAL-222 · recipe_imports table',
      to_regclass('public.recipe_imports') IS NOT NULL
    )
) AS t(migration, applied)
ORDER BY applied, migration;
