-- MEAL-133: return each object's creation time from `list_storage_objects`, so
-- orphan cleanup can leave newly uploaded objects alone.
--
-- WHY. `/api/images/upload` and `storeImageBuffer` hand a public URL back BEFORE
-- anything references it — the meal, the creator profile or the import draft that
-- will point at it is saved in a later request. During that window the object is
-- referenced by no row in any table, so
-- `app/api/admin/storage/cleanup-orphans/route.ts` classified it as an orphan and
-- deleted it, and the user's save landed on a URL with nothing behind it. Neither
-- of that route's safety gates can see it: no keep-set row is missing, so the
-- reconciliation is clean, and one object is nowhere near the orphan-share
-- ceiling. The route cannot fix it without knowing how old an object is, and this
-- function did not say.
--
-- DROP AND CREATE, not CREATE OR REPLACE. Adding a column to a RETURNS TABLE
-- changes the function's return type, and Postgres rejects that with 42P13
-- ("cannot change return type of existing function"). Nothing depends on the
-- function in SQL — no view, no other function, no policy — so dropping it is
-- safe; the two callers are HTTP routes.
--
-- COMPATIBILITY. Both callers keep working across the change, in both directions:
--   * cleanup-orphans selects `*` and discovers the shape from the rows it gets,
--     so it runs against the old two-column function (with the grace window
--     reported as unavailable) and against this one (with the window applied).
--   * backfill-hashes selects `name, size` explicitly, which is still a valid
--     column list here.
-- So this migration can be applied at any time, before or after the deploy.
--
-- `created_at` is nullable on `storage.objects`, and the route treats a null as
-- "age unknown, keep the object" rather than as "old". Columns are qualified
-- through the `o` alias so that none of them can be read as a reference to the
-- function's own output parameters of the same name.

DROP FUNCTION IF EXISTS public.list_storage_objects(text);

CREATE FUNCTION public.list_storage_objects(bucket text)
RETURNS TABLE (name text, size int, created_at timestamptz)
LANGUAGE sql SECURITY DEFINER AS $$
  SELECT o.name, (o.metadata->>'size')::int, o.created_at
  FROM storage.objects o
  WHERE o.bucket_id = bucket;
$$;
