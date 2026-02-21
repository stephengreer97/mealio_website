-- =============================================================================
-- Preset meals — Batch 2 (5 new meals × 3 stores)
-- Run this in: Supabase Dashboard → SQL Editor
-- Requires the preset_meals table to already exist (run seed-preset-meals.sql first).
-- =============================================================================

-- ── HEB ──────────────────────────────────────────────────────────────────────

INSERT INTO preset_meals (store_id, name, description, source, recipe, ingredients) VALUES
(
  'heb', 'Lemon Herb Baked Salmon',
  'Flaky oven-baked salmon with fresh lemon, dill, and roasted baby potatoes',
  'https://www.wellplated.com/baked-salmon/',
  '1. Preheat oven to 400°F. Line a sheet pan with foil.
2. Toss baby potatoes with olive oil, salt, and pepper. Roast 15 min.
3. Push potatoes to the sides. Place salmon fillets skin-side down in the center.
4. Drizzle salmon with olive oil. Arrange lemon slices on top, sprinkle with minced garlic and fresh dill.
5. Roast 12-15 min until salmon flakes easily with a fork.
6. Microwave green beans 3-4 min and serve alongside.',
  '[
    {"productName": "H-E-B Atlantic Salmon Fillets, 1.5 lb",          "searchTerm": "H-E-B Atlantic Salmon",              "quantity": 1},
    {"productName": "Baby Yellow Potatoes, 1.5 lb",                    "searchTerm": "Baby Yellow Potatoes",               "quantity": 1},
    {"productName": "Lemon",                                            "searchTerm": "Lemon",                              "quantity": 2},
    {"productName": "Garlic Bulb",                                      "searchTerm": "Garlic Bulb",                        "quantity": 1},
    {"productName": "Fresh Dill Bunch",                                 "searchTerm": "Fresh Dill",                         "quantity": 1},
    {"productName": "H-E-B Capers, 3.5 oz",                           "searchTerm": "H-E-B Capers",                       "quantity": 1},
    {"productName": "H-E-B Fresh Green Beans, 12 oz",                  "searchTerm": "Fresh Green Beans",                  "quantity": 1},
    {"productName": "H-E-B Extra Virgin Olive Oil, 16.9 oz",           "searchTerm": "H-E-B Extra Virgin Olive Oil",       "quantity": 1}
  ]'::jsonb
),
(
  'heb', 'Chicken Tortilla Soup',
  'Hearty Tex-Mex soup with tender chicken, black beans, and corn',
  'https://www.budgetbytes.com/chicken-tortilla-soup/',
  '1. Shred the rotisserie chicken, discarding skin and bones.
2. In a large pot, combine chicken, fire roasted tomatoes, chicken broth, black beans, corn, and taco seasoning.
3. Bring to a boil over medium-high heat, then reduce to low. Simmer 15-20 min.
4. Taste and adjust salt.
5. Ladle into bowls. Top with crushed tortilla chips, shredded cheese, sour cream, and cilantro.',
  '[
    {"productName": "H-E-B Rotisserie Chicken, Seasoned",              "searchTerm": "H-E-B Rotisserie Chicken",           "quantity": 1},
    {"productName": "H-E-B Fire Roasted Diced Tomatoes, 14.5 oz",     "searchTerm": "H-E-B Fire Roasted Diced Tomatoes",  "quantity": 2},
    {"productName": "H-E-B Chicken Broth, 32 oz",                      "searchTerm": "H-E-B Chicken Broth",                "quantity": 1},
    {"productName": "H-E-B Black Beans, 15 oz",                        "searchTerm": "H-E-B Black Beans",                  "quantity": 1},
    {"productName": "H-E-B Whole Kernel Corn, 15.25 oz",              "searchTerm": "H-E-B Whole Kernel Corn",            "quantity": 1},
    {"productName": "H-E-B Taco Seasoning Mix, 1 oz",                 "searchTerm": "H-E-B Taco Seasoning",               "quantity": 1},
    {"productName": "H-E-B Restaurant Style Tortilla Chips, 16 oz",   "searchTerm": "H-E-B Restaurant Style Tortilla Chips","quantity": 1},
    {"productName": "H-E-B Mexican Blend Shredded Cheese, 8 oz",      "searchTerm": "H-E-B Mexican Blend Shredded Cheese","quantity": 1},
    {"productName": "H-E-B Sour Cream, 16 oz",                        "searchTerm": "H-E-B Sour Cream",                   "quantity": 1},
    {"productName": "Fresh Cilantro Bunch",                             "searchTerm": "Fresh Cilantro",                     "quantity": 1}
  ]'::jsonb
),
(
  'heb', 'Veggie Fried Rice',
  'Quick vegetarian fried rice with peas, carrots, and scrambled egg',
  'https://www.budgetbytes.com/vegetable-fried-rice/',
  '1. Cook white rice per package and spread on a sheet pan to cool (day-old rice works even better).
2. Heat vegetable oil in a large wok or skillet over high heat until shimmering.
3. Add frozen peas and carrots. Stir-fry 2-3 min until heated through.
4. Push vegetables to the side. Crack eggs into the pan, scramble, then fold into veggies.
5. Add rice. Drizzle soy sauce and sesame oil over. Toss everything together 2-3 min.
6. Add minced garlic in the last 30 seconds. Garnish with sliced green onions.',
  '[
    {"productName": "H-E-B Long Grain White Rice, 5 lb",              "searchTerm": "H-E-B Long Grain White Rice",        "quantity": 1},
    {"productName": "H-E-B Frozen Sweet Peas & Carrots, 12 oz",       "searchTerm": "H-E-B Frozen Peas Carrots",          "quantity": 2},
    {"productName": "H-E-B Large Grade AA Eggs, 12 ct",               "searchTerm": "H-E-B Large Grade AA Eggs",          "quantity": 1},
    {"productName": "Kikkoman Soy Sauce, 10 oz",                       "searchTerm": "Kikkoman Soy Sauce",                 "quantity": 1},
    {"productName": "Kadoya Pure Sesame Oil, 5.5 oz",                  "searchTerm": "Sesame Oil",                         "quantity": 1},
    {"productName": "Green Onions Bunch",                               "searchTerm": "Green Onions",                       "quantity": 1},
    {"productName": "Garlic Bulb",                                      "searchTerm": "Garlic Bulb",                        "quantity": 1},
    {"productName": "H-E-B Vegetable Oil, 48 oz",                      "searchTerm": "H-E-B Vegetable Oil",               "quantity": 1}
  ]'::jsonb
),
(
  'heb', 'BBQ Pulled Pork Sliders',
  'Slow-cooked smoky pulled pork on soft slider buns with creamy slaw',
  'https://www.allrecipes.com/recipe/24074/easy-slow-cooker-pulled-pork/',
  '1. Rub pork shoulder all over with brown sugar, smoked paprika, salt, and pepper.
2. Place in slow cooker. Pour 1 cup BBQ sauce over the top.
3. Cook on LOW 8-10 hours (or HIGH 4-5 hours) until fall-apart tender.
4. Shred pork with two forks right in the slow cooker. Stir in more BBQ sauce to taste.
5. Mix coleslaw: toss coleslaw mix with 3 tbsp mayo, 1 tbsp apple cider vinegar, and 1 tsp sugar.
6. Toast slider buns if desired. Pile on pulled pork and top with creamy slaw.',
  '[
    {"productName": "Bone-In Pork Shoulder Butt, per lb",             "searchTerm": "Pork Shoulder Butt",                 "quantity": 4},
    {"productName": "H-E-B Original BBQ Sauce, 18 oz",                "searchTerm": "H-E-B Original BBQ Sauce",           "quantity": 2},
    {"productName": "H-E-B Slider Buns, 12 ct",                       "searchTerm": "H-E-B Slider Buns",                  "quantity": 1},
    {"productName": "H-E-B Classic Coleslaw Mix, 14 oz",              "searchTerm": "H-E-B Coleslaw Mix",                 "quantity": 1},
    {"productName": "H-E-B Real Mayonnaise, 30 oz",                   "searchTerm": "H-E-B Real Mayonnaise",              "quantity": 1},
    {"productName": "H-E-B Apple Cider Vinegar, 32 oz",               "searchTerm": "H-E-B Apple Cider Vinegar",          "quantity": 1},
    {"productName": "H-E-B Light Brown Sugar, 2 lb",                  "searchTerm": "H-E-B Light Brown Sugar",            "quantity": 1},
    {"productName": "H-E-B Smoked Paprika, 2 oz",                     "searchTerm": "H-E-B Smoked Paprika",               "quantity": 1}
  ]'::jsonb
),
(
  'heb', 'Black Bean Quesadillas',
  'Crispy quesadillas stuffed with seasoned black beans, corn, and melted cheese',
  'https://www.budgetbytes.com/black-bean-quesadillas/',
  '1. Drain and rinse black beans. Mix in a bowl with drained corn, cumin, chili powder, and a pinch of salt.
2. Heat a large skillet over medium. Lightly coat with cooking spray or a little oil.
3. Place a flour tortilla in the skillet. Spread half with the bean-corn mixture and top generously with shredded cheese.
4. Fold tortilla over. Cook 2-3 min per side until golden and crispy and cheese is fully melted.
5. Repeat for remaining tortillas. Slice each into wedges.
6. Serve with salsa, sour cream, and sliced or mashed avocado.',
  '[
    {"productName": "H-E-B Black Beans, 15 oz",                       "searchTerm": "H-E-B Black Beans",                  "quantity": 2},
    {"productName": "H-E-B Whole Kernel Corn, 15.25 oz",              "searchTerm": "H-E-B Whole Kernel Corn",            "quantity": 1},
    {"productName": "H-E-B Flour Tortillas, 10 ct",                   "searchTerm": "H-E-B Flour Tortillas",              "quantity": 1},
    {"productName": "H-E-B Mexican Blend Shredded Cheese, 8 oz",      "searchTerm": "H-E-B Mexican Blend Shredded Cheese","quantity": 2},
    {"productName": "H-E-B Ground Cumin, 3 oz",                       "searchTerm": "H-E-B Ground Cumin",                 "quantity": 1},
    {"productName": "H-E-B Chili Powder, 3 oz",                       "searchTerm": "H-E-B Chili Powder",                 "quantity": 1},
    {"productName": "H-E-B Thick & Chunky Salsa, 16 oz",              "searchTerm": "H-E-B Thick Chunky Salsa",           "quantity": 1},
    {"productName": "H-E-B Sour Cream, 16 oz",                        "searchTerm": "H-E-B Sour Cream",                   "quantity": 1},
    {"productName": "Fresh Large Hass Avocado",                        "searchTerm": "Fresh Large Hass Avocado",           "quantity": 2}
  ]'::jsonb
);

