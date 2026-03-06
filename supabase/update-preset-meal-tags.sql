-- Update tags for all 50 preset meals
-- Each meal gets up to 3 tags: cuisine/style, protein/main-ingredient, meal-type/category
-- Run in Supabase SQL Editor

UPDATE preset_meals SET tags = ARRAY['Mexican', 'Beef', 'Tacos']          WHERE name = 'Classic Beef Tacos';
UPDATE preset_meals SET tags = ARRAY['Italian', 'Beef', 'Pasta']          WHERE name = 'Spaghetti Bolognese';
UPDATE preset_meals SET tags = ARRAY['Asian', 'Chicken', 'Quick']         WHERE name = 'Chicken Stir Fry';
UPDATE preset_meals SET tags = ARRAY['American', 'Chicken', 'Pizza']      WHERE name = 'BBQ Chicken Pizza';
UPDATE preset_meals SET tags = ARRAY['Salad', 'Chicken', 'Healthy']       WHERE name = 'Caesar Salad with Grilled Chicken';
UPDATE preset_meals SET tags = ARRAY['Seafood', 'Healthy', 'Baked']       WHERE name = 'Lemon Herb Baked Salmon';
UPDATE preset_meals SET tags = ARRAY['Soup', 'Chicken', 'Mexican']        WHERE name = 'Chicken Tortilla Soup';
UPDATE preset_meals SET tags = ARRAY['Vegetarian', 'Asian', 'Rice']       WHERE name = 'Veggie Fried Rice';
UPDATE preset_meals SET tags = ARRAY['BBQ', 'Pork', 'American']           WHERE name = 'BBQ Pulled Pork Sliders';
UPDATE preset_meals SET tags = ARRAY['Vegetarian', 'Mexican', 'Quick']    WHERE name = 'Black Bean Quesadillas';

UPDATE preset_meals SET tags = ARRAY['Breakfast', 'American', 'Sweet']    WHERE name = 'Buttermilk Pancakes';
UPDATE preset_meals SET tags = ARRAY['Breakfast', 'Sweet', 'Quick']       WHERE name = 'Classic French Toast';
UPDATE preset_meals SET tags = ARRAY['Breakfast', 'Mexican', 'Eggs']      WHERE name = 'Breakfast Burritos';
UPDATE preset_meals SET tags = ARRAY['Breakfast', 'Healthy', 'Eggs']      WHERE name = 'Avocado Toast with Fried Eggs';
UPDATE preset_meals SET tags = ARRAY['American', 'Beef', 'Comfort Food']  WHERE name = 'Classic Cheeseburgers';
UPDATE preset_meals SET tags = ARRAY['American', 'Quick', 'Sandwiches']   WHERE name = 'BLT Sandwich';
UPDATE preset_meals SET tags = ARRAY['Chicken', 'Quick', 'Healthy']       WHERE name = 'Chicken Caesar Wrap';
UPDATE preset_meals SET tags = ARRAY['Vegetarian', 'Soup', 'Comfort Food'] WHERE name = 'Grilled Cheese and Tomato Soup';
UPDATE preset_meals SET tags = ARRAY['Beef', 'American', 'Comfort Food']  WHERE name = 'Beef Chili';
UPDATE preset_meals SET tags = ARRAY['Italian', 'Chicken', 'Comfort Food'] WHERE name = 'Chicken Parmesan';

