-- =============================================================================
-- preset_meals table + seed data
-- Run this in: Supabase Dashboard → SQL Editor
-- If you already ran a previous version of this file, run
-- add-recipe-to-preset-meals.sql instead of re-running this.
-- =============================================================================

CREATE TABLE IF NOT EXISTS preset_meals (
  id          uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  store_id    text        NOT NULL,
  name        text        NOT NULL,
  description text        NOT NULL DEFAULT '',
  source      text        NOT NULL DEFAULT '',
  recipe      text,
  ingredients jsonb       NOT NULL DEFAULT '[]'::jsonb,
  created_at  timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS preset_meals_store_id_idx ON preset_meals (store_id);

-- ── HEB ──────────────────────────────────────────────────────────────────────

INSERT INTO preset_meals (store_id, name, description, source, recipe, ingredients) VALUES
(
  'heb', 'Classic Beef Tacos',
  'Seasoned ground beef tacos with all the fixings',
  'https://www.allrecipes.com/recipe/84560/easy-ground-beef-tacos/',
  '1. Brown ground beef in a skillet over medium-high heat, 5-7 min. Drain fat.
2. Add taco seasoning and 2/3 cup water. Simmer 3 min.
3. Warm corn tortillas in a dry skillet or microwave.
4. Build tacos: seasoned beef, shredded cheese, lettuce, diced tomato, salsa, sour cream.',
  '[
    {"productName": "H-E-B 80/20 Ground Beef, 1 lb",                        "searchTerm": "H-E-B Ground Beef 80/20",                   "quantity": 1},
    {"productName": "Mission Yellow Corn Tortillas, 30 ct",                  "searchTerm": "Mission Yellow Corn Tortillas",             "quantity": 1},
    {"productName": "H-E-B Taco Seasoning Mix, 1 oz",                       "searchTerm": "H-E-B Taco Seasoning",                     "quantity": 1},
    {"productName": "H-E-B Mexican Blend Shredded Cheese, 8 oz",            "searchTerm": "H-E-B Mexican Blend Shredded Cheese",      "quantity": 1},
    {"productName": "H-E-B Thick & Chunky Salsa, 16 oz",                    "searchTerm": "H-E-B Thick Chunky Salsa",                 "quantity": 1},
    {"productName": "H-E-B Sour Cream, 16 oz",                              "searchTerm": "H-E-B Sour Cream",                        "quantity": 1},
    {"productName": "Iceberg Lettuce Head",                                  "searchTerm": "Iceberg Lettuce",                         "quantity": 1},
    {"productName": "Roma Tomato",                                           "searchTerm": "Roma Tomato",                             "quantity": 3}
  ]'::jsonb
),
(
  'heb', 'Spaghetti Bolognese',
  'Classic Italian meat sauce over spaghetti',
  'https://www.seriouseats.com/the-best-slow-cooked-bolognese-sauce-recipe',
  '1. Dice onion and mince garlic. Saute in olive oil over medium heat, 5 min.
2. Add ground beef. Cook until browned, breaking it up. Drain fat.
3. Stir in crushed tomatoes and marinara sauce. Season with salt and pepper.
4. Simmer uncovered 20-25 min, stirring occasionally.
5. Cook spaghetti per package. Drain, serve topped with sauce and parmesan.',
  '[
    {"productName": "Barilla Spaghetti, 16 oz",               "searchTerm": "Barilla Spaghetti",             "quantity": 1},
    {"productName": "H-E-B 80/20 Ground Beef, 1 lb",          "searchTerm": "H-E-B Ground Beef 80/20",       "quantity": 1},
    {"productName": "Rao''s Homemade Marinara Sauce, 24 oz",  "searchTerm": "Rao''s Marinara Sauce",         "quantity": 1},
    {"productName": "H-E-B Grated Parmesan Cheese, 8 oz",     "searchTerm": "H-E-B Grated Parmesan",        "quantity": 1},
    {"productName": "Yellow Onion",                            "searchTerm": "Yellow Onion",                  "quantity": 1},
    {"productName": "Garlic Bulb",                             "searchTerm": "Garlic Bulb",                   "quantity": 1},
    {"productName": "H-E-B Crushed Tomatoes, 28 oz",          "searchTerm": "H-E-B Crushed Tomatoes",       "quantity": 1}
  ]'::jsonb
),
(
  'heb', 'Sheet Pan Chicken Fajitas',
  'Easy oven-roasted fajitas with peppers and onions',
  'https://www.budgetbytes.com/sheet-pan-chicken-fajitas/',
  '1. Preheat oven to 425 F.
2. Slice chicken breasts, bell peppers, and onion into strips.
3. Toss with fajita seasoning and 2 tbsp olive oil. Spread on a sheet pan.
4. Roast 22-25 min until chicken is cooked through and edges are charred.
5. Serve in warm flour tortillas with shredded cheese, sour cream, and sliced avocado.',
  '[
    {"productName": "H-E-B Boneless Skinless Chicken Breasts, 2 lb", "searchTerm": "H-E-B Boneless Skinless Chicken Breasts", "quantity": 1},
    {"productName": "Green Bell Pepper",                              "searchTerm": "Green Bell Pepper",                      "quantity": 2},
    {"productName": "Red Bell Pepper",                                "searchTerm": "Red Bell Pepper",                        "quantity": 1},
    {"productName": "Yellow Onion",                                   "searchTerm": "Yellow Onion",                           "quantity": 1},
    {"productName": "H-E-B Fajita Seasoning, 2.5 oz",               "searchTerm": "H-E-B Fajita Seasoning",                "quantity": 1},
    {"productName": "H-E-B Flour Tortillas, 10 ct",                  "searchTerm": "H-E-B Flour Tortillas",                 "quantity": 1},
    {"productName": "H-E-B Mexican Blend Shredded Cheese, 8 oz",     "searchTerm": "H-E-B Mexican Blend Shredded Cheese",   "quantity": 1},
    {"productName": "H-E-B Sour Cream, 16 oz",                       "searchTerm": "H-E-B Sour Cream",                     "quantity": 1},
    {"productName": "Fresh Large Hass Avocado",                       "searchTerm": "Fresh Large Hass Avocado",              "quantity": 2}
  ]'::jsonb
),
(
  'heb', 'Breakfast Burritos',
  'Hearty egg and cheese burritos perfect for meal prep',
  'https://www.budgetbytes.com/breakfast-burritos/',
  '1. Cook bacon in a skillet until crisp. Crumble and set aside.
2. Cook hash browns per package directions.
3. Scramble eggs in a lightly buttered skillet over medium-low heat.
4. Warm flour tortillas. Layer eggs, bacon, hash browns, shredded cheese, and salsa.
5. Roll tightly into burritos. Toast seam-down in the skillet 1-2 min if desired.',
  '[
    {"productName": "H-E-B Large Grade AA Eggs, 12 ct",             "searchTerm": "H-E-B Large Grade AA Eggs",           "quantity": 1},
    {"productName": "H-E-B Thick Cut Bacon, 16 oz",                 "searchTerm": "H-E-B Thick Cut Bacon",              "quantity": 1},
    {"productName": "H-E-B Flour Tortillas, 10 ct",                 "searchTerm": "H-E-B Flour Tortillas",              "quantity": 1},
    {"productName": "H-E-B Mexican Blend Shredded Cheese, 8 oz",    "searchTerm": "H-E-B Mexican Blend Shredded Cheese","quantity": 1},
    {"productName": "H-E-B Thick & Chunky Salsa, 16 oz",            "searchTerm": "H-E-B Thick Chunky Salsa",           "quantity": 1},
    {"productName": "H-E-B Sour Cream, 16 oz",                      "searchTerm": "H-E-B Sour Cream",                  "quantity": 1},
    {"productName": "H-E-B Shredded Hash Browns, 30 oz",            "searchTerm": "H-E-B Shredded Hash Browns",        "quantity": 1}
  ]'::jsonb
),
(
  'heb', 'Classic Guacamole & Chips',
  'Fresh homemade guacamole with crispy tortilla chips',
  'https://www.simplyrecipes.com/recipes/perfect_guacamole/',
  '1. Halve and pit avocados. Scoop flesh into a bowl.
2. Add juice of 1 lime and 1/2 tsp salt. Mash to your preferred texture.
3. Fold in diced roma tomato, finely diced white onion, minced jalapeno, and chopped cilantro.
4. Taste and adjust salt and lime.
5. Serve immediately with tortilla chips.',
  '[
    {"productName": "Fresh Large Hass Avocado",                                      "searchTerm": "Fresh Large Hass Avocado",                    "quantity": 3},
    {"productName": "Lime",                                                           "searchTerm": "Lime",                                        "quantity": 2},
    {"productName": "Roma Tomato",                                                    "searchTerm": "Roma Tomato",                                 "quantity": 1},
    {"productName": "White Onion",                                                    "searchTerm": "White Onion",                                 "quantity": 1},
    {"productName": "Fresh Cilantro Bunch",                                           "searchTerm": "Fresh Cilantro",                             "quantity": 1},
    {"productName": "Jalapeño Pepper",                                                "searchTerm": "Jalapeño Pepper",                            "quantity": 1},
    {"productName": "H-E-B Restaurant Style Tortilla Chips, 16 oz",                  "searchTerm": "H-E-B Restaurant Style Tortilla Chips",      "quantity": 1}
  ]'::jsonb
);

