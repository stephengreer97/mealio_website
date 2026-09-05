-- Close seven tables that the PUBLIC anon key can currently read AND write.
--
-- Supabase has been warning about this. The warning is right, and narrower and
-- worse than it sounds: most tables are already protected, and the ones that are
-- not are writable, not merely readable.
--
-- MEASURED 2026-09-05 against production, using the anon key exactly as any
-- visitor has it (it ships in mealio.co's JavaScript bundle -- that is what
-- NEXT_PUBLIC_ means, and it is not a leak, it is the design):
--
--   READ + WRITE, unauthenticated:
--     app_settings        3 rows   <-- holds the BROADCASTS every app renders
--     automation_config   6 rows   <-- the REMOTE CONFIG the app fetches and obeys
--     automation_runs     506
--     automation_steps    6,495    <-- user_id + per-run detail
--     app_opens           428
--     creator_follows     3
--     photo_hashes        480
--
--   Already protected (RLS on, no policy -> anon gets an empty set):
--     user_profiles, meals, otp_codes, remembered_devices, creators, stores,
--     push_tokens, creator_import_drafts, and the rest.
--
--   Deliberately public and left alone:
--     preset_meals -- RLS is ON with a SELECT policy. An anonymous INSERT is
--     refused with "new row violates row-level security policy", which is
--     exactly right: the Discover catalogue is meant to be readable.
--
-- THE TWO THAT MATTER are the two smallest. `app_settings` holds the broadcast
-- list, so an anonymous PATCH puts arbitrary text in front of every user who
-- opens the app. `automation_config` is the remote config the app fetches and
-- acts on, so an anonymous INSERT publishes a version that can turn every
-- store's rail off. The client bounds and ignores what it does not recognise,
-- which caps the blast radius -- it does not remove it.
--
-- No emails, passwords or OTP codes were reachable. user_profiles, otp_codes
-- and remembered_devices are already locked.
--
-- WHY THIS IS SAFE TO RUN, and why it needs no policies:
--
-- Nothing legitimate reaches these tables as anon. The mobile app never talks
-- to Supabase at all -- every read goes through mealio.co/api/*, which uses the
-- SERVICE ROLE client, and the service role bypasses RLS by design. The
-- website's only use of the anon key is `supabase.auth.signOut()`, which
-- touches no table. So enabling RLS with no policies denies the anonymous
-- caller and changes nothing for the product.
--
-- Verified before writing this: grep finds no Supabase client in mealio_app at
-- all, and NEXT_PUBLIC_SUPABASE_ANON_KEY appears in exactly one runtime file
-- (app/signout/page.tsx).

ALTER TABLE public.app_settings       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.automation_config  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.automation_runs    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.automation_steps   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_opens          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.creator_follows    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.photo_hashes       ENABLE ROW LEVEL SECURITY;

-- automation_daily arrived with MEAL-219 and has never been exposed only
-- because it does not exist yet. Enabling it here means it is never born open.
ALTER TABLE IF EXISTS public.automation_daily ENABLE ROW LEVEL SECURITY;

-- ── And eight that are already safe in PRODUCTION but not in this repository ──
--
-- These were turned on by hand in the dashboard at some point. Production is
-- fine -- all eight were checked as anon on 2026-09-05 and every one returns an
-- empty set -- but the migrations do not say so, which means a rebuild from
-- this repository, or a fresh staging project, comes up OPEN. The database and
-- the repository disagreeing about security is its own defect, and the cheaper
-- half of it to fix.
--
-- ENABLE on an already-enabled table is a no-op, so this is safe to run against
-- production as it stands.
ALTER TABLE public.creator_applications  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.creators              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_sends           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.otp_codes             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.preset_meal_saves     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.remembered_devices    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.store_catalog_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stores                ENABLE ROW LEVEL SECURITY;

-- DELIBERATELY NO POLICIES.
--
-- A policy would be the thing to add if a browser needed to read one of these
-- directly. None does, and adding an empty-handed "allow read" policy now would
-- re-open exactly what this closes while looking like security.
--
-- The rule for the next table: RLS ON at creation, and a policy ONLY when
-- something that is not the service role genuinely needs the rows.

COMMENT ON TABLE public.app_settings IS
  'RLS on, no policies (2026-09-05). Server-side only, through the service role. Held the broadcast list while anonymously writable.';
COMMENT ON TABLE public.automation_config IS
  'RLS on, no policies (2026-09-05). Server-side only. An anonymous insert here published remote config the app obeys.';
