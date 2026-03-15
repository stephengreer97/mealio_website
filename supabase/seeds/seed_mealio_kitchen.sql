-- Mealio Kitchen preset meals (30 total, all difficulties covered)
-- creator_id = 'ac888f68-164b-46f2-aaa9-67b00c43feb6'
-- author    = 'Mealio Kitchen'
-- source    = 'https://mealio.co'
-- photo_url = NULL  (set manually)
-- Ingredient format: { productName, qty, unit, measure, searchTerm }
--   unit='qty'  → qty = item count, measure = null
--   other unit  → qty = 1 (cart qty), measure = amount string

DELETE FROM preset_meals
WHERE creator_id = 'ac888f68-164b-46f2-aaa9-67b00c43feb6';

INSERT INTO preset_meals
  (id, name, author, creator_id, ingredients, recipe, story, photo_url, difficulty, serves, tags, source, created_at)
VALUES

-- ─── DIFFICULTY 1 — EASY (7 meals) ───────────────────────────────────────────

-- 1. Avocado Toast
(
  '00000000-0000-0000-0000-000000000001',
  'Avocado Toast',
  'Mealio Kitchen',
  'ac888f68-164b-46f2-aaa9-67b00c43feb6',
  '[
    {"productName":"Sourdough Bread","qty":4,"unit":"qty","measure":null,"searchTerm":null},
    {"productName":"Avocados","qty":2,"unit":"qty","measure":null,"searchTerm":null},
    {"productName":"Lemon","qty":1,"unit":"qty","measure":null,"searchTerm":null},
    {"productName":"Red Pepper Flakes","qty":1,"unit":"tsp","measure":"0.5","searchTerm":null},
    {"productName":"Everything Bagel Seasoning","qty":1,"unit":"tbsp","measure":"1","searchTerm":null},
    {"productName":"Olive Oil","qty":1,"unit":"tbsp","measure":"1","searchTerm":null},
    {"productName":"Flaky Sea Salt","qty":1,"unit":"tsp","measure":"0.5","searchTerm":null}
  ]'::jsonb,
  '1. Toast the sourdough slices until golden and crisp.
2. Halve and pit the avocados. Scoop flesh into a bowl.
3. Add lemon juice and a pinch of sea salt. Mash to your preferred texture — chunky or smooth.
4. Drizzle each toast with olive oil, then spread the avocado mixture generously.
5. Finish with everything bagel seasoning, red pepper flakes, and a final pinch of flaky salt.
6. Serve immediately.',
  'The best avocado toast is all about contrast — crunchy bread, creamy avocado, a hit of acid, and a little heat. We''ve been making this at Mealio Kitchen for years and it never gets old.',
  NULL,
  1,
  '2',
  ARRAY['Breakfast','Vegetarian','Vegan','Under 10 Min','Healthy','Budget Friendly'],
  'https://mealio.co',
  NOW() - INTERVAL '82 days'
),

-- 2. Overnight Oats
(
  '00000000-0000-0000-0000-000000000002',
  'Classic Overnight Oats',
  'Mealio Kitchen',
  'ac888f68-164b-46f2-aaa9-67b00c43feb6',
  '[
    {"productName":"Old Fashioned Rolled Oats","qty":1,"unit":"cups","measure":"1","searchTerm":null},
    {"productName":"Milk","qty":1,"unit":"cups","measure":"1","searchTerm":null},
    {"productName":"Greek Yogurt","qty":1,"unit":"cups","measure":"0.5","searchTerm":null},
    {"productName":"Chia Seeds","qty":1,"unit":"tbsp","measure":"1","searchTerm":null},
    {"productName":"Honey","qty":1,"unit":"tbsp","measure":"1","searchTerm":null},
    {"productName":"Vanilla Extract","qty":1,"unit":"tsp","measure":"0.5","searchTerm":null},
    {"productName":"Mixed Berries","qty":1,"unit":"cups","measure":"0.5","searchTerm":null}
  ]'::jsonb,
  '1. Add oats, chia seeds, milk, yogurt, honey, and vanilla to a jar or container. Stir well to combine.
2. Cover and refrigerate overnight (or at least 4 hours).
3. In the morning, give it a stir. If it''s too thick, add a splash of milk.
4. Top with fresh berries and an extra drizzle of honey.
5. Eat cold straight from the jar.',
  'Prep five jars on Sunday and breakfast is sorted for the week. Overnight oats sound too simple to be exciting — but with good yogurt and ripe berries, they''re genuinely great.',
  NULL,
  1,
  '1',
  ARRAY['Breakfast','Meal Prep','Healthy','Vegetarian','Under 10 Min','Make Ahead'],
  'https://mealio.co',
  NOW() - INTERVAL '78 days'
),

-- 3. Caprese Salad
(
  '00000000-0000-0000-0000-000000000003',
  'Classic Caprese Salad',
  'Mealio Kitchen',
  'ac888f68-164b-46f2-aaa9-67b00c43feb6',
  '[
    {"productName":"Fresh Mozzarella","qty":1,"unit":"lb","measure":"1","searchTerm":null},
    {"productName":"Heirloom Tomatoes","qty":3,"unit":"qty","measure":null,"searchTerm":null},
    {"productName":"Fresh Basil","qty":1,"unit":"qty","measure":null,"searchTerm":null},
    {"productName":"Balsamic Glaze","qty":1,"unit":"tbsp","measure":"2","searchTerm":null},
    {"productName":"Extra Virgin Olive Oil","qty":1,"unit":"tbsp","measure":"3","searchTerm":null},
    {"productName":"Flaky Sea Salt","qty":1,"unit":"tsp","measure":"0.5","searchTerm":null},
    {"productName":"Black Pepper","qty":1,"unit":"tsp","measure":"0.25","searchTerm":null}
  ]'::jsonb,
  '1. Slice the mozzarella and tomatoes into even 1/4-inch rounds.
2. Arrange alternating slices of tomato and mozzarella on a platter, slightly overlapping.
3. Tuck fresh basil leaves between each slice.
4. Drizzle generously with olive oil, then drizzle the balsamic glaze over the top.
5. Finish with flaky sea salt and a few cracks of black pepper.
6. Serve immediately at room temperature.',
  'This is the dish that taught us the power of great ingredients. Use the ripest tomatoes you can find and fresh mozzarella that''s still milky and soft — nothing else matters.',
  NULL,
  1,
  '4',
  ARRAY['Salad','Vegetarian','No Cook','Italian','Under 10 Min','Healthy','Appetizer'],
  'https://mealio.co',
  NOW() - INTERVAL '75 days'
),

-- 4. Cheese Quesadilla
(
  '00000000-0000-0000-0000-000000000004',
  'Crispy Cheese Quesadilla',
  'Mealio Kitchen',
  'ac888f68-164b-46f2-aaa9-67b00c43feb6',
  '[
    {"productName":"Large Flour Tortillas","qty":4,"unit":"qty","measure":null,"searchTerm":null},
    {"productName":"Shredded Mexican Cheese Blend","qty":1,"unit":"cups","measure":"2","searchTerm":null},
    {"productName":"Butter","qty":1,"unit":"tbsp","measure":"2","searchTerm":null},
    {"productName":"Salsa","qty":1,"unit":"cups","measure":"0.5","searchTerm":null},
    {"productName":"Sour Cream","qty":1,"unit":"cups","measure":"0.5","searchTerm":null},
    {"productName":"Pickled Jalapeños","qty":1,"unit":"oz","measure":"2","searchTerm":null}
  ]'::jsonb,
  '1. Heat a large skillet or griddle over medium heat. Add a thin pat of butter.
2. Place one tortilla flat in the pan. Sprinkle half the cheese evenly over the whole surface.
3. Fold in half and press gently with a spatula.
4. Cook 2–3 minutes per side until golden and crisp and cheese is fully melted.
5. Repeat with remaining tortillas and cheese.
6. Cut into wedges and serve with salsa, sour cream, and jalapeños.',
  'The secret to a properly crispy quesadilla is butter over oil and a hot pan. Don''t rush it — let each side get genuinely golden. Cut into thirds, not quarters.',
  NULL,
  1,
  '2',
  ARRAY['Lunch','Dinner','Under 10 Min','Kid Friendly','Mexican','Budget Friendly','Quick Cleanup'],
  'https://mealio.co',
  NOW() - INTERVAL '71 days'
),

-- 5. Greek Yogurt Parfait
(
  '00000000-0000-0000-0000-000000000005',
  'Greek Yogurt Parfait',
  'Mealio Kitchen',
  'ac888f68-164b-46f2-aaa9-67b00c43feb6',
  '[
    {"productName":"Plain Greek Yogurt","qty":1,"unit":"cups","measure":"2","searchTerm":null},
    {"productName":"Granola","qty":1,"unit":"cups","measure":"0.75","searchTerm":null},
    {"productName":"Strawberries","qty":1,"unit":"cups","measure":"1","searchTerm":null},
    {"productName":"Blueberries","qty":1,"unit":"cups","measure":"0.5","searchTerm":null},
    {"productName":"Honey","qty":1,"unit":"tbsp","measure":"2","searchTerm":null},
    {"productName":"Vanilla Extract","qty":1,"unit":"tsp","measure":"0.5","searchTerm":null}
  ]'::jsonb,
  '1. Stir vanilla extract into the Greek yogurt until combined.
