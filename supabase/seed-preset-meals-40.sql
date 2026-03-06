-- Seed: 40 additional preset meals (meals 11–50)
-- Ingredient convention: Title Case, size appended after comma ("80/20 Ground Beef, 1 lb")
-- Run after seed-preset-meals.sql

INSERT INTO preset_meals (name, source, recipe, ingredients, photo_url, author, difficulty) VALUES

-- 11. Buttermilk Pancakes
(
  'Buttermilk Pancakes',
  'https://mealio.co',
  E'1. Whisk together 2 cups of pancake mix, 1 1/2 cups of buttermilk, 2 eggs, and 3 tbsp of melted butter in a bowl until just combined — a few lumps are fine.\n2. Heat a large non-stick skillet or griddle over medium heat. Lightly butter the surface.\n3. Pour 1/4 cup of batter per pancake onto the skillet.\n4. Cook 2–3 minutes until bubbles form across the surface and the edges look set.\n5. Flip and cook 1–2 minutes more until golden brown.\n6. Serve with butter and warm maple syrup.',
  '[
    {"productName": "Buttermilk Pancake Mix, 32 oz Box", "searchTerm": "pancake mix", "quantity": 1},
    {"productName": "Buttermilk, 1 qt", "searchTerm": "buttermilk", "quantity": 1},
    {"productName": "Large Eggs, 1 Dozen", "searchTerm": "eggs", "quantity": 1},
    {"productName": "Butter, 1 lb", "searchTerm": "butter", "quantity": 1},
    {"productName": "Pure Maple Syrup, 12 oz", "searchTerm": "maple syrup", "quantity": 1}
  ]'::jsonb,
  'https://pixabay.com/get/g11383e01b15635d474584111dcd667a57e1a2594a55f5314557832c2b873270f4c251e34c6b0e6cfd25ec07327c60319619d0a19ab258fa01aa4b1f128ee7612_1280.jpg',
  'Mealio Kitchen',
  1
),

-- 12. Classic French Toast
(
  'Classic French Toast',
  'https://mealio.co',
  E'1. Whisk together 4 eggs, 1/2 cup of milk, 1 tsp of cinnamon, 1 tsp of vanilla extract, and a pinch of salt in a wide shallow bowl.\n2. Heat a skillet over medium heat and melt 1 tbsp of butter.\n3. Dip each slice of brioche in the egg mixture, letting it soak 15–20 seconds per side.\n4. Cook 2–3 minutes per side until golden brown.\n5. Dust with powdered sugar and serve with maple syrup.',
  '[
    {"productName": "Brioche Bread Loaf", "searchTerm": "brioche bread", "quantity": 1},
    {"productName": "Large Eggs, 1 Dozen", "searchTerm": "eggs", "quantity": 1},
    {"productName": "Whole Milk, 1/2 Gallon", "searchTerm": "milk", "quantity": 1},
    {"productName": "Ground Cinnamon", "searchTerm": "cinnamon", "quantity": 1},
    {"productName": "Pure Vanilla Extract, 4 oz", "searchTerm": "vanilla extract", "quantity": 1},
    {"productName": "Butter, 1 lb", "searchTerm": "butter", "quantity": 1},
    {"productName": "Powdered Sugar, 2 lb Bag", "searchTerm": "powdered sugar", "quantity": 1},
    {"productName": "Pure Maple Syrup, 12 oz", "searchTerm": "maple syrup", "quantity": 1}
  ]'::jsonb,
  'https://pixabay.com/get/gf16a3966ca8cfef6b9ad92c195486d2ac83c71678a1f070cdbfd2999b8483c7f33dc4d95177fee397bc72812e59fa552894d76b9c3d75be25c55b88aab9d63bb_1280.jpg',
  'Mealio Kitchen',
  1
),

-- 13. Breakfast Burritos
(
  'Breakfast Burritos',
  'https://mealio.co',
  E'1. Cook the breakfast sausage in a large skillet over medium heat, breaking it into crumbles, until browned. Remove and set aside.\n2. In the same skillet, sauté diced onion and bell pepper in the sausage drippings for 4–5 minutes.\n3. Whisk 8 eggs with a pinch of salt and pepper. Pour into the skillet and scramble gently until just set.\n4. Warm the flour tortillas in a dry skillet or microwave.\n5. Layer each tortilla with sausage, scrambled eggs, and shredded cheese.\n6. Fold in the sides, then roll up tightly. Serve with salsa and sour cream.',
  '[
    {"productName": "Large Flour Tortillas, 8 ct", "searchTerm": "flour tortillas", "quantity": 1},
    {"productName": "Large Eggs, 1 Dozen", "searchTerm": "eggs", "quantity": 1},
    {"productName": "Breakfast Sausage Links, 12 oz", "searchTerm": "breakfast sausage", "quantity": 1},
    {"productName": "Shredded Mexican Cheese Blend, 8 oz", "searchTerm": "shredded Mexican cheese", "quantity": 1},
    {"productName": "Green Bell Pepper", "searchTerm": "green bell pepper", "quantity": 1},
    {"productName": "Yellow Onion", "searchTerm": "yellow onion", "quantity": 1},
    {"productName": "Salsa, 16 oz Jar", "searchTerm": "salsa", "quantity": 1},
    {"productName": "Sour Cream, 8 oz", "searchTerm": "sour cream", "quantity": 1}
  ]'::jsonb,
  'https://pixabay.com/get/g23abfc88f43a201e2c69aa086838ebd123a3912039b2e07097b4e1d4224c705d80698277e1e4247b8ac493822d59c29a55d112514673eee8c82296a194fa40ce_1280.jpg',
  'Mealio Kitchen',
  2
),

-- 14. Avocado Toast with Fried Eggs
(
  'Avocado Toast with Fried Eggs',
  'https://mealio.co',
  E'1. Toast 4 thick slices of sourdough bread until golden and crisp.\n2. Halve and pit 2 avocados. Scoop the flesh into a bowl and mash with the juice of half a lemon, salt, and a pinch of red pepper flakes.\n3. Heat 1 tbsp of olive oil in a non-stick skillet over medium heat. Crack in 4 eggs and cook 2–3 minutes until the whites are set but the yolks are still runny.\n4. Spread the avocado mash generously over each toast.\n5. Top each slice with a fried egg. Season with flaky sea salt and extra red pepper flakes.',
  '[
    {"productName": "Sourdough Bread Loaf", "searchTerm": "sourdough bread", "quantity": 1},
    {"productName": "Avocados", "searchTerm": "avocado", "quantity": 2},
    {"productName": "Large Eggs, 1 Dozen", "searchTerm": "eggs", "quantity": 1},
    {"productName": "Lemon", "searchTerm": "lemon", "quantity": 1},
    {"productName": "Red Pepper Flakes", "searchTerm": "red pepper flakes", "quantity": 1},
    {"productName": "Olive Oil, 16 oz", "searchTerm": "olive oil", "quantity": 1},
    {"productName": "Sea Salt", "searchTerm": "sea salt", "quantity": 1}
  ]'::jsonb,
  'https://pixabay.com/get/ga1e45b3f7cb47d6bd0fe1103e2a422bb4dcb3d4d7ea7d298ad396f66d47161bcc9ce98bf2fc9c0e22d21eb3d223b5b7ad83060bfe003314520e522d631b93c5e_1280.jpg',
  'Mealio Kitchen',
  1
),

-- 15. Classic Cheeseburgers
(
  'Classic Cheeseburgers',
  'https://mealio.co',
  E'1. Divide 2 lbs of ground beef into 8 equal portions. Gently form into patties about 3/4 inch thick. Press a small indent in the center of each to prevent puffing.\n2. Season both sides generously with salt and pepper.\n3. Heat a cast-iron skillet or grill over high heat. Cook burgers 3–4 minutes per side for medium.\n4. In the last minute of cooking, top each patty with a slice of American cheese and cover briefly to melt.\n5. Toast the buns cut-side down in the skillet for 30 seconds.\n6. Build each burger with lettuce, tomato, onion, pickles, ketchup, and mustard.',
  '[
    {"productName": "80/20 Ground Beef, 2 lb", "searchTerm": "ground beef", "quantity": 1},
    {"productName": "Hamburger Buns, 8 ct", "searchTerm": "hamburger buns", "quantity": 1},
    {"productName": "American Cheese Slices, 12 ct", "searchTerm": "American cheese slices", "quantity": 1},
    {"productName": "Romaine Lettuce Heart", "searchTerm": "lettuce", "quantity": 1},
    {"productName": "Beefsteak Tomato", "searchTerm": "tomato", "quantity": 1},
    {"productName": "Yellow Onion", "searchTerm": "yellow onion", "quantity": 1},
    {"productName": "Dill Pickle Slices, 16 oz Jar", "searchTerm": "pickle slices", "quantity": 1},
    {"productName": "Yellow Mustard, 8 oz", "searchTerm": "yellow mustard", "quantity": 1},
    {"productName": "Ketchup, 20 oz", "searchTerm": "ketchup", "quantity": 1}
  ]'::jsonb,
  'https://pixabay.com/get/g4a1d7b1af34a64d163b16dcffb1cf9a951fa86ede04c2e8ff087e9fe18cabdea9e1e939f66dc3385c99ab7916b9565759a079a8b6895ce7bd39fcba7d59dc0e3_1280.jpg',
  'Mealio Kitchen',
  2
),

-- 16. BLT Sandwich
(
  'BLT Sandwich',
  'https://mealio.co',
  E'1. Cook the bacon in a skillet over medium heat until crispy, about 8 minutes. Drain on paper towels.\n2. Toast 8 slices of bread.\n3. Spread a generous layer of mayonnaise on one side of each slice.\n4. Layer one slice with crispy bacon, sliced tomato, and romaine lettuce leaves. Season the tomato with a pinch of salt.\n5. Top with a second slice of toasted bread, mayo-side down.\n6. Slice diagonally and serve immediately.',
  '[
    {"productName": "Thick-Cut Bacon, 12 oz", "searchTerm": "thick cut bacon", "quantity": 1},
    {"productName": "Sandwich Bread Loaf", "searchTerm": "sandwich bread", "quantity": 1},
    {"productName": "Beefsteak Tomato", "searchTerm": "beefsteak tomato", "quantity": 2},
    {"productName": "Romaine Lettuce Hearts, 3 ct", "searchTerm": "romaine lettuce", "quantity": 1},
    {"productName": "Mayonnaise, 15 oz", "searchTerm": "mayonnaise", "quantity": 1},
    {"productName": "Sea Salt", "searchTerm": "sea salt", "quantity": 1}
  ]'::jsonb,
  'https://pixabay.com/get/gc0593bb128ac3af6ca699c6274d0f092685519a853d9dc4743664d52183a8f0bd4e8f8f384f1a7bb61df4b16081d78a518d069d93f329932822c9b4a3e5ef5b4_1280.jpg',
  'Mealio Kitchen',
  1
),