UPDATE preset_meals SET tags = ARRAY['Seafood', 'Mexican', 'Tacos']       WHERE name = 'Shrimp Tacos';
UPDATE preset_meals SET tags = ARRAY['Asian', 'Beef', 'Quick']            WHERE name = 'Beef and Broccoli';
UPDATE preset_meals SET tags = ARRAY['Indian', 'Chicken', 'Spicy']        WHERE name = 'Chicken Tikka Masala';
UPDATE preset_meals SET tags = ARRAY['Mexican', 'Chicken', 'Quick']       WHERE name = 'Sheet Pan Fajitas';
UPDATE preset_meals SET tags = ARRAY['Italian', 'Chicken', 'Comfort Food'] WHERE name = 'Tuscan Garlic Chicken';
UPDATE preset_meals SET tags = ARRAY['Italian', 'Turkey', 'Pasta']        WHERE name = 'Turkey Meatballs with Marinara';
UPDATE preset_meals SET tags = ARRAY['Seafood', 'Asian', 'Healthy']       WHERE name = 'Honey Garlic Salmon';
UPDATE preset_meals SET tags = ARRAY['Italian', 'Vegetarian', 'Pasta']    WHERE name = 'Creamy Tomato Pasta';
UPDATE preset_meals SET tags = ARRAY['Mexican', 'Beef', 'Comfort Food']   WHERE name = 'Beef Enchiladas';
UPDATE preset_meals SET tags = ARRAY['Thai', 'Vegetarian', 'Pasta']       WHERE name = 'Thai Peanut Noodles';

UPDATE preset_meals SET tags = ARRAY['Greek', 'Chicken', 'Healthy']       WHERE name = 'Greek Chicken Bowls';
UPDATE preset_meals SET tags = ARRAY['Soup', 'Chicken', 'Comfort Food']   WHERE name = 'White Chicken Chili';
UPDATE preset_meals SET tags = ARRAY['Beef', 'American', 'Healthy']       WHERE name = 'Stuffed Bell Peppers';
UPDATE preset_meals SET tags = ARRAY['Asian', 'Chicken', 'Rice']          WHERE name = 'Chicken Fried Rice';
UPDATE preset_meals SET tags = ARRAY['Asian', 'Seafood', 'Healthy']       WHERE name = 'Teriyaki Salmon Bowls';
UPDATE preset_meals SET tags = ARRAY['American', 'Vegetarian', 'Comfort Food'] WHERE name = 'Baked Mac and Cheese';
UPDATE preset_meals SET tags = ARRAY['Mexican', 'Pork', 'Tacos']          WHERE name = 'Carnitas Tacos';
UPDATE preset_meals SET tags = ARRAY['Beef', 'Comfort Food', 'Pasta']     WHERE name = 'Beef Stroganoff';
UPDATE preset_meals SET tags = ARRAY['Italian', 'Sausage', 'Pasta']       WHERE name = 'Pesto Pasta with Sausage';
UPDATE preset_meals SET tags = ARRAY['Mediterranean', 'Vegetarian', 'Eggs'] WHERE name = 'Shakshuka';

UPDATE preset_meals SET tags = ARRAY['Indian', 'Chicken', 'Spicy']        WHERE name = 'Chicken Curry';
UPDATE preset_meals SET tags = ARRAY['Italian', 'Chicken', 'Quick']       WHERE name = 'Chicken Piccata';
UPDATE preset_meals SET tags = ARRAY['Italian', 'Sausage', 'Pasta']       WHERE name = 'Sausage and Peppers Pasta';
UPDATE preset_meals SET tags = ARRAY['Salad', 'American', 'Healthy']      WHERE name = 'Cobb Salad';
UPDATE preset_meals SET tags = ARRAY['Pork', 'American', 'Comfort Food']  WHERE name = 'Pork Chops with Apple Sauce';
UPDATE preset_meals SET tags = ARRAY['Soup', 'American', 'Comfort Food']  WHERE name = 'Baked Potato Soup';
UPDATE preset_meals SET tags = ARRAY['Seafood', 'Italian', 'Pasta']       WHERE name = 'Lemon Garlic Shrimp Pasta';
UPDATE preset_meals SET tags = ARRAY['Korean', 'Beef', 'Asian']           WHERE name = 'Korean Beef Bowls';
UPDATE preset_meals SET tags = ARRAY['Soup', 'Chicken', 'Comfort Food']   WHERE name = 'Chicken Noodle Soup';
UPDATE preset_meals SET tags = ARRAY['Italian', 'Vegetarian', 'Salad']    WHERE name = 'Caprese Pasta Salad';

-- Verify: show all meals with their tags
SELECT name, tags FROM preset_meals ORDER BY name;
