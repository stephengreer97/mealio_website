-- Atomic OTP attempt increment (fixes the read-then-write race in
-- app/api/auth/2fa/verify/route.ts). A single UPDATE ... RETURNING is atomic,
-- so concurrent verify requests each get a distinct incremented value and the
-- MAX_ATTEMPTS lockout can't be bypassed.
--
-- Run this in the Supabase SQL editor BEFORE deploying the code that calls it.

CREATE OR REPLACE FUNCTION increment_otp_attempts(otp_id uuid)
RETURNS integer
LANGUAGE sql
AS $$
  UPDATE otp_codes SET attempts = attempts + 1 WHERE id = otp_id RETURNING attempts;
$$;

-- Only the server (service_role) should call this; keep it off the public API.
REVOKE EXECUTE ON FUNCTION increment_otp_attempts(uuid) FROM PUBLIC, anon, authenticated;
