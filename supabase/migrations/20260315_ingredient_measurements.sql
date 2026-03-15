-- Normalize all existing ingredients to the new measurements schema.
--
-- Old format: { "productName": "...", "quantity": 1, "searchTerm": "..." }
-- New format: { "productName": "...", "qty": 1, "unit": "qty", "measure": null, "searchTerm": "..." }
--
-- Rules:
--   - If ingredient object already has "unit" → skip (already migrated).
--   - Otherwise: remove "quantity", add "qty" (from quantity, default 1),
--     add "unit": "qty", add "measure": null.
--
-- Safe to re-run: already-migrated rows have "unit" and are skipped.

UPDATE meals
SET ingredients = (
  SELECT jsonb_agg(
    CASE
      WHEN jsonb_typeof(elem) != 'object'   THEN elem
      WHEN (elem->>'unit') IS NOT NULL       THEN elem
      ELSE
        (elem - 'quantity')
        || jsonb_build_object(
             'qty',     COALESCE((elem->>'quantity')::int, 1),
             'unit',    'qty',
             'measure', NULL
           )
    END
  )
  FROM jsonb_array_elements(ingredients) AS elem
)
WHERE ingredients IS NOT NULL
  AND jsonb_typeof(ingredients) = 'array';

UPDATE preset_meals
SET ingredients = (
  SELECT jsonb_agg(
    CASE
      WHEN jsonb_typeof(elem) != 'object'   THEN elem
      WHEN (elem->>'unit') IS NOT NULL       THEN elem
      ELSE
        (elem - 'quantity')
        || jsonb_build_object(
             'qty',     COALESCE((elem->>'quantity')::int, 1),
             'unit',    'qty',
             'measure', NULL
           )
    END
  )
  FROM jsonb_array_elements(ingredients) AS elem
)
WHERE ingredients IS NOT NULL
  AND jsonb_typeof(ingredients) = 'array';
