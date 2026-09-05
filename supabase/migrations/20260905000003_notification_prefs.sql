-- MEAL-217. A user's notification choices, where the SERVER can see them.
--
-- Until now the only control was a single switch in Account whose off state
-- lived in SecureStore on the handset. The server never learned about it, so
-- any sender written afterwards would have pushed to someone who had turned
-- notifications off. The setting looked like a preference and was a local mute.
--
-- jsonb rather than a column per category, because the categories will change
-- and a boolean column per kind means a migration every time the product learns
-- to say something new. The shape is small and closed --
-- { all?: bool, broadcast?: bool, creator_draft?: bool } -- and the server
-- drops keys it does not recognise before writing (lib/notification-prefs.ts).
--
-- DEFAULT IS AN EMPTY OBJECT, NOT A SET OF FALSES. Absent means ON: a user who
-- has never opened the settings screen must still receive the first
-- notification Mealio ever sends. Writing falses here would mean shipping the
-- feature to nobody, silently, in a way that looks like a broken sender.

ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS notification_prefs jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.user_profiles.notification_prefs IS
  'MEAL-217. { all?, broadcast?, creator_draft? }. Absent or true = send. `all: false` is the master switch and is stored separately from the per-category flags so turning it back on restores individual choices rather than flattening them.';

-- The send path reads this for a set of user ids at once. A GIN index would be
-- the reflex and is the wrong tool: the query is "give me these users' prefs",
-- which the primary key already serves. Nothing filters ON the jsonb.
