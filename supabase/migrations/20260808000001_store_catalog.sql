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
  -- here for humans reading this table and for ops queries. Measured on the
  -- seed: `platform = 'kroger'` is EXACTLY KROGER_BRAND_IDS and its complement
  -- is exactly WEBVIEW_STORE_IDS, and `banner_group = 'Kroger'` partitions
  -- identically — so putting either on the wire would hand the app a complete
  -- reimplementation of the capability split this ticket exists to keep in the
  -- binary. Query them freely here; the endpoint does not select them.
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
