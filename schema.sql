-- app_settings
CREATE TABLE app_settings (
  key   text NOT NULL,
  value text,
  PRIMARY KEY (key)
);

-- creator_applications
CREATE TABLE creator_applications (
  id           uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL,
  display_name text NOT NULL,
  status       text NOT NULL DEFAULT 'pending',
  created_at   timestamptz DEFAULT now(),
  phone        text,
  find_us      text,
  photo_url    text,
  PRIMARY KEY (id)
);

-- creator_follows
CREATE TABLE creator_follows (
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL,
  creator_id  uuid NOT NULL,
  followed_at timestamptz DEFAULT now(),
  PRIMARY KEY (id)
);

-- creators
CREATE TABLE creators (
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL,
  display_name  text NOT NULL,
  bio           text,
  social_handle text,
  approved_at   timestamptz DEFAULT now(),
  created_at    timestamptz DEFAULT now(),
  photo_url     text,
  PRIMARY KEY (id)
);

-- meals
CREATE TABLE meals (
  id             uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL,
  name           text NOT NULL,
  store_id       text NOT NULL,
  ingredients    jsonb NOT NULL DEFAULT '[]',
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  preset_meal_id uuid,
  edited         boolean NOT NULL DEFAULT false,
  website        text,
  recipe         text,
  photo_url      text,
  author         text,
  difficulty     integer,
  share_token    text,
  tags           text[] DEFAULT '{}',
  is_active      boolean NOT NULL DEFAULT true,
  creator_id     uuid,
  story          text,
  PRIMARY KEY (id)
);

-- otp_codes
CREATE TABLE otp_codes (
  id         uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL,
  code_hash  text NOT NULL,
  expires_at timestamptz NOT NULL,
  used       boolean NOT NULL DEFAULT false,
  attempts   integer NOT NULL DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  PRIMARY KEY (id)
);

-- preset_meal_saves
CREATE TABLE preset_meal_saves (
  id             uuid NOT NULL DEFAULT gen_random_uuid(),
  preset_meal_id uuid NOT NULL,
  user_id        uuid NOT NULL,
  saved_at       timestamptz DEFAULT now(),
  PRIMARY KEY (id)
);

-- preset_meals
CREATE TABLE preset_meals (
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  source      text DEFAULT '',
  ingredients jsonb NOT NULL DEFAULT '[]',
  created_at  timestamptz DEFAULT now(),
  author_id   uuid,
  recipe      text,
  photo_url   text,
  author      text,
  difficulty  integer,
  creator_id  uuid,
  tags        text[] DEFAULT '{}',
  story       text,
  PRIMARY KEY (id)
);

-- refresh_tokens
CREATE TABLE refresh_tokens (
  id           uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL,
  token_hash   text NOT NULL,
  expires_at   timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now(),
  revoked      boolean DEFAULT false,
  user_agent   text,
  ip_address   inet,
  PRIMARY KEY (id)
);

-- remembered_devices
CREATE TABLE remembered_devices (
  id         uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL,
  token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  user_agent text,
  ip_address text,
  created_at timestamptz DEFAULT now(),
  PRIMARY KEY (id)
);

-- subscription_events
CREATE TABLE subscription_events (
  id         uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id    uuid,
  event      text NOT NULL,
  created_at timestamptz DEFAULT now(),
  PRIMARY KEY (id)
);

-- user_profiles
CREATE TABLE user_profiles (
  id                           uuid NOT NULL,
  email                        text NOT NULL,
  display_name                 text,
  created_at                   timestamptz NOT NULL DEFAULT now(),
  updated_at                   timestamptz NOT NULL DEFAULT now(),
  last_login_at                timestamptz,
  metadata                     jsonb DEFAULT '{}',
  subscription_tier            text NOT NULL DEFAULT 'free',
  lemonsqueezy_customer_id     text,
  lemonsqueezy_subscription_id text,
  subscription_ends_at         timestamptz,
  is_admin                     boolean NOT NULL DEFAULT false,
  stripe_customer_id           text,
  stripe_subscription_id       text,
  PRIMARY KEY (id)
);

-- Unique constraints
ALTER TABLE creator_applications  ADD CONSTRAINT creator_applications_user_id_key             UNIQUE (user_id);
ALTER TABLE creator_follows       ADD CONSTRAINT creator_follows_user_id_creator_id_key       UNIQUE (user_id, creator_id);
ALTER TABLE meals                 ADD CONSTRAINT meals_share_token_key                        UNIQUE (share_token);
ALTER TABLE preset_meal_saves     ADD CONSTRAINT preset_meal_saves_preset_meal_id_user_id_key UNIQUE (preset_meal_id, user_id);
ALTER TABLE refresh_tokens        ADD CONSTRAINT refresh_tokens_token_hash_key                UNIQUE (token_hash);
ALTER TABLE remembered_devices    ADD CONSTRAINT remembered_devices_token_hash_key            UNIQUE (token_hash);
ALTER TABLE user_profiles         ADD CONSTRAINT user_profiles_email_key                      UNIQUE (email);

