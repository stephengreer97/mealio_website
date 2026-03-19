-- Social login: add google_id and apple_id columns to user_profiles
ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS google_id text UNIQUE,
  ADD COLUMN IF NOT EXISTS apple_id  text UNIQUE;

CREATE INDEX IF NOT EXISTS idx_user_profiles_google_id ON user_profiles (google_id) WHERE google_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_user_profiles_apple_id  ON user_profiles (apple_id)  WHERE apple_id  IS NOT NULL;
