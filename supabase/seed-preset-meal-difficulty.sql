-- Seed difficulty (1–5) for all preset meals
-- Run AFTER add-meal-difficulty.sql

UPDATE preset_meals SET difficulty = 2
WHERE name = 'Classic Beef Tacos';

UPDATE preset_meals SET difficulty = 3
WHERE name = 'Spaghetti Bolognese';

UPDATE preset_meals SET difficulty = 2
WHERE name = 'Chicken Stir Fry';

UPDATE preset_meals SET difficulty = 2
WHERE name = 'BBQ Chicken Pizza';

UPDATE preset_meals SET difficulty = 1
WHERE name = 'Caesar Salad with Grilled Chicken';

UPDATE preset_meals SET difficulty = 2
WHERE name = 'Lemon Herb Baked Salmon';

UPDATE preset_meals SET difficulty = 2
WHERE name = 'Chicken Tortilla Soup';

UPDATE preset_meals SET difficulty = 1
WHERE name = 'Veggie Fried Rice';

UPDATE preset_meals SET difficulty = 3
WHERE name = 'BBQ Pulled Pork Sliders';

UPDATE preset_meals SET difficulty = 1
WHERE name = 'Black Bean Quesadillas';
