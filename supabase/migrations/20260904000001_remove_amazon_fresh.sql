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
