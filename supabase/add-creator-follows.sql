CREATE TABLE IF NOT EXISTS creator_follows (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
  creator_id  uuid NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
  followed_at timestamptz DEFAULT now(),
  UNIQUE(user_id, creator_id)
);
CREATE INDEX IF NOT EXISTS idx_creator_follows_user_id    ON creator_follows(user_id);
CREATE INDEX IF NOT EXISTS idx_creator_follows_creator_id ON creator_follows(creator_id);
