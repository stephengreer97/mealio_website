-- Throttle for POST /api/auth/login.
--
-- WHY: the login endpoint had no limit of any kind. middleware.ts matches page
-- paths only ("(?!api|_next|...)"), vercel.json carries no firewall rules, and
-- the route itself counted nothing -- so an attacker could post passwords at it
-- for as long as they liked. 2FA means a guessed password alone does not get
-- anyone in, but it does not stop the guessing, and it does not stop the OTP
-- EMAIL that a correct password triggers on every single attempt.
--
-- Run this in the Supabase SQL editor BEFORE deploying the code that calls it.
-- Until it exists the route fails OPEN (see recordLoginAttempt) -- a throttle
-- that cannot read its own table must not lock everyone out of the product.

CREATE TABLE IF NOT EXISTS login_attempts (
  id         bigserial   PRIMARY KEY,
  -- 'email:someone@example.com' or 'ip:1.2.3.4'. One table, two kinds of key,
  -- because the two attacks are different shapes: many passwords against ONE
  -- account, and one password against MANY accounts.
  key        text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- The only query this table serves: count one key inside a window.
CREATE INDEX IF NOT EXISTS login_attempts_key_created_at
  ON login_attempts (key, created_at DESC);

-- Record an attempt and say how many that key has made in the window, in ONE
-- statement so concurrent requests cannot both read a stale count and both pass.
-- The same read-then-write race increment_otp_attempts was written to close.
CREATE OR REPLACE FUNCTION record_login_attempt(p_key text, p_window_seconds integer)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE n integer;
BEGIN
  INSERT INTO login_attempts (key) VALUES (p_key);
  SELECT count(*) INTO n
    FROM login_attempts
   WHERE key = p_key
     AND created_at > now() - make_interval(secs => p_window_seconds);
  -- Swept here rather than on a schedule: this table is only ever read for the
  -- current window, so anything older is dead weight and the delete is bounded
  -- by one key's rows.
  DELETE FROM login_attempts
   WHERE key = p_key
     AND created_at <= now() - make_interval(secs => p_window_seconds);
  RETURN n;
END;
$$;

-- Server only, exactly like increment_otp_attempts.
REVOKE EXECUTE ON FUNCTION record_login_attempt(text, integer) FROM PUBLIC, anon, authenticated;
ALTER TABLE login_attempts ENABLE ROW LEVEL SECURITY;
