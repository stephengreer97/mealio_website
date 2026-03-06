-- Remove description from preset_meals — recipe field covers this
ALTER TABLE preset_meals
  DROP COLUMN IF EXISTS description;