-- 17. Chicken Caesar Wrap
(
  'Chicken Caesar Wrap',
  'https://mealio.co',
  E'1. Season chicken breast with salt and pepper. Heat 1 tbsp of olive oil in a skillet over medium-high heat and cook the chicken 6–7 minutes per side until cooked through. Rest 5 minutes, then slice thinly.\n2. Roughly chop the romaine lettuce.\n3. Toss the romaine with Caesar dressing and shredded Parmesan.\n4. Warm the flour tortillas in a dry skillet for 30 seconds per side.\n5. Lay out each tortilla and top with the dressed romaine, sliced chicken, and croutons.\n6. Roll up tightly, tucking in the sides as you go. Slice in half and serve.',
  '[
    {"productName": "Chicken Breast, Boneless Skinless, 1 lb", "searchTerm": "chicken breast", "quantity": 1},
    {"productName": "Large Flour Tortillas, 8 ct", "searchTerm": "flour tortillas", "quantity": 1},
    {"productName": "Romaine Lettuce Hearts, 3 ct", "searchTerm": "romaine lettuce", "quantity": 1},
    {"productName": "Caesar Dressing, 12 oz", "searchTerm": "Caesar dressing", "quantity": 1},
    {"productName": "Shredded Parmesan Cheese, 5 oz", "searchTerm": "Parmesan cheese", "quantity": 1},
    {"productName": "Caesar Croutons, 5 oz Bag", "searchTerm": "croutons", "quantity": 1},
    {"productName": "Olive Oil, 16 oz", "searchTerm": "olive oil", "quantity": 1}
  ]'::jsonb,
  'https://pixabay.com/get/g54f7a5a3acb04af6b959666d08fb0d8b64019b5cbb2e4f55f8a8be5ee4d4e6fea10cd87b8ef0616b066d41df585f6d29ca261935ef7bc4467fc01544299c7417_1280.jpg',
  'Mealio Kitchen',
  1
),

-- 18. Grilled Cheese and Tomato Soup
(
  'Grilled Cheese and Tomato Soup',
  'https://mealio.co',
  E'1. Heat the tomato soup in a medium saucepan per package directions, stirring in a splash of milk for creaminess. Keep warm.\n2. Butter one side of each bread slice.\n3. Heat a skillet over medium-low heat. Place 2 slices of bread butter-side down.\n4. Top each with 2–3 slices of cheddar cheese, then cover with the remaining bread slices, butter-side up.\n5. Cook 3–4 minutes per side until the bread is golden and the cheese is fully melted.\n6. Slice in half and serve alongside a bowl of warm tomato soup.',
  '[
    {"productName": "Sourdough Bread Loaf", "searchTerm": "sourdough bread", "quantity": 1},
    {"productName": "Sharp Cheddar Cheese Slices, 12 ct", "searchTerm": "cheddar cheese slices", "quantity": 1},
    {"productName": "Butter, 1 lb", "searchTerm": "butter", "quantity": 1},
    {"productName": "Tomato Soup, 18.8 oz Can", "searchTerm": "tomato soup", "quantity": 2},
    {"productName": "Whole Milk, 1/2 Gallon", "searchTerm": "milk", "quantity": 1}
  ]'::jsonb,
  'https://pixabay.com/get/geb412b0bab861a607adc8e5bc4212470d750e85d5a9547aa9e7312974bab56bf955202bf3b6e395b36227a5f3cafaa798be33fea02af685a24cc4af02a9e8814_1280.jpg',
  'Mealio Kitchen',
  1
),

-- 19. Beef Chili
(
  'Beef Chili',
  'https://mealio.co',
  E'1. Heat 1 tbsp of olive oil in a large pot over medium-high heat. Add diced onion and bell pepper, cook 5 minutes.\n2. Add minced garlic and cook 1 minute more.\n3. Add the ground beef and cook 6–8 minutes, breaking it apart, until browned. Drain excess fat.\n4. Stir in the chili seasoning packet and cook 1 minute.\n5. Add the diced tomatoes, tomato sauce, and drained kidney beans. Stir to combine.\n6. Bring to a boil, then reduce heat and simmer uncovered for 30 minutes, stirring occasionally.\n7. Ladle into bowls and top with shredded cheddar and a dollop of sour cream.',
  '[
    {"productName": "80/20 Ground Beef, 1.5 lb", "searchTerm": "ground beef", "quantity": 1},
    {"productName": "Chili Seasoning Mix, 1.25 oz Packet", "searchTerm": "chili seasoning", "quantity": 1},
    {"productName": "Kidney Beans, 15 oz Can", "searchTerm": "kidney beans", "quantity": 2},
    {"productName": "Diced Tomatoes, 14.5 oz Can", "searchTerm": "diced tomatoes", "quantity": 1},
    {"productName": "Tomato Sauce, 15 oz Can", "searchTerm": "tomato sauce", "quantity": 1},
    {"productName": "Yellow Onion", "searchTerm": "yellow onion", "quantity": 1},
    {"productName": "Green Bell Pepper", "searchTerm": "green bell pepper", "quantity": 1},
    {"productName": "Garlic Bulb", "searchTerm": "garlic", "quantity": 1},
    {"productName": "Shredded Cheddar Cheese, 8 oz", "searchTerm": "shredded cheddar cheese", "quantity": 1},
    {"productName": "Sour Cream, 8 oz", "searchTerm": "sour cream", "quantity": 1},
    {"productName": "Olive Oil, 16 oz", "searchTerm": "olive oil", "quantity": 1}
  ]'::jsonb,
  'https://pixabay.com/get/g094067780242cca4908f90b01495de149ce64a2574b48d595442e3707f0942120025ca6a217b89a17a4f9074dd55c386c908ac5943f03b9fc0c125e91acccf7d_1280.jpg',
  'Mealio Kitchen',
  2
),

-- 20. Chicken Parmesan
(
  'Chicken Parmesan',
  'https://mealio.co',
  E'1. Preheat oven to 400°F.\n2. Pound chicken breasts to an even 1/2-inch thickness. Season with salt and pepper.\n3. Set up a dredging station: flour in one bowl, beaten eggs in a second, Italian bread crumbs mixed with 1/4 cup grated Parmesan in a third.\n4. Coat each chicken piece in flour, then egg, then the bread crumb mixture.\n5. Heat 3 tbsp of olive oil in an oven-safe skillet over medium-high heat. Sear chicken 3–4 minutes per side until golden.\n6. Spoon marinara sauce over each piece and top with shredded mozzarella.\n7. Transfer skillet to the oven and bake 12–15 minutes until cheese is bubbly and chicken is cooked through.\n8. Cook spaghetti per package directions. Serve chicken over pasta with extra marinara.',
  '[
    {"productName": "Chicken Breast, Boneless Skinless, 2 lb", "searchTerm": "chicken breast", "quantity": 1},
    {"productName": "Italian Bread Crumbs, 15 oz", "searchTerm": "Italian bread crumbs", "quantity": 1},
    {"productName": "Shredded Mozzarella Cheese, 8 oz", "searchTerm": "shredded mozzarella", "quantity": 1},
    {"productName": "Parmesan Cheese Wedge, 4 oz", "searchTerm": "Parmesan cheese", "quantity": 1},
    {"productName": "Marinara Sauce, 24 oz Jar", "searchTerm": "marinara sauce", "quantity": 1},
    {"productName": "Large Eggs, 1 Dozen", "searchTerm": "eggs", "quantity": 1},
    {"productName": "Spaghetti, 16 oz", "searchTerm": "spaghetti", "quantity": 1},
    {"productName": "All-Purpose Flour, 5 lb Bag", "searchTerm": "all purpose flour", "quantity": 1},
    {"productName": "Italian Seasoning", "searchTerm": "Italian seasoning", "quantity": 1},
    {"productName": "Olive Oil, 16 oz", "searchTerm": "olive oil", "quantity": 1}
  ]'::jsonb,
  'https://pixabay.com/get/g6985ad54a245a01481440be8b44bcaaa8ec561b31f40e89eb50c4a887acddf81a635d715da71f8b607fa9650abbfb3cd63708a7fa28fe687cb07f36ca85e0692_1280.jpg',
  'Mealio Kitchen',
  3
),

-- 21. Shrimp Tacos
(
  'Shrimp Tacos',
  'https://mealio.co',
  E'1. In a small bowl, whisk together 2 tbsp of sour cream, 1 chipotle pepper in adobo (minced), and juice of 1 lime. Set aside as chipotle crema.\n2. Toss the shrimp with 1 tsp cumin, 1 tsp chili powder, 1/2 tsp garlic powder, salt, and pepper.\n3. Heat 1 tbsp of olive oil in a skillet over medium-high heat. Cook shrimp 1–2 minutes per side until pink and opaque. Remove from heat.\n4. Halve and pit the avocados and slice thinly.\n5. Warm the corn tortillas in a dry skillet.\n6. Build each taco: coleslaw, shrimp, avocado slices, and a drizzle of chipotle crema. Finish with a squeeze of fresh lime.',
  '[
    {"productName": "Large Raw Shrimp, Peeled and Deveined, 1 lb", "searchTerm": "large raw shrimp", "quantity": 1},
    {"productName": "Small Corn Tortillas, 30 ct", "searchTerm": "corn tortillas", "quantity": 1},
    {"productName": "Coleslaw Mix, 14 oz Bag", "searchTerm": "coleslaw mix", "quantity": 1},
    {"productName": "Avocados", "searchTerm": "avocado", "quantity": 2},
    {"productName": "Lime", "searchTerm": "lime", "quantity": 2},
    {"productName": "Sour Cream, 8 oz", "searchTerm": "sour cream", "quantity": 1},
    {"productName": "Chipotle Peppers in Adobo Sauce, 7 oz Can", "searchTerm": "chipotle peppers adobo", "quantity": 1},
    {"productName": "Cumin", "searchTerm": "cumin", "quantity": 1},
    {"productName": "Chili Powder", "searchTerm": "chili powder", "quantity": 1},
    {"productName": "Olive Oil, 16 oz", "searchTerm": "olive oil", "quantity": 1}
  ]'::jsonb,
  'https://pixabay.com/get/ge8a2ee3c6d4636e01de0ef1c1cf16ccb058688b2358d28fb039466475f6c44ee4ea8f28ef8d60d5ff5dab54f7e9a7badf668e0925e94f044b5fb42959a6c8d4c_1280.jpg',
  'Mealio Kitchen',
  2
),

