-- =============================================================
-- Seed: 8 test creator accounts
-- Run in Supabase SQL Editor (service role context)
-- Safe to re-run: uses ON CONFLICT upserts throughout
-- =============================================================

-- ─── 1. user_profiles ────────────────────────────────────────
-- Pull email directly from auth.users so we don't need to know it.
-- Sets subscription_tier = 'paid' (creators get Full Access).
INSERT INTO user_profiles (id, email, subscription_tier)
SELECT id, email, 'paid'
FROM auth.users
WHERE id IN (
  'e2cc4f15-8858-488f-b354-f6a8a3090e3a',
  'fcac791a-deb1-4d31-b239-400ff4254482',
  'd86f033f-d553-4949-8dfc-c5b8c72072f1',
  '5174155f-1fb5-47d9-9365-401bdcd4dbae',
  'f3688831-e928-4317-aad2-618dd2724846',
  'c3c7dfc5-9338-4ba2-8916-0eb9d8378ac0',
  '10066862-c13d-4670-a6c0-9d5fd52145ee',
  'c8759416-72b4-4700-b300-8a0f7f454c29'
)
ON CONFLICT (id) DO UPDATE SET subscription_tier = 'paid';

-- ─── 2. creators ─────────────────────────────────────────────
-- Photos: pravatar.cc serves consistent headshots by img number.
-- approved_at is set so these creators appear in featured/search.
-- Hardcoded UUIDs so preset_meals can reference creator_id below.
INSERT INTO creators (id, user_id, display_name, bio, photo_url, approved_at)
VALUES
  (
    'a1000001-0000-0000-0000-000000000001',
    'e2cc4f15-8858-488f-b354-f6a8a3090e3a',
    'Emma Chen',
    'Asian fusion home cook. I make weeknight-friendly dishes inspired by my Taiwanese grandmother.',
    'https://i.pravatar.cc/300?img=47',
    NOW() - INTERVAL '25 days'
  ),
  (
    'a1000002-0000-0000-0000-000000000002',
    'fcac791a-deb1-4d31-b239-400ff4254482',
    'Marcus Williams',
    'Pitmaster and BBQ enthusiast from Houston. Low-and-slow is the only way.',
    'https://i.pravatar.cc/300?img=12',
    NOW() - INTERVAL '22 days'
  ),
  (
    'a1000003-0000-0000-0000-000000000003',
    'd86f033f-d553-4949-8dfc-c5b8c72072f1',
    'Sofia Rodriguez',
    'Abuela''s recipes, modernized. Authentic Mexican flavors for the American kitchen.',
    'https://i.pravatar.cc/300?img=38',
    NOW() - INTERVAL '20 days'
  ),
  (
    'a1000004-0000-0000-0000-000000000004',
    '5174155f-1fb5-47d9-9365-401bdcd4dbae',
    'Kai Nakamura',
    'Japanese home cooking, izakaya favorites, and ramen obsession.',
    'https://i.pravatar.cc/300?img=53',
    NOW() - INTERVAL '18 days'
  ),
  (
    'a1000005-0000-0000-0000-000000000005',
    'f3688831-e928-4317-aad2-618dd2724846',
    'Amara Osei',
    'West African comfort food. Jollof rice, stews, and everything in between.',
    'https://i.pravatar.cc/300?img=44',
    NOW() - INTERVAL '15 days'
  ),
  (
    'a1000006-0000-0000-0000-000000000006',
    'c3c7dfc5-9338-4ba2-8916-0eb9d8378ac0',
    'Liam O''Brien',
    'Irish-American comfort food. Hearty mains your whole family will actually eat.',
    'https://i.pravatar.cc/300?img=8',
    NOW() - INTERVAL '12 days'
  ),
  (
    'a1000007-0000-0000-0000-000000000007',
    '10066862-c13d-4670-a6c0-9d5fd52145ee',
    'Priya Patel',
    'Mumbai-born, Chicago-based. Sharing the spices and secrets of Indian home cooking.',
    'https://i.pravatar.cc/300?img=49',
    NOW() - INTERVAL '10 days'
  ),
  (
    'a1000008-0000-0000-0000-000000000008',
    'c8759416-72b4-4700-b300-8a0f7f454c29',
    'Jordan Taylor',
    'Plant-based recipes that don''t taste like rabbit food. Whole ingredients, real flavor.',
    'https://i.pravatar.cc/300?img=32',
    NOW() - INTERVAL '8 days'
  )
