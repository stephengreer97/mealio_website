-- Seed: 10 preset meals at difficulty 4 and 5
-- Run after seed-preset-meals-40.sql

INSERT INTO preset_meals (name, source, recipe, ingredients, photo_url, author, difficulty) VALUES

-- ── DIFFICULTY 4 ──────────────────────────────────────────────────────────────

-- D4-1. Chicken Marsala
(
  'Chicken Marsala',
  'https://mealio.co',
  E'1. Place chicken breasts between sheets of plastic wrap and pound to 1/2-inch thickness. Season both sides with salt and pepper, then dredge lightly in flour, shaking off the excess.\n2. Heat 2 tbsp olive oil and 1 tbsp butter in a large skillet over medium-high heat. Sear the chicken 3–4 minutes per side until golden brown. Remove and set aside on a plate.\n3. Reduce heat to medium. Add another tbsp of butter and sauté the sliced mushrooms and minced shallots until golden and any liquid has evaporated, about 7–8 minutes.\n4. Add minced garlic and cook 30 seconds until fragrant. Deglaze the pan with the Marsala wine, scraping up all the browned bits from the bottom. Simmer until the wine is reduced by half, about 4 minutes.\n5. Pour in the chicken broth and heavy cream. Stir and simmer 4–5 minutes until the sauce thickens enough to coat a spoon.\n6. Return the chicken to the skillet, nestling it into the sauce. Simmer 3–4 minutes to finish cooking and heat through.\n7. Swirl in 1 tbsp cold butter for gloss. Garnish with fresh parsley and serve over pasta, mashed potatoes, or with crusty bread.',
  '[
    {"productName": "Chicken Breast, 2 lb", "searchTerm": "chicken breast", "quantity": 1},
    {"productName": "All-Purpose Flour, 5 lb Bag", "searchTerm": "all purpose flour", "quantity": 1},
    {"productName": "Baby Bella Mushrooms, 8 oz", "searchTerm": "baby bella mushrooms", "quantity": 1},
    {"productName": "Marsala Wine, 750 ml", "searchTerm": "marsala wine", "quantity": 1},
    {"productName": "Chicken Broth, 32 oz", "searchTerm": "chicken broth", "quantity": 1},
    {"productName": "Heavy Cream, 1 pt", "searchTerm": "heavy cream", "quantity": 1},
    {"productName": "Butter, 1 lb", "searchTerm": "butter", "quantity": 1},
    {"productName": "Shallots, 3 ct", "searchTerm": "shallots", "quantity": 1},
    {"productName": "Garlic, 3 ct Bulb", "searchTerm": "garlic", "quantity": 1},
    {"productName": "Fresh Parsley", "searchTerm": "fresh parsley", "quantity": 1},
    {"productName": "Olive Oil, 16 oz", "searchTerm": "olive oil", "quantity": 1}
  ]'::jsonb,
  '',
  'Mealio Kitchen',
  4
),

