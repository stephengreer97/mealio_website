-- Creator Partner Program
-- Run in Supabase SQL Editor

-- 1. Applications table (requires Mealio account)
CREATE TABLE IF NOT EXISTS creator_applications (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES user_profiles(id),
  display_name  text NOT NULL,
  phone         text,
  status        text NOT NULL DEFAULT 'pending', -- 'pending' | 'approved' | 'rejected'
  created_at    timestamptz DEFAULT now(),
  UNIQUE(user_id)
);

-- 2. Approved creators table
CREATE TABLE IF NOT EXISTS creators (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES user_profiles(id),
  display_name  text NOT NULL,
  bio           text,
  social_handle text,
  approved_at   timestamptz DEFAULT now(),
  created_at    timestamptz DEFAULT now()
);

-- 3. Save event tracking (one row per user per meal, idempotent)
CREATE TABLE IF NOT EXISTS preset_meal_saves (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  preset_meal_id uuid NOT NULL REFERENCES preset_meals(id) ON DELETE CASCADE,
  user_id        uuid NOT NULL REFERENCES user_profiles(id),
  saved_at       timestamptz DEFAULT now(),
  UNIQUE(preset_meal_id, user_id)
);

-- 4. Link preset meals to creators (NULL = Mealio Kitchen)
ALTER TABLE preset_meals
  ADD COLUMN IF NOT EXISTS creator_id uuid REFERENCES creators(id);

-- 5. Indexes for performance
CREATE INDEX IF NOT EXISTS idx_preset_meal_saves_meal_id ON preset_meal_saves(preset_meal_id);
CREATE INDEX IF NOT EXISTS idx_preset_meal_saves_saved_at ON preset_meal_saves(saved_at);
CREATE INDEX IF NOT EXISTS idx_preset_meal_saves_user_id  ON preset_meal_saves(user_id);
CREATE INDEX IF NOT EXISTS idx_creators_user_id           ON creators(user_id);

-- 6. Trending score function
-- Returns preset meals sorted by trending score (recent saves weighted more heavily).
-- trending_score = saves_last_30d * 3 + saves_last_90d * 1 + saves_all_time * 0.1
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
    (
      COUNT(CASE WHEN pms.saved_at > NOW() - INTERVAL '30 days'  THEN 1 END) * 3   +
      COUNT(CASE WHEN pms.saved_at > NOW() - INTERVAL '90 days'  THEN 1 END) * 1   +
      COUNT(pms.id) * 0.1
    ) AS trending_score
  FROM preset_meals pm
  LEFT JOIN creators c          ON pm.creator_id = c.id
  LEFT JOIN preset_meal_saves pms ON pm.id = pms.preset_meal_id
  WHERE (NOT partner_only OR pm.creator_id IS NOT NULL)
  GROUP BY pm.id, c.display_name, c.social_handle
  ORDER BY trending_score DESC, pm.created_at ASC;
END;
$$ LANGUAGE plpgsql;
