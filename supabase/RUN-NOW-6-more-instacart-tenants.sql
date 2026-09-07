-- FIVE MORE INSTACART BANNERS, ADDED BUT NOT YET OFFERED.
--
-- Same shape as RUN-NOW-4-instacart-tenants.sql: every row lands with
-- `is_listed = false`, so the catalog carries it and nobody sees it. Turning one
-- on is the single UPDATE at the bottom, one banner at a time.
--
-- HOW THESE WERE CHOSEN, because "which chains use Instacart" is guessable and
-- the guesses are wrong. Each origin was fetched and checked for the platform's
-- own signature -- a page under /store/<slug>/storefront referencing Instacart --
-- and the SLUG was then read out of that page's own links rather than assumed
-- from the brand:
--
--     Price Chopper   price-chopper-ny     (not "price-chopper")
--     Save Mart       savemart             (no hyphen)
--     Dierbergs       dierbergs-markets
--     Bristol Farms   bristol-farms
--     Gelson's        gelsons
--
-- A wrong slug matches no cart and reads as a signed-out user, which is exactly
-- the Publix bug from earlier this week.
--
-- CHECKED AND NOT ON THIS PLATFORM, so nobody checks them twice: Food Lion,
-- Giant Food, Stop & Shop, Hannaford, Weis, Cub, Giant Eagle, Big Y, Raley's,
-- Erewhon, Fresh Thyme, Schnucks, Winn-Dixie, Stater Bros, Smart & Final,
-- Rouses, Festival, Natural Grocers, Market Basket, Hy-Vee, Ingles, United
-- Supermarkets, Brookshire's. Harris Teeter is Kroger family; Wegmans has its
-- own rail.
--
-- LUNDS & BYERLYS WAS A CANDIDATE AND IS NOT HERE. Its storefront path exists,
-- but shop.lundsandbyerlys.com 301s to www and neither host answers the rail's
-- persisted query at /graphql. Every banner below returns 401 "Not
-- Authenticated" to that exact hash, which is the platform accepting the
-- operation; Lunds returns an error page, so it was dropped rather than shipped.
--
-- STILL UNPROVEN. The app ships the code -- they share ALDI's rail, so search,
-- cart and sign-in come for free -- but whether each storefront answers the same
-- persisted GraphQL queries needs one signed-in run per banner. They are all
-- `proven: false` in INSTACART_TENANTS until then.

INSERT INTO stores (id, name, color, slug, banner_group, platform, host, is_listed) VALUES
  ('price_chopper',  'Price Chopper',    '#00A94F', 'price-chopper-ny',  'Price Chopper',   'instacart', 'shop.pricechopper.com',      false),
  ('bristol_farms',  'Bristol Farms',    '#7A2E39', 'bristol-farms',     'Bristol Farms',   'instacart', 'shop.bristolfarms.com',      false),
  ('save_mart',      'Save Mart',        '#E11B22', 'savemart',          'Save Mart',       'instacart', 'shop.savemart.com',          false),
  ('gelsons',        "Gelson's",         '#8B1A2B', 'gelsons',           "Gelson's",        'instacart', 'shop.gelsons.com',           false),
  ('dierbergs',      'Dierbergs',        '#005DAA', 'dierbergs-markets', 'Dierbergs',       'instacart', 'shop.dierbergs.com',         false)
ON CONFLICT (id) DO UPDATE SET
  name         = EXCLUDED.name,
  color        = EXCLUDED.color,
  slug         = EXCLUDED.slug,
  banner_group = EXCLUDED.banner_group,
  platform     = EXCLUDED.platform,
  host         = EXCLUDED.host;
  -- is_listed deliberately NOT updated: re-running this must never re-hide a
  -- banner you have already turned on.

-- Turn ONE on when you want to test it, then sign in through the app:
--
--   UPDATE stores SET is_listed = true WHERE id = 'price_chopper';
--
-- And back off again if it does not work. No release, no review.
