DROP FUNCTION IF EXISTS public.get_preset_meals_with_trending(boolean);

CREATE OR REPLACE FUNCTION public.get_preset_meals_with_trending(partner_only boolean DEFAULT false)
 RETURNS TABLE(id uuid, name text, source text, recipe text, story text, ingredients jsonb, photo_url text, author text, difficulty integer, serves text, creator_id uuid, creator_name text, creator_social text, trending_score numeric, tags text[])
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  RETURN QUERY
  SELECT
    pm.id,
    pm.name,
    pm.source,
    pm.recipe,
    pm.story,
    pm.ingredients,
    pm.photo_url,
    pm.author,
    pm.difficulty,
    pm.serves,
    pm.creator_id,
    c.display_name  AS creator_name,
    c.social_handle AS creator_social,
    ROUND(
      LOG(10, GREATEST(COUNT(pms.id)::numeric, 1))
      - EXTRACT(EPOCH FROM (NOW() - pm.created_at))::numeric / 604800
    , 7) AS trending_score,
    pm.tags
  FROM preset_meals pm
  LEFT JOIN creators c             ON pm.creator_id = c.id
  LEFT JOIN preset_meal_saves pms  ON pm.id = pms.preset_meal_id
  WHERE (NOT partner_only OR pm.creator_id IS NOT NULL)
  GROUP BY pm.id, pm.created_at, c.display_name, c.social_handle
  ORDER BY trending_score DESC;
END;
$function$
