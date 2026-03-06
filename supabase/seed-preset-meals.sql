-- Seed: 10 foundational preset meals
-- Ingredient convention: Title Case, size appended after comma ("80/20 Ground Beef, 1 lb")
-- Run on a fresh preset_meals table (or after TRUNCATE preset_meals CASCADE)

INSERT INTO preset_meals (name, source, recipe, ingredients, photo_url, author, difficulty) VALUES

-- 1. Classic Beef Tacos
(
  'Classic Beef Tacos',
  'https://mealio.co',
  E'1. Heat 1 tbsp of olive oil in a large skillet over medium-high heat.\n2. Add 1 lb of 80/20 ground beef. Cook 6\u20138 minutes, breaking it apart, until fully browned. Drain excess fat.\n3. Stir in 1 packet of taco seasoning and 1/4 cup of water. Simmer 3\u20134 minutes until the sauce thickens.\n4. Warm 8 small flour tortillas in a dry skillet for 30 seconds per side.\n5. Fill each tortilla with the beef mixture, shredded cheese, a handful of shredded lettuce, and diced tomato.\n6. Finish with a dollop of sour cream and sliced jalapeños to taste.',
  '[
    {"productName": "80/20 Ground Beef, 1 lb", "searchTerm": "ground beef", "quantity": 1},
    {"productName": "Taco Seasoning, 1 oz Packet", "searchTerm": "taco seasoning", "quantity": 1},
    {"productName": "Small Flour Tortillas, 8 ct", "searchTerm": "flour tortillas", "quantity": 1},
    {"productName": "Shredded Mexican Cheese Blend, 8 oz", "searchTerm": "shredded Mexican cheese", "quantity": 1},
    {"productName": "Shredded Iceberg Lettuce, 12 oz Bag", "searchTerm": "shredded lettuce", "quantity": 1},
    {"productName": "Roma Tomatoes", "searchTerm": "roma tomatoes", "quantity": 2},
    {"productName": "Sour Cream, 8 oz", "searchTerm": "sour cream", "quantity": 1},
    {"productName": "Jalapeño Peppers", "searchTerm": "jalapeno", "quantity": 1},
    {"productName": "Olive Oil, 16 oz", "searchTerm": "olive oil", "quantity": 1}
  ]'::jsonb,
  'https://pixabay.com/get/gb661473b729921c4f7d3244ad4f74f79962340e76de59ac8341f64fa2dd151082b64839e7116ce4265c9e7b6c4c78f4ef1d7aaa242e7e313ac42ef217105a5ce_1280.jpg',
  'Mealio Kitchen',
  2
),

-- 2. Spaghetti Bolognese
(
  'Spaghetti Bolognese',
  'https://mealio.co',
  E'1. Heat 2 tbsp of olive oil in a large pot over medium heat. Add 1 diced onion, 2 diced carrots, and 2 diced celery stalks. Cook 6\u20137 minutes until softened.\n2. Add 4 minced garlic cloves and cook 1 minute more.\n3. Add 1 lb of 80/20 ground beef. Brown for 8 minutes, breaking it apart. Drain excess fat.\n4. Stir in 2 tbsp of tomato paste and cook 2 minutes.\n5. Add one 28 oz can of crushed tomatoes, 1 tsp dried oregano, 1 tsp dried basil, 1/2 tsp salt, and 1/4 tsp black pepper.\n6. Reduce heat to low and simmer uncovered for 30 minutes, stirring occasionally.\n7. Cook 16 oz of spaghetti per package directions. Reserve 1/2 cup pasta water before draining.\n8. Toss pasta with the sauce, adding a splash of pasta water to loosen if needed.\n9. Serve topped with freshly grated Parmesan.',
  '[
    {"productName": "80/20 Ground Beef, 1 lb", "searchTerm": "ground beef", "quantity": 1},
    {"productName": "Spaghetti, 16 oz", "searchTerm": "spaghetti", "quantity": 1},
    {"productName": "Crushed Tomatoes, 28 oz Can", "searchTerm": "crushed tomatoes", "quantity": 1},
    {"productName": "Tomato Paste, 6 oz Can", "searchTerm": "tomato paste", "quantity": 1},
    {"productName": "Yellow Onion", "searchTerm": "yellow onion", "quantity": 1},
    {"productName": "Carrots", "searchTerm": "carrots", "quantity": 2},
    {"productName": "Celery", "searchTerm": "celery", "quantity": 1},
    {"productName": "Garlic Bulb", "searchTerm": "garlic", "quantity": 1},
    {"productName": "Parmesan Cheese Wedge, 4 oz", "searchTerm": "Parmesan cheese", "quantity": 1},
    {"productName": "Olive Oil, 16 oz", "searchTerm": "olive oil", "quantity": 1}
  ]'::jsonb,
  'https://pixabay.com/get/g80712f0e5f59acde94833927323a718034fa9647dde4d0a4996233f7b69fab562a4c4374706e4b687216b2e9376dfb81e7a2be9afad7fbedf17030829ab3dfae_1280.jpg',
  'Mealio Kitchen',
  3
),

