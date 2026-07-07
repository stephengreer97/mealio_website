-- Featured creators on Discover (GET /api/creators/featured).
--
-- Criteria: approved creators, ranked by the number of DISTINCT DAYS they
-- published a preset meal in the rolling last 30 days (rewards consistent
-- posting, not raw volume), top 8. STABLE + SECURITY DEFINER so it reads across
-- creators/preset_meals regardless of the caller's RLS.
--
-- Tiebreaker (added 2026-07): distinct-days is the primary sort; ties break by
-- total meals in the window, then most-recent publish, then creator id — so the
-- LIMIT-8 boundary is deterministic and the list doesn't shuffle between loads.
--
-- This is the source of truth for the live function. Re-run in the Supabase SQL
-- editor to apply changes (CREATE OR REPLACE — safe/idempotent).

CREATE OR REPLACE FUNCTION public.get_featured_creators()
 RETURNS TABLE(id uuid, display_name text, photo_url text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
AS $function$
    SELECT
      c.id,
      c.display_name,
      c.photo_url
    FROM preset_meals pm
    JOIN creators c ON c.id = pm.creator_id
    WHERE pm.created_at >= NOW() - INTERVAL '30 days'
      AND c.approved_at IS NOT NULL
    GROUP BY c.id, c.display_name, c.photo_url
    ORDER BY
      COUNT(DISTINCT DATE(pm.created_at)) DESC,
      COUNT(*)                            DESC,
      MAX(pm.created_at)                  DESC,
      c.id
    LIMIT 8;
$function$;
