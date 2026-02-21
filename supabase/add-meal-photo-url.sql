-- Add photo_url column to meals table for centrally-stored meal images
ALTER TABLE meals
  ADD COLUMN IF NOT EXISTS photo_url text;