-- 3. Chicken Stir Fry
(
  'Chicken Stir Fry',
  'https://mealio.co',
  E'1. Slice 1 1/2 lbs of chicken breast into thin strips. Season with 1/4 tsp salt.\n2. Whisk together the sauce: 3 tbsp soy sauce, 1 tbsp oyster sauce, 1 tsp sesame oil, 1 tbsp cornstarch, and 1 tsp sugar. Set aside.\n3. Heat 2 tbsp of vegetable oil in a large wok or skillet over high heat until smoking.\n4. Add the chicken and cook 5\u20136 minutes without stirring until golden. Remove and set aside.\n5. Add 1 tbsp more oil. Add 3 minced garlic cloves and 1 tsp grated ginger. Stir 30 seconds.\n6. Add the sliced red bell pepper, broccoli florets, and snap peas. Stir-fry 3\u20134 minutes until tender-crisp.\n7. Return the chicken to the pan, pour the sauce over everything, and toss 1\u20132 minutes until coated and glossy.\n8. Serve immediately over steamed white rice.',
  '[
    {"productName": "Chicken Breast, Boneless Skinless, 1.5 lb", "searchTerm": "chicken breast", "quantity": 1},
    {"productName": "Broccoli Florets, 12 oz Bag", "searchTerm": "broccoli florets", "quantity": 1},
    {"productName": "Red Bell Pepper", "searchTerm": "red bell pepper", "quantity": 1},
    {"productName": "Snap Peas, 8 oz Bag", "searchTerm": "snap peas", "quantity": 1},
    {"productName": "Soy Sauce, 10 oz", "searchTerm": "soy sauce", "quantity": 1},
    {"productName": "Oyster Sauce, 9 oz", "searchTerm": "oyster sauce", "quantity": 1},
    {"productName": "Sesame Oil, 4 oz", "searchTerm": "sesame oil", "quantity": 1},
    {"productName": "Cornstarch, 1 lb Box", "searchTerm": "cornstarch", "quantity": 1},
    {"productName": "Garlic Bulb", "searchTerm": "garlic", "quantity": 1},
    {"productName": "Fresh Ginger Root", "searchTerm": "ginger root", "quantity": 1},
    {"productName": "White Rice, 2 lb Bag", "searchTerm": "white rice", "quantity": 1},
    {"productName": "Vegetable Oil, 16 oz", "searchTerm": "vegetable oil", "quantity": 1}
  ]'::jsonb,
  'https://pixabay.com/get/gc1acecdede6b9692313f086033e5f7539111c8ee7b76b85c2a64db8758d732b08ce1dd9fa272a66f5f6d215d1d019fffb062f98b47c35cc8641bd41b1038f010_1280.jpg',
  'Mealio Kitchen',
  2
),

