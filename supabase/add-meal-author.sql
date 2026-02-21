-- Add author column to meals and preset_meals tables
ALTER TABLE meals
  ADD COLUMN IF NOT EXISTS author text;

ALTER TABLE preset_meals
  ADD COLUMN IF NOT EXISTS author text;
