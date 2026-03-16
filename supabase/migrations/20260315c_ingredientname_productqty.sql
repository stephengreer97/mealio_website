-- Rename productName → ingredientName and add productQty in ingredient JSONB arrays.
--
-- Old: { "productName": "...", "qty": N, "unit": "...", "measure": "...", "searchTerm": null }
-- New: { "ingredientName": "...", "qty": N, "unit": "...", "measure": "...", "searchTerm": null, "productQty": N }
--
-- Rules:
--   - ingredientName = existing ingredientName, else productName, else ''
--   - productQty     = existing productQty, else qty, else quantity, else 1
--   - Remove productName key (replaced by ingredientName)
-- Safe to re-run: already-migrated rows keep their ingredientName / productQty.

UPDATE meals
SET ingredients = (
  SELECT jsonb_agg(
    CASE
      WHEN jsonb_typeof(elem) != 'object' THEN elem
      ELSE
        (elem - 'productName')
        || jsonb_build_object(
             'ingredientName', COALESCE(
               NULLIF(elem->>'ingredientName', ''),
               NULLIF(elem->>'productName', ''),
               ''
             ),
             'productQty', COALESCE(
               (elem->>'productQty')::numeric,
               (elem->>'qty')::numeric,
               (elem->>'quantity')::numeric,
               1
             )::int
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
      WHEN jsonb_typeof(elem) != 'object' THEN elem
      ELSE
        (elem - 'productName')
        || jsonb_build_object(
             'ingredientName', COALESCE(
               NULLIF(elem->>'ingredientName', ''),
               NULLIF(elem->>'productName', ''),
               ''
             ),
             'productQty', COALESCE(
               (elem->>'productQty')::numeric,
               (elem->>'qty')::numeric,
               (elem->>'quantity')::numeric,
               1
             )::int
           )
    END
  )
  FROM jsonb_array_elements(ingredients) AS elem
)
WHERE ingredients IS NOT NULL
  AND jsonb_typeof(ingredients) = 'array';
