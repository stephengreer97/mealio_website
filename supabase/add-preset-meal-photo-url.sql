-- Add photo_url column to preset_meals table
ALTER TABLE preset_meals
  ADD COLUMN IF NOT EXISTS photo_url text;
