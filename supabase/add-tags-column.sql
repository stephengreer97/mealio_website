-- Add tags column to preset_meals and meals tables
-- Tags are stored as a text array (max 3 per meal, enforced at application layer)

ALTER TABLE preset_meals ADD COLUMN IF NOT EXISTS tags text[] DEFAULT '{}';
ALTER TABLE meals ADD COLUMN IF NOT EXISTS tags text[] DEFAULT '{}';
