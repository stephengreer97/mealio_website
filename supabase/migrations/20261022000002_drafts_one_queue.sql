-- Every pending import draft goes to its creator's queue.
--
-- Drafts used to live in one of two queues: the admin's (`review_by = 'admin'`,
-- from admin-run imports) or the creator's. Now every import lands in the
-- creator's queue, and an admin decides drafts there only when the creator has
-- ticked "Allow Mealio admins to edit/approve/deny your imported posts"
-- (`creators.allow_admin_review`). This moves the drafts still pending in the
-- admin queue over, so creators can see them.
--
-- Decided drafts are left alone: their `review_by` is history, not a queue.
-- Safe to run before or after the code that goes with it.

update public.creator_import_drafts
   set review_by = 'creator',
       updated_at = now()
 where status = 'pending_review'
   and review_by = 'admin';