-- 22. Beef and Broccoli
(
  'Beef and Broccoli',
  'https://mealio.co',
  E'1. Slice flank steak thinly against the grain. Toss with 1 tbsp cornstarch and a pinch of salt.\n2. Whisk sauce: 3 tbsp soy sauce, 2 tbsp oyster sauce, 1 tbsp brown sugar, 1 tsp sesame oil, and 1 tbsp cornstarch mixed with 2 tbsp water.\n3. Cook rice per package directions.\n4. Heat 2 tbsp of vegetable oil in a wok over high heat until smoking. Sear the beef in a single layer 1–2 minutes per side. Remove and set aside.\n5. Add 1 tbsp more oil. Stir-fry the broccoli florets 3–4 minutes until bright green and tender-crisp.\n6. Add minced garlic and grated ginger, stir 30 seconds.\n7. Return beef to the wok, pour the sauce over everything, and toss 1–2 minutes until glossy.\n8. Serve over steamed white rice. Drizzle with sesame oil.',
  '[
    {"productName": "Flank Steak, 1 lb", "searchTerm": "flank steak", "quantity": 1},
    {"productName": "Broccoli Florets, 12 oz Bag", "searchTerm": "broccoli florets", "quantity": 1},
    {"productName": "Soy Sauce, 10 oz", "searchTerm": "soy sauce", "quantity": 1},
    {"productName": "Oyster Sauce, 9 oz", "searchTerm": "oyster sauce", "quantity": 1},
    {"productName": "Brown Sugar, 1 lb Bag", "searchTerm": "brown sugar", "quantity": 1},
    {"productName": "Cornstarch, 1 lb Box", "searchTerm": "cornstarch", "quantity": 1},
    {"productName": "Garlic Bulb", "searchTerm": "garlic", "quantity": 1},
    {"productName": "Fresh Ginger Root", "searchTerm": "ginger root", "quantity": 1},
    {"productName": "Sesame Oil, 4 oz", "searchTerm": "sesame oil", "quantity": 1},
    {"productName": "Vegetable Oil, 16 oz", "searchTerm": "vegetable oil", "quantity": 1},
    {"productName": "White Rice, 2 lb Bag", "searchTerm": "white rice", "quantity": 1}
  ]'::jsonb,
  'https://pixabay.com/get/gcf98f479608ec9a72ed374c397827a53d00518a33928e720216d26d1d3d0f26f33cca2adf893b04546971c081d5d23321df915ee974232533571e5dfc217f63b_1280.jpg',
  'Mealio Kitchen',
  2
),

-- 23. Chicken Tikka Masala
(
  'Chicken Tikka Masala',
  'https://mealio.co',
  E'1. Cut chicken into 1-inch cubes. Toss with 1/4 cup plain Greek yogurt, 1 tsp garam masala, salt, and 2 minced garlic cloves. Marinate 30 minutes (or overnight).\n2. Cook rice per package directions.\n3. Heat 2 tbsp of olive oil in a large skillet over medium-high heat. Sear the chicken pieces 3–4 minutes per side until charred in spots. Remove and set aside.\n4. In the same skillet, cook diced onion 5 minutes. Add minced garlic and grated ginger, cook 1 minute.\n5. Add 1 jar of tikka masala sauce and 1/2 can of diced tomatoes. Simmer 5 minutes.\n6. Stir in 1/2 cup of heavy cream and the cooked chicken. Simmer 10 minutes.\n7. Serve over basmati rice. Garnish with fresh cilantro.',
  '[
    {"productName": "Chicken Breast, Boneless Skinless, 1.5 lb", "searchTerm": "chicken breast", "quantity": 1},
    {"productName": "Tikka Masala Sauce, 15 oz Jar", "searchTerm": "tikka masala sauce", "quantity": 1},
    {"productName": "Plain Greek Yogurt, 5.3 oz", "searchTerm": "plain Greek yogurt", "quantity": 1},
    {"productName": "Diced Tomatoes, 14.5 oz Can", "searchTerm": "diced tomatoes", "quantity": 1},
    {"productName": "Heavy Whipping Cream, 1 pt", "searchTerm": "heavy whipping cream", "quantity": 1},
    {"productName": "Yellow Onion", "searchTerm": "yellow onion", "quantity": 1},
    {"productName": "Garlic Bulb", "searchTerm": "garlic", "quantity": 1},
    {"productName": "Fresh Ginger Root", "searchTerm": "ginger root", "quantity": 1},
    {"productName": "Garam Masala", "searchTerm": "garam masala", "quantity": 1},
    {"productName": "Basmati Rice, 2 lb Bag", "searchTerm": "basmati rice", "quantity": 1},
    {"productName": "Fresh Cilantro", "searchTerm": "fresh cilantro", "quantity": 1},
    {"productName": "Olive Oil, 16 oz", "searchTerm": "olive oil", "quantity": 1}
  ]'::jsonb,
  'https://pixabay.com/get/ge8d2a81e7cd858f3037fe53e155376cb2edeebbd5a87828c0f902931e82354bbfb62f0128959619de714dd48587316614f58e6c90ac37b55b7298a6dab5b52c0_1280.jpg',
  'Mealio Kitchen',
  3
),

-- 24. Sheet Pan Fajitas
(
  'Sheet Pan Fajitas',
  'https://mealio.co',
  E'1. Preheat oven to 425°F.\n2. Slice chicken breast into strips. Slice bell peppers and onion into strips.\n3. Toss the chicken, peppers, and onion with olive oil, the fajita seasoning packet, and the juice of 1 lime.\n4. Spread everything in a single layer on a large sheet pan.\n5. Roast 20–25 minutes, stirring halfway, until chicken is cooked through and vegetables are tender with charred edges.\n6. Warm the flour tortillas.\n7. Serve with sour cream, shredded cheese, and extra lime wedges.',
  '[
    {"productName": "Chicken Breast, Boneless Skinless, 1.5 lb", "searchTerm": "chicken breast", "quantity": 1},
    {"productName": "Bell Peppers, 3 ct Bag", "searchTerm": "bell peppers", "quantity": 1},
    {"productName": "Yellow Onion", "searchTerm": "yellow onion", "quantity": 1},
    {"productName": "Fajita Seasoning, 1.12 oz Packet", "searchTerm": "fajita seasoning", "quantity": 1},
    {"productName": "Small Flour Tortillas, 8 ct", "searchTerm": "flour tortillas", "quantity": 1},
    {"productName": "Lime", "searchTerm": "lime", "quantity": 2},
    {"productName": "Sour Cream, 8 oz", "searchTerm": "sour cream", "quantity": 1},
    {"productName": "Shredded Mexican Cheese Blend, 8 oz", "searchTerm": "shredded Mexican cheese", "quantity": 1},
    {"productName": "Olive Oil, 16 oz", "searchTerm": "olive oil", "quantity": 1}
  ]'::jsonb,
  'https://pixabay.com/get/gc6d6a171dba8acc7330c70d6ed752ce46d7dac7b5a2c21f33e3e93eee3d7e344a2a8d215aec1d2c65aa9373af119191bf40a213bb668291ecacf81c5c9eb7263_1280.jpg',
  'Mealio Kitchen',
  1
),

-- 25. Tuscan Garlic Chicken
(
  'Tuscan Garlic Chicken',
  'https://mealio.co',
  E'1. Cook fettuccine per package directions. Drain and set aside.\n2. Season chicken breasts with Italian seasoning, salt, and pepper. Heat 2 tbsp of olive oil in a large skillet over medium-high heat. Cook chicken 6–7 minutes per side until golden and cooked through. Remove and slice.\n3. In the same skillet, sauté 4 minced garlic cloves for 1 minute.\n4. Add 1 cup of heavy cream and bring to a simmer. Stir in 1/2 cup of grated Parmesan until melted.\n5. Add the sun-dried tomatoes and baby spinach. Stir until the spinach wilts, about 2 minutes.\n6. Return the sliced chicken to the skillet and toss to coat.\n7. Serve over fettuccine.',
  '[
    {"productName": "Chicken Breast, Boneless Skinless, 2 lb", "searchTerm": "chicken breast", "quantity": 1},
    {"productName": "Heavy Whipping Cream, 1 pt", "searchTerm": "heavy whipping cream", "quantity": 1},
    {"productName": "Baby Spinach, 5 oz Bag", "searchTerm": "baby spinach", "quantity": 1},
    {"productName": "Sun-Dried Tomatoes, 8.5 oz Jar", "searchTerm": "sun dried tomatoes", "quantity": 1},
    {"productName": "Garlic Bulb", "searchTerm": "garlic", "quantity": 1},
    {"productName": "Parmesan Cheese Wedge, 4 oz", "searchTerm": "Parmesan cheese", "quantity": 1},
    {"productName": "Italian Seasoning", "searchTerm": "Italian seasoning", "quantity": 1},
    {"productName": "Fettuccine, 16 oz", "searchTerm": "fettuccine", "quantity": 1},
    {"productName": "Olive Oil, 16 oz", "searchTerm": "olive oil", "quantity": 1}
  ]'::jsonb,
  'https://pixabay.com/get/g347380fde737e44f5fc1ff849423587fd0e5db79f5c517aa47485fd0403dee933b375bbc01a2e283786f61ab0d3d4b3e46eefe597e52aa882dda115bdbf01cba_1280.jpg',
  'Mealio Kitchen',
  2
),