2. In a glass or bowl, add a base layer of yogurt.
3. Add a layer of granola for crunch.
4. Add a layer of sliced strawberries and blueberries.
5. Repeat the layers until the glass is full, ending with fruit on top.
6. Drizzle honey over everything and serve immediately.',
  'High protein, ready in two minutes, and genuinely satisfying. The key is using full-fat Greek yogurt — it''s thick, creamy, and holds up against the crunchy granola.',
  NULL,
  1,
  '2',
  ARRAY['Breakfast','Snack','No Cook','Under 10 Min','Healthy','Vegetarian','High Protein'],
  'https://mealio.co',
  NOW() - INTERVAL '67 days'
),

-- 6. Classic BLT Sandwich
(
  '00000000-0000-0000-0000-000000000006',
  'Classic BLT Sandwich',
  'Mealio Kitchen',
  'ac888f68-164b-46f2-aaa9-67b00c43feb6',
  '[
    {"productName":"Thick-Cut Bacon","qty":1,"unit":"lb","measure":"0.5","searchTerm":null},
    {"productName":"Sourdough Bread","qty":4,"unit":"qty","measure":null,"searchTerm":null},
    {"productName":"Romaine Lettuce","qty":1,"unit":"qty","measure":null,"searchTerm":null},
    {"productName":"Beefsteak Tomatoes","qty":2,"unit":"qty","measure":null,"searchTerm":null},
    {"productName":"Mayonnaise","qty":1,"unit":"tbsp","measure":"3","searchTerm":null},
    {"productName":"Black Pepper","qty":1,"unit":"tsp","measure":"0.25","searchTerm":null}
  ]'::jsonb,
  '1. Cook bacon in a skillet over medium heat until crispy, turning occasionally. Drain on paper towels.
2. Toast the sourdough slices until golden.
3. Spread mayonnaise generously on both slices of each toast.
4. Layer crisp romaine leaves on the bottom slice, followed by thick-cut tomato slices.
5. Season the tomato with black pepper.
6. Stack bacon on top and close the sandwich. Cut diagonally and serve.',
  'There are no tricks here — just the best version of each component. Thick-cut bacon cooked until truly crisp, ripe tomatoes, cold crisp lettuce, and enough mayo to make it count.',
  NULL,
  1,
  '2',
  ARRAY['Lunch','Sandwich','American','Under 10 Min','Budget Friendly'],
  'https://mealio.co',
  NOW() - INTERVAL '63 days'
),

-- 7. Soft Scrambled Eggs
(
  '00000000-0000-0000-0000-000000000007',
  'Soft Scrambled Eggs',
  'Mealio Kitchen',
  'ac888f68-164b-46f2-aaa9-67b00c43feb6',
  '[
    {"productName":"Large Eggs","qty":6,"unit":"qty","measure":null,"searchTerm":null},
    {"productName":"Unsalted Butter","qty":1,"unit":"tbsp","measure":"2","searchTerm":null},
    {"productName":"Heavy Cream","qty":1,"unit":"tbsp","measure":"2","searchTerm":null},
    {"productName":"Kosher Salt","qty":1,"unit":"tsp","measure":"0.25","searchTerm":null},
    {"productName":"Black Pepper","qty":1,"unit":"tsp","measure":"0.25","searchTerm":null},
    {"productName":"Fresh Chives","qty":1,"unit":"qty","measure":null,"searchTerm":null}
  ]'::jsonb,
  '1. Crack eggs into a cold nonstick pan. Add butter and cream. Do not whisk yet.
2. Turn heat to medium-low and begin stirring constantly with a rubber spatula, scraping the bottom.
3. Every 30 seconds, pull the pan off the heat while still stirring.
4. When the eggs are just barely set — still slightly wet-looking — remove from heat entirely.
5. Season with salt and pepper. The residual heat will finish cooking them.
6. Plate immediately and top with freshly snipped chives.',
  'Most people overcook scrambled eggs. The French low-and-slow method gives you impossibly creamy curds. The trick is pulling the pan off the heat repeatedly — patience is everything.',
  NULL,
  1,
  '2',
  ARRAY['Breakfast','Stovetop','Under 10 Min','High Protein','Vegetarian','Kid Friendly','5 Ingredients'],
  'https://mealio.co',
  NOW() - INTERVAL '59 days'
),

-- ─── DIFFICULTY 2 — EASY-MEDIUM (7 meals) ────────────────────────────────────

-- 8. Pasta Aglio e Olio
(
  '00000000-0000-0000-0000-000000000008',
  'Pasta Aglio e Olio',
  'Mealio Kitchen',
  'ac888f68-164b-46f2-aaa9-67b00c43feb6',
  '[
    {"productName":"Spaghetti","qty":1,"unit":"lb","measure":"1","searchTerm":null},
    {"productName":"Garlic","qty":8,"unit":"qty","measure":null,"searchTerm":null},
    {"productName":"Extra Virgin Olive Oil","qty":1,"unit":"cups","measure":"0.5","searchTerm":null},
    {"productName":"Red Pepper Flakes","qty":1,"unit":"tsp","measure":"1","searchTerm":null},
    {"productName":"Fresh Parsley","qty":1,"unit":"qty","measure":null,"searchTerm":null},
    {"productName":"Parmesan Cheese","qty":1,"unit":"oz","measure":"2","searchTerm":null},
    {"productName":"Kosher Salt","qty":1,"unit":"tbsp","measure":"1","searchTerm":null}
  ]'::jsonb,
  '1. Bring a large pot of heavily salted water to a boil. Cook spaghetti until just al dente. Reserve 1 cup pasta water before draining.
2. While pasta cooks, thinly slice all garlic. Heat olive oil in a large skillet over medium-low heat.
3. Add garlic and red pepper flakes. Cook slowly, stirring, until garlic is golden (not brown) — about 5–6 minutes.
4. Add the drained pasta and a splash of pasta water. Toss vigorously to coat.
5. Add more pasta water as needed to create a silky emulsified sauce.
6. Remove from heat, toss with chopped parsley and Parmesan. Serve immediately.',
  'The most famous poor man''s pasta — five ingredients, fifteen minutes, genuinely delicious. The pasta water is the secret: its starch turns the olive oil and garlic into an actual sauce.',
  NULL,
  2,
  '4',
  ARRAY['Pasta','Dinner','Italian','Vegetarian','Under 30 Min','Budget Friendly','5 Ingredients'],
  'https://mealio.co',
  NOW() - INTERVAL '55 days'
),

-- 9. Chicken Caesar Salad
(
  '00000000-0000-0000-0000-000000000009',
  'Classic Chicken Caesar Salad',
  'Mealio Kitchen',
  'ac888f68-164b-46f2-aaa9-67b00c43feb6',
  '[
    {"productName":"Chicken Breasts","qty":2,"unit":"qty","measure":null,"searchTerm":null},
    {"productName":"Romaine Lettuce Hearts","qty":2,"unit":"qty","measure":null,"searchTerm":null},
    {"productName":"Caesar Dressing","qty":1,"unit":"cups","measure":"0.5","searchTerm":null},
    {"productName":"Parmesan Cheese","qty":1,"unit":"oz","measure":"3","searchTerm":null},
    {"productName":"Croutons","qty":1,"unit":"cups","measure":"1","searchTerm":null},
    {"productName":"Lemon","qty":1,"unit":"qty","measure":null,"searchTerm":null},
    {"productName":"Olive Oil","qty":1,"unit":"tbsp","measure":"2","searchTerm":null},
    {"productName":"Garlic Powder","qty":1,"unit":"tsp","measure":"0.5","searchTerm":null},
    {"productName":"Black Pepper","qty":1,"unit":"tsp","measure":"0.5","searchTerm":null}
  ]'::jsonb,
  '1. Season chicken breasts with garlic powder, salt, and pepper. Rub with olive oil.
2. Grill or pan-sear over medium-high heat, 5–6 minutes per side, until cooked through (165°F internal). Rest 5 minutes, then slice.
3. Chop romaine into bite-sized pieces and add to a large bowl.
4. Toss with Caesar dressing until lightly coated.
5. Add half the Parmesan and toss again.
6. Plate the salad, top with sliced chicken, croutons, remaining Parmesan, and a squeeze of lemon.',
  'A Caesar done right — bold, creamy dressing, crisp cold romaine, and chicken that actually has some color on it. Don''t drown it in dressing; just enough to coat.',
  NULL,
  2,
  '4',
  ARRAY['Salad','Lunch','Dinner','Chicken','American','Under 30 Min','High Protein'],
  'https://mealio.co',
  NOW() - INTERVAL '51 days'
),