-- D4-2. Homemade Beef Ramen
(
  'Homemade Beef Ramen',
  'https://mealio.co',
  E'1. Combine the beef broth, soy sauce, mirin, sake, smashed garlic, and sliced ginger in a large pot. Bring to a simmer over medium heat. Keep at a low simmer while you prepare the toppings.\n2. Season the beef short ribs generously with salt and pepper. In a separate Dutch oven, sear them over high heat in a drizzle of oil until browned on all sides, about 8 minutes. Add 4 cups of the broth mixture, cover, and braise on low heat for 2 hours until very tender. Remove the ribs, slice the meat off the bone, and return the braising liquid to the main broth pot.\n3. For the soft-boiled eggs: bring a small pot of water to a boil. Lower eggs in gently and cook exactly 6 minutes 30 seconds. Transfer to an ice bath, peel, and marinate in a mixture of 3 tbsp soy sauce, 2 tbsp mirin, and 1/4 cup water for at least 30 minutes.\n4. Blanch baby bok choy in boiling water for 90 seconds. Drain and set aside.\n5. Cook ramen noodles per package instructions. Divide among 4 deep bowls.\n6. Strain and taste the broth; adjust with soy sauce and a drizzle of sesame oil. Ladle generously over the noodles.\n7. Top each bowl with sliced short rib, a halved marinated egg, bok choy, sliced green onions, and a sheet of nori. Add a final drizzle of sesame oil.',
  '[
    {"productName": "Beef Short Ribs, 3 lb", "searchTerm": "beef short ribs", "quantity": 1},
    {"productName": "Ramen Noodles, 4-pack", "searchTerm": "ramen noodles", "quantity": 1},
    {"productName": "Beef Broth, 64 oz", "searchTerm": "beef broth", "quantity": 1},
    {"productName": "Soy Sauce, 10 oz", "searchTerm": "soy sauce", "quantity": 1},
    {"productName": "Mirin, 10 oz", "searchTerm": "mirin", "quantity": 1},
    {"productName": "Sake or Dry Sherry, 12 oz", "searchTerm": "dry sherry", "quantity": 1},
    {"productName": "Sesame Oil, 8 oz", "searchTerm": "sesame oil", "quantity": 1},
    {"productName": "Large Eggs, 1 Dozen", "searchTerm": "eggs", "quantity": 1},
    {"productName": "Baby Bok Choy, 1 lb", "searchTerm": "baby bok choy", "quantity": 1},
    {"productName": "Green Onions, 1 Bunch", "searchTerm": "green onions", "quantity": 1},
    {"productName": "Nori Sheets, 1 Pack", "searchTerm": "nori sheets", "quantity": 1},
    {"productName": "Garlic, 3 ct Bulb", "searchTerm": "garlic", "quantity": 1},
    {"productName": "Fresh Ginger Root", "searchTerm": "fresh ginger", "quantity": 1}
  ]'::jsonb,
  '',
  'Mealio Kitchen',
  4
),

-- D4-3. Shrimp Étouffée
(
  'Shrimp Étouffée',
  'https://mealio.co',
  E'1. Make the roux: in a heavy-bottomed Dutch oven or cast-iron pot, melt 6 tbsp butter over medium heat. Whisk in 1/4 cup flour and cook, stirring constantly and scraping the bottom, for 10–15 minutes until the roux turns a deep peanut-butter brown. Do not walk away — it burns fast.\n2. Add the diced onion, celery, and bell pepper (the Cajun "holy trinity"). Cook, stirring often, for 7–8 minutes until the vegetables are completely soft.\n3. Stir in the minced garlic and 1 tbsp Cajun seasoning. Cook 1 minute until fragrant.\n4. Gradually pour in the chicken broth, whisking constantly to incorporate the roux without lumps. Add the bay leaves. Bring to a simmer and cook 10–12 minutes, stirring often, until thickened to a gravy-like consistency.\n5. Add the shrimp in a single layer. Cook 3–4 minutes, turning once, just until pink and opaque. Do not overcook.\n6. Remove bay leaves. Taste and adjust salt, pepper, and Cajun seasoning.\n7. Serve immediately over fluffy white rice, garnished generously with sliced green onions and a squeeze of lemon.',
  '[
    {"productName": "Large Shrimp, 2 lb (peeled, deveined)", "searchTerm": "large shrimp", "quantity": 1},
    {"productName": "Butter, 1 lb", "searchTerm": "butter", "quantity": 1},
    {"productName": "All-Purpose Flour, 5 lb Bag", "searchTerm": "all purpose flour", "quantity": 1},
    {"productName": "Yellow Onion", "searchTerm": "yellow onion", "quantity": 1},
    {"productName": "Celery, 1 Bunch", "searchTerm": "celery", "quantity": 1},
    {"productName": "Green Bell Pepper", "searchTerm": "green bell pepper", "quantity": 1},
    {"productName": "Garlic, 3 ct Bulb", "searchTerm": "garlic", "quantity": 1},
    {"productName": "Cajun Seasoning, 5 oz", "searchTerm": "cajun seasoning", "quantity": 1},
    {"productName": "Chicken Broth, 32 oz", "searchTerm": "chicken broth", "quantity": 1},
    {"productName": "Green Onions, 1 Bunch", "searchTerm": "green onions", "quantity": 1},
    {"productName": "White Rice, 2 lb Bag", "searchTerm": "white rice", "quantity": 1},
    {"productName": "Bay Leaves", "searchTerm": "bay leaves", "quantity": 1},
    {"productName": "Lemon", "searchTerm": "lemon", "quantity": 1}
  ]'::jsonb,
  '',
  'Mealio Kitchen',
  4
),