-- 26. Turkey Meatballs with Marinara
(
  'Turkey Meatballs with Marinara',
  'https://mealio.co',
  E'1. Preheat oven to 400°F. Line a baking sheet with parchment paper.\n2. In a large bowl, combine 1 lb ground turkey, 1/3 cup Italian bread crumbs, 1 beaten egg, 2 minced garlic cloves, 2 tbsp grated Parmesan, 1 tsp Italian seasoning, 1/2 tsp salt.\n3. Roll into 1 1/2-inch balls and place on the prepared baking sheet.\n4. Bake 18–20 minutes until cooked through and lightly browned.\n5. Meanwhile, heat the marinara sauce in a saucepan over low heat.\n6. Cook spaghetti per package directions.\n7. Serve meatballs over spaghetti with marinara sauce and extra Parmesan.',
  '[
    {"productName": "Ground Turkey, 1 lb", "searchTerm": "ground turkey", "quantity": 1},
    {"productName": "Marinara Sauce, 24 oz Jar", "searchTerm": "marinara sauce", "quantity": 1},
    {"productName": "Italian Bread Crumbs, 15 oz", "searchTerm": "Italian bread crumbs", "quantity": 1},
    {"productName": "Large Eggs, 1 Dozen", "searchTerm": "eggs", "quantity": 1},
    {"productName": "Shredded Parmesan Cheese, 5 oz", "searchTerm": "Parmesan cheese", "quantity": 1},
    {"productName": "Garlic Bulb", "searchTerm": "garlic", "quantity": 1},
    {"productName": "Italian Seasoning", "searchTerm": "Italian seasoning", "quantity": 1},
    {"productName": "Spaghetti, 16 oz", "searchTerm": "spaghetti", "quantity": 1}
  ]'::jsonb,
  'https://pixabay.com/get/g696d003cc259ab0b556bc7dd58a7df4729c7f1737e4cfeda5cbfe7cdb5347d7fd17069936d0df188850ad3aa9faf4349bdb03db68a4afc82b422c62610fd38d4_1280.jpg',
  'Mealio Kitchen',
  2
),

-- 27. Honey Garlic Salmon
(
  'Honey Garlic Salmon',
  'https://mealio.co',
  E'1. Cook rice per package directions.\n2. In a small bowl, whisk together 3 tbsp of honey, 3 tbsp of soy sauce, 4 minced garlic cloves, and juice of half a lemon.\n3. Pat salmon fillets dry and season with salt and pepper.\n4. Melt 2 tbsp of butter in an oven-safe skillet over medium-high heat. Sear salmon skin-side up 3–4 minutes until golden.\n5. Flip the salmon. Pour the honey garlic sauce over the fillets.\n6. Transfer the skillet to a 400°F oven and bake 5–7 minutes until the salmon flakes easily.\n7. Spoon the pan sauce over the salmon. Serve over rice and garnish with chopped parsley.',
  '[
    {"productName": "Salmon Fillets, 4 ct", "searchTerm": "salmon fillets", "quantity": 1},
    {"productName": "Honey, 12 oz", "searchTerm": "honey", "quantity": 1},
    {"productName": "Soy Sauce, 10 oz", "searchTerm": "soy sauce", "quantity": 1},
    {"productName": "Garlic Bulb", "searchTerm": "garlic", "quantity": 1},
    {"productName": "Lemon", "searchTerm": "lemon", "quantity": 1},
    {"productName": "Butter, 1 lb", "searchTerm": "butter", "quantity": 1},
    {"productName": "Fresh Parsley", "searchTerm": "fresh parsley", "quantity": 1},
    {"productName": "White Rice, 2 lb Bag", "searchTerm": "white rice", "quantity": 1}
  ]'::jsonb,
  'https://pixabay.com/get/ge781b8d3246654e5703c5e629d3fdaa3fd35b556240824ba5726cf4ef25c85179d5d01a42716c4575bd7e0fea3b74b3c348ed5c97e109a0c499d02c12ff5f827_1280.jpg',
  'Mealio Kitchen',
  2
),

-- 28. Creamy Tomato Pasta
(
  'Creamy Tomato Pasta',
  'https://mealio.co',
  E'1. Cook penne per package directions. Reserve 1/2 cup of pasta water before draining.\n2. Heat 2 tbsp of olive oil in a large skillet over medium heat. Cook diced onion 5 minutes. Add 4 minced garlic cloves, cook 1 minute.\n3. Stir in 2 tbsp tomato paste and cook 2 minutes.\n4. Add the crushed tomatoes and Italian seasoning. Simmer 10 minutes.\n5. Stir in 1/2 cup of heavy cream. Simmer 3 minutes more.\n6. Add the drained pasta and toss, adding pasta water as needed to loosen the sauce.\n7. Serve topped with grated Parmesan and fresh basil.',
  '[
    {"productName": "Penne Pasta, 16 oz", "searchTerm": "penne pasta", "quantity": 1},
    {"productName": "Crushed Tomatoes, 28 oz Can", "searchTerm": "crushed tomatoes", "quantity": 1},
    {"productName": "Heavy Whipping Cream, 1 pt", "searchTerm": "heavy whipping cream", "quantity": 1},
    {"productName": "Tomato Paste, 6 oz Can", "searchTerm": "tomato paste", "quantity": 1},
    {"productName": "Yellow Onion", "searchTerm": "yellow onion", "quantity": 1},
    {"productName": "Garlic Bulb", "searchTerm": "garlic", "quantity": 1},
    {"productName": "Parmesan Cheese Wedge, 4 oz", "searchTerm": "Parmesan cheese", "quantity": 1},
    {"productName": "Fresh Basil", "searchTerm": "fresh basil", "quantity": 1},
    {"productName": "Italian Seasoning", "searchTerm": "Italian seasoning", "quantity": 1},
    {"productName": "Olive Oil, 16 oz", "searchTerm": "olive oil", "quantity": 1}
  ]'::jsonb,
  'https://pixabay.com/get/g597d418df2bf2831d26562109444c1bf35aad2f71ca4a9e4e471de6b45240ff5b5624a751bb338fc62bfccbcfb6e61c8144e25ca78236fb2055f76cfd363d696_1280.jpg',
  'Mealio Kitchen',
  1
),

-- 29. Beef Enchiladas
(
  'Beef Enchiladas',
  'https://mealio.co',
  E'1. Preheat oven to 375°F.\n2. Brown ground beef in a skillet with diced onion over medium-high heat, 6–8 minutes. Drain fat. Add minced garlic, cumin, and chili powder. Cook 1 minute.\n3. Stir 1/2 cup of enchilada sauce into the beef mixture.\n4. Pour 1/2 cup of enchilada sauce into the bottom of a 9x13 baking dish.\n5. Warm the corn tortillas briefly to make them pliable.\n6. Fill each tortilla with the beef mixture and a sprinkle of cheese. Roll up and place seam-side down in the baking dish.\n7. Pour remaining enchilada sauce over the top and cover with remaining cheese.\n8. Bake covered 20 minutes, then uncovered 10 minutes until bubbly.\n9. Serve with sour cream.',
  '[
    {"productName": "80/20 Ground Beef, 1 lb", "searchTerm": "ground beef", "quantity": 1},
    {"productName": "Corn Tortillas, 30 ct", "searchTerm": "corn tortillas", "quantity": 1},
    {"productName": "Red Enchilada Sauce, 28 oz Can", "searchTerm": "enchilada sauce", "quantity": 1},
    {"productName": "Shredded Mexican Cheese Blend, 8 oz", "searchTerm": "shredded Mexican cheese", "quantity": 1},
    {"productName": "Yellow Onion", "searchTerm": "yellow onion", "quantity": 1},
    {"productName": "Garlic Bulb", "searchTerm": "garlic", "quantity": 1},
    {"productName": "Cumin", "searchTerm": "cumin", "quantity": 1},
    {"productName": "Chili Powder", "searchTerm": "chili powder", "quantity": 1},
    {"productName": "Sour Cream, 8 oz", "searchTerm": "sour cream", "quantity": 1}
  ]'::jsonb,
  'https://pixabay.com/get/gc079cfd487821acd609229d8b67d593c73f17edd97258a14c0bebbd93bc8c26bb542d11e5df31da246274a6c3da8bfaefffb68bd596e2e2fa4289ea2f9f83cf8_1280.jpg',
  'Mealio Kitchen',
  3
),

-- 30. Thai Peanut Noodles
(
  'Thai Peanut Noodles',
  'https://mealio.co',
  E'1. Cook lo mein noodles per package directions. Rinse under cold water and set aside.\n2. Whisk together the sauce: 1/3 cup peanut butter, 3 tbsp soy sauce, 2 tbsp sesame oil, juice of 1 lime, 1 tsp sriracha, 1 tsp grated ginger, and 2 minced garlic cloves. Thin with 2–3 tbsp of water to reach a pourable consistency.\n3. Toss the noodles with the peanut sauce and shredded carrots.\n4. Divide into bowls and top with sliced green onions, crushed roasted peanuts, and an extra drizzle of sriracha.',
  '[
    {"productName": "Lo Mein Noodles, 8 oz", "searchTerm": "lo mein noodles", "quantity": 1},
    {"productName": "Peanut Butter, 16 oz", "searchTerm": "peanut butter", "quantity": 1},
    {"productName": "Soy Sauce, 10 oz", "searchTerm": "soy sauce", "quantity": 1},
    {"productName": "Sesame Oil, 4 oz", "searchTerm": "sesame oil", "quantity": 1},
    {"productName": "Lime", "searchTerm": "lime", "quantity": 1},
    {"productName": "Fresh Ginger Root", "searchTerm": "ginger root", "quantity": 1},
    {"productName": "Garlic Bulb", "searchTerm": "garlic", "quantity": 1},
    {"productName": "Shredded Carrots, 10 oz Bag", "searchTerm": "shredded carrots", "quantity": 1},
    {"productName": "Green Onions", "searchTerm": "green onions", "quantity": 1},
    {"productName": "Roasted Peanuts, 16 oz Bag", "searchTerm": "roasted peanuts", "quantity": 1},
    {"productName": "Sriracha Hot Sauce, 17 oz", "searchTerm": "sriracha", "quantity": 1}
  ]'::jsonb,
  'https://pixabay.com/get/gc0d867844ba50284a10c206261d65d2a23081653736fa0ad562a9e2c0741eb12194e3758afb45d348b6104bd9a7170a80fb586472ba7039cb17ada53c376db32_1280.jpg',
  'Mealio Kitchen',
  1
),

