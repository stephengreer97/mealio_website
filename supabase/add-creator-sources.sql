-- Creator sources, polling bookkeeping, push tokens, and import draft state.
-- MEAL-81 / MEAL-75 / MEAL-88 / MEAL-89.
-- Run in Supabase SQL Editor. Safe to re-run.

-- ---------------------------------------------------------------------------
-- 1. Where a creator publishes
--
-- All four links are stored; exactly ONE is polled. Which one is an operator
-- decision made during application review, not something the engine works out
-- (MEAL-81). Storing all four means switching a creator later is a field edit
-- rather than re-onboarding them.
-- ---------------------------------------------------------------------------

ALTER TABLE creators
  ADD COLUMN IF NOT EXISTS website_url    text,
  ADD COLUMN IF NOT EXISTS youtube_url    text,
  ADD COLUMN IF NOT EXISTS instagram_url  text,
  ADD COLUMN IF NOT EXISTS tiktok_url     text,
  -- 'website' | 'youtube' | 'instagram' | 'tiktok' | 'none'
  ADD COLUMN IF NOT EXISTS primary_source text NOT NULL DEFAULT 'none',
  -- Nothing is polled until this is true, regardless of primary_source.
  -- MEAL-77 requires opt-in to be explicit and revocable in one click.
  ADD COLUMN IF NOT EXISTS import_opt_in  boolean NOT NULL DEFAULT false,
  -- Discovered once at onboarding and confirmed back to the creator, so we
  -- never re-derive it (and never silently start importing a stranger's feed).
  ADD COLUMN IF NOT EXISTS feed_url       text;

ALTER TABLE creators
  DROP CONSTRAINT IF EXISTS creators_primary_source_check;
ALTER TABLE creators
  ADD CONSTRAINT creators_primary_source_check
  CHECK (primary_source IN ('website', 'youtube', 'instagram', 'tiktok', 'none'));

-- The application form collects the same four links, so an approval can copy
-- them across rather than asking the creator twice.
ALTER TABLE creator_applications
  ADD COLUMN IF NOT EXISTS website_url   text,
  ADD COLUMN IF NOT EXISTS youtube_url   text,
  ADD COLUMN IF NOT EXISTS instagram_url text,
  ADD COLUMN IF NOT EXISTS tiktok_url    text;

-- Only opted-in creators are ever polled, so that is the shape of the index.
CREATE INDEX IF NOT EXISTS idx_creators_polling
  ON creators (primary_source)
  WHERE import_opt_in = true AND primary_source <> 'none';

-- ---------------------------------------------------------------------------
-- 2. Platform credentials
--
-- Separate table rather than columns on `creators`: a creator may connect more
-- than one platform even though only one is polled, tokens rotate on their own
-- schedule, and keeping them out of the row that every creator read touches
-- means a careless `select *` does not carry refresh tokens around.
--
-- Token lifetimes differ sharply and both fail silently (MEAL-82 / MEAL-83):
--   instagram  ~60 days, and the refresh only works while the token is ALIVE
--   tiktok     refresh token up to 365 days
--   youtube    refresh token until revoked
-- `expires_at` is what the refresh worker sweeps on.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS creator_platform_accounts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id     uuid NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
  platform       text NOT NULL,
  -- The platform's own id for the account: YouTube channel id, IG user id,
  -- TikTok open id. Derived from the OAuth grant, never typed by a creator.
  external_id    text,
  external_name  text,
  access_token   text,
  refresh_token  text,
  scopes         text,
  expires_at     timestamptz,
  -- Set when a refresh fails. Non-null means the connection is broken and an
  -- operator needs to see it; a poller that finds nothing must never be the
  -- first sign (MEAL-82).
  broken_reason  text,
  broken_at      timestamptz,
  connected_at   timestamptz DEFAULT now(),
  updated_at     timestamptz DEFAULT now(),
  UNIQUE (creator_id, platform)
);

ALTER TABLE creator_platform_accounts
  DROP CONSTRAINT IF EXISTS creator_platform_accounts_platform_check;
ALTER TABLE creator_platform_accounts
  ADD CONSTRAINT creator_platform_accounts_platform_check
  CHECK (platform IN ('youtube', 'instagram', 'tiktok'));

-- The refresh worker's query: anything expiring soon that is not already broken.
CREATE INDEX IF NOT EXISTS idx_platform_accounts_expiring
  ON creator_platform_accounts (expires_at)
  WHERE broken_reason IS NULL;