-- 4. BBQ Chicken Pizza
(
  'BBQ Chicken Pizza',
  'https://mealio.co',
  E'1. Preheat oven to 425°F.\n2. Season 1 lb of chicken breast with salt and pepper. Cook in a skillet with 1 tbsp olive oil over medium-high heat, 6\u20137 minutes per side, until cooked through. Rest 5 minutes, then shred.\n3. Toss shredded chicken with 1/4 cup of BBQ sauce.\n4. Place the pre-made pizza crust on a lightly oiled baking sheet or pizza stone.\n5. Spread 1/2 cup of BBQ sauce evenly over the crust, leaving a 1/2-inch border.\n6. Scatter the BBQ chicken over the sauce. Top with shredded mozzarella and thinly sliced red onion.\n7. Bake 12\u201315 minutes until the cheese is bubbly and the crust is golden.\n8. Scatter fresh cilantro over the pizza before serving.',
  '[
    {"productName": "Chicken Breast, Boneless Skinless, 1 lb", "searchTerm": "chicken breast", "quantity": 1},
    {"productName": "Pre-Made Pizza Crust, 12 Inch", "searchTerm": "pizza crust", "quantity": 1},
    {"productName": "BBQ Sauce, 18 oz", "searchTerm": "BBQ sauce", "quantity": 1},
    {"productName": "Shredded Mozzarella Cheese, 8 oz", "searchTerm": "shredded mozzarella", "quantity": 1},
    {"productName": "Red Onion", "searchTerm": "red onion", "quantity": 1},
    {"productName": "Fresh Cilantro Bunch", "searchTerm": "cilantro", "quantity": 1},
    {"productName": "Olive Oil, 16 oz", "searchTerm": "olive oil", "quantity": 1}
  ]'::jsonb,
  'https://pixabay.com/get/g16b0ebdd14915c38f23c275e88fd68b1c03a995f1ed66297f8e976b7d9e367570b0281b98433bf29e395800dbf88dd4b69d7b2682316bae1e1503e16d4c52160_1280.jpg',
  'Mealio Kitchen',
  2
),

-- 5. Caesar Salad with Grilled Chicken
(
  'Caesar Salad with Grilled Chicken',
  'https://mealio.co',
  E'1. Season 2 chicken breasts with 1/2 tsp salt, 1/4 tsp black pepper, and 1/2 tsp garlic powder on both sides.\n2. Heat a grill pan over medium-high heat and brush with 1 tbsp olive oil. Grill the chicken 6\u20137 minutes per side until it reaches 165°F internally. Rest 5 minutes, then slice thinly.\n3. Tear the romaine lettuce into bite-sized pieces and place in a large bowl.\n4. Drizzle 3 tbsp of Caesar dressing over the lettuce and toss to coat.\n5. Plate the salad and lay the sliced chicken on top.\n6. Finish with shaved Parmesan and croutons.',
  '[
    {"productName": "Chicken Breast, Boneless Skinless, 2 ct", "searchTerm": "chicken breast", "quantity": 1},
    {"productName": "Romaine Lettuce Hearts, 3 ct", "searchTerm": "romaine lettuce", "quantity": 1},
    {"productName": "Caesar Dressing, 12 oz", "searchTerm": "Caesar dressing", "quantity": 1},
    {"productName": "Parmesan Cheese, Shaved, 4 oz", "searchTerm": "Parmesan cheese", "quantity": 1},
    {"productName": "Seasoned Croutons, 5 oz Bag", "searchTerm": "croutons", "quantity": 1},
    {"productName": "Olive Oil, 16 oz", "searchTerm": "olive oil", "quantity": 1}
  ]'::jsonb,
  'https://pixabay.com/get/gdb4d32760b2dee219f3425a3f3e8c72b996049a7020d10ea970e2bfbfb9389a092a32e2464beddfa4f13f8802a7c0731_1280.jpg',
  'Mealio Kitchen',
  1
),