-- 10. Turkey Avocado Wrap
(
  '00000000-0000-0000-0000-000000000010',
  'Turkey Avocado Wrap',
  'Mealio Kitchen',
  'ac888f68-164b-46f2-aaa9-67b00c43feb6',
  '[
    {"productName":"Large Flour Tortillas","qty":2,"unit":"qty","measure":null,"searchTerm":null},
    {"productName":"Deli Turkey Breast","qty":1,"unit":"oz","measure":"6","searchTerm":null},
    {"productName":"Avocado","qty":1,"unit":"qty","measure":null,"searchTerm":null},
    {"productName":"Romaine Lettuce","qty":1,"unit":"qty","measure":null,"searchTerm":null},
    {"productName":"Roma Tomato","qty":1,"unit":"qty","measure":null,"searchTerm":null},
    {"productName":"Provolone Cheese","qty":2,"unit":"qty","measure":null,"searchTerm":null},
    {"productName":"Dijon Mustard","qty":1,"unit":"tbsp","measure":"1","searchTerm":null},
    {"productName":"Red Onion","qty":1,"unit":"qty","measure":null,"searchTerm":null}
  ]'::jsonb,
  '1. Lay the tortilla flat on a cutting board.
2. Spread Dijon mustard across the center.
3. Layer provolone, then turkey, then thinly sliced red onion.
4. Add sliced tomato and crisp romaine leaves.
5. Slice avocado and lay on top. Season with salt and pepper.
6. Fold in the sides of the tortilla, then roll tightly from the bottom up. Cut in half at a diagonal.',
  'Better than anything you''ll get at a sandwich shop. Slice the avocado thick, use the good deli turkey, and don''t skimp on the Dijon — that''s what ties everything together.',
  NULL,
  2,
  '2',
  ARRAY['Lunch','Wrap','Turkey','Healthy','High Protein','Under 10 Min','Meal Prep'],
  'https://mealio.co',
  NOW() - INTERVAL '47 days'
),

-- 11. Creamy Tomato Basil Soup
(
  '00000000-0000-0000-0000-000000000011',
  'Creamy Tomato Basil Soup',
  'Mealio Kitchen',
  'ac888f68-164b-46f2-aaa9-67b00c43feb6',
  '[
    {"productName":"Crushed Tomatoes","qty":2,"unit":"qty","measure":null,"searchTerm":null},
    {"productName":"Yellow Onion","qty":1,"unit":"qty","measure":null,"searchTerm":null},
    {"productName":"Garlic","qty":4,"unit":"qty","measure":null,"searchTerm":null},
    {"productName":"Heavy Cream","qty":1,"unit":"cups","measure":"0.5","searchTerm":null},
    {"productName":"Chicken Broth","qty":1,"unit":"cups","measure":"2","searchTerm":null},
    {"productName":"Fresh Basil","qty":1,"unit":"qty","measure":null,"searchTerm":null},
    {"productName":"Butter","qty":1,"unit":"tbsp","measure":"2","searchTerm":null},
    {"productName":"Olive Oil","qty":1,"unit":"tbsp","measure":"2","searchTerm":null},
    {"productName":"Sugar","qty":1,"unit":"tsp","measure":"1","searchTerm":null},
    {"productName":"Kosher Salt","qty":1,"unit":"tsp","measure":"1","searchTerm":null}
  ]'::jsonb,
  '1. Heat olive oil and butter in a large pot over medium heat. Add diced onion and cook until soft, about 5 minutes.
2. Add minced garlic and cook 1 minute more.
3. Pour in crushed tomatoes and chicken broth. Add sugar, salt, and a few large basil leaves.
4. Simmer uncovered for 15 minutes.
5. Use an immersion blender (or transfer in batches) to blend until smooth.
6. Stir in heavy cream and heat gently. Taste and adjust seasoning.
7. Ladle into bowls and garnish with fresh basil and a drizzle of cream.',
  'The soup that goes with everything, especially a grilled cheese. We add a pinch of sugar to balance the acidity from the canned tomatoes — it makes a bigger difference than you''d expect.',
  NULL,
  2,
  '4',
  ARRAY['Soup','Vegetarian','Under 30 Min','Comfort Food','Italian','Stovetop'],
  'https://mealio.co',
  NOW() - INTERVAL '43 days'
),

-- 12. Sheet Pan Roasted Vegetables
(
  '00000000-0000-0000-0000-000000000012',
  'Sheet Pan Roasted Vegetables',
  'Mealio Kitchen',
  'ac888f68-164b-46f2-aaa9-67b00c43feb6',
  '[
    {"productName":"Broccoli","qty":1,"unit":"lb","measure":"1","searchTerm":null},
    {"productName":"Bell Peppers","qty":2,"unit":"qty","measure":null,"searchTerm":null},
    {"productName":"Zucchini","qty":2,"unit":"qty","measure":null,"searchTerm":null},
    {"productName":"Red Onion","qty":1,"unit":"qty","measure":null,"searchTerm":null},
    {"productName":"Cherry Tomatoes","qty":1,"unit":"cups","measure":"1","searchTerm":null},
    {"productName":"Olive Oil","qty":1,"unit":"tbsp","measure":"4","searchTerm":null},
    {"productName":"Garlic Powder","qty":1,"unit":"tsp","measure":"1","searchTerm":null},
    {"productName":"Italian Seasoning","qty":1,"unit":"tsp","measure":"1","searchTerm":null},
    {"productName":"Kosher Salt","qty":1,"unit":"tsp","measure":"1","searchTerm":null},
    {"productName":"Black Pepper","qty":1,"unit":"tsp","measure":"0.5","searchTerm":null}
  ]'::jsonb,
  '1. Preheat oven to 425°F (220°C). Line a large sheet pan with parchment.
2. Cut all vegetables into roughly equal bite-sized pieces so they cook evenly.
3. Spread on the pan in a single layer — do not crowd. Use two pans if needed.
4. Drizzle with olive oil and sprinkle with garlic powder, Italian seasoning, salt, and pepper. Toss to coat.
5. Roast for 20–25 minutes, stirring once halfway through, until edges are caramelized and slightly charred.
6. Serve as a side or toss over rice, pasta, or grain bowls.',
  'The biggest mistake with roasted vegetables is crowding the pan — they steam instead of roast. Give them space and crank the heat. That charred edge is where all the flavor lives.',
  NULL,
  2,
  '4',
  ARRAY['Side Dish','Vegetarian','Vegan','Healthy','Sheet Pan','Under 45 Min','Meal Prep','Budget Friendly'],
  'https://mealio.co',
  NOW() - INTERVAL '39 days'
),

-- 13. Egg Fried Rice
(
  '00000000-0000-0000-0000-000000000013',
  'Egg Fried Rice',
  'Mealio Kitchen',
  'ac888f68-164b-46f2-aaa9-67b00c43feb6',
  '[
    {"productName":"Cooked White Rice","qty":1,"unit":"cups","measure":"3","searchTerm":null},
    {"productName":"Large Eggs","qty":3,"unit":"qty","measure":null,"searchTerm":null},
    {"productName":"Soy Sauce","qty":1,"unit":"tbsp","measure":"3","searchTerm":null},
    {"productName":"Sesame Oil","qty":1,"unit":"tbsp","measure":"1","searchTerm":null},
    {"productName":"Green Onions","qty":4,"unit":"qty","measure":null,"searchTerm":null},
    {"productName":"Garlic","qty":3,"unit":"qty","measure":null,"searchTerm":null},
    {"productName":"Frozen Peas and Carrots","qty":1,"unit":"cups","measure":"1","searchTerm":null},
    {"productName":"Butter","qty":1,"unit":"tbsp","measure":"2","searchTerm":null}
  ]'::jsonb,
  '1. Use day-old rice that has been refrigerated — cold, dry rice fries best.
2. Heat a wok or large skillet over very high heat until smoking. Add butter.
3. Add minced garlic and frozen peas and carrots. Stir-fry 2 minutes.
4. Push everything to one side. Crack in the eggs and scramble until just set, then mix into the rice.
5. Add all the rice, breaking up any clumps. Stir-fry for 3–4 minutes, letting the rice get slightly toasted.
6. Add soy sauce and sesame oil. Toss well.
7. Remove from heat and top with sliced green onions.',
  'The secret is hot wok, cold rice, and high heat. Day-old refrigerator rice has lost its moisture, which means it fries instead of steams. This is the best use of leftover rice.',
  NULL,
  2,
  '4',
  ARRAY['Asian','Dinner','Stovetop','Under 30 Min','Budget Friendly','Vegetarian','Meal Prep','Leftovers Good'],
  'https://mealio.co',
  NOW() - INTERVAL '35 days'
),