-- ── WALMART ───────────────────────────────────────────────────────────────────

INSERT INTO preset_meals (store_id, name, description, source, recipe, ingredients) VALUES
(
  'walmart', 'Classic Pancake Breakfast',
  'Fluffy buttermilk pancakes with bacon and eggs',
  'https://www.allrecipes.com/recipe/21014/good-old-fashioned-pancakes/',
  '1. Mix pancake batter per package directions.
2. Cook bacon in a skillet over medium heat until crisp. Set aside.
3. Heat a griddle or skillet over medium. Lightly butter the surface.
4. Pour 1/4 cup batter per pancake. Cook until bubbles form and edges look set, then flip. Cook 1-2 min more.
5. Fry or scramble eggs to taste.
6. Serve pancakes with maple syrup, butter, eggs, and bacon.',
  '[
    {"productName": "Great Value Buttermilk Pancake & Waffle Mix, 32 oz", "searchTerm": "Great Value Buttermilk Pancake Mix",   "quantity": 1},
    {"productName": "Great Value Pure Maple Syrup, 12.5 fl oz",           "searchTerm": "Great Value Pure Maple Syrup",         "quantity": 1},
    {"productName": "Great Value Large White Eggs, 18 Count",             "searchTerm": "Great Value Large White Eggs",         "quantity": 1},
    {"productName": "Land O Lakes Butter, Salted, 1 lb",                  "searchTerm": "Land O Lakes Salted Butter",          "quantity": 1},
    {"productName": "Smithfield Hometown Original Bacon, 16 oz",          "searchTerm": "Smithfield Hometown Original Bacon",  "quantity": 1}
  ]'::jsonb
),
(
  'walmart', 'Spaghetti with Meatballs',
  'Classic Italian pasta with savory meatballs',
  'https://www.seriouseats.com/classic-italian-american-spaghetti-and-meatballs-recipe',
  '1. Heat meatballs in the oven per package directions (or microwave for quick prep).
2. Warm marinara sauce in a saucepan over medium-low heat.
3. Add cooked meatballs to the sauce. Simmer together 10 min.
4. Cook spaghetti per package. Drain.
5. Plate pasta, spoon sauce and meatballs over top. Garnish with grated parmesan and fresh parsley.',
  '[
    {"productName": "Barilla Spaghetti Pasta, 16 oz",                          "searchTerm": "Barilla Spaghetti",                    "quantity": 2},
    {"productName": "Prego Traditional Italian Sauce, 24 oz",                  "searchTerm": "Prego Traditional Italian Sauce",     "quantity": 2},
    {"productName": "Cooked Perfect Homestyle Meatballs, Frozen, 26 oz",       "searchTerm": "Cooked Perfect Homestyle Meatballs",  "quantity": 1},
    {"productName": "Kraft Grated Parmesan Cheese, 8 oz",                      "searchTerm": "Kraft Grated Parmesan Cheese",        "quantity": 1},
    {"productName": "Fresh Italian Parsley, 1 bunch",                          "searchTerm": "Fresh Italian Parsley",               "quantity": 1}
  ]'::jsonb
),
(
  'walmart', 'Taco Tuesday',
  'Seasoned beef tacos with all the fixings',
  'https://www.allrecipes.com/recipe/84560/easy-ground-beef-tacos/',
  '1. Brown ground beef in a skillet over medium-high heat. Drain fat.
2. Add taco seasoning and water per package directions. Simmer 3 min.
3. Warm taco shells per package directions.
4. Build tacos: seasoned beef, fiesta blend cheese, shredded lettuce, diced tomato, sour cream.',
  '[
    {"productName": "Great Value Lean Ground Beef, 1 lb",                            "searchTerm": "Great Value Lean Ground Beef",              "quantity": 2},
    {"productName": "Old El Paso Taco Seasoning Mix, 1 oz",                          "searchTerm": "Old El Paso Taco Seasoning",                "quantity": 2},
    {"productName": "Old El Paso Taco Shells, Stand ''N Stuff, 10 Count",            "searchTerm": "Old El Paso Stand ''N Stuff Taco Shells",   "quantity": 2},
    {"productName": "Great Value Fiesta Blend Shredded Cheese, 8 oz",               "searchTerm": "Great Value Fiesta Blend Cheese",           "quantity": 2},
    {"productName": "Fresh Iceberg Lettuce, Each",                                   "searchTerm": "Iceberg Lettuce",                          "quantity": 1},
    {"productName": "Fresh Tomatoes on the Vine, 1 lb",                             "searchTerm": "Tomatoes on the Vine",                      "quantity": 1},
    {"productName": "Daisy Sour Cream, 16 oz",                                       "searchTerm": "Daisy Sour Cream",                         "quantity": 1}
  ]'::jsonb
),
(
  'walmart', 'Chicken Stir Fry',
  'Quick Asian-style stir fry with vegetables and rice',
  'https://www.budgetbytes.com/chicken-stir-fry/',
  '1. Slice chicken tenderloins into bite-sized pieces.
2. Heat canola oil in a large skillet or wok over high heat.
3. Cook chicken 5-6 min until golden and cooked through. Remove from pan.
4. Add frozen stir-fry vegetables to the same pan. Cook 3-4 min.
5. Return chicken to pan. Pour stir-fry sauce over everything. Toss to coat, 1-2 min.
6. Serve over microwaved rice.',
  '[
    {"productName": "Tyson Frozen Chicken Breast Tenderloins, 2.5 lb",    "searchTerm": "Tyson Chicken Breast Tenderloins",      "quantity": 1},
    {"productName": "Birds Eye Steamfresh Stir-Fry Vegetables, 10 oz",    "searchTerm": "Birds Eye Steamfresh Stir-Fry Vegetables","quantity": 2},
    {"productName": "Minute Ready to Serve White Rice, 8.8 oz",           "searchTerm": "Minute Ready to Serve White Rice",      "quantity": 4},
    {"productName": "Kikkoman Stir-Fry Sauce, 12.5 fl oz",                "searchTerm": "Kikkoman Stir-Fry Sauce",              "quantity": 1},
    {"productName": "Great Value Canola Oil, 48 fl oz",                   "searchTerm": "Great Value Canola Oil",               "quantity": 1}
  ]'::jsonb
),
(
  'walmart', 'Grilled Chicken Caesar Salad',
  'Fresh romaine with grilled chicken and creamy Caesar dressing',
  'https://www.simplyrecipes.com/recipes/caesar_salad/',
  '1. Heat grilled chicken strips per package directions.
2. Chop romaine hearts into bite-sized pieces.
3. Toss romaine with Caesar dressing (start light, add to taste).
4. Plate salad, top with sliced chicken, grated parmesan, and croutons.
5. Finish with fresh cracked black pepper.',
  '[
    {"productName": "Tyson Grilled & Ready Chicken Breast Strips, 22 oz",  "searchTerm": "Tyson Grilled Ready Chicken Breast",    "quantity": 1},
    {"productName": "Fresh Romaine Lettuce Hearts, 3 Count",               "searchTerm": "Fresh Romaine Lettuce Hearts",         "quantity": 2},
    {"productName": "Kraft Parmesan Grated Cheese, 8 oz",                  "searchTerm": "Kraft Parmesan Grated Cheese",         "quantity": 1},
    {"productName": "Ken''s Steak House Caesar Dressing, 16 fl oz",        "searchTerm": "Ken''s Steak House Caesar Dressing",   "quantity": 1},
    {"productName": "Fresh Croutons, Original, 5 oz",                      "searchTerm": "Fresh Gourmet Croutons",               "quantity": 1}
  ]'::jsonb
),
(
  'walmart', 'Easy Beef Chili',
  'Hearty slow-cooked chili perfect for cold days',
  'https://www.budgetbytes.com/basic-chili/',
  '1. Brown ground beef in a large pot over medium-high heat. Drain fat.
2. Add diced onion. Cook 3-4 min until softened.
3. Stir in chili seasoning, chili beans (undrained), and tomato sauce.
4. Bring to a boil, then reduce heat to low. Simmer 25-30 min, stirring occasionally.
5. Taste and adjust seasoning. Serve topped with shredded cheddar.',
  '[
    {"productName": "Great Value Lean Ground Beef, 1 lb",               "searchTerm": "Great Value Lean Ground Beef",           "quantity": 2},
    {"productName": "Bush''s Best Chili Beans, Mild, 16 oz",            "searchTerm": "Bush''s Best Chili Beans Mild",          "quantity": 3},
    {"productName": "Hunt''s Tomato Sauce, 15 oz",                      "searchTerm": "Hunt''s Tomato Sauce",                   "quantity": 2},
    {"productName": "McCormick Chili Seasoning Mix, 1.25 oz",           "searchTerm": "McCormick Chili Seasoning",              "quantity": 2},
    {"productName": "Fresh Yellow Onion, Each",                         "searchTerm": "Yellow Onion",                           "quantity": 2},
    {"productName": "Great Value Shredded Mild Cheddar Cheese, 8 oz",   "searchTerm": "Great Value Shredded Mild Cheddar",     "quantity": 1}
  ]'::jsonb
),
(
  'walmart', 'Overnight Oats Breakfast',
  'Healthy make-ahead breakfast with fresh berries',
  'https://www.thekitchn.com/how-to-make-overnight-oats-222731',
  '1. Add 1/2 cup rolled oats and 1/2 cup whole milk per serving into a jar or bowl.
2. Stir in 1 tsp honey.
3. Cover and refrigerate at least 4 hours or overnight.
4. In the morning, stir and top with fresh blueberries, strawberries, and sliced almonds.
5. Enjoy cold, or microwave 1-2 min if you prefer them warm.',
  '[
    {"productName": "Great Value Old Fashioned Oats, 42 oz",   "searchTerm": "Great Value Old Fashioned Oats",  "quantity": 1},
    {"productName": "Great Value Whole Milk, 1 Gallon",        "searchTerm": "Great Value Whole Milk",          "quantity": 1},
    {"productName": "Great Value Pure Honey, 16 oz",           "searchTerm": "Great Value Pure Honey",          "quantity": 1},
    {"productName": "Fresh Blueberries, 18 oz",                "searchTerm": "Fresh Blueberries",               "quantity": 1},
    {"productName": "Fresh Strawberries, 1 lb",                "searchTerm": "Fresh Strawberries",              "quantity": 1},
    {"productName": "Great Value Sliced Almonds, 6 oz",        "searchTerm": "Great Value Sliced Almonds",      "quantity": 1}
  ]'::jsonb
);

