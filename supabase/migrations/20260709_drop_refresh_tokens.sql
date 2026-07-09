-- The refresh-token mechanism is retired: the app uses a single sliding 90-day
-- access token (renewed via /api/auth/renew) with revocation enforced through
-- user_profiles.tokens_invalidated_at. Nothing reads or writes refresh_tokens
-- anymore, so drop the table.
drop table if exists public.refresh_tokens;