-- 14. Honey Garlic Chicken Thighs
(
  '00000000-0000-0000-0000-000000000014',
  'Honey Garlic Chicken Thighs',
  'Mealio Kitchen',
  'ac888f68-164b-46f2-aaa9-67b00c43feb6',
  '[
    {"productName":"Bone-In Skin-On Chicken Thighs","qty":4,"unit":"qty","measure":null,"searchTerm":null},
    {"productName":"Honey","qty":1,"unit":"tbsp","measure":"3","searchTerm":null},
    {"productName":"Soy Sauce","qty":1,"unit":"tbsp","measure":"3","searchTerm":null},
    {"productName":"Garlic","qty":5,"unit":"qty","measure":null,"searchTerm":null},
    {"productName":"Butter","qty":1,"unit":"tbsp","measure":"2","searchTerm":null},
    {"productName":"Apple Cider Vinegar","qty":1,"unit":"tbsp","measure":"1","searchTerm":null},
    {"productName":"Red Pepper Flakes","qty":1,"unit":"tsp","measure":"0.5","searchTerm":null},
    {"productName":"Kosher Salt","qty":1,"unit":"tsp","measure":"1","searchTerm":null}
  ]'::jsonb,
  '1. Pat chicken thighs very dry with paper towels. Season both sides with salt.
2. Place skin-side down in a cold oven-safe skillet. Turn heat to medium. Cook 12–15 minutes undisturbed until skin is deeply golden and crisp.
3. Flip, cook another 5 minutes. Remove and set aside.
4. In the same pan, melt butter over medium heat. Add minced garlic and sauté 1 minute.
5. Add honey, soy sauce, apple cider vinegar, and red pepper flakes. Simmer 2 minutes.
6. Return chicken skin-side up. Spoon sauce over chicken. Cook another 3–4 minutes until sauce thickens and chicken is glazed.',
  'Start the chicken in a cold pan — it slowly renders the fat and gives you the crispiest skin imaginable. The honey garlic sauce reduces around it into a sticky, glossy glaze.',
  NULL,
  2,
  '4',
  ARRAY['Chicken','Dinner','Stovetop','Under 30 Min','American','High Protein','Family Friendly'],
  'https://mealio.co',
  NOW() - INTERVAL '31 days'
),

-- ─── DIFFICULTY 3 — MEDIUM (7 meals) ─────────────────────────────────────────

-- 15. Street Beef Tacos
(
  '00000000-0000-0000-0000-000000000015',
  'Street Beef Tacos',
  'Mealio Kitchen',
  'ac888f68-164b-46f2-aaa9-67b00c43feb6',
  '[
    {"productName":"Skirt Steak","qty":1,"unit":"lb","measure":"1.5","searchTerm":null},
    {"productName":"Corn Tortillas","qty":12,"unit":"qty","measure":null,"searchTerm":null},
    {"productName":"White Onion","qty":1,"unit":"qty","measure":null,"searchTerm":null},
    {"productName":"Fresh Cilantro","qty":1,"unit":"qty","measure":null,"searchTerm":null},
    {"productName":"Limes","qty":3,"unit":"qty","measure":null,"searchTerm":null},
    {"productName":"Garlic","qty":3,"unit":"qty","measure":null,"searchTerm":null},
    {"productName":"Ground Cumin","qty":1,"unit":"tsp","measure":"1","searchTerm":null},
    {"productName":"Chili Powder","qty":1,"unit":"tsp","measure":"1","searchTerm":null},
    {"productName":"Avocado Oil","qty":1,"unit":"tbsp","measure":"2","searchTerm":null},
    {"productName":"Salsa Verde","qty":1,"unit":"cups","measure":"0.5","searchTerm":null}
  ]'::jsonb,
  '1. Marinate skirt steak in lime juice, minced garlic, cumin, chili powder, oil, salt, and pepper for at least 30 minutes (or overnight).
2. Heat a cast iron skillet or grill pan over screaming hot heat. Cook steak 3–4 minutes per side for medium-rare. Rest 5 minutes.
3. While steak rests, warm tortillas directly over a gas burner or in a dry skillet until charred in spots.
4. Slice steak thinly against the grain.
5. Double up the tortillas and fill each with steak.
6. Top with finely diced white onion, fresh cilantro leaves, a squeeze of lime, and salsa verde.',
  'Great street tacos require three things: high heat for the steak, double-stacked corn tortillas, and finely diced raw onion. Everything else is commentary.',
  NULL,
  3,
  '4',
  ARRAY['Tacos','Mexican','Beef','Dinner','Under 30 Min','Family Friendly','High Protein'],
  'https://mealio.co',
  NOW() - INTERVAL '27 days'
),

-- 16. Chicken Vegetable Stir Fry
(
  '00000000-0000-0000-0000-000000000016',
  'Chicken Vegetable Stir Fry',
  'Mealio Kitchen',
  'ac888f68-164b-46f2-aaa9-67b00c43feb6',
  '[
    {"productName":"Chicken Breast","qty":1,"unit":"lb","measure":"1.5","searchTerm":null},
    {"productName":"Broccoli Florets","qty":1,"unit":"cups","measure":"2","searchTerm":null},
    {"productName":"Snap Peas","qty":1,"unit":"cups","measure":"1","searchTerm":null},
    {"productName":"Red Bell Pepper","qty":1,"unit":"qty","measure":null,"searchTerm":null},
    {"productName":"Soy Sauce","qty":1,"unit":"tbsp","measure":"3","searchTerm":null},
    {"productName":"Oyster Sauce","qty":1,"unit":"tbsp","measure":"2","searchTerm":null},
    {"productName":"Garlic","qty":4,"unit":"qty","measure":null,"searchTerm":null},
    {"productName":"Fresh Ginger","qty":1,"unit":"qty","measure":null,"searchTerm":null},
    {"productName":"Sesame Oil","qty":1,"unit":"tbsp","measure":"1","searchTerm":null},
    {"productName":"Cornstarch","qty":1,"unit":"tbsp","measure":"1","searchTerm":null},
    {"productName":"Vegetable Oil","qty":1,"unit":"tbsp","measure":"2","searchTerm":null},
    {"productName":"Jasmine Rice","qty":1,"unit":"cups","measure":"2","searchTerm":null}
  ]'::jsonb,
  '1. Cook jasmine rice according to package directions.
2. Slice chicken into thin strips. Toss with cornstarch, a pinch of salt, and 1 tbsp soy sauce.
3. Mix remaining soy sauce, oyster sauce, and sesame oil into a sauce. Set aside.
4. Heat wok or large skillet over high heat until smoking. Add oil.
5. Cook chicken in a single layer without moving, 2 minutes, then stir-fry until cooked through. Remove.
6. Add more oil if needed. Stir-fry broccoli, snap peas, and bell pepper for 3 minutes until tender-crisp.
7. Add garlic and ginger, cook 30 seconds.
8. Return chicken and pour in sauce. Toss everything together. Serve over rice.',
  'Velvet the chicken with cornstarch before it hits the wok — it creates a silky coating that grabs the sauce. High heat throughout; you want char, not steam.',
  NULL,
  3,
  '4',
  ARRAY['Chicken','Asian','Stir Fry','Dinner','Healthy','High Protein','Under 30 Min','Family Friendly'],
  'https://mealio.co',
  NOW() - INTERVAL '24 days'
),

-- 17. Shakshuka
(
  '00000000-0000-0000-0000-000000000017',
  'Shakshuka',
  'Mealio Kitchen',
  'ac888f68-164b-46f2-aaa9-67b00c43feb6',
  '[
    {"productName":"Large Eggs","qty":6,"unit":"qty","measure":null,"searchTerm":null},
    {"productName":"Crushed Tomatoes","qty":1,"unit":"qty","measure":null,"searchTerm":null},
    {"productName":"Yellow Onion","qty":1,"unit":"qty","measure":null,"searchTerm":null},
    {"productName":"Garlic","qty":4,"unit":"qty","measure":null,"searchTerm":null},
    {"productName":"Red Bell Pepper","qty":1,"unit":"qty","measure":null,"searchTerm":null},
    {"productName":"Ground Cumin","qty":1,"unit":"tsp","measure":"1","searchTerm":null},
    {"productName":"Smoked Paprika","qty":1,"unit":"tsp","measure":"1","searchTerm":null},
    {"productName":"Chili Flakes","qty":1,"unit":"tsp","measure":"0.5","searchTerm":null},
    {"productName":"Olive Oil","qty":1,"unit":"tbsp","measure":"3","searchTerm":null},
    {"productName":"Feta Cheese","qty":1,"unit":"oz","measure":"3","searchTerm":null},
    {"productName":"Fresh Parsley","qty":1,"unit":"qty","measure":null,"searchTerm":null},
    {"productName":"Crusty Bread","qty":1,"unit":"qty","measure":null,"searchTerm":null}
  ]'::jsonb,
  '1. Heat olive oil in a large oven-safe skillet over medium heat.