-- ── KROGER ────────────────────────────────────────────────────────────────────

INSERT INTO preset_meals (store_id, name, description, source, recipe, ingredients) VALUES
(
  'kroger', 'Classic Pancake Breakfast',
  'Fluffy buttermilk pancakes with bacon and eggs',
  'https://www.allrecipes.com/recipe/21014/good-old-fashioned-pancakes/',
  '1. Mix pancake batter per package directions.
2. Cook bacon in a skillet over medium heat until crisp. Set aside.
3. Heat a griddle or skillet over medium. Lightly butter the surface.
4. Pour 1/4 cup batter per pancake. Cook until bubbles form and edges look set, then flip. Cook 1-2 min more.
5. Fry or scramble eggs to taste.
6. Serve pancakes with maple syrup, butter, eggs, and bacon.',
  '[
    {"productName": "Kroger Buttermilk Pancake Mix, 32 oz",       "searchTerm": "Kroger Buttermilk Pancake Mix",   "quantity": 1},
    {"productName": "Kroger Pure Maple Syrup, 12 oz",             "searchTerm": "Kroger Pure Maple Syrup",        "quantity": 1},
    {"productName": "Kroger Large Grade A Eggs, 18 ct",           "searchTerm": "Kroger Large Grade A Eggs",      "quantity": 1},
    {"productName": "Land O Lakes Salted Butter, 1 lb",           "searchTerm": "Land O Lakes Salted Butter",    "quantity": 1},
    {"productName": "Kroger Original Thick Cut Bacon, 16 oz",     "searchTerm": "Kroger Thick Cut Bacon",         "quantity": 1}
  ]'::jsonb
),
(
  'kroger', 'Spaghetti with Meatballs',
  'Classic Italian pasta with savory meatballs',
  'https://www.seriouseats.com/classic-italian-american-spaghetti-and-meatballs-recipe',
  '1. Heat meatballs in the oven per package directions (or microwave for quick prep).
2. Warm marinara sauce in a saucepan over medium-low heat.
3. Add cooked meatballs to the sauce. Simmer together 10 min.
4. Cook spaghetti per package. Drain.
5. Plate pasta, spoon sauce and meatballs over top. Garnish with grated parmesan and fresh parsley.',
  '[
    {"productName": "Barilla Spaghetti, 16 oz",                "searchTerm": "Barilla Spaghetti",           "quantity": 2},
    {"productName": "Prego Traditional Pasta Sauce, 24 oz",    "searchTerm": "Prego Traditional Sauce",     "quantity": 2},
    {"productName": "Cooked Perfect Meatballs, 26 oz",         "searchTerm": "Cooked Perfect Meatballs",   "quantity": 1},
    {"productName": "Kraft Grated Parmesan Cheese, 8 oz",      "searchTerm": "Kraft Grated Parmesan",      "quantity": 1},
    {"productName": "Fresh Italian Parsley Bunch",             "searchTerm": "Fresh Italian Parsley",       "quantity": 1}
  ]'::jsonb
),
(
  'kroger', 'Taco Tuesday',
  'Seasoned beef tacos with all the fixings',
  'https://www.allrecipes.com/recipe/84560/easy-ground-beef-tacos/',
  '1. Brown ground beef in a skillet over medium-high heat. Drain fat.
2. Add taco seasoning and water per package directions. Simmer 3 min.
3. Warm taco shells per package directions.
4. Build tacos: seasoned beef, Mexican shredded cheese, shredded lettuce, diced tomato, sour cream.',
  '[
    {"productName": "Kroger Ground Beef 93/7, 1 lb",                       "searchTerm": "Kroger Ground Beef 93",               "quantity": 2},
    {"productName": "Old El Paso Taco Seasoning, 1 oz",                    "searchTerm": "Old El Paso Taco Seasoning",          "quantity": 2},
    {"productName": "Old El Paso Stand ''N Stuff Taco Shells, 10 ct",      "searchTerm": "Old El Paso Stand ''N Stuff",         "quantity": 2},
    {"productName": "Kroger Mexican Style Shredded Cheese, 8 oz",          "searchTerm": "Kroger Mexican Shredded Cheese",      "quantity": 2},
    {"productName": "Iceberg Lettuce Head",                                "searchTerm": "Iceberg Lettuce",                     "quantity": 1},
    {"productName": "Tomatoes on the Vine, 1 lb",                          "searchTerm": "Tomatoes on the Vine",                "quantity": 1},
    {"productName": "Kroger Sour Cream, 16 oz",                            "searchTerm": "Kroger Sour Cream",                  "quantity": 1}
  ]'::jsonb
),
(
  'kroger', 'Chicken Stir Fry',
  'Quick Asian-style stir fry with vegetables and rice',
  'https://www.budgetbytes.com/chicken-stir-fry/',
  '1. Slice chicken tenderloins into bite-sized pieces.
2. Heat canola oil in a large skillet or wok over high heat.
3. Cook chicken 5-6 min until golden and cooked through. Remove from pan.
4. Add frozen Asian vegetables to the same pan. Cook 3-4 min.
5. Return chicken to pan. Pour stir-fry sauce over everything. Toss to coat, 1-2 min.
6. Serve over microwaved rice.',
  '[
    {"productName": "Tyson Chicken Breast Tenderloins, 2.5 lb",       "searchTerm": "Tyson Chicken Tenderloins",       "quantity": 1},
    {"productName": "Birds Eye Steamfresh Asian Vegetables, 10 oz",   "searchTerm": "Birds Eye Steamfresh Asian",      "quantity": 2},
    {"productName": "Minute Ready to Serve White Rice, 8.8 oz",       "searchTerm": "Minute Ready to Serve Rice",     "quantity": 4},
    {"productName": "Kikkoman Stir-Fry Sauce, 12.5 oz",               "searchTerm": "Kikkoman Stir-Fry Sauce",        "quantity": 1},
    {"productName": "Kroger Canola Oil, 48 oz",                       "searchTerm": "Kroger Canola Oil",              "quantity": 1}
  ]'::jsonb
),
(
  'kroger', 'Grilled Chicken Caesar Salad',
  'Fresh romaine with grilled chicken and creamy Caesar dressing',
  'https://www.simplyrecipes.com/recipes/caesar_salad/',
  '1. Heat grilled chicken strips per package directions.
2. Chop romaine hearts into bite-sized pieces.
3. Toss romaine with Caesar dressing (start light, add to taste).
4. Plate salad, top with sliced chicken, grated parmesan, and croutons.
5. Finish with fresh cracked black pepper.',
  '[
    {"productName": "Tyson Grilled & Ready Chicken Breast Strips, 22 oz",  "searchTerm": "Tyson Grilled Ready Chicken",   "quantity": 1},
    {"productName": "Romaine Hearts, 3 ct",                                "searchTerm": "Romaine Hearts",                "quantity": 2},
    {"productName": "Kraft Parmesan Cheese, 8 oz",                         "searchTerm": "Kraft Parmesan Cheese",        "quantity": 1},
    {"productName": "Ken''s Steak House Caesar Dressing, 16 oz",           "searchTerm": "Ken''s Caesar Dressing",       "quantity": 1},
    {"productName": "Fresh Gourmet Classic Caesar Croutons, 5 oz",         "searchTerm": "Fresh Gourmet Croutons",       "quantity": 1}
  ]'::jsonb
),
(
  'kroger', 'Easy Beef Chili',
  'Hearty slow-cooked chili perfect for cold days',
  'https://www.budgetbytes.com/basic-chili/',
  '1. Brown ground beef in a large pot over medium-high heat. Drain fat.
2. Add diced onion. Cook 3-4 min until softened.
3. Stir in chili seasoning, chili beans (undrained), and tomato sauce.
4. Bring to a boil, then reduce heat to low. Simmer 25-30 min, stirring occasionally.
5. Taste and adjust seasoning. Serve topped with shredded cheddar.',
  '[
    {"productName": "Kroger Ground Beef 93/7, 1 lb",              "searchTerm": "Kroger Ground Beef 93",              "quantity": 2},
    {"productName": "Bush''s Chili Beans Mild, 16 oz",            "searchTerm": "Bush''s Chili Beans Mild",           "quantity": 3},
    {"productName": "Hunt''s Tomato Sauce, 15 oz",                "searchTerm": "Hunt''s Tomato Sauce",               "quantity": 2},
    {"productName": "McCormick Chili Seasoning, 1.25 oz",         "searchTerm": "McCormick Chili Seasoning",          "quantity": 2},
    {"productName": "Yellow Onion",                               "searchTerm": "Yellow Onion",                       "quantity": 2},
    {"productName": "Kroger Mild Cheddar Shredded Cheese, 8 oz",  "searchTerm": "Kroger Mild Cheddar Shredded",      "quantity": 1}
  ]'::jsonb
),
(
  'kroger', 'Overnight Oats Breakfast',
  'Healthy make-ahead breakfast with fresh berries',
  'https://www.thekitchn.com/how-to-make-overnight-oats-222731',
  '1. Add 1/2 cup rolled oats and 1/2 cup whole milk per serving into a jar or bowl.
2. Stir in 1 tsp honey.
3. Cover and refrigerate at least 4 hours or overnight.
4. In the morning, stir and top with fresh blueberries, strawberries, and sliced almonds.
5. Enjoy cold, or microwave 1-2 min if you prefer them warm.',
  '[
    {"productName": "Kroger Old Fashioned Oats, 42 oz",   "searchTerm": "Kroger Old Fashioned Oats",  "quantity": 1},
    {"productName": "Kroger Whole Milk, 1 gal",           "searchTerm": "Kroger Whole Milk",          "quantity": 1},
    {"productName": "Kroger Pure Honey, 16 oz",           "searchTerm": "Kroger Pure Honey",          "quantity": 1},
    {"productName": "Fresh Blueberries, 18 oz",           "searchTerm": "Fresh Blueberries",          "quantity": 1},
    {"productName": "Fresh Strawberries, 1 lb",           "searchTerm": "Fresh Strawberries",         "quantity": 1},
    {"productName": "Kroger Sliced Almonds, 6 oz",        "searchTerm": "Kroger Sliced Almonds",      "quantity": 1}
  ]'::jsonb
);