-- ── WALMART ───────────────────────────────────────────────────────────────────

INSERT INTO preset_meals (store_id, name, description, source, recipe, ingredients) VALUES
(
  'walmart', 'Lemon Herb Baked Salmon',
  'Flaky oven-baked salmon with fresh lemon, dill, and roasted baby potatoes',
  'https://www.wellplated.com/baked-salmon/',
  '1. Preheat oven to 400°F. Line a sheet pan with foil.
2. Toss baby potatoes with olive oil, salt, and pepper. Roast 15 min.
3. Push potatoes to the sides. Place salmon fillets skin-side down in the center.
4. Drizzle salmon with olive oil. Arrange lemon slices on top, sprinkle with minced garlic and fresh dill.
5. Roast 12-15 min until salmon flakes easily with a fork.
6. Microwave green beans 3-4 min and serve alongside.',
  '[
    {"productName": "Fresh Atlantic Salmon Fillet, 1.5 lb",            "searchTerm": "Fresh Atlantic Salmon",              "quantity": 1},
    {"productName": "Little Potato Company Baby Potatoes, 1.5 lb",     "searchTerm": "Baby Yellow Potatoes",               "quantity": 1},
    {"productName": "Fresh Lemon",                                       "searchTerm": "Fresh Lemon",                        "quantity": 2},
    {"productName": "Garlic Bulb",                                       "searchTerm": "Garlic Bulb",                        "quantity": 1},
    {"productName": "Fresh Dill",                                        "searchTerm": "Fresh Dill",                         "quantity": 1},
    {"productName": "Mezzetta Non-Pareil Capers, 3.5 oz",              "searchTerm": "Mezzetta Capers",                    "quantity": 1},
    {"productName": "Fresh Green Beans, 12 oz",                         "searchTerm": "Fresh Green Beans",                  "quantity": 1},
    {"productName": "Great Value Extra Virgin Olive Oil, 25.5 oz",      "searchTerm": "Great Value Extra Virgin Olive Oil", "quantity": 1}
  ]'::jsonb
),
(
  'walmart', 'Chicken Tortilla Soup',
  'Hearty Tex-Mex soup with tender chicken, black beans, and corn',
  'https://www.budgetbytes.com/chicken-tortilla-soup/',
  '1. Shred the rotisserie chicken, discarding skin and bones.
2. In a large pot, combine chicken, fire roasted tomatoes, chicken broth, black beans, corn, and taco seasoning.
3. Bring to a boil over medium-high heat, then reduce to low. Simmer 15-20 min.
4. Taste and adjust salt.
5. Ladle into bowls. Top with crushed tortilla chips, shredded cheese, sour cream, and cilantro.',
  '[
    {"productName": "Sam''s Choice Rotisserie Chicken",                 "searchTerm": "Sam''s Choice Rotisserie Chicken",   "quantity": 1},
    {"productName": "Hunt''s Fire Roasted Diced Tomatoes, 14.5 oz",    "searchTerm": "Hunt''s Fire Roasted Diced Tomatoes","quantity": 2},
    {"productName": "Great Value Chicken Broth, 32 oz",                 "searchTerm": "Great Value Chicken Broth",          "quantity": 1},
    {"productName": "Great Value Black Beans, 15 oz",                   "searchTerm": "Great Value Black Beans",            "quantity": 1},
    {"productName": "Green Giant Whole Kernel Corn, 15.25 oz",          "searchTerm": "Green Giant Whole Kernel Corn",      "quantity": 1},
    {"productName": "Old El Paso Taco Seasoning Mix, 1 oz",             "searchTerm": "Old El Paso Taco Seasoning",         "quantity": 1},
    {"productName": "Tostitos Restaurant Style Tortilla Chips, 13 oz", "searchTerm": "Tostitos Restaurant Style Chips",    "quantity": 1},
    {"productName": "Great Value Fiesta Blend Shredded Cheese, 8 oz",  "searchTerm": "Great Value Fiesta Blend Cheese",    "quantity": 1},
    {"productName": "Daisy Sour Cream, 16 oz",                          "searchTerm": "Daisy Sour Cream",                   "quantity": 1},
    {"productName": "Fresh Cilantro Bunch",                              "searchTerm": "Fresh Cilantro",                     "quantity": 1}
  ]'::jsonb
),
(
  'walmart', 'Veggie Fried Rice',
  'Quick vegetarian fried rice with peas, carrots, and scrambled egg',
  'https://www.budgetbytes.com/vegetable-fried-rice/',
  '1. Cook white rice per package and spread on a sheet pan to cool (day-old rice works even better).
2. Heat vegetable oil in a large wok or skillet over high heat until shimmering.
3. Add frozen peas and carrots. Stir-fry 2-3 min until heated through.
4. Push vegetables to the side. Crack eggs into the pan, scramble, then fold into veggies.
5. Add rice. Drizzle soy sauce and sesame oil over. Toss everything together 2-3 min.
6. Add minced garlic in the last 30 seconds. Garnish with sliced green onions.',
  '[
    {"productName": "Great Value Long Grain White Rice, 5 lb",          "searchTerm": "Great Value Long Grain White Rice",  "quantity": 1},
    {"productName": "Birds Eye Steamfresh Sweet Peas & Carrots, 10 oz", "searchTerm": "Birds Eye Peas and Carrots",         "quantity": 2},
    {"productName": "Great Value Large White Eggs, 18 Count",           "searchTerm": "Great Value Large White Eggs",       "quantity": 1},
    {"productName": "Kikkoman Less Sodium Soy Sauce, 10 oz",            "searchTerm": "Kikkoman Soy Sauce",                 "quantity": 1},
    {"productName": "Kadoya Pure Sesame Oil, 5.5 oz",                   "searchTerm": "Kadoya Sesame Oil",                  "quantity": 1},
    {"productName": "Green Onions Bunch",                                "searchTerm": "Green Onions",                       "quantity": 1},
    {"productName": "Garlic Bulb",                                       "searchTerm": "Garlic Bulb",                        "quantity": 1},
    {"productName": "Great Value Vegetable Oil, 48 fl oz",              "searchTerm": "Great Value Vegetable Oil",          "quantity": 1}
  ]'::jsonb
),
(
  'walmart', 'BBQ Pulled Pork Sliders',
  'Slow-cooked smoky pulled pork on soft slider buns with creamy slaw',
  'https://www.allrecipes.com/recipe/24074/easy-slow-cooker-pulled-pork/',
  '1. Rub pork shoulder all over with brown sugar, smoked paprika, salt, and pepper.
2. Place in slow cooker. Pour 1 cup BBQ sauce over the top.
3. Cook on LOW 8-10 hours (or HIGH 4-5 hours) until fall-apart tender.
4. Shred pork with two forks right in the slow cooker. Stir in more BBQ sauce to taste.
5. Mix coleslaw: toss coleslaw mix with 3 tbsp mayo, 1 tbsp apple cider vinegar, and 1 tsp sugar.
6. Toast slider buns if desired. Pile on pulled pork and top with creamy slaw.',
  '[
    {"productName": "Fresh Pork Shoulder Butt, per lb",                "searchTerm": "Fresh Pork Shoulder Butt",           "quantity": 4},
    {"productName": "Sweet Baby Ray''s Original BBQ Sauce, 18 oz",     "searchTerm": "Sweet Baby Ray''s BBQ Sauce",        "quantity": 2},
    {"productName": "King''s Hawaiian Sweet Rolls, 12 ct",             "searchTerm": "King''s Hawaiian Rolls",             "quantity": 1},
    {"productName": "Dole Classic Coleslaw Mix, 14 oz",                "searchTerm": "Dole Coleslaw Mix",                  "quantity": 1},
    {"productName": "Hellmann''s Real Mayonnaise, 30 oz",              "searchTerm": "Hellmann''s Real Mayonnaise",        "quantity": 1},
    {"productName": "Great Value Apple Cider Vinegar, 32 oz",          "searchTerm": "Great Value Apple Cider Vinegar",    "quantity": 1},
    {"productName": "Great Value Light Brown Sugar, 2 lb",             "searchTerm": "Great Value Light Brown Sugar",      "quantity": 1},
    {"productName": "McCormick Smoked Paprika, 1.75 oz",               "searchTerm": "McCormick Smoked Paprika",           "quantity": 1}
  ]'::jsonb
),
(
  'walmart', 'Black Bean Quesadillas',
  'Crispy quesadillas stuffed with seasoned black beans, corn, and melted cheese',
  'https://www.budgetbytes.com/black-bean-quesadillas/',
  '1. Drain and rinse black beans. Mix in a bowl with drained corn, cumin, chili powder, and a pinch of salt.
2. Heat a large skillet over medium. Lightly coat with cooking spray or a little oil.
3. Place a flour tortilla in the skillet. Spread half with the bean-corn mixture and top generously with shredded cheese.
4. Fold tortilla over. Cook 2-3 min per side until golden and crispy and cheese is fully melted.
5. Repeat for remaining tortillas. Slice each into wedges.
6. Serve with salsa, sour cream, and sliced or mashed avocado.',
  '[
    {"productName": "Bush''s Best Black Beans, 15 oz",                 "searchTerm": "Bush''s Best Black Beans",           "quantity": 2},
    {"productName": "Green Giant Whole Kernel Corn, 15.25 oz",         "searchTerm": "Green Giant Whole Kernel Corn",      "quantity": 1},
    {"productName": "Mission Flour Tortillas, 10 ct",                   "searchTerm": "Mission Flour Tortillas",            "quantity": 1},
    {"productName": "Great Value Mexican Style Shredded Cheese, 8 oz", "searchTerm": "Great Value Mexican Shredded Cheese","quantity": 2},
    {"productName": "McCormick Ground Cumin, 1.5 oz",                  "searchTerm": "McCormick Ground Cumin",             "quantity": 1},
    {"productName": "McCormick Chili Powder, 2.5 oz",                  "searchTerm": "McCormick Chili Powder",             "quantity": 1},
    {"productName": "Tostitos Chunky Salsa, 15.5 oz",                  "searchTerm": "Tostitos Chunky Salsa",              "quantity": 1},
    {"productName": "Daisy Sour Cream, 16 oz",                          "searchTerm": "Daisy Sour Cream",                   "quantity": 1},
    {"productName": "Fresh Haas Avocado",                               "searchTerm": "Fresh Avocado",                      "quantity": 2}
  ]'::jsonb
);