-- ---------------------------------------------------------------------------
-- 3. What we have already seen
--
-- Deliberately NOT a high-water mark. A single last-seen guid or timestamp is
-- the obvious implementation and it silently loses posts: feed order is not
-- reliable, a scheduled post can publish late with an earlier date, an edit can
-- reorder entries, some platforms backdate. Anything landing "below" the mark
-- is never seen again and there is no error to notice.
--
-- The UNIQUE constraint is also the idempotency guarantee — a 15-minute cron
-- will eventually overlap itself or retry after a timeout, and re-processing a
-- cycle must not double-import (MEAL-75).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS creator_source_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id    uuid NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
  -- 'website' | 'youtube' | 'instagram' | 'tiktok'
  source        text NOT NULL,
  -- Feed guid, video id, media id. Stable per platform.
  item_id       text NOT NULL,
  url           text,
  title         text,
  published_at  timestamptz,
  -- 'seen'      marked at first connect WITHOUT importing, so connecting a blog
  --             with 200 archived posts does not fire 200 extractions
  -- 'imported'  produced a draft or a published meal
  -- 'rejected'  the gate said it is not a recipe; never retried, never notified
  -- 'failed'    extraction failed; retryable
  status        text NOT NULL DEFAULT 'seen',
  detail        text,
  draft_id      uuid,
  created_at    timestamptz DEFAULT now(),
  updated_at    timestamptz DEFAULT now(),
  UNIQUE (creator_id, source, item_id)
);

-- Six statuses, and this file said four. Production had already been widened by
-- hand for `skipped` and `withdrawn` without the migration following, so the
-- checked-in schema described a database that no longer existed.
--
-- That gap is invisible until someone reads this file and believes it, and it
-- has already cost one wrong diagnosis: a reviewer read `withdrawn` as
-- unpermitted, concluded MEAL-105's withdraw write was being silently rejected
-- in production, and reported a live bug that was not there.
--
--   seen       Polling has met this post. Nothing was imported from it.
--   imported   A draft was made, and may since have been published.
--   rejected   The gate read it and it is not a recipe. Permanent, because it
--              is an answer about the post rather than about our afternoon.
--   failed     Something broke on our side. Worth trying again.
--   skipped    Not attempted this run: already imported, or another run held it.
--   withdrawn  Imported once, and the meal made from it has since been deleted
--              (MEAL-105). Offerable again, and deliberately not a deletion of
--              the row: the poller reads the record's *presence* to know what it
--              has seen, so clearing it would have the next poll re-import what
--              the creator just removed.
ALTER TABLE creator_source_items
  DROP CONSTRAINT IF EXISTS creator_source_items_status_check;
ALTER TABLE creator_source_items
  ADD CONSTRAINT creator_source_items_status_check
  CHECK (status IN ('seen', 'imported', 'rejected', 'failed', 'skipped', 'withdrawn'));

-- No (creator_id, source) index: the UNIQUE above already builds a btree whose
-- leading columns are exactly those, so the planner serves every such lookup
-- from it and a second copy is write amplification on the table the 15-minute
-- cron writes most. Dropped rather than merely omitted, so a database that
-- already ran an earlier version of this file converges on the same shape.
DROP INDEX IF EXISTS idx_source_items_creator;

-- The retry sweep is "this creator's failed items", so the key is the column
-- that varies. Keying a partial index on the same column its WHERE clause pins
-- to one value buys nothing: every row in the index has status = 'failed'.
DROP INDEX IF EXISTS idx_source_items_retry;
CREATE INDEX IF NOT EXISTS idx_source_items_failed
  ON creator_source_items (creator_id) WHERE status = 'failed';

-- ---------------------------------------------------------------------------
-- 4. Per-source polling state
--
-- Conditional-request bookkeeping lives here so an unchanged feed costs a 304
-- rather than a full body (MEAL-75). `poll_after` carries per-domain backoff:
-- a 429 or a new 403 pushes it forward instead of us hammering on.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS creator_source_state (
  creator_id     uuid NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
  source         text NOT NULL,
  etag           text,
  last_modified  text,
  last_polled_at timestamptz,
  -- Not before this instant. Backoff and advertised TTL both write here.
  poll_after     timestamptz,
  consecutive_failures int NOT NULL DEFAULT 0,
  last_status    int,
  last_error     text,
  PRIMARY KEY (creator_id, source)
);

-- ---------------------------------------------------------------------------
-- 5. Import drafts awaiting the creator
--
-- Only the POLLER produces these. Admin sync publishes directly and notifies by
-- email instead (MEAL-90) — there a human already read the extraction.
--
-- A cancelled draft is marked, never deleted: the poller must not re-import the
-- same post next cycle and ask again, and MEAL-77's consent story needs to show
-- what was proposed and what the creator did about it.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS creator_import_drafts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id    uuid NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
  source_url    text NOT NULL,
  source        text,
  item_id       text,
  -- The CreatorMealDraft shape the publish form consumes.
  draft         jsonb NOT NULL,
  -- Field-level provenance from MEAL-72, so the review UI can call out only
  -- what needs a human.
  confidence    jsonb,
  status        text NOT NULL DEFAULT 'pending_review',
  decided_at    timestamptz,
  decided_by    uuid,
  published_meal_id uuid,
  created_at    timestamptz DEFAULT now(),
  updated_at    timestamptz DEFAULT now()
);