-- D4-4. Herb-Crusted Pork Tenderloin with Red Wine Pan Sauce
(
  'Herb-Crusted Pork Tenderloin',
  'https://mealio.co',
  E'1. Preheat the oven to 425°F. Pat the pork tenderloins thoroughly dry with paper towels. Season generously all over with salt and pepper.\n2. In a small bowl, stir together 2 tbsp Dijon mustard, 3 minced garlic cloves, 1 tbsp finely chopped fresh rosemary, and 1 tbsp fresh thyme leaves. Rub this herb paste evenly all over both tenderloins.\n3. Heat 2 tbsp olive oil in a large oven-safe skillet (cast iron works great) over high heat until smoking. Sear the tenderloins 2 minutes per side, turning to brown all around.\n4. Transfer the skillet directly to the oven. Roast for 15–18 minutes until an instant-read thermometer in the thickest part reads 145°F. Transfer the pork to a cutting board and let rest 5–8 minutes.\n5. Return the skillet to the stovetop over medium heat. Add 2 sliced shallots and cook 2–3 minutes until softened. Deglaze with 1/2 cup red wine, scraping up all the browned bits. Add 1 cup chicken broth and simmer until reduced by half, about 6 minutes.\n6. Remove from heat and swirl in 2 tbsp cold butter until the sauce is glossy and emulsified. Season with salt and pepper.\n7. Slice the rested tenderloin into 1-inch medallions. Serve over roasted baby potatoes with the red wine sauce spooned over top.',
  '[
    {"productName": "Pork Tenderloin, 2 lb", "searchTerm": "pork tenderloin", "quantity": 1},
    {"productName": "Dijon Mustard, 8 oz Jar", "searchTerm": "dijon mustard", "quantity": 1},
    {"productName": "Fresh Rosemary", "searchTerm": "fresh rosemary", "quantity": 1},
    {"productName": "Fresh Thyme", "searchTerm": "fresh thyme", "quantity": 1},
    {"productName": "Garlic, 3 ct Bulb", "searchTerm": "garlic", "quantity": 1},
    {"productName": "Shallots, 3 ct", "searchTerm": "shallots", "quantity": 1},
    {"productName": "Dry Red Wine, 750 ml", "searchTerm": "dry red wine", "quantity": 1},
    {"productName": "Chicken Broth, 32 oz", "searchTerm": "chicken broth", "quantity": 1},
    {"productName": "Butter, 1 lb", "searchTerm": "butter", "quantity": 1},
    {"productName": "Olive Oil, 16 oz", "searchTerm": "olive oil", "quantity": 1},
    {"productName": "Baby Potatoes, 1.5 lb", "searchTerm": "baby potatoes", "quantity": 1}
  ]'::jsonb,
  '',
  'Mealio Kitchen',
  4
),

-- D4-5. Creamy Lobster Bisque
(
  'Creamy Lobster Bisque',
  'https://mealio.co',
  E'1. Bring a large pot of salted water to a boil. Cook the lobster tails for 7–8 minutes until bright red. Remove, cool slightly, and extract the meat. Chop into bite-sized pieces and refrigerate. Crush the shells and add them back to the cooking liquid; simmer 15 minutes to make a quick shell stock, then strain and reserve.\n2. In a large heavy pot, melt 4 tbsp butter over medium heat. Add the diced shallots and garlic and cook until soft and translucent, about 5 minutes. Stir in the tomato paste and cook 2–3 minutes until it deepens in color.\n3. Whisk in the flour and cook 1–2 minutes. Gradually add the warm shell stock and dry sherry, whisking constantly to prevent lumps.\n4. Simmer 15–20 minutes. Use an immersion blender to puree until completely smooth. For an ultra-silky result, strain through a fine-mesh sieve.\n5. Return the pot to medium-low heat. Stir in the heavy cream and Old Bay seasoning. Season with salt, white pepper, and a pinch of cayenne to taste.\n6. Gently fold in the reserved lobster meat. Warm through over low heat without boiling, about 3 minutes.\n7. Ladle into warmed bowls. Finish each with a light drizzle of cream and a scattering of fresh chives.',
  '[
    {"productName": "Lobster Tails, 4 ct", "searchTerm": "lobster tails", "quantity": 1},
    {"productName": "Butter, 1 lb", "searchTerm": "butter", "quantity": 1},
    {"productName": "Heavy Cream, 1 pt", "searchTerm": "heavy cream", "quantity": 1},
    {"productName": "Seafood Stock, 32 oz", "searchTerm": "seafood stock", "quantity": 1},
    {"productName": "Dry Sherry, 12 oz", "searchTerm": "dry sherry", "quantity": 1},
    {"productName": "Shallots, 3 ct", "searchTerm": "shallots", "quantity": 1},
    {"productName": "Garlic, 3 ct Bulb", "searchTerm": "garlic", "quantity": 1},
    {"productName": "Tomato Paste, 6 oz Can", "searchTerm": "tomato paste", "quantity": 1},
    {"productName": "Old Bay Seasoning", "searchTerm": "old bay seasoning", "quantity": 1},
    {"productName": "All-Purpose Flour, 5 lb Bag", "searchTerm": "all purpose flour", "quantity": 1},
    {"productName": "Fresh Chives", "searchTerm": "fresh chives", "quantity": 1},
    {"productName": "Cayenne Pepper", "searchTerm": "cayenne pepper", "quantity": 1}
  ]'::jsonb,
  '',
  'Mealio Kitchen',
  4
),

