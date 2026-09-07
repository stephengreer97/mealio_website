-- FOUR INSTACART BANNERS, ADDED BUT NOT YET OFFERED (MEAL-220).
--
-- Read-safe to run now. Every row lands with `is_listed = false`, which means
-- the catalog carries it and NOBODY sees it. Turning one on is the single
-- UPDATE at the bottom, one banner at a time.
--
-- WHY THE TWO STEPS. The app already ships the code for these four: they share
-- ALDI's Instacart rail, so search, cart and sign-in come for free. What is NOT
-- known is whether each storefront answers the same persisted GraphQL queries
-- the rail sends. That cannot be checked without signing in to the banner, and
-- signing in needs the store to be selectable. Hence: insert now, list the one
-- you are about to test, sign in through the app's WebView, and I can then take
-- the four measurements MEAL-220 asks for.
--
-- IF A BANNER TURNS OUT NOT TO WORK, set `is_listed = false` again. No release,
-- no App Store review. There is a second switch too -- the per-store
-- `enabled` flag in the automation config -- if you want it selectable but not
-- automated.

INSERT INTO stores (id, name, color, slug, banner_group, platform, host, is_listed) VALUES
  ('publix',           'Publix',                 '#008542', 'publix',           'Publix',           'instacart', 'delivery.publix.com',    false),
  ('sprouts',          'Sprouts Farmers Market', '#4B9B3F', 'sprouts',          'Sprouts',          'instacart', 'shop.sprouts.com',       false),
  ('the_fresh_market', 'The Fresh Market',       '#00573F', 'the-fresh-market', 'The Fresh Market', 'instacart', 'shop.thefreshmarket.com', false),
  -- Costco Same-Day is MEMBERSHIP-GATED. A session can be signed in and still
  -- be refused a cart, which none of the others can do and which nothing on the
  -- rail handles. Worth testing last, after the others show the rail
  -- generalises at all.
  ('costco_sameday',   'Costco Same-Day',        '#E31837', 'costco',           'Costco',           'instacart', 'sameday.costco.com',     false)
-- Idempotent: re-running updates the display fields and leaves `is_listed`
-- alone, so a banner you have already switched on does not switch itself off.
ON CONFLICT (id) DO UPDATE SET
  name         = EXCLUDED.name,
  color        = EXCLUDED.color,
  slug         = EXCLUDED.slug,
  banner_group = EXCLUDED.banner_group,
  platform     = EXCLUDED.platform,
  host         = EXCLUDED.host;

-- ── Then, ONE AT A TIME, when you want to sign in and test one ───────────────
--
-- Run one of these, open the app, pick the store, and start an add-to-cart run.
-- The WebView opens at the storefront and asks you to sign in. That sign-in is
-- the thing everything else is waiting on.
--
--   UPDATE stores SET is_listed = true WHERE id = 'publix';
--   UPDATE stores SET is_listed = true WHERE id = 'sprouts';
--   UPDATE stores SET is_listed = true WHERE id = 'the_fresh_market';
--   UPDATE stores SET is_listed = true WHERE id = 'costco_sameday';
--
-- And to take one back off:
--
--   UPDATE stores SET is_listed = false WHERE id = 'publix';

SELECT id, name, host, is_listed
FROM stores
WHERE platform = 'instacart'
ORDER BY id;