-- ── KROGER ────────────────────────────────────────────────────────────────────

INSERT INTO preset_meals (store_id, name, description, source, recipe, ingredients) VALUES
(
  'kroger', 'Lemon Herb Baked Salmon',
  'Flaky oven-baked salmon with fresh lemon, dill, and roasted baby potatoes',
  'https://www.wellplated.com/baked-salmon/',
  '1. Preheat oven to 400°F. Line a sheet pan with foil.
2. Toss baby potatoes with olive oil, salt, and pepper. Roast 15 min.
3. Push potatoes to the sides. Place salmon fillets skin-side down in the center.
4. Drizzle salmon with olive oil. Arrange lemon slices on top, sprinkle with minced garlic and fresh dill.
5. Roast 12-15 min until salmon flakes easily with a fork.
6. Microwave green beans 3-4 min and serve alongside.',
  '[
    {"productName": "Kroger Atlantic Salmon Fillet, per lb",           "searchTerm": "Kroger Atlantic Salmon",             "quantity": 2},
    {"productName": "Kroger Baby Yellow Potatoes, 1.5 lb",             "searchTerm": "Kroger Baby Yellow Potatoes",        "quantity": 1},
    {"productName": "Fresh Lemon",                                       "searchTerm": "Fresh Lemon",                        "quantity": 2},
    {"productName": "Fresh Garlic Bulb",                                 "searchTerm": "Garlic Bulb",                        "quantity": 1},
    {"productName": "Fresh Dill",                                        "searchTerm": "Fresh Dill",                         "quantity": 1},
    {"productName": "Kroger Capers, 3.5 oz",                            "searchTerm": "Kroger Capers",                     "quantity": 1},
    {"productName": "Fresh Green Beans, 12 oz",                         "searchTerm": "Fresh Green Beans",                  "quantity": 1},
    {"productName": "Kroger Extra Virgin Olive Oil, 25.5 oz",           "searchTerm": "Kroger Extra Virgin Olive Oil",     "quantity": 1}
  ]'::jsonb
),
(
  'kroger', 'Chicken Tortilla Soup',
  'Hearty Tex-Mex soup with tender chicken, black beans, and corn',
  'https://www.budgetbytes.com/chicken-tortilla-soup/',
  '1. Shred the rotisserie chicken, discarding skin and bones.
2. In a large pot, combine chicken, fire roasted tomatoes, chicken broth, black beans, corn, and taco seasoning.
3. Bring to a boil over medium-high heat, then reduce to low. Simmer 15-20 min.
4. Taste and adjust salt.
5. Ladle into bowls. Top with crushed tortilla chips, shredded cheese, sour cream, and cilantro.',
  '[
    {"productName": "Kroger Rotisserie Chicken",                        "searchTerm": "Kroger Rotisserie Chicken",          "quantity": 1},
    {"productName": "Kroger Fire Roasted Diced Tomatoes, 14.5 oz",     "searchTerm": "Kroger Fire Roasted Diced Tomatoes", "quantity": 2},
    {"productName": "Kroger Chicken Broth, 32 oz",                      "searchTerm": "Kroger Chicken Broth",              "quantity": 1},
    {"productName": "Kroger Black Beans, 15 oz",                        "searchTerm": "Kroger Black Beans",                "quantity": 1},
    {"productName": "Kroger Whole Kernel Corn, 15.25 oz",              "searchTerm": "Kroger Whole Kernel Corn",           "quantity": 1},
    {"productName": "Old El Paso Taco Seasoning Mix, 1 oz",            "searchTerm": "Old El Paso Taco Seasoning",         "quantity": 1},
    {"productName": "Tostitos Restaurant Style Tortilla Chips, 13 oz", "searchTerm": "Tostitos Restaurant Chips",          "quantity": 1},
    {"productName": "Kroger Mexican Style Shredded Cheese, 8 oz",      "searchTerm": "Kroger Mexican Shredded Cheese",     "quantity": 1},
    {"productName": "Kroger Sour Cream, 16 oz",                        "searchTerm": "Kroger Sour Cream",                  "quantity": 1},
    {"productName": "Fresh Cilantro Bunch",                             "searchTerm": "Fresh Cilantro",                     "quantity": 1}
  ]'::jsonb
),
(
  'kroger', 'Veggie Fried Rice',
  'Quick vegetarian fried rice with peas, carrots, and scrambled egg',
  'https://www.budgetbytes.com/vegetable-fried-rice/',
  '1. Cook white rice per package and spread on a sheet pan to cool (day-old rice works even better).
2. Heat vegetable oil in a large wok or skillet over high heat until shimmering.
3. Add frozen peas and carrots. Stir-fry 2-3 min until heated through.
4. Push vegetables to the side. Crack eggs into the pan, scramble, then fold into veggies.
5. Add rice. Drizzle soy sauce and sesame oil over. Toss everything together 2-3 min.
6. Add minced garlic in the last 30 seconds. Garnish with sliced green onions.',
  '[
    {"productName": "Kroger Long Grain White Rice, 5 lb",              "searchTerm": "Kroger Long Grain White Rice",       "quantity": 1},
    {"productName": "Kroger Frozen Sweet Peas & Carrots, 12 oz",       "searchTerm": "Kroger Frozen Peas Carrots",         "quantity": 2},
    {"productName": "Kroger Large Grade A Eggs, 18 ct",                "searchTerm": "Kroger Large Grade A Eggs",          "quantity": 1},
    {"productName": "Kikkoman Soy Sauce, 10 oz",                        "searchTerm": "Kikkoman Soy Sauce",                "quantity": 1},
    {"productName": "Kroger Sesame Oil, 8 oz",                          "searchTerm": "Kroger Sesame Oil",                 "quantity": 1},
    {"productName": "Green Onions Bunch",                               "searchTerm": "Green Onions",                       "quantity": 1},
    {"productName": "Garlic Bulb",                                      "searchTerm": "Garlic Bulb",                        "quantity": 1},
    {"productName": "Kroger Vegetable Oil, 48 oz",                      "searchTerm": "Kroger Vegetable Oil",              "quantity": 1}
  ]'::jsonb
),
(
  'kroger', 'BBQ Pulled Pork Sliders',
  'Slow-cooked smoky pulled pork on soft slider buns with creamy slaw',
  'https://www.allrecipes.com/recipe/24074/easy-slow-cooker-pulled-pork/',
  '1. Rub pork shoulder all over with brown sugar, smoked paprika, salt, and pepper.
2. Place in slow cooker. Pour 1 cup BBQ sauce over the top.
3. Cook on LOW 8-10 hours (or HIGH 4-5 hours) until fall-apart tender.
4. Shred pork with two forks right in the slow cooker. Stir in more BBQ sauce to taste.
5. Mix coleslaw: toss coleslaw mix with 3 tbsp mayo, 1 tbsp apple cider vinegar, and 1 tsp sugar.
6. Toast slider buns if desired. Pile on pulled pork and top with creamy slaw.',
  '[
    {"productName": "Pork Shoulder Butt Roast, per lb",                "searchTerm": "Pork Shoulder Butt Roast",           "quantity": 4},
    {"productName": "Sweet Baby Ray''s Barbecue Sauce, 18 oz",         "searchTerm": "Sweet Baby Ray''s BBQ Sauce",        "quantity": 2},
    {"productName": "Kroger Slider Buns, 12 ct",                       "searchTerm": "Kroger Slider Buns",                 "quantity": 1},
    {"productName": "Kroger Classic Coleslaw Mix, 14 oz",              "searchTerm": "Kroger Coleslaw Mix",                "quantity": 1},
    {"productName": "Kroger Real Mayonnaise, 30 oz",                   "searchTerm": "Kroger Real Mayonnaise",             "quantity": 1},
    {"productName": "Kroger Apple Cider Vinegar, 32 oz",               "searchTerm": "Kroger Apple Cider Vinegar",         "quantity": 1},
    {"productName": "Kroger Light Brown Sugar, 2 lb",                  "searchTerm": "Kroger Light Brown Sugar",           "quantity": 1},
    {"productName": "McCormick Smoked Paprika, 1.75 oz",               "searchTerm": "McCormick Smoked Paprika",           "quantity": 1}
  ]'::jsonb
),
(
  'kroger', 'Black Bean Quesadillas',
  'Crispy quesadillas stuffed with seasoned black beans, corn, and melted cheese',
  'https://www.budgetbytes.com/black-bean-quesadillas/',
  '1. Drain and rinse black beans. Mix in a bowl with drained corn, cumin, chili powder, and a pinch of salt.
2. Heat a large skillet over medium. Lightly coat with cooking spray or a little oil.
3. Place a flour tortilla in the skillet. Spread half with the bean-corn mixture and top generously with shredded cheese.
4. Fold tortilla over. Cook 2-3 min per side until golden and crispy and cheese is fully melted.
5. Repeat for remaining tortillas. Slice each into wedges.
6. Serve with salsa, sour cream, and sliced or mashed avocado.',
  '[
    {"productName": "Kroger Black Beans, 15 oz",                       "searchTerm": "Kroger Black Beans",                 "quantity": 2},
    {"productName": "Kroger Whole Kernel Corn, 15.25 oz",              "searchTerm": "Kroger Whole Kernel Corn",           "quantity": 1},
    {"productName": "Mission Flour Tortillas, 10 ct",                   "searchTerm": "Mission Flour Tortillas",            "quantity": 1},
    {"productName": "Kroger Mexican Style Shredded Cheese, 8 oz",      "searchTerm": "Kroger Mexican Shredded Cheese",     "quantity": 2},
    {"productName": "Kroger Ground Cumin, 2 oz",                       "searchTerm": "Kroger Ground Cumin",                "quantity": 1},
    {"productName": "Kroger Chili Powder, 2 oz",                       "searchTerm": "Kroger Chili Powder",                "quantity": 1},
    {"productName": "Kroger Chunky Salsa, 16 oz",                      "searchTerm": "Kroger Chunky Salsa",                "quantity": 1},
    {"productName": "Kroger Sour Cream, 16 oz",                        "searchTerm": "Kroger Sour Cream",                  "quantity": 1},
    {"productName": "Fresh Avocado",                                     "searchTerm": "Fresh Avocado",                      "quantity": 2}
  ]'::jsonb
);
