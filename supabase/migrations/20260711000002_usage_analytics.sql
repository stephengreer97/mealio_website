-- Usage analytics: app/website opens + automation runs.
-- Idempotent. Both tables cascade-delete with the user so account deletion
-- auto-cleans them (no change to the account-delete flow).

-- One row per real session (session-level; deduped client-side).
CREATE TABLE IF NOT EXISTS public.app_opens (
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES public.user_profiles (id) ON DELETE CASCADE,
  source      text NOT NULL,           -- 'app' | 'web'
  platform    text,                    -- 'ios' | 'android' | 'web'
  app_version text,
  opened_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id)
);
CREATE INDEX IF NOT EXISTS idx_app_opens_user_opened ON public.app_opens (user_id, opened_at);

-- One row per add-to-cart automation run: created at start, updated at completion
-- (rows left 'started' = abandoned/never finished).
CREATE TABLE IF NOT EXISTS public.automation_runs (
  id              uuid NOT NULL DEFAULT gen_random_uuid(),  -- the run id
  user_id         uuid NOT NULL REFERENCES public.user_profiles (id) ON DELETE CASCADE,
  store_id        text NOT NULL,
  source          text NOT NULL,       -- 'app' | 'web'
  status          text NOT NULL DEFAULT 'started',  -- 'started' | 'completed' | 'failed'
  meal_count      int,
  items_requested int,
  items_added     int,
  outcome         text,                -- 'success' | 'partial' | 'failed'
  started_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz,
  PRIMARY KEY (id)
);
CREATE INDEX IF NOT EXISTS idx_automation_runs_user_started ON public.automation_runs (user_id, started_at);
CREATE INDEX IF NOT EXISTS idx_automation_runs_store        ON public.automation_runs (store_id);