-- ── DIFFICULTY 5 ──────────────────────────────────────────────────────────────

-- D5-1. Beef Bourguignon
(
  'Beef Bourguignon',
  'https://mealio.co',
  E'1. Cut the beef chuck into 2-inch cubes. Pat completely dry (moisture prevents browning). Season heavily with salt and pepper and dust lightly in flour.\n2. In a large Dutch oven over medium heat, cook the bacon lardons until the fat renders and the pieces are crispy. Remove with a slotted spoon and set aside. In the rendered fat, sear the beef in two or three uncrowded batches over medium-high heat until deeply browned on all sides, 8–10 minutes per batch. Do not rush this step — color is flavor. Remove and set aside.\n3. Reduce heat to medium. Sauté the carrots, celery, and pearl onions in the pot until lightly colored, about 5 minutes. Add the minced garlic and tomato paste; cook 2 minutes.\n4. Return the beef and bacon to the pot. Pour in the entire bottle of Burgundy red wine and enough beef broth to just barely submerge the meat. Add the thyme and bay leaves.\n5. Bring to a bare simmer, cover with a tight-fitting lid, and transfer to a 325°F oven. Braise for 2.5–3 hours until the beef is completely fork-tender and falling apart.\n6. Meanwhile, sauté the mushrooms in butter in a separate skillet over medium-high heat until golden brown. Season and set aside.\n7. Remove the Dutch oven. Transfer the beef with a slotted spoon. Discard the herb bundle. Bring the braising liquid to a boil on the stovetop and reduce until it coats a spoon like a sauce, about 10–15 minutes.\n8. Return the beef and add the mushrooms. Taste and adjust seasoning. Serve over buttered egg noodles or mashed potatoes, showered with fresh parsley.',
  '[
    {"productName": "Beef Chuck Roast, 3 lb", "searchTerm": "beef chuck roast", "quantity": 1},
    {"productName": "Thick-Cut Bacon, 8 oz", "searchTerm": "thick cut bacon", "quantity": 1},
    {"productName": "Pearl Onions, 10 oz Bag", "searchTerm": "pearl onions", "quantity": 1},
    {"productName": "Baby Bella Mushrooms, 8 oz", "searchTerm": "baby bella mushrooms", "quantity": 1},
    {"productName": "Carrots, 2 lb Bag", "searchTerm": "carrots", "quantity": 1},
    {"productName": "Celery, 1 Bunch", "searchTerm": "celery", "quantity": 1},
    {"productName": "Garlic, 3 ct Bulb", "searchTerm": "garlic", "quantity": 1},
    {"productName": "Tomato Paste, 6 oz Can", "searchTerm": "tomato paste", "quantity": 1},
    {"productName": "Burgundy Red Wine, 750 ml", "searchTerm": "burgundy red wine", "quantity": 1},
    {"productName": "Beef Broth, 32 oz", "searchTerm": "beef broth", "quantity": 1},
    {"productName": "Fresh Thyme", "searchTerm": "fresh thyme", "quantity": 1},
    {"productName": "Bay Leaves", "searchTerm": "bay leaves", "quantity": 1},
    {"productName": "Butter, 1 lb", "searchTerm": "butter", "quantity": 1},
    {"productName": "All-Purpose Flour, 5 lb Bag", "searchTerm": "all purpose flour", "quantity": 1},
    {"productName": "Fresh Parsley", "searchTerm": "fresh parsley", "quantity": 1}
  ]'::jsonb,
  '',
  'Mealio Kitchen',
  5
),