ON CONFLICT (id) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  bio          = EXCLUDED.bio,
  photo_url    = EXCLUDED.photo_url,
  approved_at  = EXCLUDED.approved_at;

-- ─── 3. preset_meals ─────────────────────────────────────────
-- One meal per creator. created_at is staggered across 30 days
-- so the get_featured_creators RPC exercises the distinct-day ranking.
-- Ingredients use the `name` key (normalized format).
INSERT INTO preset_meals (name, author, creator_id, ingredients, recipe, story, photo_url, difficulty, serves, tags, source, created_at)
VALUES

-- Emma Chen — Taiwanese Scallion Pancakes
(
  'Scallion Pancakes',
  'Emma Chen',
  'a1000001-0000-0000-0000-000000000001',
  '[
    {"name": "all-purpose flour", "quantity": "2 cups"},
    {"name": "boiling water", "quantity": "3/4 cup"},
    {"name": "sesame oil", "quantity": "2 tbsp"},
    {"name": "scallions", "quantity": "1 bunch"},
    {"name": "salt", "quantity": "1 tsp"},
    {"name": "vegetable oil", "quantity": "3 tbsp"}
  ]'::jsonb,
  '1. Mix flour and boiling water until a dough forms. Rest 30 minutes.
2. Divide into 4 balls. Roll each thin, brush with sesame oil, scatter scallions, and roll up tightly into a log, then coil into a disc.
3. Roll discs to about 1/4 inch thick.
4. Pan-fry in oil over medium heat 3–4 minutes per side until golden and crisp.',
  'My grandmother made these every Sunday morning. The trick is the boiling water — it makes the dough soft and chewy instead of cracker-crisp.',
  'https://images.unsplash.com/photo-1625944525533-473f1a3d54e7?w=800',
  2,
  4,
  ARRAY['Asian', 'Vegetarian', 'Snack'],
  'https://www.seriouseats.com/scallion-pancakes',
  NOW() - INTERVAL '27 days'
),

-- Marcus Williams — Smoked Brisket
(
  'Texas-Style Smoked Brisket',
  'Marcus Williams',
  'a1000002-0000-0000-0000-000000000002',
  '[
    {"name": "beef brisket (whole packer)", "quantity": "12 lbs"},
    {"name": "coarse kosher salt", "quantity": "1/4 cup"},
    {"name": "coarse black pepper", "quantity": "1/4 cup"},
    {"name": "garlic powder", "quantity": "1 tbsp"},
    {"name": "oak or hickory wood chunks", "quantity": "6-8 chunks"}
  ]'::jsonb,
  '1. Trim brisket to 1/4 inch fat cap. Mix salt, pepper, and garlic powder; coat all sides generously.
2. Rest at room temp 1 hour.
3. Smoke at 225°F fat-side up until internal temp hits 165°F (~6 hours).
4. Wrap tightly in butcher paper. Continue cooking to 203°F (~4 more hours).
5. Rest wrapped in a cooler 1–2 hours before slicing against the grain.',
  'Twelve hours of patience. That''s it. That''s the secret. Don''t rush the stall.',
  'https://images.unsplash.com/photo-1529193591184-b1d58069ecdd?w=800',
  3,
  12,
  ARRAY['BBQ', 'Beef', 'Smoker'],
  '',
  NOW() - INTERVAL '24 days'
),

