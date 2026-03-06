ALTER TABLE meals ADD COLUMN IF NOT EXISTS creator_id uuid REFERENCES creators(id);