2. Add diced onion and bell pepper. Cook until softened, about 8 minutes.
3. Add minced garlic, cumin, paprika, and chili flakes. Cook 1 minute until fragrant.
4. Pour in crushed tomatoes. Season with salt. Simmer 10 minutes, stirring occasionally, until sauce thickens.
5. Make 6 wells in the sauce. Crack an egg into each well.
6. Cover the skillet and cook on medium-low until whites are set but yolks are still runny, about 5–7 minutes.
7. Crumble feta over the top and scatter with fresh parsley. Serve directly from the pan with crusty bread.',
  'Eggs poached in spiced tomato sauce — one of those dishes that looks dramatically impressive and takes about 25 minutes to make. The key is letting the sauce reduce before the eggs go in.',
  NULL,
  3,
  '4',
  ARRAY['Breakfast','Brunch','Vegetarian','Middle Eastern','Eggs','Stovetop','Under 30 Min','Budget Friendly'],
  'https://mealio.co',
  NOW() - INTERVAL '21 days'
),

-- 18. Classic Smash Burgers
(
  '00000000-0000-0000-0000-000000000018',
  'Classic Smash Burgers',
  'Mealio Kitchen',
  'ac888f68-164b-46f2-aaa9-67b00c43feb6',
  '[
    {"productName":"Ground Beef 80/20","qty":1,"unit":"lb","measure":"1.5","searchTerm":null},
    {"productName":"Brioche Burger Buns","qty":4,"unit":"qty","measure":null,"searchTerm":null},
    {"productName":"American Cheese Slices","qty":8,"unit":"qty","measure":null,"searchTurn":null},
    {"productName":"White Onion","qty":1,"unit":"qty","measure":null,"searchTerm":null},
    {"productName":"Dill Pickles","qty":1,"unit":"qty","measure":null,"searchTerm":null},
    {"productName":"Yellow Mustard","qty":1,"unit":"tbsp","measure":"2","searchTerm":null},
    {"productName":"Ketchup","qty":1,"unit":"tbsp","measure":"2","searchTerm":null},
    {"productName":"Mayonnaise","qty":1,"unit":"tbsp","measure":"2","searchTerm":null},
    {"productName":"Kosher Salt","qty":1,"unit":"tsp","measure":"1","searchTerm":null},
    {"productName":"Black Pepper","qty":1,"unit":"tsp","measure":"0.5","searchTerm":null}
  ]'::jsonb,
  '1. Divide ground beef into 6-oz balls. Do not pack them too tight.
2. Heat a cast iron skillet or griddle over high heat until very hot. Add a thin film of oil.
3. Place a beef ball on the hot surface. Immediately smash it flat with a heavy spatula and a sheet of parchment. Hold pressure for 10 seconds.
4. Season the top with salt and pepper. Cook 2 minutes until edges are lacy and brown.
5. Flip, immediately add 2 slices of American cheese. Cook another 60 seconds.
6. Toast buns in the burger fat.
7. Stack with mustard, ketchup, mayo, onion, and pickles.',
  'The smash burger technique is non-negotiable: one quick, hard press maximizes the Maillard reaction and gives you those lacey caramelized edges. 80/20 fat ratio and American cheese — no substitutions.',
  NULL,
  3,
  '4',
  ARRAY['Burger','Beef','American','Dinner','Stovetop','Under 30 Min','Game Day','Family Friendly'],
  'https://mealio.co',
  NOW() - INTERVAL '18 days'
),

-- 19. Lemon Herb Baked Salmon
(
  '00000000-0000-0000-0000-000000000019',
  'Lemon Herb Baked Salmon',
  'Mealio Kitchen',
  'ac888f68-164b-46f2-aaa9-67b00c43feb6',
  '[
    {"productName":"Salmon Fillets","qty":4,"unit":"qty","measure":null,"searchTerm":null},
    {"productName":"Lemon","qty":2,"unit":"qty","measure":null,"searchTerm":null},
    {"productName":"Garlic","qty":4,"unit":"qty","measure":null,"searchTerm":null},
    {"productName":"Unsalted Butter","qty":1,"unit":"tbsp","measure":"3","searchTerm":null},
    {"productName":"Fresh Dill","qty":1,"unit":"qty","measure":null,"searchTerm":null},
    {"productName":"Fresh Parsley","qty":1,"unit":"qty","measure":null,"searchTerm":null},
    {"productName":"Olive Oil","qty":1,"unit":"tbsp","measure":"2","searchTerm":null},
    {"productName":"Capers","qty":1,"unit":"tbsp","measure":"2","searchTerm":null},
    {"productName":"Kosher Salt","qty":1,"unit":"tsp","measure":"1","searchTerm":null},
    {"productName":"Black Pepper","qty":1,"unit":"tsp","measure":"0.5","searchTerm":null}
  ]'::jsonb,
  '1. Preheat oven to 400°F (200°C). Line a baking sheet with foil.
2. Pat salmon fillets dry. Place on the baking sheet.
3. Melt butter with minced garlic in a small pan. Stir in lemon juice, capers, dill, and parsley.
4. Spoon the herb butter over each fillet. Season with salt and pepper.
5. Layer thin lemon slices on top.
6. Bake 12–15 minutes until salmon flakes easily with a fork (internal temp 130°F for medium).
7. Spoon any collected pan juices over the fish and serve.',
  'Salmon at 400°F for 12 minutes is almost foolproof. The herb butter baste keeps it moist while it bakes. Pull it a minute early — it keeps cooking on the pan.',
  NULL,
  3,
  '4',
  ARRAY['Fish','Seafood','Dinner','Healthy','High Protein','Baked','Under 30 Min','Keto','Low Carb','Date Night'],
  'https://mealio.co',
  NOW() - INTERVAL '15 days'
),

-- 20. One Pot Tuscan Pasta
(
  '00000000-0000-0000-0000-000000000020',
  'One Pot Tuscan Pasta',
  'Mealio Kitchen',
  'ac888f68-164b-46f2-aaa9-67b00c43feb6',
  '[
    {"productName":"Penne Pasta","qty":1,"unit":"lb","measure":"12","searchTerm":null},
    {"productName":"Sun-Dried Tomatoes in Oil","qty":1,"unit":"oz","measure":"8","searchTerm":null},
    {"productName":"Baby Spinach","qty":1,"unit":"cups","measure":"3","searchTerm":null},
    {"productName":"Heavy Cream","qty":1,"unit":"cups","measure":"1","searchTerm":null},
    {"productName":"Garlic","qty":4,"unit":"qty","measure":null,"searchTerm":null},
    {"productName":"Parmesan Cheese","qty":1,"unit":"oz","measure":"3","searchTerm":null},
    {"productName":"Chicken Broth","qty":1,"unit":"cups","measure":"2","searchTerm":null},
    {"productName":"Italian Seasoning","qty":1,"unit":"tsp","measure":"1","searchTerm":null},
    {"productName":"Red Pepper Flakes","qty":1,"unit":"tsp","measure":"0.5","searchTerm":null},
    {"productName":"Olive Oil","qty":1,"unit":"tbsp","measure":"2","searchTerm":null}
  ]'::jsonb,
  '1. Heat olive oil in a large, deep pot over medium heat. Add minced garlic and sauté 1 minute.
2. Add sliced sun-dried tomatoes and cook another minute.
3. Add penne, chicken broth, heavy cream, Italian seasoning, and red pepper flakes. Season with salt.
4. Bring to a boil, then reduce to a strong simmer. Cook uncovered, stirring frequently, for 15–18 minutes until pasta is tender and sauce is thick.
5. Add spinach and stir until wilted, about 2 minutes.
6. Remove from heat and stir in Parmesan until melted and creamy.
7. Serve immediately — the sauce thickens as it cools.',
  'Creamy, garlicky, and done in one pot. The pasta absorbs the cream and broth as it cooks, so there''s no draining and the starch naturally thickens the sauce.',
  NULL,
  3,
  '4',
  ARRAY['Pasta','Italian','Dinner','One Pot','Under 30 Min','Vegetarian','Comfort Food','Quick Cleanup'],
  'https://mealio.co',
  NOW() - INTERVAL '12 days'
),

-- 21. Black Bean Enchiladas
(
  '00000000-0000-0000-0000-000000000021',
  'Black Bean Enchiladas',
  'Mealio Kitchen',
  'ac888f68-164b-46f2-aaa9-67b00c43feb6',
  '[
    {"productName":"Corn Tortillas","qty":8,"unit":"qty","measure":null,"searchTerm":null},
    {"productName":"Black Beans","qty":2,"unit":"qty","measure":null,"searchTerm":null},
    {"productName":"Red Enchilada Sauce","qty":1,"unit":"qty","measure":null,"searchTerm":null},
    {"productName":"Shredded Mexican Cheese Blend","qty":1,"unit":"cups","measure":"2","searchTerm":null},
    {"productName":"Yellow Onion","qty":1,"unit":"qty","measure":null,"searchTerm":null},
    {"productName":"Green Bell Pepper","qty":1,"unit":"qty","measure":null,"searchTerm":null},
    {"productName":"Ground Cumin","qty":1,"unit":"tsp","measure":"1","searchTerm":null},
    {"productName":"Chili Powder","qty":1,"unit":"tsp","measure":"1","searchTerm":null},
    {"productName":"Sour Cream","qty":1,"unit":"cups","measure":"0.5","searchTerm":null},
    {"productName":"Fresh Cilantro","qty":1,"unit":"qty","measure":null,"searchTerm":null},
    {"productName":"Jalapeño","qty":1,"unit":"qty","measure":null,"searchTerm":null},
    {"productName":"Olive Oil","qty":1,"unit":"tbsp","measure":"2","searchTerm":null}
  ]'::jsonb,
  '1. Preheat oven to 375°F (190°C). Spread a thin layer of enchilada sauce in a 9x13 baking dish.
