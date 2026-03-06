ALTER TABLE creator_applications ADD COLUMN IF NOT EXISTS photo_url text;
ALTER TABLE creators ADD COLUMN IF NOT EXISTS photo_url text;
