-- ============================================================================
--  RUN THIS ONE FILE. It supersedes 20260905000004 (which is now redundant --
--  everything in it is repeated here, and every statement is idempotent, so
--  running both in any order is harmless).
--
--  Safe against production as it stands: it adds no policies, changes no data,
--  and takes no long lock.
-- ============================================================================
--
--  WHAT IS WRONG, measured 2026-09-05 with the public anon key -- the one that
--  ships in mealio.co's JavaScript bundle:
--
--   1. SEVEN TABLES ARE READ **AND WRITE** OPEN to anyone on the internet.
--        app_settings       holds the BROADCAST list every app renders
--        automation_config  the REMOTE CONFIG the app fetches and obeys
--        automation_runs / automation_steps / app_opens / creator_follows /
--        photo_hashes
--      Writes proved non-destructively: a PATCH filtered to a UUID matching
--      nothing returned 204 on all seven, and an INSERT of an empty row was
--      refused by a NOT NULL constraint rather than by permission.
--
--   2. TWO FUNCTIONS ARE CALLABLE BY ANON, and one of them is a deliberate
--      hole through RLS:
--        get_featured_creators           SECURITY DEFINER, anon-callable.
--                                        Returns nothing today only because no
--                                        creator qualifies. That is luck.
--        get_preset_meals_with_trending  SECURITY INVOKER, anon-callable, and
--                                        BROKEN for anon -- see below.
--
--  WHY REVOKING BEATS SECURITY DEFINER, which was the other option:
--
--  get_preset_meals_with_trending LEFT JOINs creators and preset_meal_saves,
--  both already RLS-locked. Called as anon it returns ALL 318 rows -- the same
--  count as the service role -- with every creator_name null, every
--  trending_score 0, and a different order. RLS does not error when it bites;
--  it returns fewer rows, and a LEFT JOIN turns that into wrong data at an
--  unchanged row count. That is what bit this project once already.
--
--  Making it SECURITY DEFINER would fix the symptom by punching a permanent
--  hole through RLS for every caller. Revoking makes the broken path
--  UNREACHABLE instead, and costs nothing: every legitimate call comes from
--  mealio.co/api/*, which uses the service-role client. The app never talks to
--  Supabase at all, and the website's only anon-key use is auth.signOut().
--
--  THE POSTGRES GOTCHA this file is careful about: revoking a privilege from a
--  role does NOT remove a grant made to PUBLIC. So each function is revoked
--  from PUBLIC first, then from the roles explicitly, then granted back to
--  service_role -- which would otherwise lose access along with everyone else.
-- ============================================================================


-- ── 1 · Row Level Security on every table ───────────────────────────────────
--
-- No policies, deliberately. With RLS on and no policy, the anonymous role gets
-- an empty set and the service role -- which bypasses RLS -- is unaffected. A
-- permissive "allow read" policy here would re-open exactly what this closes
-- while looking like security.
--
-- ENABLE on an already-enabled table is a no-op, so the tables listed here that
-- are already protected in production are included on purpose: the repository
-- did not say so, which means a rebuild or a fresh staging project would have
-- come up open.

ALTER TABLE public.app_settings           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.automation_config      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.automation_runs        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.automation_steps       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_opens              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.creator_follows        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.photo_hashes           ENABLE ROW LEVEL SECURITY;

-- Already on in production; recorded here so the repository stops disagreeing
-- with the database about security.
ALTER TABLE public.creator_applications   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.creators               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_sends            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.otp_codes              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.preset_meal_saves      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.remembered_devices     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.store_catalog_version  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stores                 ENABLE ROW LEVEL SECURITY;

-- preset_meals is NOT here. It is already RLS-on with a SELECT policy, and that
-- is correct: the Discover catalogue is meant to be publicly readable, and an
-- anonymous INSERT is already refused.

-- automation_daily does not exist until the MEAL-219 rollup migration runs.
-- Guarded so this file works before or after it, and so the table is never
-- born open.
DO $$ BEGIN
  IF to_regclass('public.automation_daily') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public.automation_daily ENABLE ROW LEVEL SECURITY';
  END IF;
END $$;


-- ── 2 · Only the server may call the RPCs ───────────────────────────────────
--
-- handle_updated_at and bump_store_catalog_version are deliberately absent:
-- both RETURN TRIGGER, so they are fired by the system and were never callable
-- over PostgREST in the first place.

DO $$
DECLARE
  fn text;
  fns text[] := ARRAY[
    -- Anon-callable today, and broken for anon. The reason this file exists.
    'public.get_preset_meals_with_trending(boolean)',
    -- Anon-callable today AND security definer: a standing hole through RLS.
    'public.get_featured_creators()',
    -- Server-only. An anonymous caller could inflate the attempt count for a
    -- known otp id and lock someone out of their own 2FA.
    'public.increment_otp_attempts(uuid)',
    -- Server-only, and SECURITY DEFINER.
    'public.list_storage_objects(text)',
    -- MEAL-219. These do not exist yet; when that migration runs they are
    -- created with the default PUBLIC grant, and prune_automation_steps is a
    -- SECURITY DEFINER function that DELETES telemetry. Listed here so the hole
    -- never opens, whichever order the two files are run in.
    'public.roll_up_automation_day(date)',
    'public.prune_automation_steps(integer)'
  ];
BEGIN
  FOREACH fn IN ARRAY fns LOOP
    -- to_regprocedure returns NULL rather than raising for a function that does
    -- not exist, which is what lets this run before the MEAL-219 migration.
    IF to_regprocedure(fn) IS NOT NULL THEN
      -- PUBLIC FIRST. Revoking from a role does not remove a PUBLIC grant, so
      -- doing only the second line would look correct and change nothing.
      EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', fn);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon, authenticated', fn);
      -- And back to the one role that should have it. Without this the server
      -- loses access along with everybody else.
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
      RAISE NOTICE 'locked %', fn;
    ELSE
      RAISE NOTICE 'skipped (does not exist yet) %', fn;
    END IF;
  END LOOP;
END $$;


-- ── 3 · Check it worked ─────────────────────────────────────────────────────
--
-- Run these after. Both should come back exactly as described.

-- (a) Every table below must show rowsecurity = true.
SELECT c.relname AS table_name, c.relrowsecurity AS rls_on
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind = 'r'
ORDER BY c.relrowsecurity, c.relname;

-- (b) WHO CAN EXECUTE EACH RPC.
--
--     Read this carefully: a NULL proacl does NOT mean "locked down". It means
--     DEFAULT privileges are in force, and the default for a function is
--     EXECUTE to PUBLIC -- i.e. anyone. That is the state every one of these
--     was in before this file ran, and reading it as "owner only" is exactly
--     how someone would conclude they were safe when they were not.
--
--     After running, each row should read: service_role  (and nothing else).
SELECT p.proname,
       pg_get_function_identity_arguments(p.oid) AS args,
       CASE
         WHEN p.proacl IS NULL
           THEN 'DEFAULT = PUBLIC (anyone) -- NOT LOCKED'
         ELSE (
           SELECT string_agg(
                    CASE WHEN ae.grantee = 0 THEN 'PUBLIC' ELSE r.rolname END,
                    ', ' ORDER BY 1)
           FROM aclexplode(p.proacl) AS ae
           LEFT JOIN pg_roles r ON r.oid = ae.grantee
           WHERE ae.privilege_type = 'EXECUTE'
         )
       END AS can_execute
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN ('get_preset_meals_with_trending', 'get_featured_creators',
                    'increment_otp_attempts', 'list_storage_objects',
                    'roll_up_automation_day', 'prune_automation_steps')
ORDER BY p.proname;