2. Heat oil in a skillet. Sauté diced onion and bell pepper until soft. Add cumin and chili powder, cook 1 minute.
3. Add drained black beans and a few spoonfuls of enchilada sauce. Stir and warm through. Season with salt.
4. Warm tortillas briefly in the microwave so they''re pliable.
5. Spoon filling into each tortilla, add a pinch of cheese, roll tightly, and place seam-side down in the dish.
6. Pour remaining enchilada sauce over all the rolls. Top with remaining cheese.
7. Bake 20–25 minutes until cheese is bubbly and edges are slightly crisp.
8. Top with sour cream, cilantro, and sliced jalapeño.',
  'Black bean enchiladas are deeply satisfying without any meat. The trick is warming the tortillas before rolling — cold corn tortillas crack and split. Roll tight and seam-side down.',
  NULL,
  3,
  '4',
  ARRAY['Mexican','Vegetarian','Dinner','Baked','Under 45 Min','Budget Friendly','Family Friendly'],
  'https://mealio.co',
  NOW() - INTERVAL '9 days'
),

-- ─── DIFFICULTY 4 — MEDIUM-HARD (5 meals) ────────────────────────────────────

-- 22. Chicken Tikka Masala
(
  '00000000-0000-0000-0000-000000000022',
  'Chicken Tikka Masala',
  'Mealio Kitchen',
  'ac888f68-164b-46f2-aaa9-67b00c43feb6',
  '[
    {"productName":"Chicken Breasts","qty":1,"unit":"lb","measure":"2","searchTerm":null},
    {"productName":"Crushed Tomatoes","qty":1,"unit":"qty","measure":null,"searchTerm":null},
    {"productName":"Heavy Cream","qty":1,"unit":"cups","measure":"1","searchTerm":null},
    {"productName":"Garlic","qty":5,"unit":"qty","measure":null,"searchTerm":null},
    {"productName":"Fresh Ginger","qty":1,"unit":"qty","measure":null,"searchTerm":null},
    {"productName":"Yellow Onion","qty":1,"unit":"qty","measure":null,"searchTerm":null},
    {"productName":"Garam Masala","qty":1,"unit":"tbsp","measure":"2","searchTerm":null},
    {"productName":"Ground Cumin","qty":1,"unit":"tsp","measure":"1","searchTerm":null},
    {"productName":"Turmeric","qty":1,"unit":"tsp","measure":"0.5","searchTerm":null},
    {"productName":"Smoked Paprika","qty":1,"unit":"tsp","measure":"1","searchTerm":null},
    {"productName":"Plain Greek Yogurt","qty":1,"unit":"cups","measure":"0.5","searchTerm":null},
    {"productName":"Butter","qty":1,"unit":"tbsp","measure":"2","searchTerm":null},
    {"productName":"Fresh Cilantro","qty":1,"unit":"qty","measure":null,"searchTerm":null},
    {"productName":"Basmati Rice","qty":1,"unit":"cups","measure":"2","searchTerm":null}
  ]'::jsonb,
  '1. Cut chicken into 2-inch chunks. Marinate in yogurt, half the garam masala, half the garlic, half the ginger, turmeric, and salt for at least 1 hour (overnight preferred).
2. Grill or broil marinated chicken on high heat until charred in spots. Set aside.
3. Melt butter in a large pot. Add diced onion and cook until deeply caramelized, about 15 minutes.
4. Add remaining garlic and ginger, cook 2 minutes. Add remaining garam masala, cumin, and paprika. Stir 1 minute.
5. Add crushed tomatoes. Simmer 15 minutes until sauce darkens.
6. Use an immersion blender to smooth the sauce. Stir in heavy cream.
7. Add chicken and simmer 10 minutes. Season with salt.
8. Serve over basmati rice, topped with fresh cilantro.',
  'The two-step cook — marinate and char the chicken first, then build the sauce separately — is what makes this restaurant-quality. Don''t rush the caramelized onion base; that''s where the depth comes from.',
  NULL,
  4,
  '4',
  ARRAY['Indian','Chicken','Dinner','High Protein','Comfort Food','Stovetop'],
  'https://mealio.co',
  NOW() - INTERVAL '7 days'
),

-- 23. Beef Bulgogi Bowls
(
  '00000000-0000-0000-0000-000000000023',
  'Beef Bulgogi Bowls',
  'Mealio Kitchen',
  'ac888f68-164b-46f2-aaa9-67b00c43feb6',
  '[
    {"productName":"Beef Ribeye","qty":1,"unit":"lb","measure":"1.5","searchTerm":null},
    {"productName":"Soy Sauce","qty":1,"unit":"tbsp","measure":"4","searchTerm":null},
    {"productName":"Sesame Oil","qty":1,"unit":"tbsp","measure":"2","searchTerm":null},
    {"productName":"Asian Pear","qty":1,"unit":"qty","measure":null,"searchTerm":null},
    {"productName":"Garlic","qty":5,"unit":"qty","measure":null,"searchTerm":null},
    {"productName":"Fresh Ginger","qty":1,"unit":"qty","measure":null,"searchTerm":null},
    {"productName":"Brown Sugar","qty":1,"unit":"tbsp","measure":"2","searchTerm":null},
    {"productName":"Green Onions","qty":4,"unit":"qty","measure":null,"searchTerm":null},
    {"productName":"Sesame Seeds","qty":1,"unit":"tbsp","measure":"1","searchTerm":null},
    {"productName":"Jasmine Rice","qty":1,"unit":"cups","measure":"2","searchTerm":null},
    {"productName":"Baby Spinach","qty":1,"unit":"cups","measure":"2","searchTerm":null},
    {"productName":"Carrots","qty":2,"unit":"qty","measure":null,"searchTerm":null}
  ]'::jsonb,
  '1. Freeze beef for 30 minutes to firm up, then slice paper-thin against the grain.
2. Blend grated Asian pear, garlic, ginger, soy sauce, sesame oil, and brown sugar into a marinade. Marinate beef at least 1 hour.
3. Cook jasmine rice. Julienne carrots and briefly sauté or leave raw.
4. Heat a large skillet or grill pan over high heat. Cook beef in thin batches, 1–2 minutes per side. Do not crowd the pan.
5. Assemble bowls: rice base, spinach, julienned carrots, bulgogi beef.
6. Drizzle with extra sesame oil, top with sesame seeds and sliced green onions.',
  'The Asian pear is the key — its enzymes tenderize the beef and add a subtle sweetness. Freeze the beef briefly for ultra-thin slices. Cook fast and hot so it caramelizes, not steams.',
  NULL,
  4,
  '4',
  ARRAY['Korean','Beef','Dinner','Bowl','Asian','High Protein','Meal Prep'],
  'https://mealio.co',
  NOW() - INTERVAL '5 days'
),

-- 24. Thai Basil Pork
(
  '00000000-0000-0000-0000-000000000024',
  'Thai Basil Pork (Pad Kra Pao)',
  'Mealio Kitchen',
  'ac888f68-164b-46f2-aaa9-67b00c43feb6',
  '[
    {"productName":"Ground Pork","qty":1,"unit":"lb","measure":"1","searchTerm":null},
    {"productName":"Fresh Thai Basil","qty":1,"unit":"qty","measure":null,"searchTerm":null},
    {"productName":"Garlic","qty":6,"unit":"qty","measure":null,"searchTerm":null},
    {"productName":"Thai Chilies","qty":4,"unit":"qty","measure":null,"searchTerm":null},
    {"productName":"Fish Sauce","qty":1,"unit":"tbsp","measure":"2","searchTerm":null},
    {"productName":"Oyster Sauce","qty":1,"unit":"tbsp","measure":"2","searchTerm":null},
    {"productName":"Soy Sauce","qty":1,"unit":"tbsp","measure":"1","searchTerm":null},
    {"productName":"Sugar","qty":1,"unit":"tsp","measure":"1","searchTerm":null},
    {"productName":"Large Eggs","qty":4,"unit":"qty","measure":null,"searchTerm":null},
    {"productName":"Jasmine Rice","qty":1,"unit":"cups","measure":"2","searchTerm":null},
    {"productName":"Vegetable Oil","qty":1,"unit":"tbsp","measure":"3","searchTerm":null}
  ]'::jsonb,
  '1. Cook jasmine rice and keep warm.
