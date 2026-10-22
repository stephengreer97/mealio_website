-- creators.allow_admin_review: the creator's permission for Mealio admins to
-- edit, approve and delete their imported drafts for them.
--
-- ############################################################################
-- #  RUN THIS BEFORE DEPLOYING THE CODE THAT GOES WITH IT (branch            #
-- #  feat/allow-admin-review). The poller, the creator portal and the admin  #
-- #  draft routes all select the column, and PostgREST refuses a select      #
-- #  naming a column that does not exist.                                   #
-- #                                                                          #
-- #  The old code ignores the column, so running this early is harmless.     #
-- ############################################################################
--
-- Off by default, existing creators included. Off: an admin can still see a
-- creator's drafts and send them to the creator, but not edit, approve, delete
-- or take them back. On: the poller queues new posts for the admins instead of
-- the creator, and the creator is no longer emailed to review them.

alter table public.creators
  add column if not exists allow_admin_review boolean not null default false;
