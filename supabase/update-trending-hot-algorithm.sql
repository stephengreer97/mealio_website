-- Update the trending score function to use a Reddit-style Hot algorithm.
--
-- Formula:
--   hot_score = log10(max(total_saves, 1))
--             + (epoch(created_at) - reference_epoch) / 45000
--
-- The log10 term gives diminishing returns on saves:
--   0 saves → 0 pts   1 save → 0 pts   10 saves → 1 pt   100 saves → 2 pts
--
-- The age term adds ~1.92 pts per day of recency.
-- Together: a new meal beats an older one with the same saves, but a popular
-- old meal can overcome the recency gap.
--
-- reference_epoch = 1700000000 (2023-11-14) — a fixed point near Mealio's launch.
-- Using a fixed reference keeps scores stable and comparable across queries.

CREATE OR REPLACE FUNCTION get_preset_meals_with_trending(partner_only boolean DEFAULT false)
RETURNS TABLE (
  id             uuid,
  name           text,
  source         text,
  recipe         text,
  ingredients    jsonb,
  photo_url      text,
  author         text,
  difficulty     integer,
  creator_id     uuid,
  creator_name   text,
  creator_social text,
  trending_score numeric
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    pm.id,
    pm.name,
    pm.source,
    pm.recipe,
    pm.ingredients,
    pm.photo_url,
    pm.author,
    pm.difficulty,
    pm.creator_id,
    c.display_name  AS creator_name,
    c.social_handle AS creator_social,
    ROUND(
      LOG(10, GREATEST(COUNT(pms.id)::numeric, 1))
      + (EXTRACT(EPOCH FROM pm.created_at)::bigint - 1700000000)::numeric / 45000
    , 7) AS trending_score
  FROM preset_meals pm
  LEFT JOIN creators c             ON pm.creator_id = c.id
  LEFT JOIN preset_meal_saves pms  ON pm.id = pms.preset_meal_id
  WHERE (NOT partner_only OR pm.creator_id IS NOT NULL)
  GROUP BY pm.id, pm.created_at, c.display_name, c.social_handle
  ORDER BY trending_score DESC;
END;
$$ LANGUAGE plpgsql;