-- 6. Lemon Herb Baked Salmon
(
  'Lemon Herb Baked Salmon',
  'https://mealio.co',
  E'1. Preheat oven to 400°F. Line a baking sheet with foil and lightly grease with cooking spray.\n2. Pat 4 salmon fillets dry with paper towels and place skin-side down on the baking sheet.\n3. Drizzle 2 tbsp of olive oil evenly over the fillets.\n4. Season each fillet with salt, black pepper, garlic powder, and dried dill.\n5. Lay 2 thin lemon slices on top of each fillet.\n6. Bake 12\u201315 minutes until the salmon flakes easily with a fork and is opaque all the way through.\n7. Serve immediately with steamed asparagus on the side.',
  '[
    {"productName": "Salmon Fillets, 4 ct, 24 oz", "searchTerm": "salmon fillets", "quantity": 1},
    {"productName": "Lemons", "searchTerm": "lemon", "quantity": 2},
    {"productName": "Dried Dill, 1 oz", "searchTerm": "dried dill", "quantity": 1},
    {"productName": "Garlic Powder", "searchTerm": "garlic powder", "quantity": 1},
    {"productName": "Asparagus Bunch", "searchTerm": "asparagus", "quantity": 1},
    {"productName": "Olive Oil, 16 oz", "searchTerm": "olive oil", "quantity": 1},
    {"productName": "Cooking Spray", "searchTerm": "cooking spray", "quantity": 1}
  ]'::jsonb,
  'https://pixabay.com/get/g973e3b2898262cf499993f95a97b43634a2cbb2151afbff2bec9a34b7c2c2981d76b3698e651e26561cf1435c7a03ba38fd635d1f4e0014bcf89e13270b63fed_1280.jpg',
  'Mealio Kitchen',
  2
),

-- 7. Chicken Tortilla Soup
(
  'Chicken Tortilla Soup',
  'https://mealio.co',
  E'1. Heat 1 tbsp olive oil in a large pot over medium heat. Add 1 diced onion and 3 minced garlic cloves. Cook 3\u20134 minutes until softened.\n2. Stir in 2 tsp cumin, 1 tsp chili powder, and 1/2 tsp smoked paprika. Cook 1 minute to bloom the spices.\n3. Add the diced tomatoes, black beans, corn, and chicken broth.\n4. Add 1 lb of whole chicken breast. Bring to a boil, then reduce heat and simmer 20 minutes until cooked through.\n5. Remove the chicken, shred with two forks, and return to the pot. Simmer 5 more minutes.\n6. Season with salt and pepper to taste.\n7. Ladle into bowls and top with tortilla strips, sour cream, and shredded Monterey Jack.',
  '[
    {"productName": "Chicken Breast, Boneless Skinless, 1 lb", "searchTerm": "chicken breast", "quantity": 1},
    {"productName": "Chicken Broth, 32 oz Carton", "searchTerm": "chicken broth", "quantity": 1},
    {"productName": "Diced Tomatoes, 14.5 oz Can", "searchTerm": "diced tomatoes", "quantity": 1},
    {"productName": "Black Beans, 15 oz Can", "searchTerm": "black beans", "quantity": 1},
    {"productName": "Whole Kernel Corn, 15 oz Can", "searchTerm": "canned corn", "quantity": 1},
    {"productName": "Yellow Onion", "searchTerm": "yellow onion", "quantity": 1},
    {"productName": "Garlic Bulb", "searchTerm": "garlic", "quantity": 1},
    {"productName": "Ground Cumin", "searchTerm": "cumin", "quantity": 1},
    {"productName": "Chili Powder", "searchTerm": "chili powder", "quantity": 1},
    {"productName": "Smoked Paprika", "searchTerm": "smoked paprika", "quantity": 1},
    {"productName": "Tortilla Strips, 5 oz Bag", "searchTerm": "tortilla strips", "quantity": 1},
    {"productName": "Sour Cream, 8 oz", "searchTerm": "sour cream", "quantity": 1},
    {"productName": "Shredded Monterey Jack Cheese, 8 oz", "searchTerm": "Monterey Jack cheese", "quantity": 1},
    {"productName": "Olive Oil, 16 oz", "searchTerm": "olive oil", "quantity": 1}
  ]'::jsonb,
  'https://pixabay.com/get/g26802a387f4990f523d07570675a764e2602570a0d4adaa76c614973398be9af5d765fae9f8e2fc905fc44bcb85df35525c4c5322d14c206cc43960ab8f8f29e_1280.jpg',
  'Mealio Kitchen',
  2
),