-- 31. Greek Chicken Bowls
(
  'Greek Chicken Bowls',
  'https://mealio.co',
  E'1. Toss chicken breast with olive oil, 1 tsp Greek seasoning, juice of half a lemon, salt, and pepper. Marinate 15 minutes.\n2. Cook rice per package directions.\n3. Grill or pan-sear the chicken over medium-high heat 6–7 minutes per side until cooked through. Rest 5 minutes, then slice.\n4. Slice cucumber and halve cherry tomatoes. Thinly slice red onion.\n5. Build each bowl: a scoop of rice, sliced chicken, cucumber, tomatoes, red onion, olives, and a crumble of feta.\n6. Drizzle with tzatziki sauce and finish with a squeeze of lemon.',
  '[
    {"productName": "Chicken Breast, Boneless Skinless, 1.5 lb", "searchTerm": "chicken breast", "quantity": 1},
    {"productName": "Greek Seasoning", "searchTerm": "Greek seasoning", "quantity": 1},
    {"productName": "White Rice, 2 lb Bag", "searchTerm": "white rice", "quantity": 1},
    {"productName": "Cucumber", "searchTerm": "cucumber", "quantity": 1},
    {"productName": "Cherry Tomatoes, 10 oz", "searchTerm": "cherry tomatoes", "quantity": 1},
    {"productName": "Kalamata Olives, 6 oz Can", "searchTerm": "kalamata olives", "quantity": 1},
    {"productName": "Red Onion", "searchTerm": "red onion", "quantity": 1},
    {"productName": "Feta Cheese Crumbles, 6 oz", "searchTerm": "feta cheese crumbles", "quantity": 1},
    {"productName": "Tzatziki Sauce, 12 oz", "searchTerm": "tzatziki sauce", "quantity": 1},
    {"productName": "Lemon", "searchTerm": "lemon", "quantity": 1},
    {"productName": "Olive Oil, 16 oz", "searchTerm": "olive oil", "quantity": 1}
  ]'::jsonb,
  'https://pixabay.com/get/gf78e5a1efad08aa5a7ab90fedc8245ee8a1ad8ade9d375c25ea72fb32c175cb29dfb905fdd40d887613c18f5f304136c71d824fe0bec3d19a7d0db64b0d48bf9_1280.jpg',
  'Mealio Kitchen',
  2
),

-- 32. White Chicken Chili
(
  'White Chicken Chili',
  'https://mealio.co',
  E'1. Season chicken breasts with cumin, chili powder, salt, and pepper.\n2. Heat 1 tbsp of olive oil in a large pot over medium-high heat. Sear the chicken 5–6 minutes per side until cooked through. Remove, rest, then shred with two forks.\n3. In the same pot, cook diced onion 5 minutes. Add minced garlic and green chiles, cook 1 minute.\n4. Add the white beans (drained), chicken broth, and shredded chicken. Bring to a boil, then reduce heat and simmer 15 minutes.\n5. Stir in the cream cheese until melted and smooth. Simmer 5 minutes more.\n6. Ladle into bowls and top with shredded Monterey Jack cheese and a dollop of sour cream.',
  '[
    {"productName": "Chicken Breast, Boneless Skinless, 1.5 lb", "searchTerm": "chicken breast", "quantity": 1},
    {"productName": "Great Northern Beans, 15 oz Can", "searchTerm": "white beans", "quantity": 2},
    {"productName": "Diced Green Chiles, 4 oz Can", "searchTerm": "diced green chiles", "quantity": 1},
    {"productName": "Chicken Broth, 32 oz", "searchTerm": "chicken broth", "quantity": 1},
    {"productName": "Yellow Onion", "searchTerm": "yellow onion", "quantity": 1},
    {"productName": "Garlic Bulb", "searchTerm": "garlic", "quantity": 1},
    {"productName": "Cumin", "searchTerm": "cumin", "quantity": 1},
    {"productName": "Chili Powder", "searchTerm": "chili powder", "quantity": 1},
    {"productName": "Cream Cheese, 8 oz", "searchTerm": "cream cheese", "quantity": 1},
    {"productName": "Sour Cream, 8 oz", "searchTerm": "sour cream", "quantity": 1},
    {"productName": "Shredded Monterey Jack Cheese, 8 oz", "searchTerm": "shredded Monterey Jack cheese", "quantity": 1},
    {"productName": "Olive Oil, 16 oz", "searchTerm": "olive oil", "quantity": 1}
  ]'::jsonb,
  'https://pixabay.com/get/gd5b0635d390fe89ac8eabb764eceeeeb8b007b63644ef1e05fa19fc8a2e148ce1e90729ffddc694a9c018a123bc886a63f157c87bd20df8f2de13121cb8afb90_1280.jpg',
  'Mealio Kitchen',
  2
),

-- 33. Stuffed Bell Peppers
(
  'Stuffed Bell Peppers',
  'https://mealio.co',
  E'1. Preheat oven to 375°F. Cook 1 cup of rice per package directions.\n2. Cut the tops off 6 bell peppers and remove the seeds. Place in a 9x13 baking dish.\n3. Brown ground beef with diced onion in a skillet over medium-high heat. Drain fat. Add minced garlic, Italian seasoning, diced tomatoes, and tomato sauce. Stir in the cooked rice.\n4. Fill each bell pepper generously with the beef and rice mixture.\n5. Pour 1/2 cup of water into the bottom of the baking dish. Cover tightly with foil.\n6. Bake 35 minutes. Uncover, top each pepper with shredded mozzarella, and bake 10 minutes more until cheese is melted.',
  '[
    {"productName": "Bell Peppers, 3 ct Bag", "searchTerm": "bell peppers", "quantity": 2},
    {"productName": "80/20 Ground Beef, 1 lb", "searchTerm": "ground beef", "quantity": 1},
    {"productName": "White Rice, 2 lb Bag", "searchTerm": "white rice", "quantity": 1},
    {"productName": "Diced Tomatoes, 14.5 oz Can", "searchTerm": "diced tomatoes", "quantity": 1},
    {"productName": "Tomato Sauce, 15 oz Can", "searchTerm": "tomato sauce", "quantity": 1},
    {"productName": "Shredded Mozzarella Cheese, 8 oz", "searchTerm": "shredded mozzarella", "quantity": 1},
    {"productName": "Yellow Onion", "searchTerm": "yellow onion", "quantity": 1},
    {"productName": "Garlic Bulb", "searchTerm": "garlic", "quantity": 1},
    {"productName": "Italian Seasoning", "searchTerm": "Italian seasoning", "quantity": 1}
  ]'::jsonb,
  'https://pixabay.com/get/g6d28ca9896f3ecd11a282625bccf6dcd8d739a5922a4501ea8914f158719a782e4427e767bdcd35fe3528338e29a0f2307861b24989d26993ef18164680d53cd_1280.jpg',
  'Mealio Kitchen',
  2
),

-- 34. Chicken Fried Rice
(
  'Chicken Fried Rice',
  'https://mealio.co',
  E'1. Cook rice per package directions and let it cool completely (day-old rice works best).\n2. Season chicken with salt and pepper. Heat 1 tbsp of vegetable oil in a wok or large skillet over high heat. Cook the chicken, breaking it into pieces, 5–6 minutes until cooked through. Push to one side.\n3. Add 1 tbsp of oil to the empty side of the pan. Scramble 3 eggs until just set, then mix with the chicken.\n4. Add the frozen mixed vegetables and stir-fry 2 minutes.\n5. Add the cooled rice and toss everything together. Drizzle with soy sauce and sesame oil. Stir-fry 2–3 minutes until heated through.\n6. Toss in sliced green onions and serve.',
  '[
    {"productName": "Chicken Breast, Boneless Skinless, 1 lb", "searchTerm": "chicken breast", "quantity": 1},
    {"productName": "White Rice, 2 lb Bag", "searchTerm": "white rice", "quantity": 1},
    {"productName": "Frozen Mixed Vegetables, 12 oz Bag", "searchTerm": "frozen mixed vegetables", "quantity": 1},
    {"productName": "Large Eggs, 1 Dozen", "searchTerm": "eggs", "quantity": 1},
    {"productName": "Soy Sauce, 10 oz", "searchTerm": "soy sauce", "quantity": 1},
    {"productName": "Sesame Oil, 4 oz", "searchTerm": "sesame oil", "quantity": 1},
    {"productName": "Garlic Bulb", "searchTerm": "garlic", "quantity": 1},
    {"productName": "Green Onions", "searchTerm": "green onions", "quantity": 1},
    {"productName": "Vegetable Oil, 16 oz", "searchTerm": "vegetable oil", "quantity": 1}
  ]'::jsonb,
  'https://pixabay.com/get/gf0292f6dacf826f8efa473032f3e9a56f7095c8554d1ff983b7447ee1e56c7b45a51abdc956d0d33fdb160651e9b5b0af8b5c495fc9d275b3ba20b7a14913f98_1280.jpg',
  'Mealio Kitchen',
  2
),

-- 35. Teriyaki Salmon Bowls
(
  'Teriyaki Salmon Bowls',
  'https://mealio.co',
  E'1. Cook rice per package directions.\n2. Cook shelled edamame per package directions and season with salt.\n3. Marinate salmon fillets in 1/3 cup of teriyaki sauce for 10 minutes.\n4. Heat 1 tbsp of vegetable oil in a skillet over medium-high heat. Cook salmon 3–4 minutes per side until cooked through and caramelized.\n5. Slice cucumber and avocado.\n6. Build each bowl: rice, a salmon fillet, edamame, cucumber, shredded carrots, and avocado.\n7. Drizzle with extra teriyaki sauce. Top with sesame seeds and sliced green onions.',
  '[
    {"productName": "Salmon Fillets, 4 ct", "searchTerm": "salmon fillets", "quantity": 1},
    {"productName": "Teriyaki Sauce, 10 oz", "searchTerm": "teriyaki sauce", "quantity": 1},
    {"productName": "White Rice, 2 lb Bag", "searchTerm": "white rice", "quantity": 1},
    {"productName": "Edamame, Shelled, 12 oz Bag", "searchTerm": "shelled edamame", "quantity": 1},
    {"productName": "Avocados", "searchTerm": "avocado", "quantity": 2},
    {"productName": "Shredded Carrots, 10 oz Bag", "searchTerm": "shredded carrots", "quantity": 1},
    {"productName": "Cucumber", "searchTerm": "cucumber", "quantity": 1},
    {"productName": "Sesame Seeds", "searchTerm": "sesame seeds", "quantity": 1},
    {"productName": "Green Onions", "searchTerm": "green onions", "quantity": 1},
    {"productName": "Soy Sauce, 10 oz", "searchTerm": "soy sauce", "quantity": 1}
  ]'::jsonb,
  'https://pixabay.com/get/ge684b132decc055f730849af855ba2b972d3155052e2282992ed9c48e3b1e14c49b4becbf0bac8e26f9aad424a804870a9295f2cfd7dc99453776b57ac401112_1280.jpg',
  'Mealio Kitchen',
  2
),

