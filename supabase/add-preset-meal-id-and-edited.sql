-- Run in: Supabase Dashboard → SQL Editor
-- Adds preset_meal_id (FK to preset_meals) and edited flag to the meals table.

ALTER TABLE meals
  ADD COLUMN IF NOT EXISTS preset_meal_id uuid REFERENCES preset_meals(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS edited boolean NOT NULL DEFAULT false;