2. Fry each egg in oil over high heat until whites are set with crispy edges and runny yolk. Set aside.
3. In the same pan over high heat, add more oil. Add minced garlic and sliced Thai chilies. Stir-fry 30 seconds.
4. Add ground pork. Break apart and cook, pressing against the pan, until some pieces are slightly charred — about 4–5 minutes.
5. Add fish sauce, oyster sauce, soy sauce, and sugar. Stir to combine.
6. Remove from heat, stir in fresh Thai basil leaves until wilted.
7. Serve over rice with the crispy fried egg on top.',
  'Thailand''s most beloved street dish. The crispy fried egg on top isn''t optional — it''s the entire point. Let the pork char in the pan; those dark bits are flavor. Regular basil works, but Thai basil is punchier.',
  NULL,
  4,
  '4',
  ARRAY['Thai','Pork','Dinner','Stovetop','Asian','Under 30 Min'],
  'https://mealio.co',
  NOW() - INTERVAL '4 days'
),

-- 25. Creamy Tuscan Shrimp Linguine
(
  '00000000-0000-0000-0000-000000000025',
  'Creamy Tuscan Shrimp Linguine',
  'Mealio Kitchen',
  'ac888f68-164b-46f2-aaa9-67b00c43feb6',
  '[
    {"productName":"Large Shrimp Peeled Deveined","qty":1,"unit":"lb","measure":"1","searchTerm":null},
    {"productName":"Linguine","qty":1,"unit":"lb","measure":"12","searchTerm":null},
    {"productName":"Heavy Cream","qty":1,"unit":"cups","measure":"1","searchTerm":null},
    {"productName":"Sun-Dried Tomatoes in Oil","qty":1,"unit":"oz","measure":"6","searchTerm":null},
    {"productName":"Baby Spinach","qty":1,"unit":"cups","measure":"3","searchTerm":null},
    {"productName":"Garlic","qty":5,"unit":"qty","measure":null,"searchTerm":null},
    {"productName":"Parmesan Cheese","qty":1,"unit":"oz","measure":"3","searchTerm":null},
    {"productName":"Dry White Wine","qty":1,"unit":"cups","measure":"0.5","searchTerm":null},
    {"productName":"Butter","qty":1,"unit":"tbsp","measure":"3","searchTerm":null},
    {"productName":"Red Pepper Flakes","qty":1,"unit":"tsp","measure":"0.5","searchTerm":null},
    {"productName":"Fresh Parsley","qty":1,"unit":"qty","measure":null,"searchTerm":null},
    {"productName":"Lemon","qty":1,"unit":"qty","measure":null,"searchTerm":null}
  ]'::jsonb,
  '1. Cook linguine in heavily salted water until al dente. Reserve 1/2 cup pasta water.
2. Season shrimp with salt and pepper. Sear in a hot skillet with butter, 1–2 minutes per side until pink. Remove.
3. In the same pan, sauté sliced sun-dried tomatoes and garlic in butter for 2 minutes.
4. Add white wine and reduce by half.
5. Pour in heavy cream. Simmer 3 minutes until slightly thickened.
6. Add spinach and stir until wilted.
7. Toss in drained linguine, shrimp, Parmesan, and a squeeze of lemon. Add pasta water as needed.
8. Plate and top with parsley and red pepper flakes.',
  'Restaurant pasta, home kitchen. The white wine reduction before the cream is what builds depth — don''t skip it. Shrimp go in last; they''re already cooked and just need to warm through.',
  NULL,
  4,
  '4',
  ARRAY['Seafood','Italian','Pasta','Dinner','Under 30 Min','Date Night','Stovetop'],
  'https://mealio.co',
  NOW() - INTERVAL '3 days'
),

-- 26. Slow Cooker BBQ Pulled Pork
(
  '00000000-0000-0000-0000-000000000026',
  'Slow Cooker BBQ Pulled Pork',
  'Mealio Kitchen',
  'ac888f68-164b-46f2-aaa9-67b00c43feb6',
  '[
    {"productName":"Bone-In Pork Shoulder","qty":1,"unit":"lb","measure":"5","searchTerm":null},
    {"productName":"BBQ Sauce","qty":1,"unit":"cups","measure":"1.5","searchTerm":null},
    {"productName":"Apple Cider Vinegar","qty":1,"unit":"tbsp","measure":"3","searchTerm":null},
    {"productName":"Brown Sugar","qty":1,"unit":"tbsp","measure":"2","searchTerm":null},
    {"productName":"Smoked Paprika","qty":1,"unit":"tbsp","measure":"1","searchTerm":null},
    {"productName":"Garlic Powder","qty":1,"unit":"tsp","measure":"1","searchTerm":null},
    {"productName":"Onion Powder","qty":1,"unit":"tsp","measure":"1","searchTerm":null},
    {"productName":"Ground Cumin","qty":1,"unit":"tsp","measure":"1","searchTerm":null},
    {"productName":"Cayenne Pepper","qty":1,"unit":"tsp","measure":"0.25","searchTerm":null},
    {"productName":"Kosher Salt","qty":1,"unit":"tbsp","measure":"1","searchTerm":null},
    {"productName":"Brioche Buns","qty":6,"unit":"qty","measure":null,"searchTerm":null},
    {"productName":"Coleslaw Mix","qty":1,"unit":"lb","measure":"1","searchTerm":null}
  ]'::jsonb,
  '1. Mix smoked paprika, garlic powder, onion powder, cumin, cayenne, brown sugar, and salt into a dry rub.
2. Pat pork shoulder dry and coat thoroughly in the dry rub. Let sit 30 minutes (or overnight in the fridge).
3. Place pork in slow cooker. Pour apple cider vinegar and half the BBQ sauce around it.
4. Cook on LOW for 8–10 hours, or HIGH for 5–6 hours, until fall-apart tender.
5. Remove pork and shred with two forks, discarding any large fat pieces.
6. Strain and degrease cooking liquid. Mix the drippings with remaining BBQ sauce and toss with pork.
7. Toast brioche buns. Pile pork high on each bun and top with coleslaw.',
  'Set it in the morning, eat it for dinner. The dry rub builds a pseudo-bark, and using the strained cooking juices back in the pulled pork is what separates the good from the great.',
  NULL,
  4,
  '6-8',
  ARRAY['Pork','Slow Cooker','BBQ','American','Dinner','Meal Prep','Freezer Friendly','Over 1 Hour','Family Friendly'],
  'https://mealio.co',
  NOW() - INTERVAL '2 days'
),

-- ─── DIFFICULTY 5 — HARD (4 meals) ───────────────────────────────────────────

-- 27. Homemade Tonkotsu Ramen
(
  '00000000-0000-0000-0000-000000000027',
  'Homemade Tonkotsu Ramen',
  'Mealio Kitchen',
  'ac888f68-164b-46f2-aaa9-67b00c43feb6',
  '[
    {"productName":"Pork Neck Bones","qty":1,"unit":"lb","measure":"3","searchTerm":null},
    {"productName":"Pork Belly","qty":1,"unit":"lb","measure":"1","searchTerm":null},
    {"productName":"Fresh Ramen Noodles","qty":4,"unit":"qty","measure":null,"searchTerm":null},
    {"productName":"Large Eggs","qty":4,"unit":"qty","measure":null,"searchTerm":null},
    {"productName":"Green Onions","qty":4,"unit":"qty","measure":null,"searchTerm":null},
    {"productName":"Nori Sheets","qty":4,"unit":"qty","measure":null,"searchTerm":null},
    {"productName":"Soy Sauce","qty":1,"unit":"tbsp","measure":"4","searchTerm":null},
    {"productName":"Mirin","qty":1,"unit":"tbsp","measure":"3","searchTerm":null},
    {"productName":"Sesame Oil","qty":1,"unit":"tbsp","measure":"2","searchTerm":null},
    {"productName":"Garlic","qty":6,"unit":"qty","measure":null,"searchTerm":null},
    {"productName":"Fresh Ginger","qty":1,"unit":"qty","measure":null,"searchTerm":null},
    {"productName":"Bamboo Shoots","qty":1,"unit":"qty","measure":null,"searchTerm":null},
    {"productName":"Bean Sprouts","qty":1,"unit":"cups","measure":"2","searchTerm":null}
  ]'::jsonb,
  '1. DAY BEFORE — Blanch pork bones in boiling water 10 minutes. Drain and scrub clean.
2. Return bones to pot with 12 cups water, garlic, and ginger. Boil hard (uncovered) for 4–6 hours, adding water as needed, until broth is opaque and milky white. Strain and cool overnight.
3. Make chashu: Roll pork belly and tie with twine. Simmer in soy sauce, mirin, and water for 2 hours. Slice when cooled.
4. Soft-boil eggs: 6.5 minutes in boiling water, then ice bath. Peel and marinate in equal parts soy sauce and mirin for at least 2 hours.
5. Reheat broth. Season with salt and sesame oil. Taste and adjust.
6. Cook noodles per package, drain.
7. Assemble bowls: noodles, hot broth ladled over, chashu slices, halved marinated egg, green onions, bamboo shoots, bean sprouts, and nori.',
  'Tonkotsu is a weekend commitment. The broth requires hours of hard boiling to extract collagen and turn milky. Everything else — the chashu, the marinated egg — can be made the day before. Worth every minute.',
  NULL,
  5,
  '4',
  ARRAY['Japanese','Asian','Soup','Dinner','Pork','Over 1 Hour','Comfort Food'],
  'https://mealio.co',
  NOW() - INTERVAL '1 days'
),