-- 36. Baked Mac and Cheese
(
  'Baked Mac and Cheese',
  'https://mealio.co',
  E'1. Preheat oven to 375°F. Cook elbow macaroni 2 minutes less than the package directs (it will finish in the oven). Drain.\n2. Melt 4 tbsp of butter in a large saucepan over medium heat. Whisk in 1/4 cup of flour and cook 1–2 minutes. Gradually whisk in 3 cups of whole milk until smooth.\n3. Cook, stirring constantly, until the sauce thickens, about 5 minutes. Remove from heat.\n4. Stir in 2 cups of shredded cheddar, 1 cup of shredded Gruyère, 1 tsp of Dijon mustard, a pinch of nutmeg, salt, and pepper until melted.\n5. Fold in the drained pasta. Pour into a buttered 9x13 baking dish.\n6. Toss panko with 1 tbsp melted butter and scatter over the top.\n7. Bake 25–30 minutes until golden and bubbling.',
  '[
    {"productName": "Elbow Macaroni, 16 oz", "searchTerm": "elbow macaroni", "quantity": 1},
    {"productName": "Sharp Cheddar Cheese Block, 8 oz", "searchTerm": "sharp cheddar cheese", "quantity": 1},
    {"productName": "Gruyère Cheese Block, 8 oz", "searchTerm": "Gruyere cheese", "quantity": 1},
    {"productName": "Whole Milk, 1/2 Gallon", "searchTerm": "whole milk", "quantity": 1},
    {"productName": "Butter, 1 lb", "searchTerm": "butter", "quantity": 1},
    {"productName": "All-Purpose Flour, 5 lb Bag", "searchTerm": "all purpose flour", "quantity": 1},
    {"productName": "Panko Bread Crumbs, 8 oz", "searchTerm": "panko bread crumbs", "quantity": 1},
    {"productName": "Dijon Mustard, 8 oz", "searchTerm": "Dijon mustard", "quantity": 1},
    {"productName": "Ground Nutmeg", "searchTerm": "nutmeg", "quantity": 1}
  ]'::jsonb,
  'https://pixabay.com/get/g46f8db061d560c70d9a01fa73a5aeeef34ca2e238059f773b68ac6ee8ac51c41aa39a1269e7f05fe7d8359a3caca2c325def2002629955bd49458acb042b7794_1280.jpg',
  'Mealio Kitchen',
  2
),

-- 37. Carnitas Tacos
(
  'Carnitas Tacos',
  'https://mealio.co',
  E'1. Cut pork shoulder into 3-inch chunks. Season generously with cumin, chili powder, salt, and pepper.\n2. Place the pork in a Dutch oven or large pot with 4 minced garlic cloves, juice of 1 orange, and juice of 1 lime. Add 1/2 cup of water.\n3. Cover and cook over medium-low heat for 2 to 2 1/2 hours until the pork is very tender and shreds easily.\n4. Shred the pork with two forks. Spread on a baking sheet and broil 5 minutes until crispy at the edges.\n5. Warm the corn tortillas.\n6. Top each tortilla with carnitas, diced white onion, fresh cilantro, and salsa verde. Serve with extra lime wedges.',
  '[
    {"productName": "Pork Shoulder Roast, 3 lb", "searchTerm": "pork shoulder roast", "quantity": 1},
    {"productName": "Small Corn Tortillas, 30 ct", "searchTerm": "corn tortillas", "quantity": 1},
    {"productName": "Orange", "searchTerm": "orange", "quantity": 1},
    {"productName": "Lime", "searchTerm": "lime", "quantity": 2},
    {"productName": "Garlic Bulb", "searchTerm": "garlic", "quantity": 1},
    {"productName": "Cumin", "searchTerm": "cumin", "quantity": 1},
    {"productName": "Chili Powder", "searchTerm": "chili powder", "quantity": 1},
    {"productName": "White Onion", "searchTerm": "white onion", "quantity": 1},
    {"productName": "Fresh Cilantro", "searchTerm": "fresh cilantro", "quantity": 1},
    {"productName": "Salsa Verde, 16 oz Jar", "searchTerm": "salsa verde", "quantity": 1},
    {"productName": "Sour Cream, 8 oz", "searchTerm": "sour cream", "quantity": 1}
  ]'::jsonb,
  'https://pixabay.com/get/g5aad8a08378fe12898af77c78e07345d24e818d0d531d64edcb3363997c46c4a27909a82b759131e400ce85b3bebad02cca2b7641f0de254c25f2572b209830a_1280.jpg',
  'Mealio Kitchen',
  3
),

-- 38. Beef Stroganoff
(
  'Beef Stroganoff',
  'https://mealio.co',
  E'1. Cook egg noodles per package directions. Drain and toss with a little butter.\n2. Slice flank steak thinly against the grain. Season with salt and pepper.\n3. Melt 2 tbsp of butter in a large skillet over high heat. Sear the beef in a single layer 1 minute per side until browned. Remove and set aside.\n4. In the same skillet, melt 1 more tbsp of butter. Cook diced onion and sliced mushrooms over medium heat until softened, about 7 minutes.\n5. Add 2 minced garlic cloves and cook 1 minute. Whisk in the cream of mushroom soup and beef broth. Bring to a simmer.\n6. Stir in the Worcestershire sauce and 1 cup of sour cream until smooth.\n7. Return the beef to the pan and stir to combine. Serve over egg noodles.',
  '[
    {"productName": "Flank Steak, 1.5 lb", "searchTerm": "flank steak", "quantity": 1},
    {"productName": "Wide Egg Noodles, 12 oz Bag", "searchTerm": "egg noodles", "quantity": 1},
    {"productName": "Cream of Mushroom Soup, 10.5 oz Can", "searchTerm": "cream of mushroom soup", "quantity": 1},
    {"productName": "Sour Cream, 8 oz", "searchTerm": "sour cream", "quantity": 1},
    {"productName": "Beef Broth, 32 oz", "searchTerm": "beef broth", "quantity": 1},
    {"productName": "Sliced Mushrooms, 8 oz", "searchTerm": "sliced mushrooms", "quantity": 1},
    {"productName": "Yellow Onion", "searchTerm": "yellow onion", "quantity": 1},
    {"productName": "Garlic Bulb", "searchTerm": "garlic", "quantity": 1},
    {"productName": "Butter, 1 lb", "searchTerm": "butter", "quantity": 1},
    {"productName": "Worcestershire Sauce, 10 oz", "searchTerm": "Worcestershire sauce", "quantity": 1}
  ]'::jsonb,
  'https://pixabay.com/get/gb90650a24a2460fb6efc1c491fe11da83ab1089bc57e359a79b7471e4dcd5905ee8f311c0ce5c94615e095a415a31cf343349e2246dfe14b5007c204b5448e9e_1280.jpg',
  'Mealio Kitchen',
  2
),

-- 39. Pesto Pasta with Sausage
(
  'Pesto Pasta with Sausage',
  'https://mealio.co',
  E'1. Cook rotini per package directions. Reserve 1/2 cup pasta water before draining.\n2. Heat 1 tbsp of olive oil in a large skillet over medium-high heat. Remove sausage from casings and cook, breaking into crumbles, 7–8 minutes until browned. Remove and set aside.\n3. In the same skillet, add the halved cherry tomatoes and minced garlic. Cook 3 minutes until tomatoes begin to blister.\n4. Return the sausage to the pan. Add the drained pasta and toss.\n5. Remove from heat and stir in the pesto sauce, adding pasta water to loosen as needed.\n6. Serve topped with shredded Parmesan.',
  '[
    {"productName": "Rotini Pasta, 16 oz", "searchTerm": "rotini pasta", "quantity": 1},
    {"productName": "Basil Pesto Sauce, 6.7 oz Jar", "searchTerm": "basil pesto", "quantity": 1},
    {"productName": "Italian Sausage Links, 19 oz", "searchTerm": "Italian sausage links", "quantity": 1},
    {"productName": "Cherry Tomatoes, 10 oz", "searchTerm": "cherry tomatoes", "quantity": 1},
    {"productName": "Shredded Parmesan Cheese, 5 oz", "searchTerm": "Parmesan cheese", "quantity": 1},
    {"productName": "Garlic Bulb", "searchTerm": "garlic", "quantity": 1},
    {"productName": "Olive Oil, 16 oz", "searchTerm": "olive oil", "quantity": 1}
  ]'::jsonb,
  'https://pixabay.com/get/gb2576ca93ca794cdaa3eb14399d7c23e68308aa4de392a840d0517efec668f469d1c80039ac1c9c3ac8c784303ec9294457caeaf7cf482e71b8528e6f6818ecc_1280.jpg',
  'Mealio Kitchen',
  1
),

-- 40. Shakshuka
(
  'Shakshuka',
  'https://mealio.co',
  E'1. Heat 2 tbsp of olive oil in a large oven-safe skillet over medium heat. Add diced onion and bell pepper. Cook 5 minutes until softened.\n2. Add 4 minced garlic cloves, 1 tsp cumin, 1 tsp paprika, and a pinch of cayenne. Cook 1 minute.\n3. Pour in the crushed tomatoes. Season with salt and pepper. Simmer 10 minutes until the sauce thickens.\n4. Use a spoon to create 6 wells in the sauce. Crack an egg into each well.\n5. Cover the skillet and cook 5–8 minutes until the egg whites are set but the yolks are still runny.\n6. Crumble feta over the top and scatter fresh parsley. Serve straight from the skillet with warm pita bread.',
  '[
    {"productName": "Large Eggs, 1 Dozen", "searchTerm": "eggs", "quantity": 1},
    {"productName": "Crushed Tomatoes, 28 oz Can", "searchTerm": "crushed tomatoes", "quantity": 1},
    {"productName": "Red Bell Pepper", "searchTerm": "red bell pepper", "quantity": 1},
    {"productName": "Yellow Onion", "searchTerm": "yellow onion", "quantity": 1},
    {"productName": "Garlic Bulb", "searchTerm": "garlic", "quantity": 1},
    {"productName": "Cumin", "searchTerm": "cumin", "quantity": 1},
    {"productName": "Paprika", "searchTerm": "paprika", "quantity": 1},
    {"productName": "Cayenne Pepper", "searchTerm": "cayenne pepper", "quantity": 1},
    {"productName": "Feta Cheese Crumbles, 6 oz", "searchTerm": "feta cheese crumbles", "quantity": 1},
    {"productName": "Fresh Parsley", "searchTerm": "fresh parsley", "quantity": 1},
    {"productName": "Pita Bread, 4 ct", "searchTerm": "pita bread", "quantity": 1},
    {"productName": "Olive Oil, 16 oz", "searchTerm": "olive oil", "quantity": 1}
  ]'::jsonb,
  'https://pixabay.com/get/ge983d0af239ce7398e6a68cef0fbf24dca47e5cdf18ec623538e7edb7384cd3afe8c7becd85739b488f092b68bf1ce0754b89547d8b7ec2f99b902c18e2321c4_1280.jpg',
  'Mealio Kitchen',
  2
),