-- D5-2. Potato Gnocchi with Brown Butter and Sage
(
  'Potato Gnocchi with Brown Butter and Sage',
  'https://mealio.co',
  E'1. Bake the russet potatoes directly on the oven rack at 400°F for 60–70 minutes until completely tender all the way through. While still hot, peel them (use a kitchen towel to hold) and pass through a potato ricer or food mill onto a clean work surface. Spread out and let the steam escape — wet potatoes make gummy gnocchi.\n2. Make a well in the center of the riced potato. Add 1 beaten egg, 2 tbsp grated Parmesan, a pinch of freshly grated nutmeg, and 1 tsp salt. Begin incorporating 1 cup of flour by folding and pressing the dough together. Add flour a little at a time until the dough just barely stops sticking to your hands. Less flour means lighter gnocchi.\n3. Divide the dough into 8 portions. On a lightly floured surface, roll each portion into a rope about 3/4-inch thick. Cut into 1-inch pieces. Roll each piece over the back of a fork to create ridges, pressing gently with your thumb (optional but traditional).\n4. Bring a large pot of heavily salted water to a rolling boil. Cook the gnocchi in batches — they are done exactly 30 seconds after they float to the surface. Remove with a slotted spoon and set aside on a plate lightly drizzled with olive oil.\n5. In a wide skillet over medium heat, melt 6 tbsp butter. Cook undisturbed until the foam subsides and the butter turns a deep golden-brown and smells nutty, 4–5 minutes. Add fresh sage leaves and fry until crisp, 30 seconds. Watch closely — brown butter turns burnt fast.\n6. Add the cooked gnocchi to the skillet and toss gently, pressing them against the pan to get some golden edges, 1–2 minutes.\n7. Plate immediately and shower with extra Parmesan and a crack of black pepper.',
  '[
    {"productName": "Russet Potatoes, 3 lb Bag", "searchTerm": "russet potatoes", "quantity": 1},
    {"productName": "All-Purpose Flour, 5 lb Bag", "searchTerm": "all purpose flour", "quantity": 1},
    {"productName": "Large Eggs, 1 Dozen", "searchTerm": "eggs", "quantity": 1},
    {"productName": "Parmesan Cheese, 8 oz Wedge", "searchTerm": "parmesan cheese", "quantity": 1},
    {"productName": "Unsalted Butter, 1 lb", "searchTerm": "unsalted butter", "quantity": 1},
    {"productName": "Fresh Sage", "searchTerm": "fresh sage", "quantity": 1},
    {"productName": "Ground Nutmeg", "searchTerm": "nutmeg", "quantity": 1}
  ]'::jsonb,
  '',
  'Mealio Kitchen',
  5
),

-- D5-3. Duck Confit with French Green Lentils
(
  'Duck Confit with French Green Lentils',
  'https://mealio.co',
  E'1. One day ahead — the cure: Combine 2 tbsp kosher salt, 1 tsp black pepper, 4 crushed garlic cloves, 4 sprigs thyme, and 2 bay leaves. Rub the mixture all over the duck legs, pressing it into the skin and meat. Place in a single layer in a dish, cover, and refrigerate for 12–24 hours.\n2. The next day: Preheat the oven to 225°F. Rinse the duck legs under cold water and pat completely dry. Place them skin-side down in a snug baking dish or Dutch oven. Pour the melted duck fat (or a generous pour of olive oil) over the legs until they are nearly submerged.\n3. Transfer to the oven and confit, uncovered, for 3 to 4 hours. The duck is ready when the meat pulls away from the bone with no resistance and the fat is gently bubbling around the legs.\n4. Remove the duck from the fat and transfer to a wire rack set over a rimmed baking sheet. Increase the oven to 450°F. Roast 12–15 minutes until the skin is shatteringly crisp and mahogany-dark.\n5. While the duck finishes, make the lentils: sauté the diced shallots and carrots in 1 tbsp olive oil over medium heat until softened, 5 minutes. Add the rinsed green lentils and stir to coat. Pour in the chicken broth and a bay leaf. Simmer over medium-low heat for 25–30 minutes until the lentils are tender but still hold their shape.\n6. Drain any excess liquid. Stir in the Dijon mustard and red wine vinegar. Season generously with salt and pepper.\n7. Spoon a mound of lentils onto each plate. Rest a crispy duck leg on top and drizzle with any accumulated pan juices.',
  '[
    {"productName": "Duck Legs, 4 ct", "searchTerm": "duck legs", "quantity": 1},
    {"productName": "Kosher Salt", "searchTerm": "kosher salt", "quantity": 1},
    {"productName": "Fresh Thyme", "searchTerm": "fresh thyme", "quantity": 1},
    {"productName": "Bay Leaves", "searchTerm": "bay leaves", "quantity": 1},
    {"productName": "Black Peppercorns", "searchTerm": "black peppercorns", "quantity": 1},
    {"productName": "Duck Fat, 13 oz Can", "searchTerm": "duck fat", "quantity": 1},
    {"productName": "French Green Lentils (Lentilles du Puy), 1 lb", "searchTerm": "french green lentils", "quantity": 1},
    {"productName": "Shallots, 3 ct", "searchTerm": "shallots", "quantity": 1},
    {"productName": "Carrots, 2 lb Bag", "searchTerm": "carrots", "quantity": 1},
    {"productName": "Dijon Mustard, 8 oz Jar", "searchTerm": "dijon mustard", "quantity": 1},
    {"productName": "Red Wine Vinegar, 12 oz", "searchTerm": "red wine vinegar", "quantity": 1},
    {"productName": "Chicken Broth, 32 oz", "searchTerm": "chicken broth", "quantity": 1},
    {"productName": "Garlic, 3 ct Bulb", "searchTerm": "garlic", "quantity": 1},
    {"productName": "Olive Oil, 16 oz", "searchTerm": "olive oil", "quantity": 1}
  ]'::jsonb,
  '',
  'Mealio Kitchen',
  5
),

