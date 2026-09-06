-- EVERY PENDING MIGRATION, IN DEPENDENCY ORDER. One paste.
--
-- Generated from the individual files in supabase/migrations/ rather than
-- retyped, so this cannot drift from them.
--
-- SAFE TO RUN IF YOU HAVE ALREADY RUN SOME OF THESE. Every object is guarded
-- (IF NOT EXISTS / CREATE OR REPLACE / ON CONFLICT DO NOTHING) and the two
-- statements that delete match nothing on a second pass. Checked before
-- assembling this, not assumed.
--
-- THE ORDER IS NOT ALPHABETICAL AND IT MATTERS TWICE:
--   * MEAL-202 deletes a row from `stores`, which MEAL-23 creates.
--   * MEAL-219b's rollup aggregates the columns MEAL-219a adds.
--
-- ONE OF THESE DELETES DATA. MEAL-202 hard-deletes meals saved against the
-- Amazon Fresh store, because the store they belong to no longer exists. If you
-- would rather keep them, read the block above that DELETE: it gives the
-- one-line UPDATE that deactivates them instead.
--
-- AFTER RUNNING: supabase/CHECK-migrations.sql tells you what landed, and
-- CHECK-schedules.sql tells you whether the MEAL-219 rollup and prune are
-- actually scheduled. They are not, until you schedule them.



-- ==========================================================================
-- MEAL-23  ·  20260808000001_store_catalog.sql
--
-- Creates `stores` and `store_catalog_version`
-- MUST be first: MEAL-202 deletes a row from `stores`.
-- ==========================================================================

-- MEAL-23: the store catalog as data instead of as an app release.
--
-- `src/constants/stores.ts` in the mobile app is a hardcoded list, so adding a
-- store means shipping a build and waiting for review — which caps how fast we
-- can expand and is the wrong shape entirely once the Instacart adapter makes a
-- new banner cheap. This migration moves the DISPLAY half of that list into the
-- database so adding a store becomes an INSERT.
--
-- WHAT THIS TABLE IS NOT
--
-- It is display data ONLY: what a store is called, what colour its tile is, what
-- its website is. It says NOTHING about whether this build can add to that
-- store's cart. That question is answered by KROGER_BRAND_IDS and
-- WEBVIEW_STORE_IDS in the app, and it has to stay there: those sets assert
-- "this binary contains automation code for this store", and no row in Postgres
-- can make that true. `platform` and `banner_group` below are descriptive
-- columns that GET /api/stores deliberately does NOT serve, because each of
-- them reconstructs those capability sets exactly as the seed stands today.
-- See the note on the columns themselves.
--
-- WHAT IT CONTAINS
--
-- The 35 stores the app ships with today. `mockstore` is deliberately NOT here:
-- it is a dev/e2e-only fixture the app appends itself under MOCK_STORE_ENABLED,
-- and a row for it would put "Mock Store" in every production store picker.
--
-- Run this in the Supabase SQL editor. It is self-contained and safe to re-run:
-- every object is guarded, and the seed is ON CONFLICT DO NOTHING so a re-run
-- never stomps a hand-edited colour or name.

-- ── 1. The catalog ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS stores (
  -- Matches the store id the app has always used and that `automation_runs`,
  -- `automation_steps` and every saved meal's `store_id` already reference. A
  -- mismatch here silently unlists a store, so these are transcribed from
  -- mealio_app's src/constants/stores.ts rather than retyped.
  id            text NOT NULL,
  name          text NOT NULL,
  -- Tile colour, `#RRGGBB`. NOT NULL because a store with no colour renders as
  -- an invisible tap target — the endpoint drops such a row, and this stops one
  -- ever existing.
  color         text NOT NULL,
  -- URL-safe public identifier. Underscores become hyphens (`king_soopers` →
  -- `king-soopers`) so it can appear in a path without escaping.
  slug          text NOT NULL,
  -- The corporate family this banner belongs to ("Albertsons Companies" for
  -- Acme, Safeway, Vons…).
  --
  -- NOT SERVED BY GET /api/stores, and neither is `platform` below. Both are
  -- here for humans reading this table and for ops queries. The reason they
  -- stay off the wire is not that they correlate with the app's capability sets
  -- on these 35 rows, but that a client would read them as a RULE and apply it
  -- to rows the binary has never seen — and only the binary knows what
  -- automation code it contains. Measured on the seed: `platform = 'kroger'` is
  -- EXACTLY KROGER_BRAND_IDS, `banner_group = 'Kroger'` partitions identically,
  -- and the complement is WEBVIEW_STORE_IDS MINUS `mockstore` (a dev/test store
  -- with no row here). Query them freely; the endpoint does not select them.
  banner_group  text,
  -- Which e-commerce stack the banner's storefront runs on: 'kroger',
  -- 'albertsons', 'instacart', 'heb', 'walmart', 'amazon', 'wegmans'.
  platform      text,
  -- Primary storefront hostname, no scheme and no `www.`. Transcribed from the
  -- app's DOMAIN_MAP / INSTACART_TENANTS and mealio_central's STORE_URLS, which
  -- are curl-verified (see MEAL-136 on `united`: the marketing host 301s to the
  -- storefront DISCARDING the path, so a plausible-looking host is not enough).
  host          text,
  -- Human-readable coverage ("Texas", "Southern California"). Deliberately NULL
  -- for every seeded row: unlike every other column here there is no source in
  -- either repository to transcribe it from, and 35 half-remembered region
  -- strings rendered as authoritative subtitles is worse than an absent field.
  -- Fill it with a plain UPDATE once someone has checked the list.
  serving_area  text,
  -- Editorial visibility, not capability: lets a row be staged and checked
  -- before it goes live, and lets a store be pulled without deleting its row
  -- (and with it the id that saved meals still reference).
  is_listed     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id)
);