-- 8. Veggie Fried Rice
(
  'Veggie Fried Rice',
  'https://mealio.co',
  E'1. Cook white rice per package directions. Spread on a sheet pan and refrigerate at least 1 hour — cold rice fries much better.\n2. Heat 2 tbsp of sesame oil in a large wok or skillet over high heat.\n3. Add 3 minced garlic cloves and 1 tsp of grated ginger. Stir-fry 30 seconds.\n4. Add the frozen peas and carrots and frozen corn. Cook 3 minutes, stirring constantly.\n5. Push the vegetables to one side. Crack 3 eggs into the cleared space and scramble until just set, then mix into the vegetables.\n6. Add the cold rice. Drizzle soy sauce and oyster sauce over everything. Toss and stir-fry 2\u20133 minutes over high heat until the rice is heated through and lightly crispy.\n7. Serve topped with sliced green onions and a small drizzle of sesame oil.',
  '[
    {"productName": "White Rice, 2 lb Bag", "searchTerm": "white rice", "quantity": 1},
    {"productName": "Large Eggs, 12 ct", "searchTerm": "eggs", "quantity": 1},
    {"productName": "Frozen Peas and Carrots, 12 oz Bag", "searchTerm": "frozen peas and carrots", "quantity": 1},
    {"productName": "Frozen Corn, 12 oz Bag", "searchTerm": "frozen corn", "quantity": 1},
    {"productName": "Soy Sauce, 10 oz", "searchTerm": "soy sauce", "quantity": 1},
    {"productName": "Oyster Sauce, 9 oz", "searchTerm": "oyster sauce", "quantity": 1},
    {"productName": "Sesame Oil, 4 oz", "searchTerm": "sesame oil", "quantity": 1},
    {"productName": "Garlic Bulb", "searchTerm": "garlic", "quantity": 1},
    {"productName": "Fresh Ginger Root", "searchTerm": "ginger root", "quantity": 1},
    {"productName": "Green Onions Bunch", "searchTerm": "green onions", "quantity": 1}
  ]'::jsonb,
  'https://pixabay.com/get/ga929b11cddcf0b1f226d0d79a36151beae0a81d89855c40eedaada68c41c20a9060deb95c004c4cba6245c1766f0dba018e61478005851411b05c2e79f0ae5bb_1280.jpg',
  'Mealio Kitchen',
  1
),