-- Sofia Rodriguez — Chicken Enchiladas Verdes
(
  'Chicken Enchiladas Verdes',
  'Sofia Rodriguez',
  'a1000003-0000-0000-0000-000000000003',
  '[
    {"name": "corn tortillas", "quantity": "12"},
    {"name": "rotisserie chicken, shredded", "quantity": "3 cups"},
    {"name": "tomatillos, husked", "quantity": "1 lb"},
    {"name": "white onion", "quantity": "1"},
    {"name": "jalapeños", "quantity": "2"},
    {"name": "garlic cloves", "quantity": "3"},
    {"name": "cilantro", "quantity": "1/2 cup"},
    {"name": "Mexican crema", "quantity": "1/2 cup"},
    {"name": "queso fresco", "quantity": "4 oz"},
    {"name": "vegetable oil", "quantity": "2 tbsp"}
  ]'::jsonb,
  '1. Broil tomatillos, half the onion, jalapeños, and garlic until charred, ~10 min.
2. Blend with cilantro and 1/2 tsp salt to make salsa verde.
3. Lightly fry each tortilla in oil (5 sec per side) to soften.
4. Fill each with shredded chicken, roll, and place seam-down in a baking dish.
5. Cover with salsa verde. Bake at 400°F for 20 min.
6. Drizzle with crema and crumble queso fresco on top.',
  'The secret is flash-frying the tortillas before rolling. Skip it and they''ll crack. Abuela would never forgive you.',
  'https://images.unsplash.com/photo-1534352956036-cd81e27dd615?w=800',
  2,
  6,
  ARRAY['Mexican', 'Chicken', 'Casserole'],
  '',
  NOW() - INTERVAL '21 days'
),

-- Kai Nakamura — Tonkotsu Ramen
(
  'Tonkotsu Ramen',
  'Kai Nakamura',
  'a1000004-0000-0000-0000-000000000004',
  '[
    {"name": "pork trotters", "quantity": "2 lbs"},
    {"name": "pork neck bones", "quantity": "2 lbs"},
    {"name": "fresh ramen noodles", "quantity": "4 servings"},
    {"name": "soy sauce", "quantity": "3 tbsp"},
    {"name": "mirin", "quantity": "2 tbsp"},
    {"name": "soft-boiled eggs", "quantity": "4"},
    {"name": "chashu pork belly, sliced", "quantity": "12 slices"},
    {"name": "green onions", "quantity": "4"},
    {"name": "nori sheets", "quantity": "4"},
    {"name": "bamboo shoots (menma)", "quantity": "1/2 cup"},
    {"name": "sesame seeds", "quantity": "1 tbsp"}
  ]'::jsonb,
  '1. Blanch bones in boiling water 10 min. Drain, rinse, and scrub off dark bits.
2. Cover with 3 quarts fresh water. Boil hard (not simmer) 4 hours, adding water as needed. Broth should turn milky white.
3. Strain. Season with soy sauce, mirin, and salt to taste.
4. Cook noodles per package. Divide into bowls.
5. Ladle hot broth. Top with chashu, egg halved, nori, green onions, bamboo shoots, and sesame.',
  'Tonkotsu is a commitment. But one bowl of this and you''ll understand why ramen shops spend 18 hours on broth.',
  'https://images.unsplash.com/photo-1569050467447-ce54b3bbc37d?w=800',
  3,
  4,
  ARRAY['Japanese', 'Pork', 'Soup'],
  '',
  NOW() - INTERVAL '18 days'
),