-- 28. Beef Wellington
(
  '00000000-0000-0000-0000-000000000028',
  'Beef Wellington',
  'Mealio Kitchen',
  'ac888f68-164b-46f2-aaa9-67b00c43feb6',
  '[
    {"productName":"Beef Tenderloin Center Cut","qty":1,"unit":"lb","measure":"2.5","searchTerm":null},
    {"productName":"Frozen Puff Pastry","qty":1,"unit":"qty","measure":null,"searchTerm":null},
    {"productName":"Prosciutto","qty":1,"unit":"oz","measure":"6","searchTerm":null},
    {"productName":"Cremini Mushrooms","qty":1,"unit":"lb","measure":"1","searchTerm":null},
    {"productName":"Shallots","qty":3,"unit":"qty","measure":null,"searchTerm":null},
    {"productName":"Dijon Mustard","qty":1,"unit":"tbsp","measure":"2","searchTerm":null},
    {"productName":"Garlic","qty":4,"unit":"qty","measure":null,"searchTerm":null},
    {"productName":"Fresh Thyme","qty":1,"unit":"qty","measure":null,"searchTerm":null},
    {"productName":"Butter","qty":1,"unit":"tbsp","measure":"3","searchTerm":null},
    {"productName":"Large Eggs","qty":2,"unit":"qty","measure":null,"searchTerm":null},
    {"productName":"Kosher Salt","qty":1,"unit":"tbsp","measure":"1","searchTerm":null},
    {"productName":"Black Pepper","qty":1,"unit":"tsp","measure":"1","searchTerm":null}
  ]'::jsonb,
  '1. Tie tenderloin with twine so it holds shape. Sear hard in a very hot, oiled skillet on all sides — 1–2 minutes per side. Cool completely. Brush all over with Dijon mustard.
2. Pulse mushrooms, shallots, garlic, and thyme until fine. Cook in butter over high heat until completely dry — 15–20 minutes. Season and cool completely.
3. Lay prosciutto slices overlapping on plastic wrap. Spread mushroom mixture (duxelles) evenly over prosciutto.
4. Place beef at one end and roll tightly, using the wrap to form a log. Refrigerate 30 minutes minimum.
5. Thaw and unroll puff pastry. Unwrap beef and place on pastry. Wrap tightly, sealing edges with egg wash. Refrigerate 15 minutes.
6. Preheat oven to 425°F. Brush pastry with egg wash, score lightly, sprinkle with flaky salt.
7. Roast 25–30 minutes until pastry is deep golden. Rest 10 minutes before slicing.',
  'One of the great showstopper dishes. The duxelles must be completely dry before wrapping or the pastry goes soggy. The tenderloin must be fully chilled before going into the oven. Do not rush either step.',
  NULL,
  5,
  '4-6',
  ARRAY['Beef','Dinner','Date Night','Baked','Over 1 Hour','French'],
  'https://mealio.co',
  NOW() - INTERVAL '18 hours'
),

-- 29. Lamb Shawarma
(
  '00000000-0000-0000-0000-000000000029',
  'Lamb Shawarma',
  'Mealio Kitchen',
  'ac888f68-164b-46f2-aaa9-67b00c43feb6',
  '[
    {"productName":"Lamb Leg Boneless","qty":1,"unit":"lb","measure":"2","searchTerm":null},
    {"productName":"Plain Yogurt","qty":1,"unit":"cups","measure":"1","searchTerm":null},
    {"productName":"Lemon","qty":2,"unit":"qty","measure":null,"searchTerm":null},
    {"productName":"Garlic","qty":6,"unit":"qty","measure":null,"searchTerm":null},
    {"productName":"Ground Cumin","qty":1,"unit":"tbsp","measure":"1","searchTerm":null},
    {"productName":"Ground Coriander","qty":1,"unit":"tsp","measure":"1","searchTerm":null},
    {"productName":"Turmeric","qty":1,"unit":"tsp","measure":"0.5","searchTerm":null},
    {"productName":"Cinnamon","qty":1,"unit":"tsp","measure":"0.5","searchTerm":null},
    {"productName":"Smoked Paprika","qty":1,"unit":"tbsp","measure":"1","searchTerm":null},
    {"productName":"Pita Bread","qty":4,"unit":"qty","measure":null,"searchTerm":null},
    {"productName":"Tahini","qty":1,"unit":"tbsp","measure":"3","searchTerm":null},
    {"productName":"Cherry Tomatoes","qty":1,"unit":"cups","measure":"1","searchTerm":null},
    {"productName":"English Cucumber","qty":1,"unit":"qty","measure":null,"searchTerm":null},
    {"productName":"Fresh Parsley","qty":1,"unit":"qty","measure":null,"searchTerm":null}
  ]'::jsonb,
  '1. Slice lamb into thin 1/4-inch strips. Combine with yogurt, lemon juice, minced garlic, cumin, coriander, turmeric, cinnamon, paprika, and salt. Marinate at least 4 hours, preferably overnight.
2. Make tahini sauce: whisk tahini with lemon juice, garlic, water, and salt until smooth and pourable.
3. Cook lamb in batches in a screaming hot cast iron pan. Spread in a single layer and leave undisturbed 2–3 minutes to char. Stir and cook until fully cooked through and caramelized.
4. Warm pitas in a dry skillet or directly over a flame.
5. Assemble: spread tahini sauce on pita, pile on lamb, add sliced cucumber, halved cherry tomatoes, and fresh parsley.
6. Wrap tightly in foil and serve, or leave open-faced.',
  'The overnight yogurt marinade tenderizes the lamb and gives it that characteristic flavor. The charred bits in the pan — the crispy remnants — are the best part. Don''t skip them.',
  NULL,
  5,
  '4',
  ARRAY['Lamb','Middle Eastern','Dinner','High Protein','Over 1 Hour','Stovetop'],
  'https://mealio.co',
  NOW() - INTERVAL '12 hours'
),

-- 30. Chocolate Soufflé
(
  '00000000-0000-0000-0000-000000000030',
  'Chocolate Soufflé',
  'Mealio Kitchen',
  'ac888f68-164b-46f2-aaa9-67b00c43feb6',
  '[
    {"productName":"Dark Chocolate 70%","qty":1,"unit":"oz","measure":"6","searchTerm":null},
    {"productName":"Unsalted Butter","qty":1,"unit":"tbsp","measure":"4","searchTerm":null},
    {"productName":"Large Eggs","qty":4,"unit":"qty","measure":null,"searchTerm":null},
    {"productName":"Granulated Sugar","qty":1,"unit":"tbsp","measure":"6","searchTerm":null},
    {"productName":"All-Purpose Flour","qty":1,"unit":"tbsp","measure":"2","searchTerm":null},
    {"productName":"Whole Milk","qty":1,"unit":"tbsp","measure":"6","searchTerm":null},
    {"productName":"Vanilla Extract","qty":1,"unit":"tsp","measure":"1","searchTerm":null},
    {"productName":"Cream of Tartar","qty":1,"unit":"tsp","measure":"0.25","searchTerm":null},
    {"productName":"Powdered Sugar","qty":1,"unit":"tbsp","measure":"2","searchTerm":null},
    {"productName":"Cocoa Powder","qty":1,"unit":"tbsp","measure":"2","searchTerm":null}
  ]'::jsonb,
  '1. Preheat oven to 375°F (190°C). Butter 4 ramekins generously, then dust with cocoa powder. Refrigerate.
2. Melt chocolate and butter together in a double boiler until smooth. Cool slightly.
3. Whisk flour and milk in a small saucepan over medium heat until it thickens into a paste. Remove from heat. Stir in chocolate mixture, egg yolks, vanilla, and 2 tbsp sugar. Cool to room temperature.
4. In a clean bowl, beat egg whites with cream of tartar until foamy. Gradually add remaining sugar and beat to stiff, glossy peaks.
5. Fold one third of the meringue into the chocolate base vigorously to lighten it. Gently fold in remaining meringue in two additions — work quickly but gently to preserve volume.
6. Fill ramekins to just below the rim. Run a thumb around the inner edge to create a ridge (this helps even rise).
7. Bake 12–14 minutes until risen and just set on top with a slight wobble in the center. Serve immediately — soufflés wait for no one.',
  'The soufflé is the great culinary test of patience and precision. Buttered and cocoa-dusted ramekins are non-negotiable, stiff egg whites are non-negotiable, and timing is non-negotiable. Everything else is forgiving.',
  NULL,
  5,
  '4',
  ARRAY['Dessert','Baked','French','Vegetarian','Date Night','Over 1 Hour'],
  'https://mealio.co',
  NOW()
);
