-- Add soft-delete support to meals table
ALTER TABLE meals ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;

-- Backfill: all existing meals are active
UPDATE meals SET is_active = true WHERE is_active IS NULL;