-- Postgres has no ADD CONSTRAINT IF NOT EXISTS, so each one is guarded to keep
-- the whole file safely re-runnable — it is applied by hand in the SQL editor.
DO $$ BEGIN
  ALTER TABLE stores ADD CONSTRAINT stores_id_format_check
    CHECK (id ~ '^[a-z0-9_]+$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE stores ADD CONSTRAINT stores_slug_format_check
    CHECK (slug ~ '^[a-z0-9-]+$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The endpoint refuses to serve a row whose colour is not a six-digit hex, so a
-- row that would be dropped on read cannot be written in the first place.
DO $$ BEGIN
  ALTER TABLE stores ADD CONSTRAINT stores_color_format_check
    CHECK (color ~ '^#[0-9A-Fa-f]{6}$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE stores ADD CONSTRAINT stores_name_not_blank_check
    CHECK (btrim(name) <> '');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS stores_slug_key ON stores (slug);

-- The endpoint's only read: listed rows, ordered by id.
CREATE INDEX IF NOT EXISTS idx_stores_listed_id ON stores (id) WHERE is_listed;

-- ── 2. The catalog version ──────────────────────────────────────────────────
--
-- A single monotonic counter, so the client can (a) skip a re-fetch when nothing
-- changed and (b) REFUSE a payload older than the one it has cached — the same
-- rule the automation-config client already applies.
--
-- Why a counter and not `max(updated_at)`, which would need no extra table:
-- DELETE. Add a store at T2 and delete it again and `max(updated_at)` falls back
-- to T1, so the version goes BACKWARDS and every client that applied T2 refuses
-- the correction forever. A counter only ever increments, including on delete.

CREATE TABLE IF NOT EXISTS store_catalog_version (
  id          smallint NOT NULL DEFAULT 1,
  version     bigint   NOT NULL DEFAULT 1,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id)
);

DO $$ BEGIN
  ALTER TABLE store_catalog_version ADD CONSTRAINT store_catalog_version_singleton_check
    CHECK (id = 1);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

INSERT INTO store_catalog_version (id, version)
  SELECT 1, 1
  WHERE NOT EXISTS (SELECT 1 FROM store_catalog_version WHERE id = 1);

CREATE OR REPLACE FUNCTION public.bump_store_catalog_version()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE store_catalog_version
     SET version = version + 1, updated_at = now()
   WHERE id = 1;
  RETURN NULL;
END;
$$;

-- FOR EACH STATEMENT, not FOR EACH ROW: seeding 35 stores is one change to the
-- catalog, not 35. A statement that matches no rows still bumps — clients then
-- re-fetch an identical payload once, which is the harmless direction to err in.
DROP TRIGGER IF EXISTS stores_bump_catalog_version ON stores;
CREATE TRIGGER stores_bump_catalog_version
  AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON stores
  FOR EACH STATEMENT EXECUTE FUNCTION public.bump_store_catalog_version();

-- `public.handle_updated_at()` is the shared function already driving
-- `set_meals_updated_at` and `set_user_profiles_updated_at` (schema.sql), so
-- this adds no second copy of it. It is re-declared here rather than merely
-- referenced so that this file depends on nothing outside itself: pasted into a
-- database where that function is somehow absent, a bare CREATE TRIGGER would
-- fail with the catalog already half-written. CREATE OR REPLACE with a
-- byte-identical body is a no-op against the database we actually have, and
-- replacing a function does not disturb the triggers already using it.
CREATE OR REPLACE FUNCTION public.handle_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS set_stores_updated_at ON stores;
CREATE TRIGGER set_stores_updated_at
  BEFORE UPDATE ON stores
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- ── 3. Seed: the 35 stores the app ships today ──────────────────────────────
--
-- id / name / color transcribed character-for-character from mealio_app
-- src/constants/stores.ts. host transcribed from:
--   • Kroger family      — mealio_central app/my-meals/page.tsx STORE_URLS
--   • Albertsons family  — mealio_app src/lib/webview-scripts/albertsons.ts DOMAIN_MAP
--   • heb                — src/lib/webview-scripts/index.ts
--   • walmart / amazon / wegmans — the *_DOMAIN constant in each adapter
--   • aldi               — src/lib/webview-scripts/instacart.ts INSTACART_TENANTS
--
-- ON CONFLICT DO NOTHING: this is a bootstrap, not a source of truth. Later
-- corrections are UPDATEs, and a re-run must not undo them.

INSERT INTO stores (id, name, color, slug, banner_group, platform, host) VALUES
  ('acme',          'Acme Markets',        '#F04035', 'acme',          'Albertsons Companies', 'albertsons', 'acmemarkets.com'),
  ('albertsons',    'Albertsons',          '#009ee5', 'albertsons',    'Albertsons Companies', 'albertsons', 'albertsons.com'),
  ('aldi',          'ALDI',                '#02205F', 'aldi',          'ALDI',                 'instacart',  'aldi.us'),
  ('amazon',        'Amazon Fresh',        '#78BD21', 'amazon',        'Amazon',               'amazon',     'amazon.com'),
  ('bakers',        'Baker''s',            '#EE3124', 'bakers',        'Kroger',               'kroger',     'bakersplus.com'),
  ('balduccis',     'Balducci''s',         '#8D2B1E', 'balduccis',     'Albertsons Companies', 'albertsons', 'balduccis.com'),
  ('carrs',         'Carrs',               '#E5171D', 'carrs',         'Albertsons Companies', 'albertsons', 'carrsqc.com'),
  ('city_market',   'City Market',         '#EE3124', 'city-market',   'Kroger',               'kroger',     'citymarket.com'),
  ('dillons',       'Dillons',             '#CA2128', 'dillons',       'Kroger',               'kroger',     'dillons.com'),
  ('fred_meyer',    'Fred Meyer',          '#D7282F', 'fred-meyer',    'Kroger',               'kroger',     'fredmeyer.com'),
  ('frys',          'Fry''s Food',         '#E1251B', 'frys',          'Kroger',               'kroger',     'frysfood.com'),
  ('haggen',        'Haggen',              '#025635', 'haggen',        'Albertsons Companies', 'albertsons', 'haggen.com'),
  ('harris_teeter', 'Harris Teeter',       '#A32036', 'harris-teeter', 'Kroger',               'kroger',     'harristeeter.com'),
  ('heb',           'H-E-B',               '#dd0031', 'heb',           'H-E-B',                'heb',        'heb.com'),
  ('jewel_osco',    'Jewel-Osco',          '#E12C47', 'jewel-osco',    'Albertsons Companies', 'albertsons', 'jewelosco.com'),
  ('king_soopers',  'King Soopers',        '#005DAA', 'king-soopers',  'Kroger',               'kroger',     'kingsoopers.com'),
  ('kings',         'Kings Food Markets',  '#417EC0', 'kings',         'Albertsons Companies', 'albertsons', 'kingsfoodmarkets.com'),
  ('kroger',        'Kroger',              '#0E51A1', 'kroger',        'Kroger',               'kroger',     'kroger.com'),
  ('marianos',      'Mariano''s',          '#64433D', 'marianos',      'Kroger',               'kroger',     'marianos.com'),
  ('metro_market',  'Metro Market',        '#63463E', 'metro-market',  'Kroger',               'kroger',     'metromarket.net'),
  ('pavilions',     'Pavilions',           '#2D2B29', 'pavilions',     'Albertsons Companies', 'albertsons', 'pavilions.com'),
  ('pay_less',      'Pay-Less',            '#D8232A', 'pay-less',      'Kroger',               'kroger',     'pay-less.com'),
  ('pick_n_save',   'Pick ''n Save',       '#243444', 'pick-n-save',   'Kroger',               'kroger',     'picknsave.com'),
  ('qfc',           'QFC',                 '#006BB6', 'qfc',           'Kroger',               'kroger',     'qfc.com'),
  ('ralphs',        'Ralphs',              '#EA0029', 'ralphs',        'Kroger',               'kroger',     'ralphs.com'),
  ('randalls',      'Randalls',            '#02365E', 'randalls',      'Albertsons Companies', 'albertsons', 'randalls.com'),
  ('safeway',       'Safeway',             '#E5161E', 'safeway',       'Albertsons Companies', 'albertsons', 'safeway.com'),
  ('shaws',         'Shaw''s',             '#F48424', 'shaws',         'Albertsons Companies', 'albertsons', 'shaws.com'),
  ('smiths',        'Smith''s Food & Drug','#D51E48', 'smiths',        'Kroger',               'kroger',     'smithsfoodanddrug.com'),
  ('star_market',   'Star Market',         '#7AC142', 'star-market',   'Albertsons Companies', 'albertsons', 'starmarket.com'),
  ('tom_thumb',     'Tom Thumb',           '#0435A6', 'tom-thumb',     'Albertsons Companies', 'albertsons', 'tomthumb.com'),
  ('united',        'United Supermarkets', '#003087', 'united',        'Albertsons Companies', 'albertsons', 'shopunitedsupermarkets.com'),
  ('vons',          'Vons',                '#E41720', 'vons',          'Albertsons Companies', 'albertsons', 'vons.com'),
  ('walmart',       'Walmart',             '#0053E2', 'walmart',       'Walmart',              'walmart',    'walmart.com'),
  ('wegmans',       'Wegmans',             '#000000', 'wegmans',       'Wegmans',              'wegmans',    'wegmans.com')
ON CONFLICT (id) DO NOTHING;

-- ── 4. Adding a store later ─────────────────────────────────────────────────
--
-- One INSERT, no app release. Stage it hidden, look at it, then list it:
--
--   INSERT INTO stores (id, name, color, slug, banner_group, platform, host, is_listed)
--   VALUES ('sprouts', 'Sprouts Farmers Market', '#4B9B3F', 'sprouts',
--           'Sprouts', 'instacart', 'shop.sprouts.com', false);
--   UPDATE stores SET is_listed = true WHERE id = 'sprouts';
--
-- Both statements bump the catalog version, so clients pick it up on their next
-- fetch. Remember that listing a store only puts it in the PICKER — add-to-cart
-- still needs adapter code in the app.


-- ==========================================================================
-- MEAL-202  ·  20260904000001_remove_amazon_fresh.sql
--
-- Removes Amazon Fresh
-- THE ONLY DESTRUCTIVE ONE: it hard-deletes meals saved against that store
-- See the note inside if you would rather deactivate them.
-- ==========================================================================

-- Remove Amazon Fresh from Mealio, 2026-09-04.
--
-- WHY, so nobody re-adds it by reflex: Amazon Fresh was the last store with no
-- network rail. Every other store has an API path Mealio can search and write
-- with; Amazon had none, so since DOM automation was removed it could only
-- search and hand the user the page to add from. A store Mealio cannot add to
-- is not a supported store. MEAL-212 (the spike asking whether an in-page rail
-- was possible) is closed unstarted along with it.
--
-- The 2026-08-08 seed migration is NOT edited. It is history: it records what
-- the catalog was when it was written, and a database built from scratch runs
-- it and then runs this one, which is self-consistent. Rewriting an applied
-- migration to hide a row is how the file and the database stop agreeing.
--
-- SAFE TO RE-RUN. Every statement is idempotent: deletes match nothing the
-- second time, and the jsonb rewrite is a no-op once the keys are gone.
--
-- READ THE COUNTS FIRST. Section 0 changes nothing and tells you exactly what
-- sections 1-3 will touch. Run it on its own, look at the numbers, then run the
-- rest.

-- ── 0. What this will do (SELECT only — safe) ───────────────────────────────

SELECT 'meals to delete'            AS what, count(*) AS rows FROM meals  WHERE store_id = 'amazon'
UNION ALL
SELECT 'of those, already deleted', count(*) FROM meals WHERE store_id = 'amazon' AND is_active = false
UNION ALL
SELECT 'users affected',            count(DISTINCT user_id) FROM meals WHERE store_id = 'amazon'
UNION ALL
SELECT 'meals keeping an Amazon chosen-product',
       count(*) FROM meals
       WHERE store_id <> 'amazon'
         AND EXISTS (
           SELECT 1 FROM jsonb_array_elements(ingredients) ing
           WHERE ing -> 'storeProducts' ? 'amazon')
UNION ALL
SELECT 'catalog rows',              count(*) FROM stores WHERE id = 'amazon';

-- ── 1. The meals ────────────────────────────────────────────────────────────
--
-- A HARD delete, because the store they belong to no longer exists: soft
-- deletion (is_active = false) leaves them in the "Recently deleted" screen
-- offering a Restore that would restore a meal to a store the app cannot show.
--
-- If you would rather keep them, run THIS instead of the DELETE and stop here:
--
--   UPDATE meals SET is_active = false, updated_at = now()
--   WHERE store_id = 'amazon' AND is_active;
--
-- They stay recoverable, and the only cost is that Restore on one of them puts
-- a meal back under a store id nothing in the app renders.

DELETE FROM meals WHERE store_id = 'amazon';

-- ── 2. Chosen products saved AGAINST Amazon, on meals that are staying ───────
--
-- An ingredient remembers the product picked at each store, keyed by store id:
--   ingredients[i].storeProducts = { "heb": {...}, "amazon": {...} }
-- Those Amazon entries are dead weight on meals for OTHER stores. Nothing reads
-- them (the app looks up by the store being shopped), so this is tidying rather
-- than a correctness fix — and it is the one statement here that rewrites a row
-- it is not deleting, so it is written to touch only rows that actually carry
-- one.

UPDATE meals m
SET ingredients = (
      SELECT jsonb_agg(
               CASE
                 WHEN ing -> 'storeProducts' ? 'amazon'
                   THEN jsonb_set(ing, '{storeProducts}', (ing -> 'storeProducts') - 'amazon')
                 ELSE ing
               END
               ORDER BY ord)
      FROM jsonb_array_elements(m.ingredients) WITH ORDINALITY AS t(ing, ord)
    ),
    updated_at = now()
WHERE EXISTS (
  SELECT 1 FROM jsonb_array_elements(m.ingredients) ing
  WHERE ing -> 'storeProducts' ? 'amazon');

-- ── 3. The catalog row ──────────────────────────────────────────────────────
--
-- This is what actually unlists the store: GET /api/stores serves this table,
-- and the app filters what it serves through its own capability set. With the
-- row gone and the app updated, neither half offers it.

DELETE FROM stores WHERE id = 'amazon';

-- ── What this deliberately does NOT touch ───────────────────────────────────
--
-- automation_runs and automation_steps keep their Amazon rows. They are a
-- record of what happened, not a list of what is offered, and deleting them
-- would silently change every historical funnel number this store ever
-- contributed to. Filter them out in a query if you want a current-stores view:
--
--   ... WHERE store_id <> 'amazon'
--
-- preset_meals are not touched either: no preset has ever been created against
-- Amazon Fresh, and if one were it would be a creator's meal to move rather
-- than a row to delete. Check with:
--
--   SELECT count(*) FROM preset_meals WHERE store_id = 'amazon';


-- ==========================================================================
-- MEAL-219a  ·  20260905000001_automation_request_telemetry.sql
--
-- Adds http_status / phase / attempts / rail to `automation_steps`
-- MUST come before 219b, whose rollup reads them.
-- ==========================================================================

-- MEAL-219. The network rail's requests, stored as facts rather than as prose.
--
-- Stephen, 2026-09-05: "now that we are 100% on network... it should be much
-- easier to collect data since it all traces back to http codes."
--
-- It does, and none of it was reaching this database. Every rail computes an
-- HTTP status -- it is what the retry policy decides on -- and there were 25
-- telemetry calls in the cart engine carrying exactly zero of them. The one
-- status that arrived did so smuggled inside a reason STRING as 'http-403', so
-- the single most queryable fact about a run had to be parsed out of text.
--
-- FOUR NEW COLUMNS, and they are columns rather than `detail` keys on purpose.
-- The questions worth asking are "which stores are 5xx-ing this week" and "did
-- the 429s stop after the backoff shipped", and neither is answerable against
-- unindexed jsonb without a full scan.
--
-- SAFE TO RUN WHILE THE APP IS LIVE. Every column is nullable with no default,
-- so this rewrites no rows and takes no long lock. Existing rows keep NULL and
-- always will: automation_steps upserts with ignoreDuplicates, so an old row can
-- never gain a value here. The dashboard must therefore render correctly when
-- these are NULL, which is every row written before this ships.

-- ── 1 · the columns ──────────────────────────────────────────────────────────

ALTER TABLE public.automation_steps
  -- The store's own answer. NULL means the request never got one -- a dropped
  -- connection or an abort -- which is a different fact from a 500 and must
  -- stay distinguishable from it.
  ADD COLUMN IF NOT EXISTS http_status smallint,
  -- session | search | add | cart_read. NOT derived from `step`, which cannot
  -- answer it: that vocabulary was named for the DOM era and one of its values
  -- is literally 'add_click'.
  ADD COLUMN IF NOT EXISTS phase text,
  -- How many times the request was ASKED. 1 means it worked first time.
  -- Distinct from detail.attempt, which only the deleted click path ever set.
  ADD COLUMN IF NOT EXISTS attempts smallint,
  -- Which RAIL answered, which is not the same as store_id: fifteen Albertsons
  -- banners and every Instacart tenant share one implementation, and a
  -- rail-level regression shows up as fifteen unrelated store problems without
  -- this column.
  ADD COLUMN IF NOT EXISTS rail text;

-- Deliberately NOT a CHECK constraint on `phase`. A newer client shipping a
-- fifth phase must not have its rows rejected by an older database -- losing the
-- rows we most want to see, at exactly the moment something new is happening.
-- The app validates against STEP_PHASES before sending; this stores what
-- arrives.

COMMENT ON COLUMN public.automation_steps.http_status IS
  'MEAL-219. The store''s HTTP status for this request. NULL = no answer at all (dropped/aborted), which is not the same as a 5xx.';
COMMENT ON COLUMN public.automation_steps.phase IS
  'MEAL-219. session|search|add|cart_read. Unconstrained on purpose so a newer client is never rejected.';
COMMENT ON COLUMN public.automation_steps.attempts IS
  'MEAL-219. Times asked, including the first. >1 means the retry policy fired.';
COMMENT ON COLUMN public.automation_steps.rail IS
  'MEAL-219. The rail implementation, not the banner. albertsons covers 15 stores; instacart covers every tenant.';

-- ── 2 · the index the dashboard actually queries ─────────────────────────────
--
-- Per store, per status, over a window -- the status histogram. Partial on
-- http_status IS NOT NULL so it does not carry a row for every pre-MEAL-219
-- step, which is most of the table and none of the answers.

CREATE INDEX IF NOT EXISTS idx_automation_steps_store_status_time
  ON public.automation_steps (store_id, http_status, occurred_at DESC)
  WHERE http_status IS NOT NULL;

-- The phase funnel: per store, per phase, over a window.
CREATE INDEX IF NOT EXISTS idx_automation_steps_store_phase_time
  ON public.automation_steps (store_id, phase, occurred_at DESC)
  WHERE phase IS NOT NULL;


-- ==========================================================================
-- MEAL-219b  ·  20260905000002_automation_daily_rollup.sql
--
-- Creates `automation_daily` plus roll_up_automation_day() and prune_automation_steps()
-- Creating them does NOT schedule them.
-- ==========================================================================

-- MEAL-219, retention. Stephen chose "aggregate then prune after 30 days".
--
-- There has never been a pruning job. Rows leave automation_steps only when an
-- account is deleted, and the funnel query already caps at 50k rows per window
-- and renders a `truncated` flag -- so the volume is real today, before this
-- ticket adds four columns and two indexes to every future row.
--
-- WHAT IS LOST, said plainly because it is a real cost and not a footnote:
-- after 30 days an individual run can no longer be WALKED step by step. That is
-- MEAL-143's feature. Thirty days is Stephen's call; the rollup below is what
-- makes it survivable, because the aggregate answers every question the
-- dashboard asks and none of the questions a single run answers.
--
-- Runs are NOT pruned. automation_runs is one row per run, not one per step, so
-- the long tail is cheap and "how many runs did this store have in March" stays
-- answerable forever.

-- ── 1 · the daily aggregate ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.automation_daily (
  day           date    NOT NULL,
  store_id      text    NOT NULL,
  rail          text,
  phase         text,
  step          text    NOT NULL,
  outcome       text    NOT NULL,
  code          text,
  -- Bucketed, not exact: 200, 400, 403, 429, 500, 503 all matter individually,
  -- and nothing is learned from separating 507 from 508. NULL stays NULL --
  -- "no answer at all" is its own bucket and must not be folded into 5xx.
  http_status   smallint,
  rows          integer NOT NULL,
  -- Summed, so an average can be recovered; storing a pre-divided mean makes
  -- the rows unmergeable across any window but the one it was computed for.
  duration_sum  bigint,
  duration_rows integer,
  attempts_sum  integer,
  retried_rows  integer,
  -- A surrogate key, matching automation_steps. The real uniqueness is the
  -- index below, and it CANNOT be a PRIMARY KEY: Postgres allows expressions in
  -- an INDEX but only bare column names in a PRIMARY KEY or UNIQUE constraint.
  -- Written as a constraint first, and it was a syntax error -- caught by
  -- Stephen running it, which is one place too late.
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY
);

-- ONE ROW PER (day, store, step, outcome, rail, phase, code, status).
--
-- coalesce because four of those are nullable and NULL is not equal to itself
-- in a unique index -- without it, a hundred rows with a NULL rail would all be
-- considered distinct and the table would silently accumulate duplicates.
--
-- Not required for the rollup to be correct: roll_up_automation_day DELETEs the
-- day before inserting it, so nothing depends on ON CONFLICT. This is the guard
-- that says so out loud.
CREATE UNIQUE INDEX IF NOT EXISTS automation_daily_grain
  ON public.automation_daily (
    day, store_id, step, outcome,
    coalesce(rail, ''), coalesce(phase, ''), coalesce(code, ''), coalesce(http_status, -1)
  );

CREATE INDEX IF NOT EXISTS idx_automation_daily_store_day
  ON public.automation_daily (store_id, day DESC);
CREATE INDEX IF NOT EXISTS idx_automation_daily_day
  ON public.automation_daily (day DESC);

COMMENT ON TABLE public.automation_daily IS
  'MEAL-219. One row per (day, store, step, outcome, rail, phase, code, status). Survives the 30-day prune of automation_steps.';

-- ── 2 · roll one day up ──────────────────────────────────────────────────────
--
-- IDEMPOTENT. Re-running for the same day replaces that day's rows rather than
-- adding to them, so a retry, a manual re-run, or two schedulers firing at once
-- cannot double a count. That matters more than speed here: a rollup that
-- double-counts is worse than no rollup, because it looks authoritative.

CREATE OR REPLACE FUNCTION public.roll_up_automation_day(target_day date)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  inserted integer;
BEGIN
  DELETE FROM public.automation_daily WHERE day = target_day;

  INSERT INTO public.automation_daily (
    day, store_id, rail, phase, step, outcome, code, http_status,
    rows, duration_sum, duration_rows, attempts_sum, retried_rows
  )
  SELECT
    target_day,
    s.store_id,
    s.rail,
    s.phase,
    s.step,
    s.outcome,
    s.code,
    s.http_status,
    count(*),
    sum(s.duration_ms)                                   FILTER (WHERE s.duration_ms IS NOT NULL),
    count(*)                                             FILTER (WHERE s.duration_ms IS NOT NULL),
    sum(s.attempts)                                      FILTER (WHERE s.attempts IS NOT NULL),
    -- The number worth watching after the retry policy shipped: how often a
    -- request needed asking twice.
    count(*)                                             FILTER (WHERE s.attempts > 1)
  FROM public.automation_steps s
  WHERE s.occurred_at >= target_day::timestamptz
    AND s.occurred_at <  (target_day + 1)::timestamptz
  GROUP BY s.store_id, s.rail, s.phase, s.step, s.outcome, s.code, s.http_status;

  GET DIAGNOSTICS inserted = ROW_COUNT;
  RETURN inserted;
END;
$$;

-- ── 3 · roll up, THEN prune ──────────────────────────────────────────────────
--
-- One function so the order cannot be got wrong. Pruning a day that was never
-- rolled up destroys it, and that is not recoverable, so the prune only ever
-- touches days the rollup has already covered.

CREATE OR REPLACE FUNCTION public.prune_automation_steps(keep_days integer DEFAULT 30)
RETURNS TABLE (rolled_days integer, deleted_rows bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  cutoff  date := (now() AT TIME ZONE 'UTC')::date - keep_days;
  d       date;
  days    integer := 0;
  gone    bigint  := 0;
BEGIN
  -- Every day that still has raw rows older than the cutoff, oldest first.
  FOR d IN
    SELECT DISTINCT (occurred_at AT TIME ZONE 'UTC')::date AS day
    FROM public.automation_steps
    WHERE occurred_at < cutoff::timestamptz
    ORDER BY 1
  LOOP
    PERFORM public.roll_up_automation_day(d);
    days := days + 1;
  END LOOP;

  DELETE FROM public.automation_steps WHERE occurred_at < cutoff::timestamptz;
  GET DIAGNOSTICS gone = ROW_COUNT;

  RETURN QUERY SELECT days, gone;
END;
$$;

COMMENT ON FUNCTION public.prune_automation_steps IS
  'MEAL-219. Rolls every day older than keep_days into automation_daily, THEN deletes it. Idempotent; safe to re-run.';

-- ── 4 · yesterday, every day ─────────────────────────────────────────────────
--
-- Rolling yesterday up nightly means the aggregate is never more than a day
-- behind, so the dashboard can read `daily` for old windows and `steps` for
-- recent ones without a gap between them. The prune is separate and slower-
-- moving; scheduling both is in the checklist item that ships with this.

-- ── 5 · These two are for the server, not for the internet ──────────────────
--
-- A function is created with EXECUTE granted to PUBLIC by default, and
-- `prune_automation_steps` is SECURITY DEFINER and DELETES telemetry. Created
-- without this, anyone with the anon key -- which ships in mealio.co's
-- JavaScript bundle -- could call it and wipe the funnel.
--
-- PUBLIC IS REVOKED FIRST, and that ordering is the whole point: revoking a
-- privilege from a role does not remove a grant made to PUBLIC, so revoking
-- only from anon/authenticated would look correct and change nothing.
--
-- automation_daily is created above with RLS off, like every table. It is
-- turned on here so it is never born open.

ALTER TABLE public.automation_daily ENABLE ROW LEVEL SECURITY;

REVOKE EXECUTE ON FUNCTION public.roll_up_automation_day(date)     FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.roll_up_automation_day(date)     FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.roll_up_automation_day(date)     TO service_role;

REVOKE EXECUTE ON FUNCTION public.prune_automation_steps(integer)  FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.prune_automation_steps(integer)  FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.prune_automation_steps(integer)  TO service_role;


-- ==========================================================================
-- MEAL-217  ·  20260905000003_notification_prefs.sql
--
-- Adds user_profiles.notification_prefs
-- This is the one behind the 500 on /api/account/notification-prefs.
-- ==========================================================================

-- MEAL-217. A user's notification choices, where the SERVER can see them.
--
-- Until now the only control was a single switch in Account whose off state
-- lived in SecureStore on the handset. The server never learned about it, so
-- any sender written afterwards would have pushed to someone who had turned
-- notifications off. The setting looked like a preference and was a local mute.
--
-- jsonb rather than a column per category, because the categories will change
-- and a boolean column per kind means a migration every time the product learns
-- to say something new. The shape is small and closed --
-- { all?: bool, broadcast?: bool, creator_draft?: bool } -- and the server
-- drops keys it does not recognise before writing (lib/notification-prefs.ts).
--
-- DEFAULT IS AN EMPTY OBJECT, NOT A SET OF FALSES. Absent means ON: a user who
-- has never opened the settings screen must still receive the first
-- notification Mealio ever sends. Writing falses here would mean shipping the
-- feature to nobody, silently, in a way that looks like a broken sender.

ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS notification_prefs jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.user_profiles.notification_prefs IS
  'MEAL-217. { all?, broadcast?, creator_draft? }. Absent or true = send. `all: false` is the master switch and is stored separately from the per-category flags so turning it back on restores individual choices rather than flattening them.';

-- The send path reads this for a set of user ids at once. A GIN index would be
-- the reflex and is the wrong tool: the query is "give me these users' prefs",
-- which the primary key already serves. Nothing filters ON the jsonb.


-- ==========================================================================
-- MEAL-222  ·  20260906000001_recipe_imports.sql
--
-- Creates `recipe_imports`, the per-import token and cost accounting.
-- ==========================================================================

-- MEAL-222. Every recipe import, with the tokens and the cost it actually spent.
--
-- Nothing new is measured here. `lib/import/anthropic.ts` already reads
-- `usage.input_tokens` and `usage.output_tokens` off every response, records the
-- CONCRETE model snapshot the API served (claude-haiku-4-5-20251001, not the
-- alias we sent), and prices it -- per call, gate and extraction separately.
-- Then `ImportTelemetry` flattened the lot to one `costUsd` and wrote a log
-- line. This is the promotion that comment asked for: "it can be promoted to a
-- table once the poller makes the volume worth querying", and opening imports to
-- users (MEAL-221) is that moment.
--
-- ONE ROW PER ATTEMPT, NOT PER SUCCESS. A rejection costs money too -- about
-- $0.0031 when the gate says no -- and an import that failed AFTER paying for
-- extraction is exactly the row worth finding. Filtering to successes would hide
-- the spend that has nothing to show for it.
--
-- TOKENS AND COST, PER STAGE. Both, and separately, for three reasons:
--
--   * Prices change and models change. Tokens are the FACT and the dollar figure
--     is a derivation, so keeping both means a repricing can be recomputed over
--     history rather than leaving a column that quietly means something
--     different before and after a date.
--   * "How often does the gate reject, and what does rejecting cost" cannot be
--     answered from a single total.
--   * TYPICAL_IMPORT_TOKENS in lib/import/cost.ts was measured in MEAL-71 when
--     extraction ran on Opus with adaptive thinking. Extraction is Haiku now and
--     thinking is off, and nobody has re-measured the SHAPE. Pricing follows the
--     model automatically; the token counts do not. A week of these rows
--     replaces that estimate with fact.
--
-- WHY ONE TABLE AND NOT TWO. `actor` distinguishes an import a creator ran from
-- one a user ran, which is the split Stephen asked for. Two tables would make
-- every "what did imports cost this month" query a UNION, and MEAL-221's
-- per-user budget needs a count that cannot be allowed to disagree with the
-- accounting -- which it will, if they are two different counters.

CREATE TABLE IF NOT EXISTS public.recipe_imports (
  id           bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  occurred_at  timestamptz NOT NULL DEFAULT now(),

  -- ── who ───────────────────────────────────────────────────────────────────
  -- Nullable: the poller imports on a creator's behalf with no user in the
  -- request, and a row with no user is still a row worth costing.
  user_id      uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  creator_id   uuid REFERENCES public.creators(id) ON DELETE SET NULL,
  -- 'creator' | 'user'. Unconstrained text on purpose, like `phase` in
  -- MEAL-219: a newer server shipping a third kind of actor must not have its
  -- rows REJECTED by an older database, which loses exactly the rows we most
  -- want to see at the moment something new is happening.
  actor        text NOT NULL,

  -- ── what ──────────────────────────────────────────────────────────────────
  -- THE URL IS STORED, NOT HASHED, and that was a real choice. It is the
  -- creator's own published page, already public, and already written in full
  -- to creator_source_items and to the log line this replaces -- so hashing
  -- here would protect nothing while making the two questions this table exists
  -- for unanswerable: "which import cost this much" and "what does a KEPT meal
  -- cost", the second of which needs a join to the draft the URL produced.
  -- Capped so a pathological URL cannot bloat the row.
  url          text,
  platform     text,
  path         text,

  -- ── outcome ───────────────────────────────────────────────────────────────
  outcome      text NOT NULL,
  stage        text NOT NULL,
  reason       text,
  gate_verdict text,
  gate_source  text,
  -- A cache hit costs nothing and must not be averaged in with calls that paid.
  cached       boolean NOT NULL DEFAULT false,

  -- ── tokens and cost, per stage ────────────────────────────────────────────
  gate_model            text,
  gate_input_tokens     integer,
  gate_output_tokens    integer,
  gate_cost_usd         numeric(10, 6),
  extract_model         text,
  extract_input_tokens  integer,
  extract_output_tokens integer,
  extract_cost_usd      numeric(10, 6),
  -- Stored rather than generated. It is the sum of the two above TODAY, but a
  -- third paid stage would make a generated column silently wrong at exactly
  -- the moment it mattered, and this is the number every dashboard reads.
  total_cost_usd        numeric(10, 6) NOT NULL DEFAULT 0,

  -- ── quality ───────────────────────────────────────────────────────────────
  ingredient_count integer,
  confidence_green integer,
  confidence_amber integer,
  confidence_red   integer,

  duration_ms integer,

  -- Long enough for any real URL, short enough that a crafted one cannot bloat
  -- the table. Enforced here rather than only in the writer, because the writer
  -- is not the only thing that will ever insert.
  CONSTRAINT recipe_imports_url_len CHECK (url IS NULL OR length(url) <= 2048)
);

COMMENT ON TABLE public.recipe_imports IS
  'MEAL-222. One row per import ATTEMPT, creator or user, with per-stage tokens and cost. Rejections included: they cost money too.';
COMMENT ON COLUMN public.recipe_imports.actor IS
  'MEAL-222. creator|user. Unconstrained on purpose so a newer server is never rejected by an older database.';
COMMENT ON COLUMN public.recipe_imports.gate_model IS
  'MEAL-222. The CONCRETE model snapshot the API served, not the alias we sent. The client goes to the trouble of capturing it and that is worthless unless it is persisted.';
COMMENT ON COLUMN public.recipe_imports.total_cost_usd IS
  'MEAL-222. Sum of the per-stage costs. Stored, not generated: a third paid stage would make a generated column silently wrong.';

-- ── indexes: the three questions this table exists to answer ────────────────

-- "What did imports cost this month, split by creator vs user."
CREATE INDEX IF NOT EXISTS idx_recipe_imports_actor_time
  ON public.recipe_imports (actor, occurred_at DESC);

-- MEAL-221's per-user monthly budget. Partial, because a row with no user is
-- never part of anyone's allowance and carrying it here only slows the count.
CREATE INDEX IF NOT EXISTS idx_recipe_imports_user_time
  ON public.recipe_imports (user_id, occurred_at DESC)
  WHERE user_id IS NOT NULL;

-- "How often does the gate reject, and what does rejecting cost."
CREATE INDEX IF NOT EXISTS idx_recipe_imports_outcome_time
  ON public.recipe_imports (outcome, stage, occurred_at DESC);

-- ── RLS, on from birth ──────────────────────────────────────────────────────
--
-- This table is for the server. It carries what every creator publishes, what
-- it cost us, and a URL per row, none of which belongs to the anon key that
-- ships inside mealio.co's JavaScript bundle.
--
-- No policies are added, which with RLS enabled means anon and authenticated
-- can do nothing at all. `service_role` bypasses RLS, so the writer and the
-- admin read are unaffected. This is the standing rule from the RLS lockdown:
-- a new table is never born open.

ALTER TABLE public.recipe_imports ENABLE ROW LEVEL SECURITY;

-- ── retention ───────────────────────────────────────────────────────────────
--
-- Decided here rather than left to be decided later, which is what MEAL-219's
-- rollup ticket asked for. KEPT OUTRIGHT, no prune: this is one row per import,
-- not one per step. At a hundred imports a month it is 1,200 rows a year, and
-- the whole point of "cost per KEPT meal" is a question asked over history. A
-- prune here would delete the answer to the question the table was built for.
