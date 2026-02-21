-- Remove store_id from preset_meals — preset meals are now store-agnostic
ALTER TABLE preset_meals
  DROP COLUMN IF EXISTS store_id;