-- D5-4. Homemade Butter Croissants
(
  'Homemade Butter Croissants',
  'https://mealio.co',
  E'1. Make the dough (détrempe): Combine 2 1/4 tsp active dry yeast with 1/4 cup warm milk and let sit 5 minutes. In a large bowl, whisk together 3 cups flour, 1/4 cup sugar, and 1.5 tsp salt. Add the yeast mixture and 3/4 cup more cold milk. Mix until a shaggy dough forms. Knead 3–4 minutes until just smooth — do not over-work it. Flatten into a 6-inch square, wrap in plastic, and refrigerate at least 1 hour (overnight is ideal).\n2. Make the butter block (beurrage): Place 2 sticks (1 cup) cold European-style butter between two sheets of parchment. Pound and press with a rolling pin until it forms a 6-inch square about 1/4-inch thick. Refrigerate until firm but still pliable — it should bend without cracking.\n3. Lamination — fold 1: Roll the cold dough on a lightly floured surface into a 12-inch square. Center the butter block on the dough and fold the four corners of the dough over it like an envelope, sealing the edges. Roll into a 7 x 20-inch rectangle. Fold into thirds like a letter. Wrap and refrigerate 30 minutes.\n4. Repeat the roll-and-fold process two more times, chilling 30 minutes between each fold. After 3 folds you will have 27 layers of butter.\n5. Shape: Roll the laminated dough to 1/8-inch thickness, about 10 x 20 inches. Cut into long, narrow triangles. Starting from the wide base, roll each triangle tightly toward the tip, stretching gently as you go. Curve the ends inward to form a crescent. Place on parchment-lined baking sheets with the tip tucked underneath.\n6. Proof: Cover loosely with plastic wrap and proof at a cool room temperature (68–72°F) for 2–3 hours. The croissants should look visibly larger and jiggle when you shake the pan.\n7. Bake: Whisk 1 egg with 1 tbsp milk for the egg wash. Gently brush over each croissant, taking care not to deflate them. Bake at 400°F for 18–22 minutes until a deep, glossy mahogany. Cool on a wire rack at least 15 minutes before eating.',
  '[
    {"productName": "All-Purpose Flour, 5 lb Bag", "searchTerm": "all purpose flour", "quantity": 1},
    {"productName": "European-Style Unsalted Butter, 1 lb (e.g. Kerrygold)", "searchTerm": "european unsalted butter", "quantity": 1},
    {"productName": "Active Dry Yeast, 3-Pack", "searchTerm": "active dry yeast", "quantity": 1},
    {"productName": "Whole Milk, 1/2 Gallon", "searchTerm": "whole milk", "quantity": 1},
    {"productName": "Granulated Sugar, 4 lb Bag", "searchTerm": "sugar", "quantity": 1},
    {"productName": "Sea Salt", "searchTerm": "sea salt", "quantity": 1},
    {"productName": "Large Eggs, 1 Dozen", "searchTerm": "eggs", "quantity": 1}
  ]'::jsonb,
  '',
  'Mealio Kitchen',
  5
),

