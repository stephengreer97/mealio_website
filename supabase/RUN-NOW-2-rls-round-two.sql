-- ============================================================================
--  ROUND TWO. Run after RUN-NOW-rls-lockdown.sql. Idempotent; safe to re-run.
--
--  The first file fixed what the REPOSITORY knew about. The Supabase advisor
--  knows what is actually in the database, and it found more -- because tables
--  and functions created in the dashboard leave no trace in supabase/, so any
--  hand-written list was always going to be short.
--
--  So this file stops listing things. Sections 1 and 2 sweep the catalogue and
--  fix whatever they find, which means they also cover the next table someone
--  creates in the dashboard.
-- ============================================================================
--
--  WHAT WAS STILL OPEN, measured 2026-09-05 with the public anon key AFTER the
--  first file ran:
--
--    subscription_events            3 rows    user_id, event, stripe_event_id
--    meals_backup_20260805          89 rows   USERS' SAVED MEALS
--    preset_meals_backup_20260805   316 rows
--
--  meals_backup_20260805 is the one that matters: a month-old snapshot of
--  private user data, readable by anyone. It is also not in the repository at
--  all, which is exactly why the first pass missed it.
--
--  preset_meals stays readable and is not touched. It has RLS on with a SELECT
--  policy on purpose -- the Discover catalogue is public.
-- ============================================================================


-- ── 1 · RLS on EVERY public table, found rather than listed ─────────────────
--
-- A table with RLS on and no policy denies anon and is invisible to the service
-- role's bypass, so this is safe to apply blindly. A table that already has a
-- policy (preset_meals) keeps working exactly as before -- enabling RLS does
-- not remove policies, and it is already enabled there anyway.

DO $$
DECLARE
  t record;
  n int := 0;
BEGIN
  FOR t IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace ns ON ns.oid = c.relnamespace
    WHERE ns.nspname = 'public'
      AND c.relkind = 'r'          -- ordinary tables only; not views, not sequences
      AND NOT c.relrowsecurity
    ORDER BY c.relname
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.relname);
    RAISE NOTICE 'RLS enabled on %', t.relname;
    n := n + 1;
  END LOOP;
  RAISE NOTICE '--- % table(s) newly protected ---', n;
END $$;


-- ── 2 · Pin search_path on every function that has none ─────────────────────
--
-- What the advisor's "Function Search Path Mutable" means, and why it is worth
-- doing rather than dismissing: a function without a pinned search_path
-- resolves unqualified names using the CALLER's search_path. For a SECURITY
-- DEFINER function -- which runs with the definer's privileges -- someone who
-- can create a schema and put a lookalike table or operator in it can make the
-- function touch THEIR object while holding OUR privileges.
--
-- On this project the exposure is small: the callable functions are being
-- locked to service_role, and creating schemas is not something a Mealio user
-- can do. It is cheap, it is the documented hardening, and it removes a whole
-- class of question. So: do it.
--
-- Swept rather than listed, for the same reason as section 1. `public, pg_temp`
-- is the standard pinning; pg_temp last so a temp object can never shadow a
-- real one. Checked first: the only function reaching outside public is
-- list_storage_objects, and it already writes `storage.objects` fully
-- qualified, so pinning cannot break it.

DO $$
DECLARE
  f record;
  n int := 0;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p
    JOIN pg_namespace ns ON ns.oid = p.pronamespace
    WHERE ns.nspname = 'public'
      AND p.prokind = 'f'
      AND (p.proconfig IS NULL
           OR NOT EXISTS (SELECT 1 FROM unnest(p.proconfig) cfg
                          WHERE cfg LIKE 'search\_path=%'))
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = public, pg_temp', f.sig);
    RAISE NOTICE 'search_path pinned on %', f.sig;
    n := n + 1;
  END LOOP;
  RAISE NOTICE '--- % function(s) pinned ---', n;
END $$;


-- ── 3 · cleanup_expired_tokens is reachable from the internet ───────────────
--
-- SECURITY DEFINER, and PostgREST exposes it as /rpc/cleanup_expired_tokens --
-- confirmed by reading the live OpenAPI spec. A SECURITY DEFINER function that
-- anyone can invoke runs OUR privileges on THEIR command, and this one deletes.
--
-- PUBLIC first, then the roles: revoking from a role does not remove a grant
-- made to PUBLIC, so the second line alone would look right and do nothing.

DO $$
DECLARE fn text;
BEGIN
  SELECT p.oid::regprocedure::text INTO fn
  FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
  WHERE ns.nspname = 'public' AND p.proname = 'cleanup_expired_tokens'
  LIMIT 1;

  IF fn IS NOT NULL THEN
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', fn);
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon, authenticated', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
    RAISE NOTICE 'locked %', fn;
  END IF;
END $$;

-- handle_new_user IS DELIBERATELY NOT REVOKED, and the advisor's advice is
-- wrong for it. It is a TRIGGER function -- it returns trigger, PostgREST does
-- not expose it (it is absent from the live RPC list), and nothing on the
-- internet can call it. What fires it is the trigger on auth.users that creates
-- a profile row on signup.
--
-- Revoking EXECUTE there risks breaking SIGNUP for a warning about a door that
-- does not open. Section 2 pins its search_path, which is the part of the
-- advisor's advice that genuinely applies.


-- ── 4 · Check it ────────────────────────────────────────────────────────────

-- (a) Must return NO ROWS.
SELECT c.relname AS table_without_rls
FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
WHERE ns.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity;

-- (b) Must return NO ROWS.
SELECT p.oid::regprocedure AS function_without_search_path
FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
WHERE ns.nspname = 'public' AND p.prokind = 'f'
  AND (p.proconfig IS NULL
       OR NOT EXISTS (SELECT 1 FROM unnest(p.proconfig) cfg WHERE cfg LIKE 'search\_path=%'));

-- (c) Who can execute what. A NULL proacl means DEFAULT = PUBLIC = anyone,
--     NOT "locked" -- reading it the other way is how you conclude you are safe
--     when you are not. Every row here should say service_role, except
--     handle_new_user (a trigger, see above).
SELECT p.proname,
       pg_get_function_identity_arguments(p.oid) AS args,
       p.prosecdef AS security_definer,
       CASE WHEN p.proacl IS NULL THEN 'DEFAULT = PUBLIC (anyone) -- NOT LOCKED'
            ELSE (SELECT string_agg(CASE WHEN ae.grantee = 0 THEN 'PUBLIC' ELSE r.rolname END, ', ' ORDER BY 1)
                  FROM aclexplode(p.proacl) ae
                  LEFT JOIN pg_roles r ON r.oid = ae.grantee
                  WHERE ae.privilege_type = 'EXECUTE')
       END AS can_execute
FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
WHERE ns.nspname = 'public' AND p.prokind = 'f'
ORDER BY p.prosecdef DESC, p.proname;
