-- The admin review queue (MEAL-91).
-- Run in Supabase SQL Editor. Safe to re-run.
--
-- Additive only. `add-creator-sources.sql` is not touched: two branches have
-- already had to reconcile divergent copies of that file, and a third would be
-- worse than a third file.
--
-- ---------------------------------------------------------------------------
-- Why this exists
--
-- MEAL-90 published synced recipes straight to Discover on the grounds that
-- "a human operator has read the extraction in the admin UI before triggering
-- it". That was not true: the operator read a title in an RSS feed. Between the
-- model's extraction and a live recipe under a real creator's name there was no
-- point at which any human saw the ingredients.
--
-- So admin sync now writes `creator_import_drafts` like the poller does, and a
-- person decides. `creator_import_drafts` is therefore shared by two queues, and
-- the two columns below are what tell them apart and what keeps a decision from
-- being silently undone.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. Whose queue a draft is in
--
-- 'creator'  the creator decides (the poller's drafts — MEAL-89)
-- 'admin'    an operator decides (admin sync — MEAL-90/91)
--
-- Without this, "what is waiting on me" is not a question either queue can ask,
-- and **Send to creator** — the escape hatch for an operator who thinks a recipe
-- looks right but is not the person who cooked it — has nothing to flip.
--
-- Defaults to 'creator' because that is what every row written before this
-- migration is, and because a writer that forgets to set it lands the draft in
-- front of the person whose name is on the recipe. Both directions fail safe (a
-- human still sees it either way); this is the one that also matches history.
-- ---------------------------------------------------------------------------

ALTER TABLE creator_import_drafts
  ADD COLUMN IF NOT EXISTS review_by text NOT NULL DEFAULT 'creator',
  -- Set the first time an operator changes a field. Approving a draft that was
  -- edited records `edited` rather than `approved`, so "did a human change what
  -- the model wrote?" is answerable from the row months later.
  ADD COLUMN IF NOT EXISTS edited_at timestamptz,
  -- Handing a draft to the creator is a decision with an actor too, even though
  -- it leaves the draft pending. `decided_by` is reserved for the terminal
  -- decision, so the handoff gets its own pair rather than overwriting it.
  ADD COLUMN IF NOT EXISTS sent_to_creator_at timestamptz,
  ADD COLUMN IF NOT EXISTS sent_to_creator_by uuid,
  -- Which sync run produced this draft, when one did. Null for the poller.
  -- Lets an operator who ran a 40-item catalog sync find its drafts as a batch
  -- instead of picking them out of a mixed queue by date.
  ADD COLUMN IF NOT EXISTS sync_run_id uuid;

ALTER TABLE creator_import_drafts
  DROP CONSTRAINT IF EXISTS creator_import_drafts_review_by_check;
ALTER TABLE creator_import_drafts
  ADD CONSTRAINT creator_import_drafts_review_by_check
  CHECK (review_by IN ('admin', 'creator'));

-- ---------------------------------------------------------------------------
-- 2. Declining is a state, not a deletion
--
-- Enforced in `lib/import-drafts.ts` — Delete sets status = 'cancelled' and
-- never issues a DELETE. Stated here as well because the reason is a database
-- one: `creator_source_items` records that this post was imported, and a draft
-- row that disappears leaves that record describing a draft nobody can find.
-- The next sync or poll of the same post would then re-import it and ask again,
-- which is how a recipe a human already declined comes back.
--
-- The existing status CHECK already allows 'cancelled'; nothing to add. There is
-- deliberately no ON DELETE rule and no trigger — a real deletion by a human at
-- the SQL prompt is a considered act, and should not be silently prevented.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 3. The queue's own query
--
-- "Everything waiting on me, oldest first" — the shape both review screens read.
-- The MEAL-81 index (creator_id WHERE status = 'pending_review') answers the
-- creator's badge count and stays; this one answers the admin queue, which is
-- not scoped to a creator at all.
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_import_drafts_review_queue
  ON creator_import_drafts (review_by, created_at)
  WHERE status = 'pending_review';

-- ---------------------------------------------------------------------------
-- 4. The append-consent flag
--
-- Added here for MEAL-79 with nothing reading it; MEAL-74 is now its first
-- reader and writer. It is captured when a creator connects YouTube, revocable
-- from the creator portal in one click, and enforced by `assertAppendAllowed`
-- in `lib/youtube.ts` — the single gate every append endpoint must go through.
--
-- YouTube back-catalog import will run through admin sync, and appending the
-- Mealio link to a video's description is a **separate** permission from
-- importing it: a creator can be happy for us to read their videos and not at
-- all happy for us to edit what their channel says. `import_opt_in` must not be
-- stretched to cover both.
--
-- Carried here only so MEAL-79 does not need a migration of its own for one
-- boolean. The default is the refusing answer, and it stays that way: anything
-- other than an explicit `true` refuses, so a null on an older row or a careless
-- write is not consent.
-- ---------------------------------------------------------------------------

ALTER TABLE creators
  ADD COLUMN IF NOT EXISTS youtube_append_opt_in boolean NOT NULL DEFAULT false;

-- ---------------------------------------------------------------------------
-- 5. `creator_sync_runs.notify_creator` is now vestigial
--
-- The email announcing what went live used to fire from the sync run, because
-- the run is what published. Nothing publishes from a run any more, so it fires
-- from Approve instead and the per-run flag has nothing to decide. Left in place
-- rather than dropped: it is NOT NULL DEFAULT true, it costs a byte, and
-- dropping a column is the kind of migration that is painful to undo if the
-- direct-publish path ever comes back behind a setting.
-- ---------------------------------------------------------------------------
