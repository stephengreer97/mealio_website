-- Add difficulty column to meals and preset_meals tables (1 = easiest, 5 = hardest)
ALTER TABLE meals
  ADD COLUMN IF NOT EXISTS difficulty integer CHECK (difficulty BETWEEN 1 AND 5);

ALTER TABLE preset_meals
  ADD COLUMN IF NOT EXISTS difficulty integer CHECK (difficulty BETWEEN 1 AND 5);