-- Amara Osei — Jollof Rice
(
  'Nigerian Jollof Rice',
  'Amara Osei',
  'a1000005-0000-0000-0000-000000000005',
  '[
    {"name": "long-grain parboiled rice", "quantity": "3 cups"},
    {"name": "plum tomatoes", "quantity": "6"},
    {"name": "red bell peppers", "quantity": "2"},
    {"name": "scotch bonnet pepper", "quantity": "1"},
    {"name": "white onion", "quantity": "1 large"},
    {"name": "tomato paste", "quantity": "3 tbsp"},
    {"name": "chicken stock", "quantity": "3 cups"},
    {"name": "vegetable oil", "quantity": "1/3 cup"},
    {"name": "bay leaves", "quantity": "2"},
    {"name": "thyme", "quantity": "1 tsp"},
    {"name": "curry powder", "quantity": "1 tsp"},
    {"name": "seasoning cubes (Maggi)", "quantity": "2"}
  ]'::jsonb,
  '1. Blend tomatoes, bell peppers, scotch bonnet, and half the onion until smooth.
2. Fry tomato paste in oil 3 min. Add blended pepper mixture; fry on medium-high 20–25 min until reduced and oil floats on top.
3. Add stock, bay leaves, thyme, curry, seasoning cubes. Season with salt. Bring to a boil.
4. Rinse rice and add. Stir once, then reduce heat to low. Cover tightly with foil, then lid.
5. Cook 30 min undisturbed. Check rice — if water remains, cook 10 more min. The slight char on the bottom is intentional (party rice!)',
  'The jollof wars are real. But Nigerian jollof — with the smoky bottom — is simply undefeated.',
  'https://images.unsplash.com/photo-1604329760661-e71dc83f8f26?w=800',
  2,
  6,
  ARRAY['African', 'Rice', 'Vegetarian'],
  '',
  NOW() - INTERVAL '15 days'
),

-- Liam O'Brien — Irish Beef Stew
(
  'Classic Irish Beef Stew',
  'Liam O''Brien',
  'a1000006-0000-0000-0000-000000000006',
  '[
    {"name": "beef chuck, cut into 1.5-inch cubes", "quantity": "2 lbs"},
    {"name": "Guinness stout", "quantity": "1 can (14.9 oz)"},
    {"name": "beef broth", "quantity": "2 cups"},
    {"name": "Yukon Gold potatoes, quartered", "quantity": "1.5 lbs"},
    {"name": "carrots, sliced", "quantity": "3"},
    {"name": "celery stalks, sliced", "quantity": "2"},
    {"name": "white onion, diced", "quantity": "1"},
    {"name": "garlic cloves, minced", "quantity": "4"},
    {"name": "tomato paste", "quantity": "2 tbsp"},
    {"name": "flour", "quantity": "3 tbsp"},
    {"name": "butter", "quantity": "2 tbsp"},
    {"name": "fresh thyme", "quantity": "4 sprigs"},
    {"name": "bay leaf", "quantity": "1"}
  ]'::jsonb,
  '1. Pat beef dry, season generously with salt and pepper. Sear in batches in butter until browned on all sides. Remove.
2. Sauté onion, celery, and garlic 4 min. Add tomato paste; cook 1 min. Sprinkle flour; stir 1 min.
3. Deglaze with Guinness, scraping the bottom. Add broth, beef, thyme, and bay leaf.
4. Bring to a simmer. Cover and cook low 1.5 hours.
5. Add potatoes and carrots. Cook uncovered 30 more min until veg is tender and broth thickens.',
  'Guinness in the stew sounds like a pub trick but it adds a deep malty backbone that beef broth alone can''t match. Make it a day ahead — it''s better reheated.',
  'https://images.unsplash.com/photo-1547592166-23ac45744acd?w=800',
  2,
  6,
  ARRAY['European', 'Beef', 'Comfort Food', 'Soup'],
  '',
  NOW() - INTERVAL '11 days'
),