-- Indexes
CREATE INDEX idx_creator_follows_creator_id    ON creator_follows    (creator_id);
CREATE INDEX idx_creator_follows_user_id       ON creator_follows    (user_id);
CREATE INDEX idx_creators_user_id              ON creators           (user_id);
CREATE INDEX idx_otp_codes_user_id             ON otp_codes          (user_id);
CREATE INDEX idx_preset_meal_saves_meal_id     ON preset_meal_saves  (preset_meal_id);
CREATE INDEX idx_preset_meal_saves_user_id     ON preset_meal_saves  (user_id);
CREATE INDEX idx_preset_meal_saves_saved_at    ON preset_meal_saves  (saved_at);
CREATE INDEX idx_refresh_tokens_token_hash     ON refresh_tokens     (token_hash);
CREATE INDEX idx_refresh_tokens_expires_at     ON refresh_tokens     (expires_at);
CREATE INDEX idx_refresh_tokens_user_id        ON refresh_tokens     (user_id);
CREATE INDEX idx_remembered_devices_token_hash ON remembered_devices (token_hash);
CREATE INDEX idx_remembered_devices_user_id    ON remembered_devices (user_id);
CREATE INDEX idx_user_profiles_email           ON user_profiles      (email);

-- Foreign keys
ALTER TABLE meals                ADD CONSTRAINT meals_preset_meal_id_fkey                    FOREIGN KEY (preset_meal_id) REFERENCES preset_meals  (id);
ALTER TABLE meals                ADD CONSTRAINT meals_creator_id_fkey                        FOREIGN KEY (creator_id)     REFERENCES creators       (id);
ALTER TABLE preset_meals         ADD CONSTRAINT preset_meals_author_id_fkey                  FOREIGN KEY (author_id)      REFERENCES user_profiles  (id);
ALTER TABLE preset_meals         ADD CONSTRAINT preset_meals_creator_id_fkey                 FOREIGN KEY (creator_id)     REFERENCES creators       (id);
ALTER TABLE preset_meal_saves    ADD CONSTRAINT preset_meal_saves_preset_meal_id_fkey        FOREIGN KEY (preset_meal_id) REFERENCES preset_meals   (id);
ALTER TABLE preset_meal_saves    ADD CONSTRAINT preset_meal_saves_user_id_fkey               FOREIGN KEY (user_id)        REFERENCES user_profiles  (id);
ALTER TABLE creator_applications ADD CONSTRAINT creator_applications_user_id_fkey            FOREIGN KEY (user_id)        REFERENCES user_profiles  (id);
ALTER TABLE creators             ADD CONSTRAINT creators_user_id_fkey                        FOREIGN KEY (user_id)        REFERENCES user_profiles  (id);
ALTER TABLE creator_follows      ADD CONSTRAINT creator_follows_user_id_fkey                 FOREIGN KEY (user_id)        REFERENCES user_profiles  (id);
ALTER TABLE creator_follows      ADD CONSTRAINT creator_follows_creator_id_fkey              FOREIGN KEY (creator_id)     REFERENCES creators       (id);
ALTER TABLE otp_codes            ADD CONSTRAINT otp_codes_user_id_fkey                       FOREIGN KEY (user_id)        REFERENCES user_profiles  (id);
ALTER TABLE remembered_devices   ADD CONSTRAINT remembered_devices_user_id_fkey              FOREIGN KEY (user_id)        REFERENCES user_profiles  (id);
ALTER TABLE subscription_events  ADD CONSTRAINT subscription_events_user_id_fkey             FOREIGN KEY (user_id)        REFERENCES user_profiles  (id);

-- Functions

CREATE OR REPLACE FUNCTION public.cleanup_expired_tokens()
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM public.refresh_tokens
  WHERE expires_at < NOW()
  OR (revoked = true AND created_at < NOW() - INTERVAL '30 days');
END;
$$;

CREATE OR REPLACE FUNCTION public.get_preset_meals_with_trending(partner_only boolean DEFAULT false)
RETURNS TABLE (
  id             uuid,
  name           text,
  source         text,
  recipe         text,
  story          text,
  ingredients    jsonb,
  photo_url      text,
  author         text,
  difficulty     integer,
  creator_id     uuid,
  creator_name   text,
  creator_social text,
  trending_score numeric,
  tags           text[]
) LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY
  SELECT
    pm.id,
    pm.name,
    pm.source,
    pm.recipe,
    pm.story,
    pm.ingredients,
    pm.photo_url,
    pm.author,
    pm.difficulty,
    pm.creator_id,
    c.display_name  AS creator_name,
    c.social_handle AS creator_social,
    ROUND(
      LOG(10, GREATEST(COUNT(pms.id)::numeric, 1))
      - EXTRACT(EPOCH FROM (NOW() - pm.created_at))::numeric / 604800
    , 7) AS trending_score,
    pm.tags
  FROM preset_meals pm
  LEFT JOIN creators c             ON pm.creator_id = c.id
  LEFT JOIN preset_meal_saves pms  ON pm.id = pms.preset_meal_id
  WHERE (NOT partner_only OR pm.creator_id IS NOT NULL)
  GROUP BY pm.id, pm.created_at, c.display_name, c.social_handle
  ORDER BY trending_score DESC;
END;
$$;

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO public.user_profiles (id, email, display_name)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'display_name', split_part(NEW.email, '@', 1))
  );
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.handle_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

-- Triggers

CREATE OR REPLACE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

CREATE OR REPLACE TRIGGER set_meals_updated_at
  BEFORE UPDATE ON public.meals
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

CREATE OR REPLACE TRIGGER set_user_profiles_updated_at
  BEFORE UPDATE ON public.user_profiles
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();
