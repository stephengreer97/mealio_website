-- Null out all searchTerm values in existing ingredients.
-- searchTerm should only be set after the first add-to-cart flow.
-- Safe to re-run: sets searchTerm to null unconditionally on all ingredient objects.

UPDATE meals
SET ingredients = (
  SELECT jsonb_agg(
    CASE
      WHEN jsonb_typeof(elem) != 'object' THEN elem
      ELSE elem || jsonb_build_object('searchTerm', NULL)
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
      ELSE elem || jsonb_build_object('searchTerm', NULL)
    END
  )
  FROM jsonb_array_elements(ingredients) AS elem
)
WHERE ingredients IS NOT NULL
  AND jsonb_typeof(ingredients) = 'array';