-- Priya Patel — Butter Chicken
(
  'Butter Chicken (Murgh Makhani)',
  'Priya Patel',
  'a1000007-0000-0000-0000-000000000007',
  '[
    {"name": "boneless chicken thighs", "quantity": "2 lbs"},
    {"name": "plain full-fat yogurt", "quantity": "1/2 cup"},
    {"name": "lemon juice", "quantity": "2 tbsp"},
    {"name": "garam masala", "quantity": "2 tsp"},
    {"name": "cumin", "quantity": "1 tsp"},
    {"name": "turmeric", "quantity": "1/2 tsp"},
    {"name": "kashmiri chili powder", "quantity": "1 tbsp"},
    {"name": "butter", "quantity": "4 tbsp"},
    {"name": "yellow onion, diced", "quantity": "1"},
    {"name": "garlic cloves, minced", "quantity": "5"},
    {"name": "fresh ginger, grated", "quantity": "1 tbsp"},
    {"name": "crushed tomatoes", "quantity": "1 can (28 oz)"},
    {"name": "heavy cream", "quantity": "1/2 cup"},
    {"name": "sugar", "quantity": "1 tsp"},
    {"name": "kasuri methi (dried fenugreek leaves)", "quantity": "1 tsp"}
  ]'::jsonb,
  '1. Marinate chicken in yogurt, lemon, garam masala, cumin, turmeric, and half the chili powder. Minimum 2 hours, overnight preferred.
2. Broil or grill chicken until charred. Rest 5 min, then cut into chunks.
3. Melt butter in a wide pan. Sauté onion 8 min until golden. Add garlic and ginger; cook 2 min.
4. Add remaining chili powder and crushed tomatoes. Simmer 20 min. Blend smooth.
5. Return to pan. Add chicken, cream, sugar, and kasuri methi. Simmer 10 min. Adjust salt.',
  'Kashmiri chili gives the deep orange-red color without brutal heat. And kasuri methi — dried fenugreek — is the flavor you can never quite identify but can''t imagine the dish without.',
  'https://images.unsplash.com/photo-1588166524941-3bf61a9c41db?w=800',
  2,
  5,
  ARRAY['Indian', 'Chicken', 'Curry'],
  '',
  NOW() - INTERVAL '7 days'
),

-- Jordan Taylor — Vegan Mushroom Tacos
(
  'Smoky Portobello Tacos',
  'Jordan Taylor',
  'a1000008-0000-0000-0000-000000000008',
  '[
    {"name": "portobello mushrooms", "quantity": "4 large"},
    {"name": "corn tortillas (6-inch)", "quantity": "8"},
    {"name": "smoked paprika", "quantity": "1 tbsp"},
    {"name": "cumin", "quantity": "1 tsp"},
    {"name": "garlic powder", "quantity": "1 tsp"},
    {"name": "soy sauce", "quantity": "2 tbsp"},
    {"name": "lime juice", "quantity": "2 tbsp"},
    {"name": "olive oil", "quantity": "2 tbsp"},
    {"name": "avocados", "quantity": "2"},
    {"name": "red cabbage, shredded", "quantity": "1 cup"},
    {"name": "fresh cilantro", "quantity": "1/4 cup"},
    {"name": "pickled red onion", "quantity": "1/4 cup"},
    {"name": "hot sauce", "quantity": "to taste"}
  ]'::jsonb,
  '1. Slice mushrooms into 1/2-inch strips. Toss with smoked paprika, cumin, garlic powder, soy sauce, lime juice, and olive oil.
2. Marinate 20 min.
3. Cook in a cast iron skillet on high heat 3–4 min per side. Don''t crowd the pan — you want char, not steam.
4. Warm tortillas directly over a gas flame or dry skillet.
5. Mash avocado with salt and lime. Spread on tortillas, add mushrooms, cabbage, cilantro, and pickled onion.',
  'Smoked paprika and high heat turn a humble portobello into something that genuinely satisfies the taco craving. No meat needed — and I say that as a former carnivore.',
  'https://images.unsplash.com/photo-1565299715199-866c917206bb?w=800',
  1,
  4,
  ARRAY['Vegan', 'Mexican', 'Quick'],
  '',
  NOW() - INTERVAL '4 days'
);
