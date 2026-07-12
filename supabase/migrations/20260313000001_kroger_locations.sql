ALTER TABLE user_profiles
ADD COLUMN IF NOT EXISTS kroger_locations jsonb NOT NULL DEFAULT '{}';