ALTER TABLE creator_import_drafts
  DROP CONSTRAINT IF EXISTS creator_import_drafts_status_check;
ALTER TABLE creator_import_drafts
  ADD CONSTRAINT creator_import_drafts_status_check
  CHECK (status IN ('pending_review', 'approved', 'edited', 'cancelled'));

-- The badge count query (MEAL-89), and the review queue itself.
CREATE INDEX IF NOT EXISTS idx_import_drafts_pending
  ON creator_import_drafts (creator_id)
  WHERE status = 'pending_review';

-- ---------------------------------------------------------------------------
-- 6. Push tokens (MEAL-88)
--
-- One row per device, not per user: a creator with a phone and a tablet must
-- get both. Expo hands back DeviceNotRegistered for uninstalled apps, which is
-- what `revoked_at` records so dead tokens stop being sent to.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS push_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
  token       text NOT NULL,
  platform    text,
  device_name text,
  created_at  timestamptz DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz
);

-- Unique on (user_id, token), NOT on token alone.
--
-- A handset changes hands, so registering a token another account already holds
-- has to succeed. Under UNIQUE(token) the only way to do that is to overwrite
-- the other account's row in place, which erases the fact that they were ever
-- enrolled and makes a handover indistinguishable from a takeover by anyone who
-- scraped a token out of a log. Keyed per account, the handover is the new row
-- appearing and the old one being revoked — same outcome, both halves recorded.
ALTER TABLE push_tokens DROP CONSTRAINT IF EXISTS push_tokens_token_key;
CREATE UNIQUE INDEX IF NOT EXISTS push_tokens_user_token_key
  ON push_tokens (user_id, token);

CREATE INDEX IF NOT EXISTS idx_push_tokens_user
  ON push_tokens (user_id)
  WHERE revoked_at IS NULL;

-- The revoke paths and the register handover both filter on token alone, which
-- the (user_id, token) index above cannot serve.
CREATE INDEX IF NOT EXISTS idx_push_tokens_token ON push_tokens (token);

-- Expo only makes a delivery receipt available a few minutes AFTER the send, and
-- only for about a day — so the request that sends cannot be the request that
-- learns the device is gone. The ticket ids park here and the daily cron sweeps
-- them (MEAL-88); without that hop `revoked_at` would only ever be written for
-- the subset of dead devices Expo happens to reject synchronously, and every
-- future send would keep paying for the rest forever.
--
-- Rows are deleted as soon as they are checked, including ones Expo no longer
-- recognises, so a receipt that will never resolve is not retried forever.
--
-- That dequeue filters on ticket id, which travels in the URL, so it is chunked
-- server-side and each chunk can fail on its own. The sweep selects
-- OLDEST-FIRST, so rows a dequeue failed to remove would sit at the head of
-- every future window and, once there were enough of them, no receipt written
-- after would ever be read again. What actually makes that impossible is the
-- TTL purge the sweep runs first: a delete by created_at RANGE, one short URL
-- regardless of how many rows it clears.
CREATE TABLE IF NOT EXISTS push_receipts (
  ticket_id  text PRIMARY KEY,
  -- Denormalised rather than a FK: the receipt is about THIS token, and the
  -- token row may legitimately be gone by the time the receipt is read.
  token      text NOT NULL,
  -- NOT NULL because both the sweep's window and its TTL purge filter on it,
  -- and a NULL would be skipped by `<` in silence — the one row shape neither
  -- the sweep nor the purge could ever reach. It is also read as "when the send
  -- happened", to avoid revoking a device that re-registered after it.
  created_at timestamptz NOT NULL DEFAULT now()
);

-- The sweep's query: oldest first, anything past the settle delay.
CREATE INDEX IF NOT EXISTS idx_push_receipts_created ON push_receipts (created_at);

-- ---------------------------------------------------------------------------
-- 7. RLS
--
-- Every table here is written by server routes using the service role, which
-- bypasses RLS. Enabling it with no permissive policy is therefore the correct
-- default: it denies the anon and authenticated keys outright, so a token
-- leaking into a client bundle cannot read refresh tokens or other creators'
-- drafts.
-- ---------------------------------------------------------------------------

ALTER TABLE creator_platform_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE creator_source_items      ENABLE ROW LEVEL SECURITY;
ALTER TABLE creator_source_state      ENABLE ROW LEVEL SECURITY;
ALTER TABLE creator_import_drafts     ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_tokens               ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_receipts             ENABLE ROW LEVEL SECURITY;
