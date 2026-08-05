-- Posts that were declined before MEAL-99, and still say `imported` (MEAL-99).
--
-- `cancelDraft` now moves a declined post's `creator_source_items` row to
-- `declined`, so the catalogue offers it back with a tag saying what happened.
-- Rows declined before that change never got the update: they still say
-- `imported`, which means "a draft or a published meal came of this" — and after
-- a decline neither exists. The creator sees **Already Imported** against a post
-- with no meal behind it, and cannot tick it.
--
-- Run once. Idempotent: a second run matches nothing, because the rows it fixed
-- no longer say `imported`.
--
-- Nothing is deleted. The row is what tells the poller it has seen this post, so
-- a declined post that lost its row would be re-imported on the next poll and
-- declined again, forever — the loop the whole design exists to prevent.

UPDATE creator_source_items AS i
SET
  status = 'declined',
  detail = 'This was turned into a draft and then declined in review, so nothing was published. Tick it again to have another go at it.',
  updated_at = now()
FROM creator_import_drafts AS d
WHERE d.creator_id = i.creator_id
  AND d.source     = i.source
  AND d.item_id    = i.item_id
  AND d.status     = 'cancelled'
  AND i.status     = 'imported'
  -- Only when the decline is the last thing that happened to this post. A post
  -- declined once and imported again since has a live draft or a published meal
  -- behind that `imported`, and marking it rejected would strand the draft and
  -- lie about the meal.
  AND NOT EXISTS (
    SELECT 1 FROM creator_import_drafts AS later
    WHERE later.creator_id = i.creator_id
      AND later.source     = i.source
      AND later.item_id    = i.item_id
      AND later.status    <> 'cancelled'
  );

-- What it changed, for the operator running it:
--
--   SELECT status, count(*) FROM creator_source_items GROUP BY status;