-- 9. BBQ Pulled Pork Sliders
(
  'BBQ Pulled Pork Sliders',
  'https://mealio.co',
  E'1. Preheat oven to 300°F.\n2. Mix the dry rub: 1 tbsp brown sugar, 1 tsp smoked paprika, 1 tsp garlic powder, 1 tsp onion powder, 1/2 tsp salt, and 1/2 tsp black pepper. Rub all over the pork shoulder.\n3. Heat 1 tbsp vegetable oil in a Dutch oven over medium-high heat. Sear the pork 3 minutes per side until browned.\n4. Pour 3/4 cup of BBQ sauce and 1/2 cup of apple cider vinegar around the pork. Add 1/2 cup of water.\n5. Cover and bake at 300°F for 3 to 3.5 hours until the pork pulls apart easily with a fork.\n6. Transfer to a cutting board. Shred with two forks, discarding large fat pieces. Toss with 1/4 cup more BBQ sauce and a few spoonfuls of cooking juices.\n7. Pile onto slider buns and top each with coleslaw.',
  '[
    {"productName": "Pork Shoulder, 2 lb", "searchTerm": "pork shoulder", "quantity": 1},
    {"productName": "Slider Buns, 12 ct", "searchTerm": "slider buns", "quantity": 1},
    {"productName": "BBQ Sauce, 18 oz", "searchTerm": "BBQ sauce", "quantity": 1},
    {"productName": "Apple Cider Vinegar, 16 oz", "searchTerm": "apple cider vinegar", "quantity": 1},
    {"productName": "Coleslaw Mix, 14 oz Bag", "searchTerm": "coleslaw mix", "quantity": 1},
    {"productName": "Brown Sugar, 1 lb Bag", "searchTerm": "brown sugar", "quantity": 1},
    {"productName": "Smoked Paprika", "searchTerm": "smoked paprika", "quantity": 1},
    {"productName": "Garlic Powder", "searchTerm": "garlic powder", "quantity": 1},
    {"productName": "Onion Powder", "searchTerm": "onion powder", "quantity": 1},
    {"productName": "Vegetable Oil, 16 oz", "searchTerm": "vegetable oil", "quantity": 1}
  ]'::jsonb,
  'https://pixabay.com/get/gef4e576d722f6affae1454ce516976049b11d07af19fc46f7836223f0a670742c47537e4bbc234b8d2ebddeb9bf086bc1b6e4e1656728a5bda7282a177039aef_1280.jpg',
  'Mealio Kitchen',
  3
),

-- 10. Black Bean Quesadillas
(
  'Black Bean Quesadillas',
  'https://mealio.co',
  E'1. Drain and rinse the black beans. Warm in a small pan with 1 tsp cumin, 1/2 tsp chili powder, and a pinch of salt over medium heat for 3 minutes. Lightly mash about half the beans with a fork.\n2. Lay the large flour tortillas flat. On one half of each, spread the bean mixture, shredded Monterey Jack, salsa, and diced red onion.\n3. Fold each tortilla in half over the filling.\n4. Heat a dry skillet over medium heat. Cook each quesadilla 2\u20133 minutes per side until golden brown and the cheese is fully melted.\n5. Slice each quesadilla into 3 wedges.\n6. Serve with sour cream and guacamole on the side.',
  '[
    {"productName": "Black Beans, 15 oz Can", "searchTerm": "black beans", "quantity": 1},
    {"productName": "Large Flour Tortillas, 8 ct", "searchTerm": "flour tortillas", "quantity": 1},
    {"productName": "Shredded Monterey Jack Cheese, 8 oz", "searchTerm": "Monterey Jack cheese", "quantity": 1},
    {"productName": "Salsa, 16 oz Jar", "searchTerm": "salsa", "quantity": 1},
    {"productName": "Red Onion", "searchTerm": "red onion", "quantity": 1},
    {"productName": "Sour Cream, 8 oz", "searchTerm": "sour cream", "quantity": 1},
    {"productName": "Guacamole, 8 oz", "searchTerm": "guacamole", "quantity": 1},
    {"productName": "Ground Cumin", "searchTerm": "cumin", "quantity": 1},
    {"productName": "Chili Powder", "searchTerm": "chili powder", "quantity": 1}
  ]'::jsonb,
  'https://pixabay.com/get/g20505115ed0848e573e6cfe8595cb90c5e9a5ea15ff1a624016cfb1c4246dc9997b21d7bd7da01ec1b13524d51e7492ea5450fbd9b9982f87c1c47b873eb6723_1280.jpg',
  'Mealio Kitchen',
  1
);
