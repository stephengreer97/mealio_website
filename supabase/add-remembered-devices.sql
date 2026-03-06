-- Remembered devices for 2FA bypass (30-day trust window)
CREATE TABLE IF NOT EXISTS remembered_devices (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  user_agent  text,
  ip_address  text,
  created_at  timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_remembered_devices_user_id    ON remembered_devices(user_id);
CREATE INDEX IF NOT EXISTS idx_remembered_devices_token_hash ON remembered_devices(token_hash);