-- 41. Chicken Curry
(
  'Chicken Curry',
  'https://mealio.co',
  E'1. Cook basmati rice per package directions.\n2. Cut chicken thighs into 1-inch pieces. Season with 1 tsp curry powder, salt, and pepper.\n3. Heat 2 tbsp of olive oil in a large pot over medium-high heat. Brown the chicken 4–5 minutes. Remove and set aside.\n4. In the same pot, cook diced onion 5 minutes. Add 3 minced garlic cloves, 1 tbsp grated ginger, and 2 tsp curry powder. Cook 2 minutes.\n5. Add the diced tomatoes and coconut milk. Stir to combine.\n6. Return the chicken to the pot. Simmer uncovered 20 minutes until the sauce thickens.\n7. Taste and adjust seasoning. Serve over basmati rice and garnish with fresh cilantro.',
  '[
    {"productName": "Chicken Thighs, Boneless Skinless, 2 lb", "searchTerm": "boneless chicken thighs", "quantity": 1},
    {"productName": "Curry Powder", "searchTerm": "curry powder", "quantity": 1},
    {"productName": "Coconut Milk, 13.5 oz Can", "searchTerm": "coconut milk", "quantity": 1},
    {"productName": "Diced Tomatoes, 14.5 oz Can", "searchTerm": "diced tomatoes", "quantity": 1},
    {"productName": "Yellow Onion", "searchTerm": "yellow onion", "quantity": 1},
    {"productName": "Garlic Bulb", "searchTerm": "garlic", "quantity": 1},
    {"productName": "Fresh Ginger Root", "searchTerm": "ginger root", "quantity": 1},
    {"productName": "Basmati Rice, 2 lb Bag", "searchTerm": "basmati rice", "quantity": 1},
    {"productName": "Fresh Cilantro", "searchTerm": "fresh cilantro", "quantity": 1},
    {"productName": "Olive Oil, 16 oz", "searchTerm": "olive oil", "quantity": 1}
  ]'::jsonb,
  'https://pixabay.com/get/g2042bda9f8411f5280f461d1fc7ad3b70400f8b1a803ab4a9e151a3b33020efed44e46332766879ccb1183aa497b541fb70dbed265f013e7b0051fc9ee36dd0e_1280.jpg',
  'Mealio Kitchen',
  3
),

-- 42. Chicken Piccata
(
  'Chicken Piccata',
  'https://mealio.co',
  E'1. Cook angel hair pasta per package directions. Drain and toss with a little olive oil.\n2. Slice chicken breasts in half horizontally to create thin cutlets. Season with salt and pepper, then dredge lightly in flour.\n3. Heat 2 tbsp of olive oil and 2 tbsp of butter in a large skillet over medium-high heat. Cook the chicken 3–4 minutes per side until golden. Remove and set aside.\n4. Add 1/2 cup of chicken broth, juice of 1 lemon, and the capers to the skillet. Scrape up any browned bits. Simmer 3 minutes.\n5. Remove from heat and stir in 2 tbsp of cold butter until the sauce is glossy.\n6. Return the chicken to the pan and coat in the sauce.\n7. Serve over angel hair pasta and garnish with fresh parsley.',
  '[
    {"productName": "Chicken Breast, Boneless Skinless, 2 lb", "searchTerm": "chicken breast", "quantity": 1},
    {"productName": "Capers, 3.5 oz Jar", "searchTerm": "capers", "quantity": 1},
    {"productName": "Lemon", "searchTerm": "lemon", "quantity": 2},
    {"productName": "Chicken Broth, 32 oz", "searchTerm": "chicken broth", "quantity": 1},
    {"productName": "Butter, 1 lb", "searchTerm": "butter", "quantity": 1},
    {"productName": "All-Purpose Flour, 5 lb Bag", "searchTerm": "all purpose flour", "quantity": 1},
    {"productName": "Fresh Parsley", "searchTerm": "fresh parsley", "quantity": 1},
    {"productName": "Angel Hair Pasta, 16 oz", "searchTerm": "angel hair pasta", "quantity": 1},
    {"productName": "Olive Oil, 16 oz", "searchTerm": "olive oil", "quantity": 1}
  ]'::jsonb,
  'https://pixabay.com/get/gf8f7fd8f96045cac0aa03c17b9e6bc5102226f0df4404b74bc4a2c2eda45eae62f8b6e927b41bf1b348f791d2c970715f8c6f7c2f3a9c3e1cf6c47d5e992e6cc_1280.jpg',
  'Mealio Kitchen',
  2
),

-- 43. Sausage and Peppers Pasta
(
  'Sausage and Peppers Pasta',
  'https://mealio.co',
  E'1. Cook penne per package directions. Reserve 1/2 cup pasta water before draining.\n2. Heat 1 tbsp of olive oil in a large skillet over medium-high heat. Remove sausage from casings and cook, breaking into pieces, 7–8 minutes until browned. Remove and set aside.\n3. In the same skillet, cook sliced bell peppers and sliced onion 6–7 minutes until softened and lightly charred.\n4. Add minced garlic and Italian seasoning, cook 1 minute.\n5. Add the crushed tomatoes and sausage. Simmer 10 minutes.\n6. Add the drained pasta and toss, using pasta water to loosen as needed.\n7. Serve topped with shredded Parmesan.',
  '[
    {"productName": "Italian Sausage Links, 19 oz", "searchTerm": "Italian sausage links", "quantity": 1},
    {"productName": "Penne Pasta, 16 oz", "searchTerm": "penne pasta", "quantity": 1},
    {"productName": "Bell Peppers, 3 ct Bag", "searchTerm": "bell peppers", "quantity": 1},
    {"productName": "Yellow Onion", "searchTerm": "yellow onion", "quantity": 1},
    {"productName": "Crushed Tomatoes, 28 oz Can", "searchTerm": "crushed tomatoes", "quantity": 1},
    {"productName": "Garlic Bulb", "searchTerm": "garlic", "quantity": 1},
    {"productName": "Italian Seasoning", "searchTerm": "Italian seasoning", "quantity": 1},
    {"productName": "Shredded Parmesan Cheese, 5 oz", "searchTerm": "Parmesan cheese", "quantity": 1},
    {"productName": "Olive Oil, 16 oz", "searchTerm": "olive oil", "quantity": 1}
  ]'::jsonb,
  'https://pixabay.com/get/g16546869aac6295ead73dddae00d2c833db6fa9d054e04e000d682a559ec96c923e2e285ac4d551708758a0162a73394f6c7c280b7868bf85502c7a94b212ebc_1280.jpg',
  'Mealio Kitchen',
  2
),

-- 44. Cobb Salad
(
  'Cobb Salad',
  'https://mealio.co',
  E'1. Season chicken with salt and pepper. Heat 1 tbsp of olive oil in a skillet over medium-high heat. Cook 6–7 minutes per side until cooked through. Rest 5 minutes, then slice or chop.\n2. Cook bacon in a skillet until crispy. Drain and crumble.\n3. Hard-boil 4 eggs: place in cold water, bring to a boil, cover, remove from heat, and let sit 10 minutes. Cool and quarter.\n4. Halve the cherry tomatoes. Dice the avocados. Chop the romaine.\n5. Arrange the romaine in a large bowl or platter. In rows, add the chicken, bacon, eggs, tomatoes, avocado, and bleu cheese crumbles.\n6. Drizzle with ranch dressing just before serving.',
  '[
    {"productName": "Chicken Breast, Boneless Skinless, 1 lb", "searchTerm": "chicken breast", "quantity": 1},
    {"productName": "Romaine Lettuce Hearts, 3 ct", "searchTerm": "romaine lettuce", "quantity": 1},
    {"productName": "Thick-Cut Bacon, 12 oz", "searchTerm": "thick cut bacon", "quantity": 1},
    {"productName": "Large Eggs, 1 Dozen", "searchTerm": "eggs", "quantity": 1},
    {"productName": "Avocados", "searchTerm": "avocado", "quantity": 2},
    {"productName": "Cherry Tomatoes, 10 oz", "searchTerm": "cherry tomatoes", "quantity": 1},
    {"productName": "Bleu Cheese Crumbles, 4 oz", "searchTerm": "bleu cheese crumbles", "quantity": 1},
    {"productName": "Ranch Dressing, 16 oz", "searchTerm": "ranch dressing", "quantity": 1},
    {"productName": "Olive Oil, 16 oz", "searchTerm": "olive oil", "quantity": 1}
  ]'::jsonb,
  'https://pixabay.com/get/g6722bdf9de533dd5d28f9933459e9a066786a514b92aa636d95b0e7f6c00a139f68c4ba00b194ca730bdceaf7810f6255c8badc7108b7e24b77e54dfb316931f_1280.jpg',
  'Mealio Kitchen',
  1
),

-- 45. Pork Chops with Apple Sauce
(
  'Pork Chops with Apple Sauce',
  'https://mealio.co',
  E'1. Pat pork chops dry and season generously with salt, pepper, and a pinch of garlic powder.\n2. Heat 2 tbsp of olive oil in a large skillet over medium-high heat until shimmering. Sear the chops 3–4 minutes per side until golden brown and cooked through (145°F internal temperature).\n3. Remove chops and tent with foil to rest.\n4. In the same skillet, melt 2 tbsp of butter over medium heat. Add 2 minced garlic cloves and a sprig of fresh rosemary, cook 1 minute.\n5. Add 1/4 cup of chicken broth and scrape up the browned bits. Simmer 2 minutes.\n6. Serve pork chops with the pan sauce spooned over the top and warm applesauce on the side.',
  '[
    {"productName": "Bone-In Pork Chops, 4 ct", "searchTerm": "bone-in pork chops", "quantity": 1},
    {"productName": "Applesauce, 24 oz", "searchTerm": "applesauce", "quantity": 1},
    {"productName": "Garlic Bulb", "searchTerm": "garlic", "quantity": 1},
    {"productName": "Chicken Broth, 32 oz", "searchTerm": "chicken broth", "quantity": 1},
    {"productName": "Butter, 1 lb", "searchTerm": "butter", "quantity": 1},
    {"productName": "Fresh Rosemary", "searchTerm": "fresh rosemary", "quantity": 1},
    {"productName": "Olive Oil, 16 oz", "searchTerm": "olive oil", "quantity": 1}
  ]'::jsonb,
  'https://pixabay.com/get/gd776360a9aff6b474a3d63f8184ec1f33cd39de7d330c46c0b0ca99c2e9c37f5b91cdc77524a83c5e6ad49a8ce1bd1051991084480625b43de00dfdb269cd4c8_1280.jpg',
  'Mealio Kitchen',
  2
),

