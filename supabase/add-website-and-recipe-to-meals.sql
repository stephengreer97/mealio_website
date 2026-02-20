-- Run in: Supabase Dashboard → SQL Editor
ALTER TABLE meals
  ADD COLUMN IF NOT EXISTS website text,
  ADD COLUMN IF NOT EXISTS recipe  text;
