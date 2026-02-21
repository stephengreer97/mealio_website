-- Seed photo_url for all preset meals
-- Run AFTER add-preset-meal-photo-url.sql
-- All images sourced from Unsplash (free for commercial use)

UPDATE preset_meals SET photo_url = 'https://images.unsplash.com/photo-1565299585323-38d6b0865b47?w=400&fit=crop&auto=format'
WHERE name = 'Classic Beef Tacos';

UPDATE preset_meals SET photo_url = 'https://images.unsplash.com/photo-1622973536968-3ead9e780960?w=400&fit=crop&auto=format'
WHERE name = 'Spaghetti Bolognese';

UPDATE preset_meals SET photo_url = 'https://images.unsplash.com/photo-1564834724105-918b73d1b9e0?w=400&fit=crop&auto=format'
WHERE name = 'Chicken Stir Fry';

UPDATE preset_meals SET photo_url = 'https://images.unsplash.com/photo-1565299624946-b28f40a0ae38?w=400&fit=crop&auto=format'
WHERE name = 'BBQ Chicken Pizza';

UPDATE preset_meals SET photo_url = 'https://images.unsplash.com/photo-1556386734-4227a180d19e?w=400&fit=crop&auto=format'
WHERE name = 'Caesar Salad with Grilled Chicken';

UPDATE preset_meals SET photo_url = 'https://images.unsplash.com/photo-1572862905000-c5b6244027a5?w=400&fit=crop&auto=format'
WHERE name = 'Lemon Herb Baked Salmon';

UPDATE preset_meals SET photo_url = 'https://images.unsplash.com/photo-1707387312816-112e5ca3c145?w=400&fit=crop&auto=format'
WHERE name = 'Chicken Tortilla Soup';

UPDATE preset_meals SET photo_url = 'https://images.unsplash.com/photo-1512058564366-18510be2db19?w=400&fit=crop&auto=format'
WHERE name = 'Veggie Fried Rice';

UPDATE preset_meals SET photo_url = 'https://images.unsplash.com/photo-1709581529998-11b7b2e17f55?w=400&fit=crop&auto=format'
WHERE name = 'BBQ Pulled Pork Sliders';

UPDATE preset_meals SET photo_url = 'https://images.unsplash.com/photo-1628838233717-be047a0b54fb?w=400&fit=crop&auto=format'
WHERE name = 'Black Bean Quesadillas';