-- 46. Baked Potato Soup
(
  'Baked Potato Soup',
  'https://mealio.co',
  E'1. Cook bacon in a large pot until crispy. Remove and crumble. Leave 2 tbsp of drippings in the pot.\n2. Cook diced onion in the drippings over medium heat, 5 minutes. Whisk in 1/4 cup of flour and cook 1 minute.\n3. Gradually whisk in 4 cups of chicken broth and 2 cups of whole milk until smooth. Bring to a simmer.\n4. Add diced peeled russet potatoes. Cook 15–20 minutes until very tender.\n5. Use a potato masher to mash some of the potato chunks right in the pot for a thick, creamy texture.\n6. Stir in 1 cup of sour cream. Season with salt and pepper.\n7. Ladle into bowls and top with crumbled bacon, shredded cheddar, and sliced green onions.',
  '[
    {"productName": "Russet Potatoes, 5 lb Bag", "searchTerm": "russet potatoes", "quantity": 1},
    {"productName": "Chicken Broth, 32 oz", "searchTerm": "chicken broth", "quantity": 1},
    {"productName": "Thick-Cut Bacon, 12 oz", "searchTerm": "thick cut bacon", "quantity": 1},
    {"productName": "Sour Cream, 8 oz", "searchTerm": "sour cream", "quantity": 1},
    {"productName": "Shredded Cheddar Cheese, 8 oz", "searchTerm": "shredded cheddar cheese", "quantity": 1},
    {"productName": "Whole Milk, 1/2 Gallon", "searchTerm": "whole milk", "quantity": 1},
    {"productName": "Butter, 1 lb", "searchTerm": "butter", "quantity": 1},
    {"productName": "All-Purpose Flour, 5 lb Bag", "searchTerm": "all purpose flour", "quantity": 1},
    {"productName": "Yellow Onion", "searchTerm": "yellow onion", "quantity": 1},
    {"productName": "Green Onions", "searchTerm": "green onions", "quantity": 1}
  ]'::jsonb,
  'https://pixabay.com/get/g9937e5c5e0f16ff344f906044f734659adb25515e0cb3b71720c9cc4ebcf2ed9ac925a41bef56f4a10c63d54046f92f8a645fa37923848073d5bb0ed6c9a2efe_1280.jpg',
  'Mealio Kitchen',
  2
),

-- 47. Lemon Garlic Shrimp Pasta
(
  'Lemon Garlic Shrimp Pasta',
  'https://mealio.co',
  E'1. Cook linguine per package directions. Reserve 1 cup of pasta water before draining.\n2. Pat shrimp dry and season with salt, pepper, and a pinch of red pepper flakes.\n3. Melt 2 tbsp of butter with 1 tbsp of olive oil in a large skillet over medium-high heat. Cook the shrimp 1–2 minutes per side until pink. Remove and set aside.\n4. In the same skillet, melt 2 more tbsp of butter. Add 6 minced garlic cloves and cook 1 minute.\n5. Add 1/2 cup of chicken broth and juice of 1 lemon. Simmer 2 minutes.\n6. Add the drained linguine and toss, adding pasta water as needed for a silky sauce.\n7. Return the shrimp to the pan. Toss to combine. Serve topped with Parmesan and fresh parsley.',
  '[
    {"productName": "Large Raw Shrimp, Peeled and Deveined, 1 lb", "searchTerm": "large raw shrimp", "quantity": 1},
    {"productName": "Linguine, 16 oz", "searchTerm": "linguine", "quantity": 1},
    {"productName": "Lemon", "searchTerm": "lemon", "quantity": 2},
    {"productName": "Garlic Bulb", "searchTerm": "garlic", "quantity": 1},
    {"productName": "Butter, 1 lb", "searchTerm": "butter", "quantity": 1},
    {"productName": "Chicken Broth, 32 oz", "searchTerm": "chicken broth", "quantity": 1},
    {"productName": "Fresh Parsley", "searchTerm": "fresh parsley", "quantity": 1},
    {"productName": "Red Pepper Flakes", "searchTerm": "red pepper flakes", "quantity": 1},
    {"productName": "Shredded Parmesan Cheese, 5 oz", "searchTerm": "Parmesan cheese", "quantity": 1},
    {"productName": "Olive Oil, 16 oz", "searchTerm": "olive oil", "quantity": 1}
  ]'::jsonb,
  'https://pixabay.com/get/gafa56c0eff0976c6153cf7962afecbcdeb2354cd3aa379c63f1d140227fc47a1a8903f3dd44edb8f49c068b5e1492b760a575f70b9fecbacaf1ec080ae34831f_1280.jpg',
  'Mealio Kitchen',
  2
),

-- 48. Korean Beef Bowls
(
  'Korean Beef Bowls',
  'https://mealio.co',
  E'1. Cook rice per package directions.\n2. In a small bowl, whisk together the sauce: 3 tbsp soy sauce, 2 tbsp brown sugar, 1 tsp sesame oil, 1 tbsp minced garlic, 1 tsp grated fresh ginger, and 1 tsp sriracha.\n3. Brown ground beef in a large skillet over medium-high heat, breaking it apart, 6–8 minutes. Drain excess fat.\n4. Pour the sauce over the beef and toss to coat. Cook 2 minutes more until the sauce caramelizes slightly.\n5. Thinly slice the cucumber.\n6. Serve beef over rice with cucumber slices alongside. Top with sesame seeds and sliced green onions. Add extra sriracha to taste.',
  '[
    {"productName": "80/20 Ground Beef, 1 lb", "searchTerm": "ground beef", "quantity": 1},
    {"productName": "White Rice, 2 lb Bag", "searchTerm": "white rice", "quantity": 1},
    {"productName": "Soy Sauce, 10 oz", "searchTerm": "soy sauce", "quantity": 1},
    {"productName": "Brown Sugar, 1 lb Bag", "searchTerm": "brown sugar", "quantity": 1},
    {"productName": "Sesame Oil, 4 oz", "searchTerm": "sesame oil", "quantity": 1},
    {"productName": "Garlic Bulb", "searchTerm": "garlic", "quantity": 1},
    {"productName": "Fresh Ginger Root", "searchTerm": "ginger root", "quantity": 1},
    {"productName": "Green Onions", "searchTerm": "green onions", "quantity": 1},
    {"productName": "Sesame Seeds", "searchTerm": "sesame seeds", "quantity": 1},
    {"productName": "Sriracha Hot Sauce, 17 oz", "searchTerm": "sriracha", "quantity": 1},
    {"productName": "Cucumber", "searchTerm": "cucumber", "quantity": 1}
  ]'::jsonb,
  'https://pixabay.com/get/g009604a043ab09e7d67484e8692f0e5e4448baa0f018516acc0a9dc60a48d7e06cd6afcb1db5d8efb5ba200daf5ee9c0a4c7efa11286ce07d281dee570b4a334_1280.jpg',
  'Mealio Kitchen',
  2
),

-- 49. Chicken Noodle Soup
(
  'Chicken Noodle Soup',
  'https://mealio.co',
  E'1. Heat 2 tbsp of olive oil in a large pot over medium heat. Cook diced onion, sliced carrots, and sliced celery 6–8 minutes until softened.\n2. Add 3 minced garlic cloves and 2 bay leaves. Cook 1 minute.\n3. Add the chicken broth and chicken breasts. Bring to a boil, then reduce heat and simmer 20 minutes until chicken is cooked through.\n4. Remove chicken, shred with two forks, and return to the pot.\n5. Add the egg noodles and cook per package directions until tender.\n6. Remove bay leaves. Stir in fresh parsley and season generously with salt and pepper. Serve hot.',
  '[
    {"productName": "Chicken Breast, Boneless Skinless, 1.5 lb", "searchTerm": "chicken breast", "quantity": 1},
    {"productName": "Wide Egg Noodles, 12 oz Bag", "searchTerm": "egg noodles", "quantity": 1},
    {"productName": "Chicken Broth, 32 oz", "searchTerm": "chicken broth", "quantity": 2},
    {"productName": "Carrots", "searchTerm": "carrots", "quantity": 3},
    {"productName": "Celery", "searchTerm": "celery", "quantity": 1},
    {"productName": "Yellow Onion", "searchTerm": "yellow onion", "quantity": 1},
    {"productName": "Garlic Bulb", "searchTerm": "garlic", "quantity": 1},
    {"productName": "Fresh Parsley", "searchTerm": "fresh parsley", "quantity": 1},
    {"productName": "Bay Leaves", "searchTerm": "bay leaves", "quantity": 1},
    {"productName": "Olive Oil, 16 oz", "searchTerm": "olive oil", "quantity": 1}
  ]'::jsonb,
  'https://pixabay.com/get/gf7fd8136246417649f54b1850bd844ee2c4fed01976bceff3587bcd07254a1e94c66e6a08db56ae50797f7676d7c5d28a14bee11ccf13bcf69613da951acf833_1280.jpg',
  'Mealio Kitchen',
  2
),

-- 50. Caprese Pasta Salad
(
  'Caprese Pasta Salad',
  'https://mealio.co',
  E'1. Cook rotini per package directions. Rinse under cold water until cooled, then drain well.\n2. Halve the cherry tomatoes. Tear the fresh mozzarella into bite-sized pieces. Roughly tear the basil leaves.\n3. In a large bowl, toss the cooled pasta with 3 tbsp of olive oil, salt, and pepper.\n4. Add the cherry tomatoes, mozzarella, and basil. Gently toss to combine.\n5. Drizzle generously with balsamic glaze just before serving. Taste and adjust seasoning.',
  '[
    {"productName": "Rotini Pasta, 16 oz", "searchTerm": "rotini pasta", "quantity": 1},
    {"productName": "Cherry Tomatoes, 10 oz", "searchTerm": "cherry tomatoes", "quantity": 1},
    {"productName": "Fresh Mozzarella, 8 oz", "searchTerm": "fresh mozzarella", "quantity": 1},
    {"productName": "Fresh Basil", "searchTerm": "fresh basil", "quantity": 1},
    {"productName": "Balsamic Glaze, 8.5 oz", "searchTerm": "balsamic glaze", "quantity": 1},
    {"productName": "Olive Oil, 16 oz", "searchTerm": "olive oil", "quantity": 1},
    {"productName": "Sea Salt", "searchTerm": "sea salt", "quantity": 1}
  ]'::jsonb,
  'https://pixabay.com/get/geaf081e70c228fc1e1e0e98861c64122dc15f8473bb94b859ee44e0695b78af6f84586051df8ec91a394ad6d396b5be0d1a307c4b921197c317b69f4fba52a85_1280.jpg',
  'Mealio Kitchen',
  1
);