-- D5-5. Chicken Mole Enchiladas
(
  'Chicken Mole Enchiladas',
  'https://mealio.co',
  E'1. Remove the stems and seeds from all the dried chiles. Heat a dry skillet over medium heat and toast each chile for 30 seconds per side until fragrant and just starting to blister — do not burn them. Transfer to a bowl, cover with boiling water, and soak for 20–25 minutes until softened. Drain and reserve 1 cup of the soaking liquid.\n2. In the same dry skillet, char the halved tomato, quartered onion, and unpeeled garlic cloves until blackened in spots, about 10 minutes. Peel the garlic.\n3. In a large blender, combine the rehydrated chiles, charred vegetables, almonds, raisins, cumin, coriander, cinnamon, and 1 cup of the reserved chile soaking water. Blend until completely smooth, scraping down the sides as needed.\n4. Heat 2 tbsp oil in a large Dutch oven over medium-high heat until shimmering. Pour in the chile paste — it will splatter, so stand back. Fry, stirring constantly and scraping the bottom, for 8–10 minutes until the paste darkens, thickens, and turns almost black.\n5. Add the chicken broth and bring to a simmer. Cook 20–25 minutes, stirring occasionally, until the mole has the consistency of a thin gravy. Add the chopped bittersweet chocolate and stir until fully melted. Season with salt and a pinch of sugar to balance the bitterness. The mole should taste complex, earthy, and barely sweet.\n6. Season the chicken thighs with salt and pepper. Poach them directly in 3 cups of the mole sauce for 20–25 minutes until fully cooked. Remove, shred with two forks, and mix with 1 cup of the mole sauce.\n7. Preheat oven to 375°F. Warm the corn tortillas one at a time directly over a gas burner or in a dry skillet until pliable. Fill each with shredded chicken, roll tightly, and place seam-side down in a 9x13 baking dish.\n8. Pour the remaining mole generously over the enchiladas. Bake 20–25 minutes until bubbling at the edges. Top with crumbled queso fresco, a drizzle of sour cream, and a sprinkle of sesame seeds.',
  '[
    {"productName": "Chicken Thighs, 2 lb (bone-in or boneless)", "searchTerm": "chicken thighs", "quantity": 1},
    {"productName": "Dried Ancho Chiles, 2 oz Bag", "searchTerm": "dried ancho chiles", "quantity": 1},
    {"productName": "Dried Pasilla Chiles, 2 oz Bag", "searchTerm": "dried pasilla chiles", "quantity": 1},
    {"productName": "Whole Tomatoes, 28 oz Can", "searchTerm": "whole tomatoes", "quantity": 1},
    {"productName": "Yellow Onion", "searchTerm": "yellow onion", "quantity": 1},
    {"productName": "Garlic, 3 ct Bulb", "searchTerm": "garlic", "quantity": 1},
    {"productName": "Raw Almonds, 8 oz Bag", "searchTerm": "almonds", "quantity": 1},
    {"productName": "Raisins, 12 oz Box", "searchTerm": "raisins", "quantity": 1},
    {"productName": "Bittersweet Chocolate, 4 oz Bar", "searchTerm": "bittersweet chocolate", "quantity": 1},
    {"productName": "Chicken Broth, 32 oz", "searchTerm": "chicken broth", "quantity": 1},
    {"productName": "Corn Tortillas, 30 ct", "searchTerm": "corn tortillas", "quantity": 1},
    {"productName": "Queso Fresco, 10 oz", "searchTerm": "queso fresco", "quantity": 1},
    {"productName": "Sour Cream, 8 oz", "searchTerm": "sour cream", "quantity": 1},
    {"productName": "Sesame Seeds", "searchTerm": "sesame seeds", "quantity": 1},
    {"productName": "Ground Cumin", "searchTerm": "ground cumin", "quantity": 1},
    {"productName": "Ground Coriander", "searchTerm": "ground coriander", "quantity": 1},
    {"productName": "Ground Cinnamon", "searchTerm": "ground cinnamon", "quantity": 1}
  ]'::jsonb,
  '',
  'Mealio Kitchen',
  5
);
