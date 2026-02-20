-- Run this ONLY if you already created the preset_meals table from an older
-- version of seed-preset-meals.sql that did not include the recipe column.
-- Then re-run seed-preset-meals.sql to repopulate with recipe text.
ALTER TABLE preset_meals
  ADD COLUMN IF NOT EXISTS recipe text;
